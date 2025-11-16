"""Async-friendly helpers for interacting with the Enable Banking API."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests

from .enable_banking import EnableBankingClient

LOGGER = logging.getLogger(__name__)


@dataclass
class EnableBankingTokens:
    """Represents the access and refresh tokens for Enable Banking sessions."""

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


class EnableBankingService:
    """High-level wrapper that exposes coroutine-friendly Enable Banking helpers."""

    def __init__(
        self,
        *,
        app_id: Optional[str] = None,
        private_key_path: Optional[str] = None,
        sandbox: Optional[bool] = None,
        aspsp_name: Optional[str] = None,
        aspsp_country: Optional[str] = None,
        redirect_uri: Optional[str] = None,
        client_cls: Optional[type[EnableBankingClient]] = None,
    ) -> None:
        env = os.getenv("ENABLE_ENV", "sandbox").lower()
        self.sandbox = sandbox if sandbox is not None else env != "production"
        self.app_id = app_id or os.getenv("ENABLE_APP_ID")
        self.private_key_path = private_key_path or os.getenv("ENABLE_PRIVATE_KEY_PATH")
        self.aspsp_name = aspsp_name or os.getenv("ENABLE_BANKING_ASPSP_ID")
        if not self.aspsp_name:
            self.aspsp_name = "MOCKASPSP_SANDBOX" if self.sandbox else ""
        self.aspsp_country = aspsp_country or os.getenv("ENABLE_ASPSP_COUNTRY", "FI")
        self.redirect_uri = redirect_uri or os.getenv("ENABLE_OAUTH_REDIRECT_URL")
        self._client_cls = client_cls or EnableBankingClient

    @property
    def is_configured(self) -> bool:
        return bool(self.app_id and self.private_key_path)

    @classmethod
    def from_environment(cls) -> "EnableBankingService":
        return cls()

    def _client(self) -> EnableBankingClient:
        if not self.is_configured:
            raise RuntimeError(
                "Enable Banking credentials missing. Set ENABLE_APP_ID and ENABLE_PRIVATE_KEY_PATH."
            )
        return self._client_cls(
            app_id=self.app_id,
            private_key_path=self.private_key_path,
            sandbox=self.sandbox,
        )

    async def initiate_auth(
        self,
        *,
        redirect_url: str,
        state: str,
        aspsp_name: Optional[str] = None,
        aspsp_country: Optional[str] = None,
        psu_type: str = "personal",
    ) -> Dict[str, Any]:
        client = self._client()
        try:
            return await asyncio.to_thread(
                client.initiate_auth,
                aspsp_name or self.aspsp_name,
                aspsp_country or self.aspsp_country,
                redirect_url,
                state,
                psu_type,
            )
        except requests.RequestException as exc:  # pragma: no cover - network failure
            LOGGER.error("Enable Banking auth initiation failed: %s", exc)
            raise RuntimeError("Enable Banking auth initiation failed") from exc

    async def exchange_code(self, code: str, redirect_uri: str) -> Tuple[EnableBankingTokens, Dict[str, Any]]:
        client = self._client()
        try:
            payload = await asyncio.to_thread(client.exchange_code, code, redirect_uri)
        except requests.RequestException as exc:  # pragma: no cover - network failure
            LOGGER.error("Enable Banking token exchange failed: %s", exc)
            raise RuntimeError("Enable Banking token exchange failed") from exc

        expires_in = payload.get("expires_in")
        tokens = EnableBankingTokens(
            access_token=payload["access_token"],
            refresh_token=payload.get("refresh_token"),
            expires_at=time.time() + expires_in if expires_in else None,
        )
        return tokens, payload

    async def _refresh_if_needed(self, tokens: EnableBankingTokens) -> EnableBankingTokens:
        if not tokens.refresh_token:
            return tokens
        if tokens.expires_at and tokens.expires_at - time.time() > 30:
            return tokens
        client = self._client()
        client.refresh_token = tokens.refresh_token
        try:
            refreshed = await asyncio.to_thread(client.refresh_access_token)
        except requests.RequestException as exc:  # pragma: no cover - network failure
            LOGGER.error("Enable Banking refresh failed: %s", exc)
            raise RuntimeError("Failed to refresh Enable Banking token") from exc
        tokens.access_token = refreshed["access_token"]
        tokens.refresh_token = refreshed.get("refresh_token", tokens.refresh_token)
        expires_in = refreshed.get("expires_in")
        tokens.expires_at = time.time() + expires_in if expires_in else None
        return tokens

    async def _client_with_tokens(
        self, tokens: EnableBankingTokens
    ) -> Tuple[EnableBankingClient, EnableBankingTokens]:
        tokens = await self._refresh_if_needed(tokens)
        client = self._client()
        client.access_token = tokens.access_token
        client.refresh_token = tokens.refresh_token
        return client, tokens

    async def fetch_accounts(self, tokens: EnableBankingTokens) -> Tuple[List[Dict[str, Any]], EnableBankingTokens]:
        client, tokens = await self._client_with_tokens(tokens)
        try:
            accounts = await asyncio.to_thread(client.get_accounts)
        except requests.RequestException as exc:  # pragma: no cover - network failure
            LOGGER.error("Enable Banking accounts call failed: %s", exc)
            raise RuntimeError("Failed to fetch Enable Banking accounts") from exc
        return accounts, tokens

    async def fetch_transactions(
        self,
        tokens: EnableBankingTokens,
        *,
        account_ids: Optional[Sequence[str]] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Tuple[List[Dict[str, Any]], EnableBankingTokens]:
        accounts: Sequence[str]
        if account_ids:
            accounts = account_ids
        else:
            fetched_accounts, tokens = await self.fetch_accounts(tokens)
            accounts = [acct.get("resourceId") or acct.get("id") for acct in fetched_accounts]

        collected: List[Dict[str, Any]] = []
        client, tokens = await self._client_with_tokens(tokens)
        for account_id in accounts:
            if not account_id:
                continue
            try:
                data = await asyncio.to_thread(
                    client.get_transactions,
                    account_id,
                    date_from,
                    date_to,
                )
            except requests.RequestException as exc:  # pragma: no cover - network failure
                LOGGER.error("Enable Banking transactions call failed: %s", exc)
                raise RuntimeError("Failed to fetch Enable Banking transactions") from exc
            collected.extend(data)
            if limit and len(collected) >= limit:
                return collected[:limit], tokens
        return collected, tokens

    @staticmethod
    def mask_token(token: str) -> str:
        if not token:
            return ""
        if len(token) <= 8:
            return "***"
        return f"{token[:4]}…{token[-4:]}"
