#!/usr/bin/env python3
"""
Test Enable Banking JWT authentication and OAuth flow
"""
import json
import os
import time
from datetime import datetime, timezone
import jwt
import requests

def create_enable_banking_jwt(app_id, private_key_path):
    """Create JWT for Enable Banking API authentication"""
    
    # Read private key
    with open(private_key_path, 'rb') as f:
        private_key = f.read()
    
    # JWT headers
    headers = {
        "typ": "JWT",
        "alg": "RS256",
        "kid": app_id  # Application ID as key ID
    }
    
    # JWT payload
    now = int(datetime.now(timezone.utc).timestamp())
    payload = {
        "iss": "enablebanking.com",
        "aud": "api.enablebanking.com",
        "iat": now,
        "exp": now + 3600  # 1 hour expiry
    }
    
    # Create JWT
    token = jwt.encode(
        payload,
        private_key,
        algorithm="RS256",
        headers=headers
    )
    
    return token

def test_enable_banking_auth():
    """Test Enable Banking authentication flow"""
    
    print("🔍 Testing Enable Banking JWT Authentication")
    print("=" * 60)
    
    # Configuration
    app_id = os.getenv("ENABLE_APP_ID", "sandbox-app-id")
    private_key_path = os.getenv("ENABLE_PRIVATE_KEY_PATH", "keys/test_private.pem")
    api_base_url = os.getenv("ENABLE_API_BASE_URL", "https://api.enablebanking.com")
    
    # Check if private key exists
    if not os.path.exists(private_key_path):
        print(f"❌ Private key not found at: {private_key_path}")
        print("   Please ensure the private key file exists")
        return False
    
    print(f"✅ Private key found at: {private_key_path}")
    
    # Create JWT
    try:
        jwt_token = create_enable_banking_jwt(app_id, private_key_path)
        print(f"✅ JWT created successfully")
        print(f"   Token (first 50 chars): {jwt_token[:50]}...")
    except Exception as e:
        print(f"❌ Failed to create JWT: {e}")
        return False
    
    # Test API access with JWT
    print("\n1️⃣ Testing API access with JWT...")
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/json"
    }
    
    # Test application endpoint
    app_url = f"{api_base_url}/application"
    print(f"   Testing: GET {app_url}")
    
    try:
        response = requests.get(app_url, headers=headers, timeout=10)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            app_data = response.json()
            print(f"✅ Application details retrieved:")
            print(f"   Application ID: {app_data.get('applicationId', 'N/A')}")
            print(f"   Name: {app_data.get('name', 'N/A')}")
        else:
            print(f"❌ API access failed: {response.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")
        return False
    
    # Test OAuth authorization with JWT
    print("\n2️⃣ Testing OAuth authorization endpoint with JWT...")
    auth_params = {
        "response_type": "code",
        "client_id": app_id,
        "redirect_uri": "http://localhost:8081/auth/callback",
        "scope": "accounts transactions",
        "state": "test-state-123"
    }
    
    auth_url = f"{api_base_url}/auth/authorize"
    print(f"   Testing: GET {auth_url}")
    print(f"   Params: {auth_params}")
    
    try:
        response = requests.get(
            auth_url,
            params=auth_params,
            headers=headers,
            timeout=10,
            allow_redirects=False  # Don't follow redirects
        )
        print(f"   Status: {response.status_code}")
        
        if response.status_code in [200, 302, 303]:
            print(f"✅ OAuth authorization initiated")
            if 'Location' in response.headers:
                print(f"   Redirect URL: {response.headers['Location'][:100]}...")
            if response.text:
                print(f"   Response (first 200 chars): {response.text[:200]}...")
        else:
            print(f"❌ OAuth authorization failed: {response.text}")
            return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")
        return False
    
    # Test ASPSPs listing
    print("\n3️⃣ Testing ASPSPs (banks) listing...")
    aspsps_url = f"{api_base_url}/aspsps"
    print(f"   Testing: GET {aspsps_url}")
    
    try:
        response = requests.get(aspsps_url, headers=headers, timeout=10)
        print(f"   Status: {response.status_code}")
        
        if response.status_code == 200:
            aspsps_data = response.json()
            aspsps = aspsps_data.get('aspsps', [])
            print(f"✅ Found {len(aspsps)} ASPSPs")
            
            # Show first few banks
            for aspsp in aspsps[:5]:
                print(f"   - {aspsp.get('name', 'Unknown')} ({aspsp.get('country', 'N/A')})")
            if len(aspsps) > 5:
                print(f"   ... and {len(aspsps) - 5} more")
        else:
            print(f"❌ ASPSPs listing failed: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")
    
    print("\n✅ Enable Banking JWT authentication is working!")
    print("📋 Next steps:")
    print("1. The OAuth flow requires JWT authentication")
    print("2. The authorization endpoint returns a consent page or redirect")
    print("3. After user consent, Enable Banking redirects back with auth code")
    print("4. Exchange the auth code for access token using JWT auth")
    
    return True

if __name__ == "__main__":
    success = test_enable_banking_auth()
    exit(0 if success else 1)