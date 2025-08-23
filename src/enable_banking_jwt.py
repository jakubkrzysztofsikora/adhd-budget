"""
Enable Banking JWT Authentication
Implements RS256 JWT signing per Enable Banking spec
https://enablebanking.com/docs/api/reference/
"""

import jwt
import time
import os
from datetime import datetime, timedelta
from typing import Dict, Optional
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend


class EnableBankingJWT:
    """Generate JWT tokens for Enable Banking API authentication"""
    
    def __init__(self, 
                 app_id: Optional[str] = None,
                 private_key_path: Optional[str] = None):
        """
        Initialize JWT generator
        
        Args:
            app_id: Application ID from Enable Banking (used as 'kid')
            private_key_path: Path to private key file for RS256 signing
        """
        self.app_id = app_id or os.environ.get('ENABLE_APP_ID')
        self.private_key_path = private_key_path or os.environ.get('ENABLE_PRIVATE_KEY_PATH')
        
        if not self.app_id:
            raise ValueError("Application ID (ENABLE_APP_ID) is required")
        
        if not self.private_key_path:
            raise ValueError("Private key path (ENABLE_PRIVATE_KEY_PATH) is required")
        
        # Load private key
        self.private_key = self._load_private_key()
    
    def _load_private_key(self) -> bytes:
        """
        Load private key from file
        
        Returns:
            Private key bytes
        """
        if not os.path.exists(self.private_key_path):
            raise FileNotFoundError(f"Private key not found: {self.private_key_path}")
        
        with open(self.private_key_path, 'rb') as f:
            return f.read()
    
    def generate_token(self, ttl_seconds: int = 3600) -> str:
        """
        Generate JWT token for Enable Banking API
        
        Args:
            ttl_seconds: Token time-to-live in seconds (max 86400 = 24 hours)
        
        Returns:
            JWT token string
        """
        # Validate TTL
        if ttl_seconds > 86400:
            raise ValueError("Token TTL cannot exceed 86400 seconds (24 hours)")
        
        # Current timestamp
        now = int(time.time())
        
        # JWT header as per Enable Banking spec
        headers = {
            "typ": "JWT",
            "alg": "RS256",
            "kid": self.app_id  # Application ID as key ID
        }
        
        # JWT payload as per Enable Banking spec
        payload = {
            "iss": "enablebanking.com",           # Issuer
            "aud": "api.enablebanking.com",       # Audience (new API endpoint)
            "iat": now,                            # Issued at
            "exp": now + ttl_seconds               # Expiry (iat + TTL)
        }
        
        # Generate JWT with RS256
        token = jwt.encode(
            payload,
            self.private_key,
            algorithm="RS256",
            headers=headers
        )
        
        # PyJWT returns string in newer versions, bytes in older
        if isinstance(token, bytes):
            token = token.decode('utf-8')
        
        return token
    
    def decode_token(self, token: str, public_key: Optional[bytes] = None) -> Dict:
        """
        Decode and verify JWT token (for testing)
        
        Args:
            token: JWT token string
            public_key: Public key for verification (optional)
        
        Returns:
            Decoded token payload
        """
        # If no public key provided, decode without verification (testing only)
        if not public_key:
            return jwt.decode(token, options={"verify_signature": False})
        
        # Decode and verify with public key
        return jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience="api.enablebanking.com",
            issuer="enablebanking.com"
        )
    
    def get_auth_header(self) -> Dict[str, str]:
        """
        Get authorization header with JWT token
        
        Returns:
            Dictionary with Authorization header
        """
        token = self.generate_token()
        return {
            "Authorization": f"Bearer {token}"
        }


def create_test_keypair():
    """
    Create test RSA keypair for development/testing
    This should NOT be used in production
    """
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import hashes
    
    # Generate private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend()
    )
    
    # Extract public key
    public_key = private_key.public_key()
    
    # Serialize private key
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    
    # Serialize public key (certificate format)
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    
    # Save to test files
    os.makedirs("keys", exist_ok=True)
    
    with open("keys/test_private.pem", "wb") as f:
        f.write(private_pem)
    
    with open("keys/test_public.pem", "wb") as f:
        f.write(public_pem)
    
    print("Test keypair created in keys/ directory")
    print("Private key: keys/test_private.pem")
    print("Public key: keys/test_public.pem")
    
    return "keys/test_private.pem", "keys/test_public.pem"


if __name__ == "__main__":
    # Example usage
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "create-test-keys":
        create_test_keypair()
        print("\nTest keys created. Set environment variables:")
        print("export ENABLE_APP_ID=test-app-123")
        print("export ENABLE_PRIVATE_KEY_PATH=keys/test_private.pem")
    else:
        # Test token generation
        try:
            jwt_gen = EnableBankingJWT()
            token = jwt_gen.generate_token()
            print(f"Generated JWT token:\n{token}")
            
            # Decode to show structure
            decoded = jwt_gen.decode_token(token)
            print(f"\nDecoded payload:\n{decoded}")
        except Exception as e:
            print(f"Error: {e}")
            print("\nTo create test keys, run:")
            print("python enable_banking_jwt.py create-test-keys")