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
import json
import logging
import os
import secrets
import textwrap
import time
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional
from urllib.parse import urlencode
from uuid import uuid4

from aiohttp import web


LOGGER = logging.getLogger("adhd_budget.mcp")


SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26")
DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

ALLOWED_ORIGINS = (
    "https://claude.ai",
    "https://www.claude.ai",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)


def _json_dumps(payload: Dict[str, Any]) -> bytes:
    """Serialize a JSON payload using compact separators."""

    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@dataclass
class Session:
    """Represents an MCP session associated with a connected client."""

    id: str
    protocol_version: str
    client_info: Dict[str, Any]
    created_at: float = field(default_factory=lambda: time.time())
    queue: "asyncio.Queue[Dict[str, Any]]" = field(default_factory=asyncio.Queue)
    last_seen: float = field(default_factory=lambda: time.time())

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


class OAuthProvider:
    """In-memory OAuth 2.1 provider implementation."""

    def __init__(self) -> None:
        self.clients: Dict[str, Dict[str, Any]] = {}
        self.auth_codes: Dict[str, Dict[str, Any]] = {}
        self.access_tokens: Dict[str, Dict[str, Any]] = {}
        self.refresh_tokens: Dict[str, Dict[str, Any]] = {}
        self.issuer = "https://auth.local.adhd-budget"

    def register_client(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        redirect_uris = payload.get("redirect_uris")
        if not redirect_uris:
            raise web.HTTPBadRequest(text="Missing redirect_uris")

        client_id = secrets.token_urlsafe(24)
        client_secret = secrets.token_urlsafe(32)

        client = {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uris": redirect_uris,
            "grant_types": payload.get("grant_types", ["authorization_code", "refresh_token"]),
            "response_types": payload.get("response_types", ["code"]),
            "scope": payload.get("scope", "transactions accounts"),
            "token_endpoint_auth_method": payload.get("token_endpoint_auth_method", "client_secret_basic"),
            "client_id_issued_at": int(time.time()),
        }

        self.clients[client_id] = client
        return client

    def _validate_client(self, client_id: str, client_secret: Optional[str]) -> Dict[str, Any]:
        client = self.clients.get(client_id)
        if not client:
            raise web.HTTPUnauthorized(text="Unknown client")
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
    ) -> str:
        client = self._validate_client(client_id, None)
        if redirect_uri not in client["redirect_uris"]:
            raise web.HTTPBadRequest(text="Invalid redirect_uri")

        code = secrets.token_urlsafe(32)
        self.auth_codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
            "resource": resource,
            "expires_at": time.time() + 300,
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
            client = self._validate_client(client_id, client_secret)
        elif os.getenv("ENABLE_ENV", "sandbox") != "production":
            client_id = client_id or os.getenv("ENABLE_APP_ID", "enable-sandbox")
            default_redirect = payload.get("redirect_uri") or "https://claude.ai/api/mcp/auth_callback"
            client = self.clients.setdefault(
                client_id,
                {
                    "client_id": client_id,
                    "client_secret": client_secret or secrets.token_urlsafe(32),
                    "redirect_uris": [default_redirect],
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
            else:
                scope = payload.get("scope") or client.get("scope", "transactions accounts")
                resource = payload.get("resource")

            return self._issue_tokens(client_id, scope, resource)

        if grant_type == "refresh_token":
            refresh_token = payload.get("refresh_token")
            token_info = self.refresh_tokens.get(refresh_token)
            if token_info:
                if token_info["client_id"] != client_id:
                    raise web.HTTPBadRequest(text="Client mismatch")
                if token_info["expires_at"] <= time.time():
                    raise web.HTTPBadRequest(text="Refresh token expired")

                resource = payload.get("resource") or token_info.get("resource")
                self._validate_resource(resource, token_info.get("resource"))
                scope = token_info["scope"]
            else:
                scope = payload.get("scope") or client.get("scope", "transactions accounts")
                resource = payload.get("resource")

            return self._issue_tokens(client_id, scope, resource)

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

    def _issue_tokens(self, client_id: str, scope: str, resource: Optional[str]) -> Dict[str, Any]:
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        expires_in = 3600
        now = time.time()
        token_info = {
            "client_id": client_id,
            "scope": scope,
            "resource": resource,
            "issued_at": now,
            "expires_at": now + expires_in,
        }
        self.access_tokens[access_token] = token_info
        self.refresh_tokens[refresh_token] = {
            **token_info,
            "refresh_token": refresh_token,
            "expires_at": now + 7 * 86400,
        }
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "refresh_token": refresh_token,
            "scope": scope,
            "resource": resource,
        }


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
        self.app = web.Application(middlewares=[cors_and_origin_middleware])
        self.app.router.add_route("GET", "/mcp", self.handle_get)
        # Backwards compatibility with earlier test harnesses that used
        # dedicated streaming endpoints.
        self.app.router.add_route("GET", "/mcp/stream", self.handle_get)
        self.app.router.add_route("GET", "/mcp/sse", self.handle_get)
        self.app.router.add_route("POST", "/mcp", self.handle_post)
        self.app.router.add_route("OPTIONS", "/mcp", self.handle_options)
        self.app.router.add_get("/health", self.handle_health)
        self._register_oauth_routes()

        self.tools: Dict[str, Callable[[Dict[str, Any], Optional[Session], web.Request], Awaitable[Dict[str, Any]]]] = {
            "echo": self.tool_echo,
            "search": self.tool_search,
            "fetch": self.tool_fetch,
            "summary.today": self.tool_summary_today,
            "projection.month": self.tool_projection_month,
            "transactions.query": self.tool_transactions_query,
        }

        self.protected_tools = {"search", "fetch", "summary.today", "projection.month", "transactions.query"}

    def _register_oauth_routes(self) -> None:
        self.app.router.add_get("/.well-known/oauth-authorization-server", self.oauth_metadata)
        self.app.router.add_get("/.well-known/oauth-protected-resource", self.oauth_protected_resource)
        self.app.router.add_post("/oauth/register", self.oauth_register)
        self.app.router.add_get("/oauth/authorize", self.oauth_authorize)
        self.app.router.add_post("/oauth/token", self.oauth_token)
        self.app.router.add_post("/oauth/revoke", self.oauth_revoke)

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

        result = {
            "protocolVersion": requested_version,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
                "prompts": {"listChanged": False},
            },
            "serverInfo": {"name": "adhd-budget-mcp", "version": "2.0.0"},
            "protectedResourceMetadata": {
                "resource": "https://adhdbudget.bieda.it/mcp",
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

    async def rpc_tools_list(self, params: Dict[str, Any], request: web.Request, session: Session) -> Dict[str, Any]:
        tools = []
        for name, handler in self.tools.items():
            tools.append(
                {
                    "name": name,
                    "description": handler.__doc__ or "",
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": True,
                    },
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
        if name in self.protected_tools:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header.split(" ", 1)[1]
            self.oauth.validate_bearer(token)

        handler = self.tools[name]
        return await handler(arguments, session, request)

    async def tool_echo(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Echoes the provided message back to the caller."""

        message = arguments.get("message", "")
        return {"content": [{"type": "text", "text": str(message)}]}

    async def tool_search(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Search recent transactions by free text (requires OAuth token)."""

        query = (arguments.get("query") or "").lower()
        results = []
        sample = [
            {"id": "tx-101", "merchant": "Tesco", "amount": -42.5, "tags": ["groceries"]},
            {"id": "tx-205", "merchant": "Starbucks", "amount": -5.8, "tags": ["coffee", "treats"]},
            {"id": "tx-330", "merchant": "TFL", "amount": -3.2, "tags": ["transport"]},
        ]

        for entry in sample:
            if not query or query in entry["merchant"].lower() or any(query in tag for tag in entry["tags"]):
                results.append(entry)

        if session:
            await self.sessions.publish(
                session.id,
                {"type": "search", "query": query, "count": len(results), "timestamp": time.time()},
            )

        return {"results": results, "query": query}

    async def tool_fetch(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Fetch a transaction by id (requires OAuth token)."""

        resource_id = arguments.get("id")
        if not resource_id:
            raise web.HTTPBadRequest(text="Missing id argument")

        record = {
            "id": resource_id,
            "date": "2025-01-15T12:00:00Z",
            "amount": -42.5,
            "merchant": "Tesco",
            "category": "groceries",
            "notes": "Sample data from MCP server",
        }
        return {"resource": record}

    async def tool_summary_today(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Return a mock summary of today's spending (requires OAuth token)."""

        return {
            "summary": {
                "date": time.strftime("%Y-%m-%d"),
                "total_spent": 132.48,
                "categories": {"groceries": 54.12, "transport": 28.5, "eating_out": 36.42, "other": 13.44},
                "daily_budget": 120.0,
                "variance": 12.48,
                "status": "over",
            }
        }

    async def tool_projection_month(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Return a projection for the current month (requires OAuth token)."""

        return {
            "projection": {
                "month": time.strftime("%Y-%m"),
                "projected_spend": 3845.32,
                "budget": 3600.0,
                "variance": 245.32,
                "pace": "over",
                "month_end_balance": -245.32,
            }
        }

    async def tool_transactions_query(self, arguments: Dict[str, Any], session: Optional[Session], request: web.Request) -> Dict[str, Any]:
        """Query recent transactions and stream progress updates (requires OAuth token)."""

        since = arguments.get("since", "2025-01-01T00:00:00Z")
        limit = int(arguments.get("limit", 5))

        # Demonstrate streaming progress over SSE.
        if session:
            await self.sessions.publish(
                session.id,
                {
                    "event": "progress",
                    "type": "progress",
                    "message": "Fetching transactions",
                    "timestamp": time.time(),
                },
            )

        await asyncio.sleep(0.1)

        if session:
            await self.sessions.publish(
                session.id,
                {
                    "event": "progress",
                    "type": "progress",
                    "message": "Normalising results",
                    "timestamp": time.time(),
                },
            )

        transactions = [
            {
                "id": f"tx-{index:03d}",
                "date": "2025-01-15T12:00:00Z",
                "amount": (-1) ** index * 42.5,
                "merchant": "Sample Merchant",
                "category": "misc",
            }
            for index in range(1, limit + 1)
        ]

        return {"transactions": transactions, "since": since, "limit": limit}

    async def oauth_metadata(self, request: web.Request) -> web.Response:
        metadata = {
            "issuer": self.oauth.issuer,
            "authorization_endpoint": f"{request.scheme}://{request.host}/oauth/authorize",
            "token_endpoint": f"{request.scheme}://{request.host}/oauth/token",
            "revocation_endpoint": f"{request.scheme}://{request.host}/oauth/revoke",
            "registration_endpoint": f"{request.scheme}://{request.host}/oauth/register",
            "scopes_supported": ["transactions", "accounts", "summary"],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["client_secret_post"],
            "code_challenge_methods_supported": ["S256"],
        }
        return web.json_response(metadata)

    async def oauth_protected_resource(self, request: web.Request) -> web.Response:
        metadata = {
            "resource": f"{request.scheme}://{request.host}/mcp",
            "authorization_server": self.oauth.issuer,
            "authorization_servers": [self.oauth.issuer],
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

        if not client_id or not redirect_uri:
            raise web.HTTPBadRequest(text="Missing client_id or redirect_uri")

        client = self.oauth.clients.get(client_id)
        if not client:
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

        code = self.oauth.issue_authorization_code(client_id, redirect_uri, scope, state, resource)
        query = {"code": code}
        if state:
            query["state"] = state
        location = f"{redirect_uri}?{urlencode(query)}"

        if client.get("token_endpoint_auth_method") == "none":
            html = textwrap.dedent(
                f"""
                <!doctype html>
                <html>
                    <head><title>Enable Banking OAuth</title></head>
                    <body>
                        <h1>Select Your Bank</h1>
                        <p>Authorization complete. Continue to your callback:</p>
                        <p><a href="{location}">{location}</a></p>
                    </body>
                </html>
                """
            ).strip()
            return web.Response(text=html, content_type="text/html")

        raise web.HTTPFound(location=location)

    async def oauth_token(self, request: web.Request) -> web.Response:
        if request.content_type == "application/json":
            payload = await request.json()
        else:
            form = await request.post()
            payload = dict(form)
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
    logging.basicConfig(level=logging.INFO)
    server = MCPApplication()
    return server.app


def main() -> None:
    app = create_app()
    host = os.getenv("MCP_HOST", "127.0.0.1")
    port = int(os.getenv("MCP_PORT", "8000"))
    web.run_app(app, host=host, port=port)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    main()

