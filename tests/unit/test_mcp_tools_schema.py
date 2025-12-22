import os

import requests


def _base_url() -> str:
    return (os.getenv("TEST_BASE_URL") or os.getenv("MCP_URL") or "http://127.0.0.1:8081").rstrip("/")


def test_tools_list_exposes_snake_case_input_schema():
    response = requests.post(
        f"{_base_url()}/mcp",
        json={"jsonrpc": "2.0", "method": "tools/list", "id": "schema-check"},
        headers={"Content-Type": "application/json"},
        timeout=5,
    )

    assert response.status_code == 200
    payload = response.json()
    tools = payload.get("result", {}).get("tools", [])
    assert tools, "tools/list should return at least one tool"

    for tool in tools:
        assert "input_schema" in tool, "input_schema must follow MCP spec naming"
        assert isinstance(tool["input_schema"], dict)
