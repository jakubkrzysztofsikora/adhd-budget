import base64

import pytest
from aiohttp import web

from src.mcp_remote_server import OAuthProvider, _apply_basic_auth_credentials


def test_validate_client_requires_secret_when_confidential():
    provider = OAuthProvider()
    client = {
        "client_id": "client-123",
        "client_secret": "secret-xyz",
        "token_endpoint_auth_method": "client_secret_post",
    }
    provider.clients[client["client_id"]] = client

    with pytest.raises(web.HTTPUnauthorized):
        provider._validate_client(client["client_id"], None, require_secret=True)


def test_validate_client_allows_public_clients_without_secret():
    provider = OAuthProvider()
    client = {
        "client_id": "public-client",
        "client_secret": "ignored",
        "token_endpoint_auth_method": "none",
    }
    provider.clients[client["client_id"]] = client

    assert (
        provider._validate_client(
            client["client_id"], None, require_secret=True
        )
        == client
    )


def test_validate_client_rejects_incorrect_secret():
    provider = OAuthProvider()
    client = {
        "client_id": "client-123",
        "client_secret": "secret-xyz",
        "token_endpoint_auth_method": "client_secret_basic",
    }
    provider.clients[client["client_id"]] = client

    with pytest.raises(web.HTTPUnauthorized):
        provider._validate_client(client["client_id"], "wrong", require_secret=True)


def test_apply_basic_auth_credentials_populates_missing_fields():
    payload = {}
    header = base64.b64encode(b"client-id:super-secret").decode("ascii")
    result = _apply_basic_auth_credentials(payload, {"Authorization": f"Basic {header}"})

    assert result["client_id"] == "client-id"
    assert result["client_secret"] == "super-secret"


def test_apply_basic_auth_credentials_rejects_mismatched_client_id():
    header = base64.b64encode(b"client-id:super-secret").decode("ascii")
    with pytest.raises(web.HTTPUnauthorized):
        _apply_basic_auth_credentials(
            {"client_id": "other"}, {"Authorization": f"Basic {header}"}
        )
