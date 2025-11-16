"""Remote MCP server implementation compliant with the 2025-06-18 specification.

The server exposes a single ``/mcp`` endpoint that accepts ``POST`` requests for
client → server JSON-RPC messages and ``GET`` requests to establish an
SSE (Server Sent Events) stream used for optional server → client messaging.

Key features implemented here:

* Protocol negotiation supporting ``2025-06-18`` (primary) and ``2025-03-26``
  (backwards compatibility) via the ``MCP-Protocol-Version`` header.
* Session management with secure UUID v4 identifiers returned in the
  ``Mcp-Session-Id`` response header on successful ``initialize`` calls.
* Strict JSON-RPC 2.0 handling for requests, notifications and error
  responses.
* Origin validation and CORS headers for Claude and local development
  tooling to mitigate DNS rebinding and similar attacks.
* Basic OAuth 2.1 provider implementation supporting
  Dynamic Client Registration, authorization code and refresh token grants,
  RFC 8707 resource indicators and token revocation. Tokens are tracked
  in-memory for demonstrative purposes.
* A small library of financial tools illustrating gated (OAuth-protected)
  and public tool access patterns. Long running tools emit progress updates
  through the SSE stream to showcase server push.

This module is intentionally self-contained to simplify deployment in
environments where only the Python standard library and ``aiohttp`` are
available. For production use the OAuth storage should be backed by a
durable database.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import calendar
import json
import logging
import os
import secrets
import textwrap
import time
from collections import defaultdict
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Optional
from urllib.parse import urlencode
from uuid import uuid4

from aiohttp import web

from .enable_banking_service import EnableBankingService, EnableBankingTokens

LOGGER = logging.getLogger("adhd_budget.mcp")


SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26")
DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

ALLOWED_ORIGINS = (
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
)

DEFAULT_REMOTE_REDIRECT_URIS = (
    "https://www.claude.ai/api/auth/callback",
    "https://claude.ai/api/auth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://www.claude.ai/api/mcp/auth_callback",
    "https://app.claude.ai/api/auth/callback",
    "https://lite.claude.ai/api/auth/callback",
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

DEFAULT_OAUTH_ISSUER = "https://auth.local.adhd-budget"


def _external_base_url(request: web.Request) -> str:
    """Return the externally visible base URL accounting for reverse proxies."""

    proto = request.headers.get("X-Forwarded-Proto", request.scheme)

    # Cloudflare support: check CF-Visitor header
    cf_visitor = request.headers.get("CF-Visitor")
    if cf_visitor and '"scheme":"https"' in cf_visitor:
        proto = "https"

    # Force HTTPS for known production domains
    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host") or request.host
    if "adhdbudget.bieda.it" in host:
        proto = "https"

    return f"{proto}://{host}"


def _is_allowed_remote_redirect(uri: Optional[str]) -> bool:
    if not uri:
        return False
    return any(uri.startswith(prefix) for prefix in REMOTE_REDIRECT_PREFIXES)


def _json_dumps(payload: Dict[str, Any]) -> bytes:
    """Serialize a JSON payload using compact separators."""

    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _apply_basic_auth_credentials(
    payload: Dict[str, Any], headers: Dict[str, str]
) -> Dict[str, Any]:
    """Merge client credentials provided via HTTP Basic auth into the payload."""

    authorization = headers.get("Authorization")
    if not authorization or not authorization.startswith("Basic "):
        return payload

    encoded = authorization.split(" ", 1)[1].strip()
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        raise web.HTTPUnauthorized(text="Invalid client authentication")

    if ":" not in decoded:
        raise web.HTTPUnauthorized(text="Invalid client authentication")

    basic_client_id, basic_client_secret = decoded.split(":", 1)
    if payload.get("client_id") and payload["client_id"] != basic_client_id:
        raise web.HTTPUnauthorized(text="Client mismatch")

    if "client_id" not in payload:
        payload["client_id"] = basic_client_id
    if not payload.get("client_secret"):
        payload["client_secret"] = basic_client_secret

    return payload


@dataclass
class Session:
    """Represents an MCP session associated with a connected client."""

    id: str
    protocol_version: str
    client_info: Dict[str, Any]
    created_at: float = field(default_factory=lambda: time.time())
    queue: "asyncio.Queue[Dict[str, Any]]" = field(default_factory=asyncio.Queue)
    last_seen: float = field(default_factory=lambda: time.time())
    metadata: Dict[str, Any] = field(default_factory=dict)

    def heartbeat(self) -> None:
        """Update last seen timestamp."""

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
        if not session:
            raise KeyError(f"Unknown session {session_id}")
        await session.queue.put(payload)

    async def cleanup(self, ttl_seconds: int = 3600) -> None:
        """Remove stale sessions."""

        cutoff = time.time() - ttl_seconds
        async with self._lock:
            for session_id in list(self._sessions.keys()):
                if self._sessions[session_id].last_seen < cutoff:
                    LOGGER.info("Removing expired MCP session %s", session_id)
                    self._sessions.pop(session_id, None)


@dataclass
class ToolDefinition:
    """Metadata describing an MCP tool."""

    handler: Callable[[Dict[str, Any], Optional[Session], web.Request], Awaitable[Dict[str, Any]]]
    description: str
    input_schema: Dict[str, Any]
    protected: bool = True


class OAuthProvider:
    """In-memory OAuth 2.1 provider implementation."""

    def __init__(self) -> None:
        self.clients: Dict[str, Dict[str, Any]] = {}
        self.auth_codes: Dict[str, Dict[str, Any]] = {}
        self.access_tokens: Dict[str, Dict[str, Any]] = {}
        self.refresh_tokens: Dict[str, Dict[str, Any]] = {}
        self.issuer = os.getenv("OAUTH_ISSUER", DEFAULT_OAUTH_ISSUER)

    def register_client(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        redirect_uris = payload.get("redirect_uris") or payload.get("redirect_uri")
        if isinstance(redirect_uris, str):
            redirect_uris = [redirect_uris]
        if not redirect_uris:
            raise web.HTTPBadRequest(text="Missing redirect_uris")

        unique_redirects: list[str] = []
        for uri in redirect_uris:
            if not uri or (
                os.getenv("ENABLE_ENV", "sandbox") == "production"
                and not _is_allowed_remote_redirect(uri)
                and not uri.startswith((
                    "http://localhost",
                    "https://localhost",
                    "http://127.0.0.1",
                    "https://127.0.0.1",
                ))
            ):
                raise web.HTTPBadRequest(text="Invalid redirect_uris entry")
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
        self,
        client_id: str,
        client_secret: Optional[str],
        *,
        require_secret: bool = False,
    ) -> Dict[str, Any]:
        client = self.clients.get(client_id)
        if not client:
            raise web.HTTPUnauthorized(text="Unknown client")
        token_auth_method = client.get("token_endpoint_auth_method")
        expects_secret = token_auth_method is None or token_auth_method != "none"
        if require_secret and expects_secret and not client_secret:
            raise web.HTTPUnauthorized(text="Invalid client secret")
        if client_secret and client_secret != client["client_secret"]:
            raise web.HTTPUnauthorized(text="Invalid client secret")
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
    ) -> str:
        client = self._validate_client(client_id, None)
        if redirect_uri not in client["redirect_uris"]:
            if _is_allowed_remote_redirect(redirect_uri):
                client["redirect_uris"].append(redirect_uri)
            elif os.getenv("ENABLE_ENV", "sandbox") != "production":
                client["redirect_uris"].append(redirect_uri)
            else:
                raise web.HTTPBadRequest(text="Invalid redirect_uri")

        code = secrets.token_urlsafe(32)
        self.auth_codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
            "resource": resource,
            "expires_at": time.time() + 300,
            "extra": extra or {},
        }
        return code

    def _validate_resource(self, requested: Optional[str], stored: Optional[str]) -> None:
        if requested and stored and requested != stored:
            raise web.HTTPBadRequest(text="Resource indicator mismatch")

    def exchange_token(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        grant_type = payload.get("grant_type")
        if not grant_type:
            raise web.HTTPBadRequest(text="Missing grant_type")

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
            client = self._validate_client(
                client_id,
                client_secret,
                require_secret=True,
            )
        elif os.getenv("ENABLE_ENV", "sandbox") != "production":
            client_id = client_id or os.getenv("ENABLE_APP_ID", "enable-sandbox")
            redirect_candidates: list[str] = []
            payload_redirects = payload.get("redirect_uris")
            if isinstance(payload_redirects, str):
                payload_redirects = [payload_redirects]
            if payload_redirects:
                redirect_candidates.extend(payload_redirects)
            if payload.get("redirect_uri"):
                redirect_candidates.append(payload["redirect_uri"])
            redirect_candidates.extend(DEFAULT_REMOTE_REDIRECT_URIS)
            unique_redirects = list(dict.fromkeys(uri for uri in redirect_candidates if uri))

            client = self.clients.setdefault(
                client_id,
                {
                    "client_id": client_id,
                    "client_secret": client_secret or secrets.token_urlsafe(32),
                    "redirect_uris": unique_redirects,
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "scope": payload.get("scope", "transactions accounts"),
                    "token_endpoint_auth_method": "none" if not client_secret else "client_secret_post",
                    "client_id_issued_at": int(time.time()),
                },
            )
        else:
            raise web.HTTPUnauthorized(text="Unknown client")

        if grant_type == "authorization_code":
            if code_info:
                stored = self.auth_codes.pop(code, None)
                if not stored:
                    raise web.HTTPBadRequest(text="Invalid authorization code")
                if stored["client_id"] != client_id:
                    raise web.HTTPBadRequest(text="Client mismatch")
                if time.time() > stored["expires_at"]:
                    raise web.HTTPBadRequest(text="Authorization code expired")
                redirect_uri = payload.get("redirect_uri")
                if redirect_uri and redirect_uri != stored["redirect_uri"]:
                    raise web.HTTPBadRequest(text="Redirect URI mismatch")

                resource = payload.get("resource") or stored.get("resource")
                self._validate_resource(resource, stored.get("resource"))
                scope = stored["scope"]
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
                    raise web.HTTPBadRequest(text="Client mismatch")
                if token_info["expires_at"] <= time.time():
                    raise web.HTTPBadRequest(text="Refresh token expired")

                resource = payload.get("resource") or token_info.get("resource")
                self._validate_resource(resource, token_info.get("resource"))
                scope = token_info["scope"]
                extra = token_info.get("extra")
            else:
                scope = payload.get("scope") or client.get("scope", "transactions accounts")
                resource = payload.get("resource")

            return self._issue_tokens(client_id, scope, resource, extra=extra)

        raise web.HTTPBadRequest(text="Unsupported grant_type")

    def revoke(self, payload: Dict[str, Any]) -> None:
        token = payload.get("token")
        if not token:
            raise web.HTTPBadRequest(text="Missing token")
        self.access_tokens.pop(token, None)
        self.refresh_tokens.pop(token, None)

    def validate_bearer(self, token: Optional[str]) -> Dict[str, Any]:
        if not token:
            raise web.HTTPUnauthorized(text="Missing bearer token")
        token_info = self.access_tokens.get(token)
        if token_info:
            if token_info["expires_at"] <= time.time():
                self.access_tokens.pop(token, None)
                raise web.HTTPUnauthorized(text="Bearer token expired")
            return token_info

        if token.startswith("eb_session_") and os.getenv("ENABLE_ENV", "sandbox") != "production":
            # Developer sandbox token issued by upstream provider
            return {
                "client_id": "enable-sandbox",
                "scope": "transactions accounts",
                "resource": None,
                "issued_at": time.time(),
                "expires_at": time.time() + 3600,
            }

        raise web.HTTPUnauthorized(text="Invalid bearer token")

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


def apply_cors_headers(response: web.StreamResponse, origin: Optional[str]) -> None:
    if origin and any(origin.startswith(allowed) for allowed in ALLOWED_ORIGINS):
        response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version"
    )
    response.headers["Access-Control-Expose-Headers"] = "Mcp-Session-Id"


@web.middleware
async def cors_and_origin_middleware(
    request: web.Request,
    handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
) -> web.StreamResponse:
    origin = request.headers.get("Origin")

    if request.method == "OPTIONS":
        response = web.Response(status=200)
        apply_cors_headers(response, origin)
        return response

    if origin and not any(origin.startswith(allowed) for allowed in ALLOWED_ORIGINS):
        return web.json_response({"error": "Invalid origin"}, status=403)

    response = await handler(request)
    if not response.prepared:
        apply_cors_headers(response, origin)
    return response


class MCPApplication:
    """Encapsulates the aiohttp application and MCP handlers."""

    def __init__(self) -> None:
        self.sessions = SessionManager()
        self.oauth = OAuthProvider()
        self.enable_banking = EnableBankingService.from_environment()
        self.pending_enable_banking: Dict[str, Dict[str, Any]] = {}
        self.app = web.Application(middlewares=[cors_and_origin_middleware])
        self.app.router.add_route("GET", "/mcp", self.handle_get)
        # Backwards compatibility with earlier test harnesses that used
        # dedicated streaming endpoints.
        self.app.router.add_route("GET", "/mcp/stream", self.handle_get)
        self.app.router.add_route("GET", "/mcp/sse", self.handle_get)
        self.app.router.add_route("POST", "/mcp", self.handle_post)
        self.app.router.add_route("OPTIONS", "/mcp", self.handle_options)
        self.app.router.add_get("/health", self.handle_health)
        self.app.router.add_get("/.well-known/mcp.json", self.mcp_manifest)
        self._register_oauth_routes()

        self.tool_definitions: Dict[str, ToolDefinition] = {
            "echo": ToolDefinition(
                handler=self.tool_echo,
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
                handler=self.tool_search,
                description="Search recent transactions across all connected accounts.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search term matched against merchant, description or reference."},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum number of matches to return."},
                    },
                    "additionalProperties": False,
                },
            ),
            "fetch": ToolDefinition(
                handler=self.tool_fetch,
                description="Fetch a single transaction by its identifier.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Transaction identifier (transactionId)."},
                    },
                    "required": ["id"],
                    "additionalProperties": False,
                },
            ),
            "summary.today": ToolDefinition(
                handler=self.tool_summary_today,
                description="Summarise today's spending across connected Enable Banking accounts.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "currency": {"type": "string", "description": "Preferred ISO currency code for totals."},
                    },
                    "additionalProperties": False,
                },
            ),
            "projection.month": ToolDefinition(
                handler=self.tool_projection_month,
                description="Project end-of-month spend based on current month-to-date activity.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "budget": {"type": "number", "description": "Monthly budget used for variance calculations."},
                    },
                    "additionalProperties": False,
                },
            ),
            "transactions.query": ToolDefinition(
                handler=self.tool_transactions_query,
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
            ),
        }

        self.tools = {name: definition.handler for name, definition in self.tool_definitions.items()}
        self.protected_tools = {
            name
            for name, definition in self.tool_definitions.items()
            if definition.protected
        }

    def _register_oauth_routes(self) -> None:
        self.app.router.add_get("/.well-known/oauth-authorization-server", self.oauth_metadata)
        self.app.router.add_get("/.well-known/oauth-protected-resource", self.oauth_protected_resource)
        self.app.router.add_post("/oauth/register", self.oauth_register)
        self.app.router.add_get("/oauth/authorize", self.oauth_authorize)
        self.app.router.add_get("/oauth/enable-banking/callback", self.oauth_enable_banking_callback)
        self.app.router.add_post("/oauth/token", self.oauth_token)
        self.app.router.add_post("/oauth/revoke", self.oauth_revoke)

    async def mcp_manifest(self, request: web.Request) -> web.Response:
        base_url = _external_base_url(request)
        manifest = {
            "name": "adhd-budget-mcp",
            "version": "1.0.0",
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
                "scopes": ["transactions", "accounts", "summary"],
                "resource": f"{base_url}/mcp",
            },
        }
        return web.json_response(manifest)

    async def handle_options(self, request: web.Request) -> web.Response:
        return web.Response(status=200)

    async def handle_get(self, request: web.Request) -> web.StreamResponse:
        session_id = request.headers.get("Mcp-Session-Id") or request.query.get("sessionId")
        session = await self.sessions.get(session_id)
        if not session:
            return web.json_response(
                {
                    "jsonrpc": "2.0",
                    "error": {"code": -32000, "message": "Session ID required"},
                    "id": None,
                },
                status=400,
            )

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
        apply_cors_headers(response, request.headers.get("Origin"))
        await response.prepare(request)

        await self._write_sse_event(
            response,
            "connected",
            {"session": session.id, "timestamp": time.time()},
        )
        await self._write_sse_event(
            response,
            "heartbeat",
            {"timestamp": time.time()},
        )

        try:
            while True:
                try:
                    message = await asyncio.wait_for(session.queue.get(), timeout=1)
                except asyncio.TimeoutError:
                    await self._write_sse_event(response, "heartbeat", {"timestamp": time.time()})
                    continue

                await self._write_sse_event(response, message.get("event", "message"), message)
        except asyncio.CancelledError:
            raise
        except ConnectionResetError:
            LOGGER.info("SSE connection closed for session %s", session.id)
        finally:
            with suppress(ConnectionResetError, RuntimeError):
                await response.write_eof()

        return response

    async def _write_sse_event(self, response: web.StreamResponse, event: str, data: Dict[str, Any]) -> None:
        payload = _json_dumps(data)
        await response.write(f"event: {event}\n".encode("utf-8"))
        await response.write(b"data: " + payload + b"\n\n")

    async def handle_post(self, request: web.Request) -> web.StreamResponse:
        self._validate_headers(request)

        try:
            payload = await request.json()
        except json.JSONDecodeError as exc:  # pragma: no cover - aiohttp already validates
            raise web.HTTPBadRequest(text=f"Invalid JSON payload: {exc}") from exc

        if payload.get("jsonrpc") != "2.0":
            return self._jsonrpc_error(None, -32600, "Invalid Request: jsonrpc must be 2.0")

        method = payload.get("method")
        if not method:
            return self._jsonrpc_error(payload.get("id"), -32600, "Invalid Request: method required")

        request_id = payload.get("id")

        if request_id is None:
            await self._handle_notification(method, payload.get("params", {}), request)
            return web.Response(status=202)

        if method == "initialize":
            result, session = await self._handle_initialize(payload, request)
            response = web.json_response({"jsonrpc": "2.0", "id": request_id, "result": result})
            if session:
                response.headers["Mcp-Session-Id"] = session.id
            return response

        session_id = request.headers.get("Mcp-Session-Id")
        session = await self.sessions.get(session_id)
        if not session:
            if method == "tools/list":
                session = Session(
                    id="legacy-tools-list",
                    protocol_version=request.headers.get("MCP-Protocol-Version")
                    or DEFAULT_PROTOCOL_VERSION,
                    client_info={"name": "legacy-client", "version": "unknown"},
                )
            elif method == "tools/call" and not request.headers.get("Authorization"):
                return self._jsonrpc_error(
                    request_id, -32001, "Authorization required", status=401
                )
            else:
                return self._jsonrpc_error(request_id, -32000, "Session ID required", status=400)

        handler = getattr(self, f"rpc_{method.replace('/', '_')}", None)
        if handler is None:
            return self._jsonrpc_error(request_id, -32601, f"Method not found: {method}")

        try:
            result = await handler(payload.get("params", {}), request, session)
        except web.HTTPException as exc:
            return self._jsonrpc_error(request_id, -32000, exc.text, status=exc.status)
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("Unhandled MCP error")
            return self._jsonrpc_error(request_id, -32603, f"Internal error: {exc}")

        return web.json_response({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _validate_headers(self, request: web.Request) -> None:
        content_type = request.headers.get("Content-Type", "").split(";")[0].strip()
        if request.method == "POST" and content_type != "application/json":
            raise web.HTTPUnsupportedMediaType(text="Content-Type must be application/json")

        protocol_version = request.headers.get("MCP-Protocol-Version")
        if protocol_version and protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise web.HTTPBadRequest(text="Unsupported protocol version")

        accept = request.headers.get("Accept", "application/json")
        if "application/json" not in accept and "*/*" not in accept:
            raise web.HTTPNotAcceptable(text="Accept header must allow application/json")

    async def _handle_initialize(self, payload: Dict[str, Any], request: web.Request) -> tuple[Dict[str, Any], Optional[Session]]:
        params = payload.get("params") or {}
        requested_version = (
            params.get("protocolVersion")
            or request.headers.get("MCP-Protocol-Version")
            or DEFAULT_PROTOCOL_VERSION
        )
        if requested_version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise web.HTTPBadRequest(text="Unsupported protocol version")

        session = await self.sessions.create_session(
            requested_version, params.get("clientInfo", {})
        )

        resource_url = f"{request.scheme}://{request.host}/mcp"
        result = {
            "protocolVersion": requested_version,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
                "prompts": {"listChanged": False},
            },
            "serverInfo": {"name": "adhd-budget-mcp", "version": "2.0.0"},
            "protectedResourceMetadata": {
                "resource": resource_url,
                "authorization_servers": [self.oauth.issuer],
            },
        }
        return result, session

    async def handle_health(self, request: web.Request) -> web.Response:
        """Basic health check used by docker-compose."""

        return web.json_response({"status": "ok"})

    async def _handle_notification(self, method: str, params: Dict[str, Any], request: web.Request) -> None:
        LOGGER.info("Notification received: method=%s params=%s", method, params)

    def _jsonrpc_error(self, request_id: Any, code: int, message: str, *, status: int = 200) -> web.Response:
        payload = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
        return web.json_response(payload, status=status)

    async def rpc_ping(self, params: Dict[str, Any], request: web.Request, session: Session) -> Dict[str, Any]:
        """Ping method for keep-alive checks."""
        return {}

    async def rpc_tools_list(self, params: Dict[str, Any], request: web.Request, session: Session) -> Dict[str, Any]:
        tools = []
        for name, definition in self.tool_definitions.items():
            tools.append(
                {
                    "name": name,
                    "description": definition.description,
                    "inputSchema": definition.input_schema,
                }
            )
        return {"tools": tools}

    async def rpc_tools_call(self, params: Dict[str, Any], request: web.Request, session: Session) -> Dict[str, Any]:
        if not isinstance(params, dict):
            raise web.HTTPBadRequest(text="Invalid params: expected object")

        name = params.get("name")
        arguments = params.get("arguments") or {}

        if name not in self.tools:
            raise web.HTTPBadRequest(text=f"Unknown tool: {name}")

        token = None
        token_info: Optional[Dict[str, Any]] = None
        if name in self.protected_tools:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header.split(" ", 1)[1]
            token_info = self.oauth.validate_bearer(token)
            request["oauth_token_info"] = token_info
            request["oauth_access_token"] = token

        handler = self.tools[name]
        return await handler(arguments, session, request)

    def _ensure_enable_banking(self) -> EnableBankingService:
        if not self.enable_banking or not self.enable_banking.is_configured:
            raise web.HTTPServiceUnavailable(
                text=(
                    "Enable Banking credentials are not configured. Set ENABLE_APP_ID "
                    "and ENABLE_PRIVATE_KEY_PATH in the server environment."
                )
            )
        return self.enable_banking

    def _get_enable_banking_tokens(self, request: web.Request) -> EnableBankingTokens:
        token_info = request.get("oauth_token_info")
        if not token_info:
            raise web.HTTPUnauthorized(text="Enable Banking authorization required. Reconnect the MCP connector.")
        extra = token_info.get("extra") or {}
        payload = extra.get("enable_banking_tokens")
        if not payload:
            raise web.HTTPUnauthorized(text="No Enable Banking consent found. Re-run the OAuth connection flow.")
        return EnableBankingTokens.from_dict(payload)

    def _update_enable_banking_tokens(self, request: web.Request, tokens: EnableBankingTokens) -> None:
        token_info = request.get("oauth_token_info") or {}
        extra = dict(token_info.get("extra") or {})
        extra["enable_banking_tokens"] = tokens.to_dict()
        access_token = request.get("oauth_access_token")
        if access_token:
            self.oauth.update_token_extra(access_token, extra)
        if token_info is not None:
            token_info.setdefault("extra", {})
            token_info["extra"].update(extra)

    async def _collect_transactions(
        self,
        session: Session,
        request: web.Request,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: Optional[int] = None,
        account_id: Optional[str] = None,
    ) -> list[Dict[str, Any]]:
        service = self._ensure_enable_banking()
        tokens = self._get_enable_banking_tokens(request)
        account_ids = [account_id] if account_id else None
        transactions, tokens = await service.fetch_transactions(
            tokens,
            account_ids=account_ids,
            date_from=since,
            date_to=until,
            limit=limit,
        )
        self._update_enable_banking_tokens(request, tokens)
        return transactions

    @staticmethod
    def _normalise_transaction(record: Dict[str, Any]) -> Dict[str, Any]:
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

    async def tool_echo(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Echoes the provided message back to the caller."""

        message = arguments.get("message", "")
        return {"content": [{"type": "text", "text": str(message)}]}

    async def tool_search(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Search recent transactions by free text (requires OAuth token)."""

        if not session:
            raise web.HTTPBadRequest(text="Session required")
        query = (arguments.get("query") or "").lower()
        limit = int(arguments.get("limit", 25))
        transactions = await self._collect_transactions(session, request, limit=200)
        matches = []
        for record in transactions:
            normalised = self._normalise_transaction(record)
            haystack = " ".join(
                filter(
                    None,
                    [
                        normalised.get("merchant"),
                        normalised.get("description"),
                        normalised.get("reference"),
                    ],
                )
            ).lower()
            if not query or query in haystack:
                matches.append(normalised)
            if len(matches) >= limit:
                break

        await self.sessions.publish(
            session.id,
            {"type": "search", "query": query, "count": len(matches), "timestamp": time.time()},
        )

        return {"results": matches, "query": query}

    async def tool_fetch(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Fetch a transaction by id (requires OAuth token)."""

        resource_id = arguments.get("id")
        if not resource_id:
            raise web.HTTPBadRequest(text="Missing id argument")
        if not session:
            raise web.HTTPBadRequest(text="Session required")

        transactions = await self._collect_transactions(session, request, limit=500)
        for record in transactions:
            normalised = self._normalise_transaction(record)
            if str(normalised.get("id")) == str(resource_id):
                return {"resource": normalised}

        raise web.HTTPNotFound(text="Transaction not found")

    async def tool_summary_today(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Summarise today's spending using Enable Banking transactions."""

        if not session:
            raise web.HTTPBadRequest(text="Session required")
        today = datetime.now(timezone.utc).date().isoformat()
        transactions = await self._collect_transactions(session, request, since=today, until=today)
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

    async def tool_projection_month(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Return a projection for the current month based on live data."""

        if not session:
            raise web.HTTPBadRequest(text="Session required")
        now = datetime.now(timezone.utc)
        month = now.strftime("%Y-%m")
        month_start = now.replace(day=1).date().isoformat()
        transactions = await self._collect_transactions(session, request, since=month_start)
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

    async def tool_transactions_query(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Query recent transactions and stream progress updates (requires OAuth token)."""

        if not session:
            raise web.HTTPBadRequest(text="Session required")
        since = arguments.get("since")
        until = arguments.get("until")
        limit = int(arguments.get("limit", 50))
        account_id = arguments.get("account_id")

        await self.sessions.publish(
            session.id,
            {
                "event": "progress",
                "type": "progress",
                "message": "Fetching transactions",
                "timestamp": time.time(),
            },
        )

        transactions = await self._collect_transactions(
            session,
            request,
            since=since,
            until=until,
            limit=limit,
            account_id=account_id,
        )

        await self.sessions.publish(
            session.id,
            {
                "event": "progress",
                "type": "progress",
                "message": "Normalising results",
                "timestamp": time.time(),
            },
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

    async def oauth_metadata(self, request: web.Request) -> web.Response:
        base_url = _external_base_url(request)
        issuer = os.getenv("OAUTH_ISSUER") or base_url
        self.oauth.issuer = issuer

        metadata = {
            "issuer": issuer,
            "authorization_endpoint": f"{base_url}/oauth/authorize",
            "token_endpoint": f"{base_url}/oauth/token",
            "revocation_endpoint": f"{base_url}/oauth/revoke",
            "registration_endpoint": f"{base_url}/oauth/register",
            "scopes_supported": ["transactions", "accounts", "summary"],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["client_secret_post"],
            "code_challenge_methods_supported": ["S256"],
        }
        return web.json_response(metadata)

    async def oauth_protected_resource(self, request: web.Request) -> web.Response:
        base_url = _external_base_url(request)
        issuer = os.getenv("OAUTH_ISSUER") or base_url
        self.oauth.issuer = issuer

        metadata = {
            "resource": f"{base_url}/mcp",
            "authorization_server": issuer,
            "authorization_servers": [issuer],
        }
        payload = {"protectedResourceMetadata": metadata, **metadata}
        return web.json_response(payload)

    async def oauth_register(self, request: web.Request) -> web.Response:
        payload = await request.json()
        client = self.oauth.register_client(payload)
        response = web.json_response(client, status=201)
        return response

    async def oauth_authorize(self, request: web.Request) -> web.StreamResponse:
        params = request.rel_url.query
        client_id = params.get("client_id")
        redirect_uri = params.get("redirect_uri")
        scope = params.get("scope", "transactions accounts")
        state = params.get("state")
        resource = params.get("resource")
        aspsp_name = params.get("aspsp_name")
        aspsp_country = params.get("aspsp_country")
        psu_type = params.get("psu_type", "personal")

        if not client_id or not redirect_uri:
            raise web.HTTPBadRequest(text="Missing client_id or redirect_uri")

        client = self.oauth.clients.get(client_id)
        if not client:
            # Auto-register clients from allowed remote platforms (ChatGPT, Claude)
            if _is_allowed_remote_redirect(redirect_uri):
                LOGGER.info("Auto-registering remote client for redirect_uri: %s", redirect_uri)
                try:
                    client = self.oauth.register_client({
                        "redirect_uris": [redirect_uri],
                        "grant_types": ["authorization_code", "refresh_token"],
                        "response_types": ["code"],
                        "scope": scope,
                        "token_endpoint_auth_method": "none",  # Public client
                    })
                    # Override the generated client_id with the one from the request
                    self.oauth.clients.pop(client["client_id"], None)
                    client["client_id"] = client_id
                    self.oauth.clients[client_id] = client
                except Exception as exc:
                    LOGGER.error("Failed to auto-register client: %s", exc)
                    html = textwrap.dedent(
                        """
                        <!doctype html>
                        <html>
                            <head><title>Authorization Error</title></head>
                            <body>
                                <h1>Authorization Failed</h1>
                                <p>Could not register client. Please try again.</p>
                            </body>
                        </html>
                        """
                    ).strip()
                    return web.Response(text=html, content_type="text/html", status=400)
            else:
                html = textwrap.dedent(
                    """
                    <!doctype html>
                    <html>
                        <head><title>Enable Banking Setup</title></head>
                        <body>
                            <h1>Select Your Bank</h1>
                            <p>Register this client via /oauth/register before starting the OAuth flow.</p>
                        </body>
                    </html>
                    """
                ).strip()
                return web.Response(text=html, content_type="text/html")

        service = self._ensure_enable_banking()
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
        }

        try:
            payload = await service.initiate_auth(
                redirect_url=callback_uri,
                state=eb_state,
                aspsp_name=aspsp_name,
                aspsp_country=aspsp_country,
                psu_type=psu_type,
            )
        except RuntimeError as exc:
            LOGGER.error("Enable Banking auth initiation failed: %s", exc)
            raise web.HTTPServiceUnavailable(text="Enable Banking authorization failed. Try again later.") from exc

        auth_url = payload.get("url")
        if not auth_url:
            raise web.HTTPServiceUnavailable(text="Enable Banking did not return an authorization URL")

        html_body = textwrap.dedent(
            f"""
            <!doctype html>
            <html>
                <head><title>Enable Banking Consent</title></head>
                <body>
                    <h1>Continue to your bank</h1>
                    <p>We need to confirm access to your bank account via Enable Banking.</p>
                    <p><a href="{auth_url}">Click here to continue</a></p>
                </body>
            </html>
            """
        ).strip()
        headers = {"Location": auth_url, "Cache-Control": "no-store"}
        if "text/html" in request.headers.get("Accept", "text/html"):
            return web.Response(status=302, headers=headers, text=html_body, content_type="text/html")
        return web.Response(status=302, headers=headers)

    async def oauth_enable_banking_callback(self, request: web.Request) -> web.StreamResponse:
        params = request.rel_url.query
        error = params.get("error")
        error_description = params.get("error_description")
        state = params.get("state")
        code = params.get("code")
        if error:
            message = error_description or error
            html = textwrap.dedent(
                f"""
                <!doctype html>
                <html>
                    <head><title>Enable Banking Error</title></head>
                    <body>
                        <h1>Consent Failed</h1>
                        <p>{message}</p>
                    </body>
                </html>
                """
            ).strip()
            return web.Response(text=html, content_type="text/html", status=400)

        if not code or not state:
            raise web.HTTPBadRequest(text="Missing code or state from Enable Banking")

        context = self.pending_enable_banking.pop(state, None)
        if not context:
            raise web.HTTPBadRequest(text="Unknown or expired consent state")

        service = self._ensure_enable_banking()
        callback_uri = context.get("callback_uri") or f"{_external_base_url(request)}/oauth/enable-banking/callback"
        tokens, raw = await service.exchange_code(code, callback_uri)
        extra = {"enable_banking_tokens": tokens.to_dict(), "enable_banking_expires_in": raw.get("expires_in")}

        auth_code = self.oauth.issue_authorization_code(
            context["client_id"],
            context["redirect_uri"],
            context["scope"],
            context.get("state"),
            context.get("resource"),
            extra=extra,
        )
        query = {"code": auth_code}
        if context.get("state"):
            query["state"] = context["state"]
        location = f"{context['redirect_uri']}?{urlencode(query)}"

        html_body = textwrap.dedent(
            f"""
            <!doctype html>
            <html>
                <head><title>Authorization Complete</title></head>
                <body>
                    <h1>Consent Complete</h1>
                    <p>You can close this tab. If not redirected automatically, continue here:</p>
                    <p><a href="{location}">{location}</a></p>
                </body>
            </html>
            """
        ).strip()
        headers = {"Location": location, "Cache-Control": "no-store"}
        if "text/html" in request.headers.get("Accept", "text/html"):
            return web.Response(status=302, headers=headers, text=html_body, content_type="text/html")
        return web.Response(status=302, headers=headers)

    async def oauth_token(self, request: web.Request) -> web.Response:
        if request.content_type == "application/json":
            payload = await request.json()
        else:
            form = await request.post()
            payload = dict(form)
        payload = _apply_basic_auth_credentials(dict(payload), request.headers)
        tokens = self.oauth.exchange_token(payload)
        return web.json_response(tokens)

    async def oauth_revoke(self, request: web.Request) -> web.Response:
        if request.content_type == "application/json":
            payload = await request.json()
        else:
            form = await request.post()
            payload = dict(form)
        self.oauth.revoke(payload)
        return web.json_response({"status": "revoked"})


def create_app() -> web.Application:
    # Configure logging to both console and file
    log_dir = os.getenv("LOG_DIR", "/var/log/mcp")
    log_file = os.path.join(log_dir, "mcp-server.log")

    # Create log directory if it doesn't exist, fall back to console-only if permission denied
    handlers = [logging.StreamHandler()]  # Always log to console
    file_logging_status = None
    try:
        os.makedirs(log_dir, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, mode='a'))  # Add file logging if possible
        file_logging_status = f"SUCCESS: Logging to {log_file}"
    except PermissionError as e:
        file_logging_status = f"WARNING: File logging disabled - Permission denied for {log_dir}: {e}"
    except OSError as e:
        file_logging_status = f"WARNING: File logging disabled - OS error for {log_dir}: {e}"
    except Exception as e:
        file_logging_status = f"ERROR: File logging disabled - Unexpected error: {type(e).__name__}: {e}"

    # Configure logging handlers
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=handlers
    )

    # Log the file logging status (will appear in console and file if file logging succeeded)
    LOGGER.info(f"File logging configuration: {file_logging_status}")
    if "WARNING" in file_logging_status or "ERROR" in file_logging_status:
        LOGGER.info("Continuing with console-only logging - all logs will still be visible via docker logs")

    server = MCPApplication()
    return server.app


def main() -> None:
    app = create_app()
    host = os.getenv("MCP_HOST", "127.0.0.1")
    port = int(os.getenv("MCP_PORT", "8000"))
    web.run_app(app, host=host, port=port)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    main()

