import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from src.mcp_remote_server import MCPApplication


def test_determine_error_status_allows_jsonrpc_errors_for_authenticated_clients():
    app = MCPApplication()
    request = make_mocked_request("POST", "/mcp", headers={"Authorization": "Bearer test"})
    status = app._determine_error_status(web.HTTPUnauthorized(text="No consent"), request)
    assert status == 200


def test_determine_error_status_preserves_http_status_without_authorization():
    app = MCPApplication()
    request = make_mocked_request("POST", "/mcp", headers={})
    status = app._determine_error_status(web.HTTPUnauthorized(text="Missing"), request)
    assert status == 401
