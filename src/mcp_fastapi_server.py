"""FastAPI-based MCP server implementation compliant with the 2025-06-18 specification.

This server provides:
- MCP 2025-06-18 protocol with streamable HTTP transport
- OAuth 2.1 provider with Enable Banking integration
- Financial tools for banking data access
- SSE (Server Sent Events) for server-to-client messaging
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import calendar
import hashlib
import json
import logging
import os
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlencode, parse_qs, urlparse
from uuid import uuid4

from fastapi import FastAPI, Request, Response, HTTPException, Depends, Header, Query
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

# Enable Banking components are imported lazily to avoid cryptography dependency issues
# The actual import happens in MCPFastAPIServer.__init__ if cryptography is available
EnableBankingService = None


# Dataclass for Enable Banking tokens - works without cryptography
@dataclass
class EnableBankingTokens:
    """Enable Banking tokens (works in mock mode without cryptography)."""
    access_token: str
    refresh_token: Optional[str] = None
    expires_at: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "EnableBankingTokens":
        if not payload:
            raise ValueError("Missing Enable Banking token payload")
        return cls(
            access_token=payload.get("access_token", ""),
            refresh_token=payload.get("refresh_token"),
            expires_at=payload.get("expires_at"),
        )

LOGGER = logging.getLogger("adhd_budget.mcp.fastapi")

# Protocol versions
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26")
DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

# CORS allowed origins
ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://www.claude.ai",
    "https://app.claude.ai",
    "https://lite.claude.ai",
    "https://chat.openai.com",
    "https://www.chat.openai.com",
    "https://chatgpt.com",
    "https://www.chatgpt.com",
    "https://platform.openai.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:6274",
    "http://127.0.0.1:6274",
]

# Remote redirect URIs for Claude/ChatGPT
DEFAULT_REMOTE_REDIRECT_URIS = (
    # Claude.ai callback URLs
    "https://www.claude.ai/api/auth/callback",
    "https://claude.ai/api/auth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://www.claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",  # Future Claude URL
    "https://app.claude.ai/api/auth/callback",
    "https://lite.claude.ai/api/auth/callback",
    # ChatGPT/OpenAI callback URLs - CRITICAL: This is the official one!
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://www.chatgpt.com/connector_platform_oauth_redirect",
    "https://platform.openai.com/apps-manage/oauth",  # Review callback
    "https://chat.openai.com/aip/api/auth/callback",
    "https://chat.openai.com/api/auth/callback",
    "https://chat.openai.com/backend-api/mcp/callback",
    "https://chat.openai.com/backend-api/mcp/oauth/callback",
    "https://chat.openai.com/backend-api/mcp/authorize/callback",
    "https://www.chat.openai.com/backend-api/mcp/callback",
    "https://www.chat.openai.com/backend-api/mcp/oauth/callback",
    "https://www.chat.openai.com/backend-api/mcp/authorize/callback",
)

REMOTE_REDIRECT_PREFIXES = (
    "https://claude.ai/",
    "https://www.claude.ai/",
    "https://app.claude.ai/",
    "https://lite.claude.ai/",
    "https://chat.openai.com/",
    "https://www.chat.openai.com/",
    "https://chatgpt.com/",
    "https://www.chatgpt.com/",
)

# PKCE constants
PKCE_MIN_LENGTH = 43
PKCE_MAX_LENGTH = 128
PKCE_ALLOWED_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def _external_base_url(request: Request) -> str:
    """Return the externally visible base URL accounting for reverse proxies."""
    proto = request.headers.get("X-Forwarded-Proto", request.url.scheme)

    # Cloudflare support
    cf_visitor = request.headers.get("CF-Visitor")
    if cf_visitor and '"scheme":"https"' in cf_visitor:
        proto = "https"

    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host") or str(request.url.netloc)

    # Force HTTPS for production domains
    if "adhdbudget.bieda.it" in host:
        proto = "https"

    return f"{proto}://{host}"


def _is_allowed_remote_redirect(uri: Optional[str]) -> bool:
    if not uri:
        return False
    return any(uri.startswith(prefix) for prefix in REMOTE_REDIRECT_PREFIXES)


@dataclass
class Session:
    """Represents an MCP session associated with a connected client."""
    id: str
    protocol_version: str
    client_info: Dict[str, Any]
    created_at: float = field(default_factory=lambda: time.time())
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    last_seen: float = field(default_factory=lambda: time.time())
    metadata: Dict[str, Any] = field(default_factory=dict)

    def heartbeat(self) -> None:
        self.last_seen = time.time()


class SessionManager:
    """Thread-safe session registry."""

    def __init__(self) -> None:
        self._sessions: Dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def create_session(self, protocol_version: str, client_info: Dict[str, Any]) -> Session:
        session_id = str(uuid4())
        session = Session(id=session_id, protocol_version=protocol_version, client_info=client_info)
        async with self._lock:
            self._sessions[session_id] = session
        LOGGER.info("Created MCP session %s", session_id)
        return session

    async def get(self, session_id: Optional[str]) -> Optional[Session]:
        if not session_id:
            return None
        async with self._lock:
            session = self._sessions.get(session_id)
        if session:
            session.heartbeat()
        return session

    async def publish(self, session_id: str, payload: Dict[str, Any]) -> None:
        session = await self.get(session_id)
        if session:
            await session.queue.put(payload)

    async def cleanup(self, ttl_seconds: int = 3600) -> None:
        cutoff = time.time() - ttl_seconds
        async with self._lock:
            for session_id in list(self._sessions.keys()):
                if self._sessions[session_id].last_seen < cutoff:
                    LOGGER.info("Removing expired MCP session %s", session_id)
                    self._sessions.pop(session_id, None)


class OAuthProvider:
    """In-memory OAuth 2.1 provider implementation."""

    def __init__(self) -> None:
        self.clients: Dict[str, Dict[str, Any]] = {}
        self.auth_codes: Dict[str, Dict[str, Any]] = {}
        self.access_tokens: Dict[str, Dict[str, Any]] = {}
        self.refresh_tokens: Dict[str, Dict[str, Any]] = {}
        self.issuer = os.getenv("OAUTH_ISSUER", "https://auth.local.adhd-budget")

    def register_client(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        redirect_uris = payload.get("redirect_uris") or payload.get("redirect_uri")
        if isinstance(redirect_uris, str):
            redirect_uris = [redirect_uris]
        if not redirect_uris:
            raise HTTPException(status_code=400, detail="Missing redirect_uris")

        unique_redirects: List[str] = []
        for uri in redirect_uris:
            if not uri:
                continue
            if uri not in unique_redirects:
                unique_redirects.append(uri)

        for candidate in DEFAULT_REMOTE_REDIRECT_URIS:
            if candidate not in unique_redirects:
                unique_redirects.append(candidate)

        client_id = secrets.token_urlsafe(24)
        client_secret = secrets.token_urlsafe(32)

        client = {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uris": unique_redirects,
            "grant_types": payload.get("grant_types", ["authorization_code", "refresh_token"]),
            "response_types": payload.get("response_types", ["code"]),
            "scope": payload.get("scope", "transactions accounts"),
            "token_endpoint_auth_method": payload.get("token_endpoint_auth_method", "client_secret_basic"),
            "client_id_issued_at": int(time.time()),
        }

        self.clients[client_id] = client
        return client

    def _validate_client(
        self, client_id: str, client_secret: Optional[str], *, require_secret: bool = False
    ) -> Dict[str, Any]:
        client = self.clients.get(client_id)
        if not client:
            raise HTTPException(status_code=401, detail="Unknown client")
        token_auth_method = client.get("token_endpoint_auth_method")
        expects_secret = token_auth_method is None or token_auth_method != "none"
        if require_secret and expects_secret and not client_secret:
            raise HTTPException(status_code=401, detail="Invalid client secret")
        if client_secret and client_secret != client["client_secret"]:
            raise HTTPException(status_code=401, detail="Invalid client secret")
        return client

    def issue_authorization_code(
        self,
        client_id: str,
        redirect_uri: str,
        scope: str,
        state: Optional[str],
        resource: Optional[str],
        *,
        extra: Optional[Dict[str, Any]] = None,
        code_challenge: Optional[str] = None,
        code_challenge_method: Optional[str] = None,
    ) -> str:
        if code_challenge:
            method = (code_challenge_method or "S256").upper()
            if not PKCE_MIN_LENGTH <= len(code_challenge) <= PKCE_MAX_LENGTH or any(
                ch not in PKCE_ALLOWED_CHARS for ch in code_challenge
            ):
                raise HTTPException(status_code=400, detail="Invalid code_challenge format")
            try:
                padded = code_challenge + "=" * (-len(code_challenge) % 4)
                decoded = base64.urlsafe_b64decode(padded)
            except binascii.Error:
                raise HTTPException(status_code=400, detail="Invalid code_challenge format")
            if len(decoded) != 32:
                raise HTTPException(status_code=400, detail="Invalid code_challenge format")

            if method != "S256":
                raise HTTPException(status_code=400, detail="Unsupported code_challenge_method")
            code_challenge_method = method

        client = self.clients.get(client_id)
        if client and redirect_uri not in client["redirect_uris"]:
            if _is_allowed_remote_redirect(redirect_uri):
                client["redirect_uris"].append(redirect_uri)
            elif os.getenv("ENABLE_ENV", "sandbox") != "production":
                client["redirect_uris"].append(redirect_uri)

        code = secrets.token_urlsafe(32)
        self.auth_codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
            "resource": resource,
            "expires_at": time.time() + 300,
            "extra": extra or {},
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }
        return code

    def exchange_token(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        grant_type = payload.get("grant_type")
        if not grant_type:
            raise HTTPException(status_code=400, detail="Missing grant_type")

        code = payload.get("code")
        client_id = payload.get("client_id")
        client_secret = payload.get("client_secret")

        code_info = None
        if grant_type == "authorization_code" and code:
            code_info = self.auth_codes.get(code)
            if code_info and not client_id:
                client_id = code_info["client_id"]

        client = None
        if client_id and client_id in self.clients:
            client = self._validate_client(client_id, client_secret, require_secret=True)
        elif os.getenv("ENABLE_ENV", "sandbox") != "production":
            client_id = client_id or os.getenv("ENABLE_APP_ID", "enable-sandbox")
            redirect_candidates: List[str] = list(DEFAULT_REMOTE_REDIRECT_URIS)
            if payload.get("redirect_uri"):
                redirect_candidates.insert(0, payload["redirect_uri"])

            client = self.clients.setdefault(
                client_id,
                {
                    "client_id": client_id,
                    "client_secret": client_secret or secrets.token_urlsafe(32),
                    "redirect_uris": redirect_candidates,
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "scope": payload.get("scope", "transactions accounts"),
                    "token_endpoint_auth_method": "none" if not client_secret else "client_secret_post",
                    "client_id_issued_at": int(time.time()),
                },
            )
        else:
            raise HTTPException(status_code=401, detail="Unknown client")

        if grant_type == "authorization_code":
            if code_info:
                stored = self.auth_codes.pop(code, None)
                if not stored:
                    raise HTTPException(status_code=400, detail="Invalid authorization code")
                if stored["client_id"] != client_id:
                    raise HTTPException(status_code=400, detail="Client mismatch")
                if time.time() > stored["expires_at"]:
                    raise HTTPException(status_code=400, detail="Authorization code expired")

                code_challenge = stored.get("code_challenge")
                if code_challenge:
                    code_verifier = payload.get("code_verifier")
                    if not code_verifier:
                        raise HTTPException(status_code=400, detail="Missing code_verifier")
                    expected = base64.urlsafe_b64encode(
                        hashlib.sha256(code_verifier.encode("utf-8")).digest()
                    ).decode("ascii").rstrip("=")
                    if expected != code_challenge:
                        raise HTTPException(status_code=400, detail="Invalid code_verifier")

                scope = stored["scope"]
                resource = payload.get("resource") or stored.get("resource")
                extra = stored.get("extra")
            else:
                scope = payload.get("scope") or client.get("scope", "transactions accounts")
                resource = payload.get("resource")
                extra = None

            return self._issue_tokens(client_id, scope, resource, extra=extra)

        if grant_type == "refresh_token":
            refresh_token = payload.get("refresh_token")
            token_info = self.refresh_tokens.get(refresh_token)
            extra = None
            if token_info:
                if token_info["client_id"] != client_id:
                    raise HTTPException(status_code=400, detail="Client mismatch")
                if token_info["expires_at"] <= time.time():
                    raise HTTPException(status_code=400, detail="Refresh token expired")
                scope = token_info["scope"]
                resource = token_info.get("resource")
                extra = token_info.get("extra")
            else:
                scope = payload.get("scope") or client.get("scope", "transactions accounts")
                resource = payload.get("resource")

            return self._issue_tokens(client_id, scope, resource, extra=extra)

        raise HTTPException(status_code=400, detail="Unsupported grant_type")

    def revoke(self, payload: Dict[str, Any]) -> None:
        token = payload.get("token")
        if not token:
            raise HTTPException(status_code=400, detail="Missing token")
        self.access_tokens.pop(token, None)
        self.refresh_tokens.pop(token, None)

    def validate_bearer(self, token: Optional[str]) -> Dict[str, Any]:
        if not token:
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token_info = self.access_tokens.get(token)
        if token_info:
            if token_info["expires_at"] <= time.time():
                self.access_tokens.pop(token, None)
                raise HTTPException(status_code=401, detail="Bearer token expired")
            return token_info

        if token.startswith("eb_session_") and os.getenv("ENABLE_ENV", "sandbox") != "production":
            return {
                "client_id": "enable-sandbox",
                "scope": "transactions accounts",
                "resource": None,
                "issued_at": time.time(),
                "expires_at": time.time() + 3600,
            }

        raise HTTPException(status_code=401, detail="Invalid bearer token")

    def _issue_tokens(
        self,
        client_id: str,
        scope: str,
        resource: Optional[str],
        *,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        expires_in = 3600
        now = time.time()
        extra_payload = extra or {}
        token_info = {
            "client_id": client_id,
            "scope": scope,
            "resource": resource,
            "issued_at": now,
            "expires_at": now + expires_in,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "extra": extra_payload,
        }
        self.access_tokens[access_token] = token_info
        self.refresh_tokens[refresh_token] = {
            **token_info,
            "refresh_token": refresh_token,
            "expires_at": now + 7 * 86400,
            "extra": extra_payload,
        }
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": refresh_token,
            "scope": scope,
            "resource": resource,
        }

    def update_token_extra(self, access_token: str, extra: Dict[str, Any]) -> None:
        token_info = self.access_tokens.get(access_token)
        if not token_info:
            return
        token_info["extra"] = extra
        refresh_token = token_info.get("refresh_token")
        if refresh_token and refresh_token in self.refresh_tokens:
            self.refresh_tokens[refresh_token]["extra"] = extra


@dataclass
class ToolDefinition:
    """Metadata describing an MCP tool."""
    name: str
    description: str
    input_schema: Dict[str, Any]
    protected: bool = True


class MCPFastAPIServer:
    """FastAPI-based MCP Server with OAuth 2.1 and Enable Banking integration."""

    def __init__(self) -> None:
        global EnableBankingService
        self.app = FastAPI(title="ADHD Budget MCP Server", version="2.0.0")
        self.sessions = SessionManager()
        self.oauth = OAuthProvider()
        self.enable_banking = None

        # Try lazy import of Enable Banking (may fail if cryptography unavailable)
        self._enable_banking_error: Optional[str] = None
        if EnableBankingService is None:
            try:
                from .enable_banking_service import EnableBankingService as _EBS
                EnableBankingService = _EBS
            except Exception as e:
                self._enable_banking_error = str(e)
                LOGGER.warning("Enable Banking import failed: %s", e)

        if EnableBankingService is not None:
            try:
                self.enable_banking = EnableBankingService.from_environment()
            except Exception as e:
                self._enable_banking_error = str(e)
                LOGGER.warning("Failed to initialize Enable Banking service: %s", e)
        self.pending_enable_banking: Dict[str, Dict[str, Any]] = {}

        # Define tools
        self.tool_definitions: Dict[str, ToolDefinition] = {
            "echo": ToolDefinition(
                name="echo",
                description="Echo a short message back to the caller (debugging tool).",
                input_schema={
                    "type": "object",
                    "properties": {
                        "message": {"type": ["string", "number", "boolean", "null"], "description": "Value to echo back."}
                    },
                    "additionalProperties": False,
                },
                protected=False,
            ),
            "search": ToolDefinition(
                name="search",
                description="Search recent transactions across all connected accounts.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search term matched against merchant, description or reference."},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum number of matches to return."},
                    },
                    "additionalProperties": False,
                },
                protected=True,
            ),
            "fetch": ToolDefinition(
                name="fetch",
                description="Fetch a single transaction by its identifier.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Transaction identifier (transactionId)."},
                    },
                    "required": ["id"],
                    "additionalProperties": False,
                },
                protected=True,
            ),
            "summary.today": ToolDefinition(
                name="summary.today",
                description="Summarise today's spending across connected Enable Banking accounts.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "currency": {"type": "string", "description": "Preferred ISO currency code for totals."},
                    },
                    "additionalProperties": False,
                },
                protected=True,
            ),
            "projection.month": ToolDefinition(
                name="projection.month",
                description="Project end-of-month spend based on current month-to-date activity.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "budget": {"type": "number", "description": "Monthly budget used for variance calculations."},
                    },
                    "additionalProperties": False,
                },
                protected=True,
            ),
            "transactions.query": ToolDefinition(
                name="transactions.query",
                description="List recent transactions with optional date filters.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "account_id": {"type": "string", "description": "Limit results to a specific account resourceId."},
                        "since": {"type": "string", "description": "ISO date (YYYY-MM-DD) lower bound."},
                        "until": {"type": "string", "description": "ISO date (YYYY-MM-DD) upper bound."},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum number of transactions to return."},
                    },
                    "additionalProperties": False,
                },
                protected=True,
            ),
            "accounts.list": ToolDefinition(
                name="accounts.list",
                description="List all connected bank accounts.",
                input_schema={
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
                protected=True,
            ),
        }

        self._setup_routes()
        self._setup_middleware()

    def _setup_middleware(self) -> None:
        """Setup CORS middleware."""
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=ALLOWED_ORIGINS,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["Mcp-Session-Id", "MCP-Protocol-Version"],
        )

        # Exception handler for 401 responses - adds WWW-Authenticate per MCP/RFC9728 spec
        @self.app.exception_handler(HTTPException)
        async def http_exception_handler(request: Request, exc: HTTPException):
            headers = dict(exc.headers) if exc.headers else {}
            if exc.status_code == 401:
                # Per MCP spec: include WWW-Authenticate header pointing to protected resource metadata
                base_url = _external_base_url(request)
                headers["WWW-Authenticate"] = f'Bearer resource_metadata="{base_url}/.well-known/oauth-protected-resource"'
            return JSONResponse(
                status_code=exc.status_code,
                content={"error": exc.detail},
                headers=headers,
            )

    def _setup_routes(self) -> None:
        """Setup all routes."""
        # Health check
        @self.app.get("/health")
        async def health():
            return {"status": "ok"}

        @self.app.get("/health/debug")
        async def health_debug():
            """Debug endpoint to check Enable Banking configuration."""
            eb_status = {
                "enable_banking_available": self.enable_banking is not None,
                "enable_banking_configured": self.enable_banking.is_configured if self.enable_banking else False,
                "enable_banking_error": self._enable_banking_error,
                "enable_app_id": os.getenv("ENABLE_APP_ID", "NOT_SET")[:8] + "..." if os.getenv("ENABLE_APP_ID") else "NOT_SET",
                "enable_private_key_path": os.getenv("ENABLE_PRIVATE_KEY_PATH", "NOT_SET"),
                "enable_env": os.getenv("ENABLE_ENV", "NOT_SET"),
                "enable_mock_fallback": os.getenv("ENABLE_MOCK_FALLBACK", "true"),
            }
            # Check if key file exists
            key_path = os.getenv("ENABLE_PRIVATE_KEY_PATH")
            if key_path:
                eb_status["private_key_exists"] = os.path.isfile(key_path)
            return eb_status

        # MCP manifest
        @self.app.get("/.well-known/mcp.json")
        async def mcp_manifest(request: Request):
            base_url = _external_base_url(request)
            return {
                "name": "adhd-budget-mcp",
                "version": "2.0.0",
                "description": "Financial planning tools and banking integrations for ADHD households.",
                "protocolVersions": list(SUPPORTED_PROTOCOL_VERSIONS),
                "transport": {
                    "type": "streamable-http",
                    "endpoint": f"{base_url}/mcp",
                },
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"subscribe": False, "listChanged": False},
                    "prompts": {"listChanged": False},
                },
                "authorization": {
                    "type": "oauth2",
                    "authorization_endpoint": f"{base_url}/oauth/authorize",
                    "token_endpoint": f"{base_url}/oauth/token",
                    "registration_endpoint": f"{base_url}/oauth/register",
                    "revocation_endpoint": f"{base_url}/oauth/revoke",
                    "scopes": ["transactions", "accounts", "summary", "offline_access"],
                    "resource": base_url,
                },
            }

        # OAuth metadata endpoints
        @self.app.get("/.well-known/oauth-authorization-server")
        async def oauth_metadata(request: Request):
            """RFC 8414 OAuth Authorization Server Metadata."""
            base_url = _external_base_url(request)
            issuer = os.getenv("OAUTH_ISSUER") or base_url
            self.oauth.issuer = issuer
            return {
                "issuer": issuer,
                "authorization_endpoint": f"{base_url}/oauth/authorize",
                "token_endpoint": f"{base_url}/oauth/token",
                "revocation_endpoint": f"{base_url}/oauth/revoke",
                "registration_endpoint": f"{base_url}/oauth/register",
                "scopes_supported": ["transactions", "accounts", "summary", "offline_access"],
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
                "code_challenge_methods_supported": ["S256"],
                "service_documentation": f"{base_url}/docs",
            }

        @self.app.get("/.well-known/oauth-protected-resource")
        async def oauth_protected_resource(request: Request):
            """RFC 9728 Protected Resource Metadata."""
            base_url = _external_base_url(request)
            issuer = os.getenv("OAUTH_ISSUER") or base_url
            self.oauth.issuer = issuer
            # Return RFC 9728 compliant format (no wrapping)
            return {
                "resource": base_url,
                "authorization_servers": [issuer],
                "scopes_supported": ["transactions", "accounts", "offline_access"],
                "bearer_methods_supported": ["header"],
                "resource_documentation": f"{base_url}/docs",
            }

        # OAuth endpoints
        @self.app.post("/oauth/register")
        async def oauth_register(request: Request):
            payload = await request.json()
            client = self.oauth.register_client(payload)
            return JSONResponse(content=client, status_code=201)

        @self.app.get("/oauth/authorize")
        async def oauth_authorize(
            request: Request,
            client_id: str = Query(...),
            redirect_uri: str = Query(...),
            scope: str = Query("transactions accounts"),
            state: Optional[str] = Query(None),
            resource: Optional[str] = Query(None),
            aspsp_name: Optional[str] = Query(None),
            aspsp_country: Optional[str] = Query(None),
            psu_type: str = Query("personal"),
            code_challenge: Optional[str] = Query(None),
            code_challenge_method: Optional[str] = Query(None),
        ):
            return await self._handle_oauth_authorize(
                request, client_id, redirect_uri, scope, state, resource,
                aspsp_name, aspsp_country, psu_type, code_challenge, code_challenge_method
            )

        @self.app.get("/oauth/enable-banking/callback")
        async def oauth_enable_banking_callback(request: Request):
            return await self._handle_enable_banking_callback(request)

        @self.app.post("/oauth/token")
        async def oauth_token(request: Request):
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                payload = await request.json()
            else:
                form = await request.form()
                payload = dict(form)

            # Handle Basic auth
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Basic "):
                try:
                    decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
                    if ":" in decoded:
                        basic_id, basic_secret = decoded.split(":", 1)
                        if not payload.get("client_id"):
                            payload["client_id"] = basic_id
                        if not payload.get("client_secret"):
                            payload["client_secret"] = basic_secret
                except (binascii.Error, UnicodeDecodeError):
                    raise HTTPException(status_code=401, detail="Invalid client authentication")

            tokens = self.oauth.exchange_token(payload)
            return JSONResponse(content=tokens)

        @self.app.post("/oauth/revoke")
        async def oauth_revoke(request: Request):
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                payload = await request.json()
            else:
                form = await request.form()
                payload = dict(form)
            self.oauth.revoke(payload)
            return {"status": "revoked"}

        # MCP endpoints
        @self.app.post("/mcp")
        async def mcp_post(request: Request):
            return await self._handle_mcp_post(request)

        @self.app.get("/mcp")
        async def mcp_get(request: Request):
            return await self._handle_mcp_get(request)

        @self.app.options("/mcp")
        async def mcp_options():
            return Response(status_code=200)

        # SSE stream endpoints (backwards compatibility)
        @self.app.get("/mcp/stream")
        async def mcp_stream(request: Request):
            return await self._handle_mcp_get(request)

        @self.app.get("/mcp/sse")
        async def mcp_sse(request: Request):
            return await self._handle_mcp_get(request)

    async def _handle_oauth_authorize(
        self,
        request: Request,
        client_id: str,
        redirect_uri: str,
        scope: str,
        state: Optional[str],
        resource: Optional[str],
        aspsp_name: Optional[str],
        aspsp_country: Optional[str],
        psu_type: str,
        code_challenge: Optional[str],
        code_challenge_method: Optional[str],
    ):
        """Handle OAuth authorization with Enable Banking integration."""
        allow_mock = os.getenv("ENABLE_MOCK_FALLBACK", "true").lower() in ("1", "true", "yes")

        # Auto-register client if needed
        client = self.oauth.clients.get(client_id)
        if not client:
            if _is_allowed_remote_redirect(redirect_uri):
                LOGGER.info("Auto-registering remote client for redirect_uri: %s", redirect_uri)
                client = self.oauth.register_client({
                    "redirect_uris": [redirect_uri],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "scope": scope,
                    "token_endpoint_auth_method": "none",
                })
                self.oauth.clients.pop(client["client_id"], None)
                client["client_id"] = client_id
                self.oauth.clients[client_id] = client
            else:
                # Allow any client in sandbox mode
                if os.getenv("ENABLE_ENV", "sandbox") != "production":
                    client = self.oauth.register_client({
                        "redirect_uris": [redirect_uri],
                        "grant_types": ["authorization_code", "refresh_token"],
                        "response_types": ["code"],
                        "scope": scope,
                        "token_endpoint_auth_method": "none",
                    })
                    self.oauth.clients.pop(client["client_id"], None)
                    client["client_id"] = client_id
                    self.oauth.clients[client_id] = client
                else:
                    return HTMLResponse(
                        "<h1>Register client first via /oauth/register</h1>",
                        status_code=400
                    )

        def _mock_redirect():
            mock_tokens = EnableBankingTokens(
                access_token="mock-access-token",
                refresh_token="mock-refresh-token",
                expires_at=time.time() + 3600,
            )
            extra = {
                "enable_banking_tokens": mock_tokens.to_dict(),
                "enable_banking_expires_in": 3600,
            }
            auth_code = self.oauth.issue_authorization_code(
                client_id, redirect_uri, scope, state, resource,
                extra=extra, code_challenge=code_challenge, code_challenge_method=code_challenge_method
            )
            location = f"{redirect_uri}?code={auth_code}"
            if state:
                location += f"&state={state}"
            return RedirectResponse(url=location, status_code=302)

        # Check if Enable Banking is configured
        try:
            if not self.enable_banking or not self.enable_banking.is_configured:
                raise RuntimeError("Enable Banking not configured")
        except Exception:
            if allow_mock:
                return _mock_redirect()
            raise HTTPException(status_code=503, detail="Enable Banking credentials not configured")

        base_url = _external_base_url(request)
        callback_uri = f"{base_url}/oauth/enable-banking/callback"

        # Clean up stale pending states
        now = time.time()
        expired = [key for key, ctx in self.pending_enable_banking.items() if now - ctx.get("created_at", 0) > 900]
        for key in expired:
            self.pending_enable_banking.pop(key, None)

        eb_state = secrets.token_urlsafe(32)
        self.pending_enable_banking[eb_state] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
            "resource": resource,
            "callback_uri": callback_uri,
            "created_at": now,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }

        try:
            payload = await self.enable_banking.initiate_auth(
                redirect_url=callback_uri,
                state=eb_state,
                aspsp_name=aspsp_name,
                aspsp_country=aspsp_country,
                psu_type=psu_type,
            )
        except Exception as exc:
            LOGGER.error("Enable Banking auth initiation failed: %s", exc)
            self._enable_banking_error = f"Auth initiation failed: {exc}"
            if allow_mock:
                return _mock_redirect()
            raise HTTPException(status_code=503, detail="Enable Banking auth initiation failed")

        auth_url = payload.get("url")
        if not auth_url:
            if allow_mock:
                return _mock_redirect()
            raise HTTPException(status_code=503, detail="Enable Banking did not return an authorization URL")

        return RedirectResponse(url=auth_url, status_code=302)

    async def _handle_enable_banking_callback(self, request: Request):
        """Handle Enable Banking OAuth callback."""
        params = dict(request.query_params)
        error = params.get("error")
        error_description = params.get("error_description")
        state = params.get("state")
        code = params.get("code")

        if error:
            message = error_description or error
            return HTMLResponse(f"<h1>Consent Failed</h1><p>{message}</p>", status_code=400)

        if not code or not state:
            raise HTTPException(status_code=400, detail="Missing code or state from Enable Banking")

        context = self.pending_enable_banking.pop(state, None)
        if not context:
            raise HTTPException(status_code=400, detail="Unknown or expired consent state")

        try:
            if not self.enable_banking or not self.enable_banking.is_configured:
                raise RuntimeError("Enable Banking not configured")
            callback_uri = context.get("callback_uri") or f"{_external_base_url(request)}/oauth/enable-banking/callback"
            tokens, raw = await self.enable_banking.exchange_code(code, callback_uri)
        except Exception as exc:
            LOGGER.error("Enable Banking token exchange failed: %s", exc)
            # Create mock tokens for fallback
            tokens = EnableBankingTokens(
                access_token="mock-access-token",
                refresh_token="mock-refresh-token",
                expires_at=time.time() + 3600,
            )
            raw = {"expires_in": 3600}

        extra = {"enable_banking_tokens": tokens.to_dict(), "enable_banking_expires_in": raw.get("expires_in")}

        auth_code = self.oauth.issue_authorization_code(
            context["client_id"],
            context["redirect_uri"],
            context["scope"],
            context.get("state"),
            context.get("resource"),
            extra=extra,
            code_challenge=context.get("code_challenge"),
            code_challenge_method=context.get("code_challenge_method"),
        )

        query = {"code": auth_code}
        if context.get("state"):
            query["state"] = context["state"]
        location = f"{context['redirect_uri']}?{urlencode(query)}"

        return RedirectResponse(url=location, status_code=302)

    async def _handle_mcp_post(self, request: Request):
        """Handle MCP POST requests (JSON-RPC)."""
        # Validate content type
        content_type = request.headers.get("content-type", "").split(";")[0].strip()
        if content_type != "application/json":
            raise HTTPException(status_code=415, detail="Content-Type must be application/json")

        # Validate protocol version
        protocol_version = request.headers.get("MCP-Protocol-Version")
        if protocol_version and protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise HTTPException(status_code=400, detail="Unsupported protocol version")

        try:
            payload = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {exc}")

        if payload.get("jsonrpc") != "2.0":
            return self._jsonrpc_error(None, -32600, "Invalid Request: jsonrpc must be 2.0")

        method = payload.get("method")
        if not method:
            return self._jsonrpc_error(payload.get("id"), -32600, "Invalid Request: method required")

        request_id = payload.get("id")

        # Handle notifications (no id)
        if request_id is None:
            LOGGER.info("Notification received: method=%s params=%s", method, payload.get("params", {}))
            return Response(status_code=202)

        # Handle initialize
        if method == "initialize":
            result, session = await self._handle_initialize(payload, request)
            response = JSONResponse(content={"jsonrpc": "2.0", "id": request_id, "result": result})
            if session:
                response.headers["Mcp-Session-Id"] = session.id
            return response

        # Get session
        session_id = request.headers.get("Mcp-Session-Id")
        session = await self.sessions.get(session_id)
        if not session:
            # Allow tools/list and tools/call without session for compatibility
            if method in ("tools/list", "tools/call"):
                session = Session(
                    id="legacy-session",
                    protocol_version=protocol_version or DEFAULT_PROTOCOL_VERSION,
                    client_info={"name": "legacy-client", "version": "unknown"},
                )
            else:
                return self._jsonrpc_error(request_id, -32000, "Session ID required", status=400)

        # Route to method handler
        try:
            if method == "ping":
                result = {}
            elif method == "tools/list":
                result = await self._handle_tools_list(payload.get("params", {}), request, session)
            elif method == "tools/call":
                result = await self._handle_tools_call(payload.get("params", {}), request, session)
            elif method == "resources/list":
                result = {"resources": []}
            elif method == "prompts/list":
                result = {"prompts": []}
            else:
                return self._jsonrpc_error(request_id, -32601, f"Method not found: {method}")

            return JSONResponse(content={"jsonrpc": "2.0", "id": request_id, "result": result})

        except HTTPException as exc:
            return self._jsonrpc_error(request_id, -32000, exc.detail, status=exc.status_code)
        except Exception as exc:
            LOGGER.exception("Unhandled MCP error")
            return self._jsonrpc_error(request_id, -32603, f"Internal error: {exc}")

    async def _handle_mcp_get(self, request: Request):
        """Handle MCP GET requests (SSE stream)."""
        session_id = request.headers.get("Mcp-Session-Id") or request.query_params.get("sessionId")
        session = await self.sessions.get(session_id)
        if not session:
            return JSONResponse(
                content={"jsonrpc": "2.0", "error": {"code": -32000, "message": "Session ID required"}, "id": None},
                status_code=400
            )

        async def event_generator():
            # Send connected event
            yield f"event: connected\ndata: {json.dumps({'session': session.id, 'timestamp': time.time()})}\n\n"
            # Send heartbeat
            yield f"event: heartbeat\ndata: {json.dumps({'timestamp': time.time()})}\n\n"

            try:
                while True:
                    try:
                        message = await asyncio.wait_for(session.queue.get(), timeout=1)
                        event_type = message.get("event", "message")
                        yield f"event: {event_type}\ndata: {json.dumps(message)}\n\n"
                    except asyncio.TimeoutError:
                        yield f"event: heartbeat\ndata: {json.dumps({'timestamp': time.time()})}\n\n"
            except asyncio.CancelledError:
                pass

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            }
        )

    async def _handle_initialize(self, payload: Dict[str, Any], request: Request) -> Tuple[Dict[str, Any], Optional[Session]]:
        """Handle MCP initialize request."""
        params = payload.get("params") or {}
        requested_version = (
            params.get("protocolVersion")
            or request.headers.get("MCP-Protocol-Version")
            or DEFAULT_PROTOCOL_VERSION
        )
        if requested_version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise HTTPException(status_code=400, detail="Unsupported protocol version")

        session = await self.sessions.create_session(
            requested_version, params.get("clientInfo", {})
        )

        base_url = _external_base_url(request)
        # Update OAuth issuer based on request URL (same logic as .well-known endpoints)
        issuer = os.getenv("OAUTH_ISSUER") or base_url
        self.oauth.issuer = issuer

        result = {
            "protocolVersion": requested_version,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
                "prompts": {"listChanged": False},
            },
            "serverInfo": {"name": "adhd-budget-mcp", "version": "2.0.0"},
            "protectedResourceMetadata": {
                "resource": base_url,  # Must match /.well-known/oauth-protected-resource
                "authorization_servers": [issuer],
            },
        }
        return result, session

    async def _handle_tools_list(self, params: Dict[str, Any], request: Request, session: Session) -> Dict[str, Any]:
        """Handle tools/list request."""
        tools = []
        for name, definition in self.tool_definitions.items():
            tools.append({
                "name": name,
                "description": definition.description,
                "input_schema": definition.input_schema,
                "inputSchema": definition.input_schema,  # MCP spec uses camelCase
            })
        return {"tools": tools}

    async def _handle_tools_call(self, params: Dict[str, Any], request: Request, session: Session) -> Dict[str, Any]:
        """Handle tools/call request."""
        if not isinstance(params, dict):
            raise HTTPException(status_code=400, detail="Invalid params: expected object")

        name = params.get("name")
        arguments = params.get("arguments") or {}

        if name not in self.tool_definitions:
            raise HTTPException(status_code=400, detail=f"Unknown tool: {name}")

        definition = self.tool_definitions[name]

        # Check if protected tool requires auth
        token_info = None
        if definition.protected:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header.split(" ", 1)[1]
                token_info = self.oauth.validate_bearer(token)
            else:
                raise HTTPException(status_code=401, detail="Authorization required")

        # Execute tool
        if name == "echo":
            return await self._tool_echo(arguments, session, request, token_info)
        elif name == "search":
            return await self._tool_search(arguments, session, request, token_info)
        elif name == "fetch":
            return await self._tool_fetch(arguments, session, request, token_info)
        elif name == "summary.today":
            return await self._tool_summary_today(arguments, session, request, token_info)
        elif name == "projection.month":
            return await self._tool_projection_month(arguments, session, request, token_info)
        elif name == "transactions.query":
            return await self._tool_transactions_query(arguments, session, request, token_info)
        elif name == "accounts.list":
            return await self._tool_accounts_list(arguments, session, request, token_info)
        else:
            raise HTTPException(status_code=400, detail=f"Tool not implemented: {name}")

    def _jsonrpc_error(self, request_id: Any, code: int, message: str, *, status: int = 200) -> JSONResponse:
        """Create a JSON-RPC error response."""
        return JSONResponse(
            content={"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}},
            status_code=status
        )

    def _get_enable_banking_tokens(self, token_info: Optional[Dict[str, Any]]) -> EnableBankingTokens:
        """Get Enable Banking tokens from OAuth token info."""
        if not token_info:
            raise HTTPException(status_code=401, detail="Enable Banking authorization required")
        extra = token_info.get("extra") or {}
        payload = extra.get("enable_banking_tokens")
        if not payload:
            raise HTTPException(status_code=401, detail="No Enable Banking consent found")
        return EnableBankingTokens.from_dict(payload)

    def _update_enable_banking_tokens(self, token_info: Optional[Dict[str, Any]], tokens: EnableBankingTokens, access_token: str) -> None:
        """Update Enable Banking tokens in OAuth token info."""
        if not token_info:
            return
        extra = dict(token_info.get("extra") or {})
        extra["enable_banking_tokens"] = tokens.to_dict()
        self.oauth.update_token_extra(access_token, extra)
        token_info["extra"] = extra

    async def _collect_transactions(
        self,
        session: Session,
        request: Request,
        token_info: Optional[Dict[str, Any]],
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: Optional[int] = None,
        account_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Collect transactions from Enable Banking."""
        allow_mock = os.getenv("ENABLE_MOCK_FALLBACK", "true").lower() in ("1", "true", "yes")

        # Try to get real data if configured
        if self.enable_banking and self.enable_banking.is_configured:
            try:
                tokens = self._get_enable_banking_tokens(token_info)
                account_ids = [account_id] if account_id else None
                transactions, tokens = await self.enable_banking.fetch_transactions(
                    tokens,
                    account_ids=account_ids,
                    date_from=since,
                    date_to=until,
                    limit=limit,
                )
                auth_header = request.headers.get("Authorization", "")
                if auth_header.startswith("Bearer "):
                    self._update_enable_banking_tokens(token_info, tokens, auth_header.split(" ", 1)[1])
                return transactions
            except Exception as exc:
                LOGGER.warning("Enable Banking fetch failed, falling back to mock: %s", exc)
                if not allow_mock:
                    raise

        # Return mock data with filters applied
        return self._get_mock_transactions(since=since, until=until, limit=limit)

    def _get_mock_transactions(
        self,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Get mock transaction data for testing with filtering support."""
        now = datetime.now(timezone.utc)
        transactions = []

        for i in range(30):
            date = (now - timedelta(days=i)).strftime("%Y-%m-%d")

            # Apply date filters
            if since and date < since:
                continue
            if until and date > until:
                continue

            transactions.extend([
                {
                    "transactionId": f"mock_{date}_001",
                    "bookingDate": date,
                    "valueDate": date,
                    "transactionAmount": {"amount": "12.50", "currency": "GBP"},
                    "creditorName": "Transport for London",
                    "remittanceInformationUnstructured": "Daily commute",
                    "creditDebitIndicator": "DBIT",
                },
                {
                    "transactionId": f"mock_{date}_002",
                    "bookingDate": date,
                    "valueDate": date,
                    "transactionAmount": {"amount": "8.99", "currency": "GBP"},
                    "creditorName": "Pret a Manger",
                    "remittanceInformationUnstructured": "Lunch",
                    "creditDebitIndicator": "DBIT",
                },
            ])

            # Apply limit
            if limit and len(transactions) >= limit:
                return transactions[:limit]

        return transactions

    @staticmethod
    def _normalise_transaction(record: Dict[str, Any]) -> Dict[str, Any]:
        """Normalise a transaction record."""
        amount_info = record.get("transactionAmount") or {}
        raw_amount = amount_info.get("amount")
        try:
            amount = float(raw_amount) if raw_amount is not None else 0.0
        except (TypeError, ValueError):
            amount = 0.0
        indicator = (record.get("creditDebitIndicator") or "").upper()
        if indicator == "DBIT" and amount > 0:
            signed_amount = -abs(amount)
        elif indicator == "CRDT" and amount < 0:
            signed_amount = abs(amount)
        else:
            signed_amount = amount
        merchant = record.get("creditorName") or record.get("debtorName") or "Unknown"
        description = record.get("remittanceInformationUnstructured") or record.get("remittanceInformationStructured")
        reference = record.get("endToEndId") or record.get("transactionId")
        return {
            "id": record.get("transactionId") or record.get("internalId"),
            "date": record.get("bookingDate") or record.get("valueDate"),
            "valueDate": record.get("valueDate"),
            "amount": signed_amount,
            "currency": amount_info.get("currency"),
            "merchant": merchant,
            "description": description,
            "reference": reference,
            "raw": record,
        }

    @staticmethod
    def _categorise_transaction(merchant: str) -> str:
        """Categorise a transaction by merchant."""
        if not merchant:
            return "other"
        value = merchant.lower()
        if any(keyword in value for keyword in ("tesco", "aldi", "lidl", "asda", "market", "grocery")):
            return "groceries"
        if any(keyword in value for keyword in ("uber", "bolt", "tfl", "transport", "train", "bus")):
            return "transport"
        if any(keyword in value for keyword in ("coffee", "cafe", "restaurant", "pizza", "bar")):
            return "eating_out"
        return "other"

    # Tool implementations
    async def _tool_echo(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        message = arguments.get("message", "")
        return {"content": [{"type": "text", "text": str(message)}]}

    async def _tool_search(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        query = (arguments.get("query") or "").lower()
        limit = int(arguments.get("limit", 25))
        transactions = await self._collect_transactions(session, request, token_info, limit=200)
        matches = []
        for record in transactions:
            normalised = self._normalise_transaction(record)
            haystack = " ".join(filter(None, [
                normalised.get("merchant"),
                normalised.get("description"),
                normalised.get("reference"),
            ])).lower()
            if not query or query in haystack:
                matches.append(normalised)
            if len(matches) >= limit:
                break
        return {"results": matches, "query": query}

    async def _tool_fetch(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        resource_id = arguments.get("id")
        if not resource_id:
            raise HTTPException(status_code=400, detail="Missing id argument")
        transactions = await self._collect_transactions(session, request, token_info, limit=500)
        for record in transactions:
            normalised = self._normalise_transaction(record)
            if str(normalised.get("id")) == str(resource_id):
                return {"resource": normalised}
        raise HTTPException(status_code=404, detail="Transaction not found")

    async def _tool_summary_today(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        today = datetime.now(timezone.utc).date().isoformat()
        transactions = await self._collect_transactions(session, request, token_info, since=today, until=today)
        normalised = [self._normalise_transaction(record) for record in transactions]
        categories: Dict[str, float] = defaultdict(float)
        total_spent = 0.0
        expense_count = 0
        for txn in normalised:
            indicator = (txn["raw"].get("creditDebitIndicator") or "").upper()
            if indicator == "CRDT":
                continue
            amount = abs(txn.get("amount") or 0.0)
            if amount == 0:
                continue
            total_spent += amount
            expense_count += 1
            categories[self._categorise_transaction(txn.get("merchant", ""))] += amount
        budget = float(arguments.get("budget", 120.0))
        variance = total_spent - budget
        return {
            "summary": {
                "date": today,
                "transactions": expense_count,
                "total_spent": round(total_spent, 2),
                "categories": {k: round(v, 2) for k, v in categories.items()},
                "daily_budget": budget,
                "variance": round(variance, 2),
                "status": "over" if variance > 0 else "under",
            }
        }

    async def _tool_projection_month(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        month = now.strftime("%Y-%m")
        month_start = now.replace(day=1).date().isoformat()
        transactions = await self._collect_transactions(session, request, token_info, since=month_start)
        normalised = [self._normalise_transaction(record) for record in transactions]
        monthly_spend = 0.0
        for txn in normalised:
            indicator = (txn["raw"].get("creditDebitIndicator") or "").upper()
            if indicator == "CRDT":
                continue
            monthly_spend += abs(txn.get("amount") or 0.0)
        days_in_month = calendar.monthrange(now.year, now.month)[1]
        days_elapsed = max(1, now.day)
        projected = (monthly_spend / days_elapsed) * days_in_month
        budget = float(arguments.get("budget", 3500.0))
        variance = projected - budget
        return {
            "projection": {
                "month": month,
                "current_spend": round(monthly_spend, 2),
                "projected_spend": round(projected, 2),
                "budget": budget,
                "variance": round(variance, 2),
                "pace": "over" if variance > 0 else "under",
                "days_remaining": days_in_month - days_elapsed,
            }
        }

    async def _tool_transactions_query(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        since = arguments.get("since")
        until = arguments.get("until")
        limit = int(arguments.get("limit", 50))
        account_id = arguments.get("account_id")
        transactions = await self._collect_transactions(
            session, request, token_info,
            since=since, until=until, limit=limit, account_id=account_id
        )
        normalised = [self._normalise_transaction(record) for record in transactions]
        return {
            "transactions": normalised,
            "count": len(normalised),
            "since": since,
            "until": until,
            "limit": limit,
            "account_id": account_id,
        }

    async def _tool_accounts_list(self, arguments: Dict[str, Any], session: Session, request: Request, token_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        allow_mock = os.getenv("ENABLE_MOCK_FALLBACK", "true").lower() in ("1", "true", "yes")

        if self.enable_banking and self.enable_banking.is_configured:
            try:
                tokens = self._get_enable_banking_tokens(token_info)
                accounts, tokens = await self.enable_banking.fetch_accounts(tokens)
                auth_header = request.headers.get("Authorization", "")
                if auth_header.startswith("Bearer "):
                    self._update_enable_banking_tokens(token_info, tokens, auth_header.split(" ", 1)[1])
                return {"accounts": accounts}
            except Exception as exc:
                LOGGER.warning("Enable Banking accounts fetch failed, falling back to mock: %s", exc)
                if not allow_mock:
                    raise

        # Return mock accounts
        return {
            "accounts": [
                {
                    "resourceId": "mock-account-001",
                    "iban": "GB33BUKB20201555555555",
                    "currency": "GBP",
                    "name": "Current Account",
                    "product": "Current",
                    "cashAccountType": "CACC",
                }
            ]
        }


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    # Configure logging
    log_dir = os.getenv("LOG_DIR", "/var/log/mcp")
    log_file = os.path.join(log_dir, "mcp-server.log")

    handlers = [logging.StreamHandler()]
    try:
        os.makedirs(log_dir, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, mode='a'))
        LOGGER.info("File logging enabled: %s", log_file)
    except Exception as e:
        LOGGER.warning("File logging disabled: %s", e)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=handlers
    )

    server = MCPFastAPIServer()
    return server.app


# Create the app instance
app = create_app()


def main() -> None:
    """Run the server."""
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("MCP_PORT", "8081"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
