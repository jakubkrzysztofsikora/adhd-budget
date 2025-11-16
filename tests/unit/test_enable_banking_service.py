from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import List

import pytest

from src.enable_banking_service import EnableBankingService, EnableBankingTokens


class DummyClient:
    def __init__(self, *_, **__):
        self.access_token = None
        self.refresh_token = None
        self._accounts: List[dict] = [{"resourceId": "acc-1"}]
        self._transactions: List[dict] = [
            {
                "transactionId": "tx-1",
                "transactionAmount": {"amount": "10.00", "currency": "EUR"},
                "bookingDate": "2024-01-02",
            }
        ]

    def get_accounts(self) -> List[dict]:
        return self._accounts

    def get_transactions(self, *_args, **_kwargs) -> List[dict]:
        return self._transactions

    def refresh_access_token(self) -> dict:
        return {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 120}


@pytest.fixture(autouse=True)
def fake_client(monkeypatch, tmp_path: Path):
    key = tmp_path / "fake.pem"
    key.write_text("dummy")
    monkeypatch.setenv("ENABLE_APP_ID", "app-123")
    monkeypatch.setenv("ENABLE_PRIVATE_KEY_PATH", str(key))
    monkeypatch.setattr("src.enable_banking_service.EnableBankingClient", DummyClient)


@pytest.mark.asyncio
async def test_fetch_accounts_returns_data():
    service = EnableBankingService.from_environment()
    accounts, tokens = await service.fetch_accounts(EnableBankingTokens(access_token="foo"))
    assert accounts[0]["resourceId"] == "acc-1"
    assert tokens.access_token == "foo"


@pytest.mark.asyncio
async def test_refresh_if_needed_updates_tokens():
    service = EnableBankingService.from_environment()
    expired = EnableBankingTokens(access_token="old", refresh_token="refresh", expires_at=time.time() - 10)
    refreshed = await service._refresh_if_needed(expired)
    assert refreshed.access_token == "new-access"
    assert refreshed.refresh_token == "new-refresh"
    assert refreshed.expires_at is not None


@pytest.mark.asyncio
async def test_fetch_transactions_handles_limit():
    service = EnableBankingService.from_environment()
    transactions, _ = await service.fetch_transactions(EnableBankingTokens(access_token="foo"), limit=1)
    assert len(transactions) == 1
    assert transactions[0]["transactionId"] == "tx-1"
