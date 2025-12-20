import base64
import hashlib

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


def test_pkce_verification_required_when_challenge_present():
    provider = OAuthProvider()
    client = {
        "client_id": "public-client",
        "redirect_uris": ["https://example.com/cb"],
        "token_endpoint_auth_method": "none",
    }
    provider.clients[client["client_id"]] = client

    verifier = "test-verifier-123"
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("utf-8")).digest()
    ).decode("ascii").rstrip("=")
    code = provider.issue_authorization_code(
        client["client_id"],
        client["redirect_uris"][0],
        "accounts",
        None,
        None,
        code_challenge=challenge,
        code_challenge_method="S256",
    )

    with pytest.raises(web.HTTPBadRequest):
        provider.exchange_token(
            {"grant_type": "authorization_code", "code": code, "client_id": client["client_id"]}
        )

    code_with_verifier = provider.issue_authorization_code(
        client["client_id"],
        client["redirect_uris"][0],
        "accounts",
        None,
        None,
        code_challenge=challenge,
        code_challenge_method="S256",
    )

    tokens = provider.exchange_token(
        {
            "grant_type": "authorization_code",
            "code": code_with_verifier,
            "code_verifier": verifier,
            "client_id": client["client_id"],
        }
    )
    assert "access_token" in tokens


def test_pkce_plain_method_is_rejected():
    provider = OAuthProvider()
    client = {
        "client_id": "public-client-plain",
        "redirect_uris": ["https://example.com/cb"],
        "token_endpoint_auth_method": "none",
    }
    provider.clients[client["client_id"]] = client

    code = provider.issue_authorization_code(
        client["client_id"],
        client["redirect_uris"][0],
        "accounts",
        None,
        None,
        code_challenge="plain-challenge",
        code_challenge_method="plain",
    )

    with pytest.raises(web.HTTPBadRequest):
        provider.exchange_token(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": "plain-challenge",
                "client_id": client["client_id"],
            }
        )
