#!/usr/bin/env python3
"""
Test OAuth 2.0 flow with MCP Inspector integration
"""
import requests
import json
import time

def test_oauth_flow():
    print("🔍 Testing OAuth 2.0 flow with ADHD Budget MCP Server")
    print("=" * 60)
    
    # Step 1: Test OAuth 2.0 Discovery
    print("\n1️⃣ Testing OAuth 2.0 Discovery...")
    discovery_resp = requests.get("http://localhost/.well-known/oauth-authorization-server")
    print(f"Status: {discovery_resp.status_code}")
    if discovery_resp.status_code == 200:
        discovery_data = discovery_resp.json()
        print(f"✅ Discovery URL: {discovery_data.get('authorization_endpoint')}")
        print(f"✅ Token endpoint: {discovery_data.get('token_endpoint')}")
        print(f"✅ Registration endpoint: {discovery_data.get('registration_endpoint')}")
        print(f"✅ Scopes: {discovery_data.get('scopes_supported')}")
    else:
        print(f"❌ Discovery failed: {discovery_resp.text}")
        return False
    
    # Step 2: Test Dynamic Client Registration
    print("\n2️⃣ Testing Dynamic Client Registration...")
    registration_data = {
        "redirect_uris": ["http://localhost:6274/callback"],
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "scope": "accounts transactions"
    }
    
    reg_resp = requests.post(
        "http://localhost/oauth/register",
        headers={"Content-Type": "application/json"},
        json=registration_data
    )
    
    print(f"Status: {reg_resp.status_code}")
    if reg_resp.status_code == 201:
        client_data = reg_resp.json()
        print(f"✅ Client ID: {client_data.get('client_id')}")
        print(f"✅ Redirect URIs: {client_data.get('redirect_uris')}")
        print(f"✅ Grant types: {client_data.get('grant_types')}")
        print(f"✅ Scopes: {client_data.get('scope')}")
    else:
        print(f"❌ Registration failed: {reg_resp.text}")
        return False
    
    # Step 3: Test MCP tools list (should work without auth)
    print("\n3️⃣ Testing MCP tools list (no auth required)...")
    tools_req = {
        "jsonrpc": "2.0",
        "method": "tools/list",
        "id": "1"
    }
    
    tools_resp = requests.post(
        "http://localhost/mcp",
        headers={"Content-Type": "application/json"},
        json=tools_req
    )
    
    print(f"Status: {tools_resp.status_code}")
    if tools_resp.status_code == 200:
        tools_data = tools_resp.json()
        if "result" in tools_data and "tools" in tools_data["result"]:
            tools = tools_data["result"]["tools"]
            print(f"✅ Found {len(tools)} tools:")
            for tool in tools:
                print(f"   - {tool['name']}: {tool['description']}")
        else:
            print(f"❌ Invalid tools response: {tools_data}")
            return False
    else:
        print(f"❌ Tools list failed: {tools_resp.text}")
        return False
    
    # Step 4: Test protected tool (should require auth)
    print("\n4️⃣ Testing protected tool (should require auth)...")
    protected_req = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": "summary.today",
            "arguments": {}
        },
        "id": "2"
    }
    
    protected_resp = requests.post(
        "http://localhost/mcp",
        headers={"Content-Type": "application/json"},
        json=protected_req
    )
    
    print(f"Status: {protected_resp.status_code}")
    if protected_resp.status_code == 200:
        protected_data = protected_resp.json()
        if "error" in protected_data:
            error = protected_data["error"]
            if "Enable Banking access token required" in error["message"]:
                print("✅ Protected tool correctly requires OAuth token")
            else:
                print(f"❌ Unexpected error: {error}")
                return False
        else:
            print(f"❌ Expected auth error but got: {protected_data}")
            return False
    else:
        print(f"❌ Protected tool test failed: {protected_resp.text}")
        return False
    
    print("\n🎉 All OAuth 2.0 integration tests passed!")
    print("✅ OAuth discovery endpoint working")
    print("✅ Dynamic client registration working")
    print("✅ MCP tools list accessible without auth")
    print("✅ Protected tools properly require OAuth")

    print("\n📋 Next steps for MCP Inspector:")
    print("1. Open MCP Inspector at http://localhost:6274")
    print("2. Select 'ADHD Budget MCP Server' from dropdown")
    print("3. Start the OAuth flow and follow the Enable Banking redirect")
    print("4. After consent, Inspector can call financial tools immediately")
    
    return True

if __name__ == "__main__":
    success = test_oauth_flow()
    exit(0 if success else 1)