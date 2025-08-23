"""
Enable Banking API Integration
Uses Mock ASPSP for sandbox testing
https://enablebanking.com/docs/api/sandbox/#mock-aspsp
"""

import requests
import json
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
import os
from .enable_banking_jwt import EnableBankingJWT


class EnableBankingClient:
    """Client for Enable Banking API with Mock ASPSP support"""
    
    def __init__(self, app_id: str = None, private_key_path: str = None, sandbox: bool = True):
        """
        Initialize Enable Banking client
        
        Args:
            app_id: Application ID from Enable Banking
            private_key_path: Path to private key file for JWT signing
            sandbox: Use sandbox/Mock ASPSP (default True)
        """
        self.app_id = app_id or os.environ.get('ENABLE_APP_ID', 'sandbox-app-id')
        self.private_key_path = private_key_path or os.environ.get('ENABLE_PRIVATE_KEY_PATH')
        self.sandbox = sandbox
        
        # Initialize JWT generator if credentials provided
        if self.app_id and self.private_key_path:
            self.jwt_generator = EnableBankingJWT(self.app_id, self.private_key_path)
        else:
            self.jwt_generator = None
        
        if sandbox:
            self.base_url = "https://api.sandbox.enablebanking.com"
            self.aspsp_id = "MOCKASPSP_SANDBOX"
        else:
            self.base_url = "https://api.enablebanking.com"
            self.aspsp_id = os.environ.get('ENABLE_BANKING_ASPSP_ID')
        
        self.access_token = None
        self.refresh_token = None
        self.consent_id = None
    
    def get_auth_url(self, redirect_uri: str, state: str = None) -> str:
        """
        Get authorization URL for user consent
        
        Args:
            redirect_uri: OAuth redirect URI
            state: Optional state parameter
            
        Returns:
            Authorization URL
        """
        params = {
            'response_type': 'code',
            'client_id': self.app_id,
            'redirect_uri': redirect_uri,
            'scope': 'accounts transactions',
            'aspsp': self.aspsp_id
        }
        
        if state:
            params['state'] = state
        
        auth_url = f"{self.base_url}/auth/authorize"
        query_string = '&'.join(f"{k}={v}" for k, v in params.items())
        return f"{auth_url}?{query_string}"
    
    def exchange_code(self, code: str, redirect_uri: str) -> Dict[str, Any]:
        """
        Exchange authorization code for access token
        
        Args:
            code: Authorization code
            redirect_uri: OAuth redirect URI
            
        Returns:
            Token response
        """
        url = f"{self.base_url}/auth/token"
        
        data = {
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': redirect_uri,
            'client_id': self.app_id
        }
        
        # Add JWT authentication if available
        headers = {}
        if self.jwt_generator:
            headers = self.jwt_generator.get_auth_header()
        
        response = requests.post(url, data=data, headers=headers)
        response.raise_for_status()
        
        token_data = response.json()
        self.access_token = token_data['access_token']
        self.refresh_token = token_data.get('refresh_token')
        
        return token_data
    
    def refresh_access_token(self) -> Dict[str, Any]:
        """
        Refresh access token using refresh token
        
        Returns:
            New token response
        """
        if not self.refresh_token:
            raise ValueError("No refresh token available")
        
        url = f"{self.base_url}/auth/token"
        
        data = {
            'grant_type': 'refresh_token',
            'refresh_token': self.refresh_token,
            'client_id': self.app_id
        }
        
        response = requests.post(url, data=data)
        response.raise_for_status()
        
        token_data = response.json()
        self.access_token = token_data['access_token']
        self.refresh_token = token_data.get('refresh_token', self.refresh_token)
        
        return token_data
    
    def get_accounts(self) -> List[Dict[str, Any]]:
        """
        Get list of accounts
        
        Returns:
            List of account objects
        """
        if not self.access_token:
            raise ValueError("Not authenticated. Call exchange_code first.")
        
        url = f"{self.base_url}/accounts"
        
        headers = {
            'Authorization': f'Bearer {self.access_token}',
            'Accept': 'application/json'
        }
        
        response = requests.get(url, headers=headers)
        
        if response.status_code == 401:
            # Token expired, try refresh
            self.refresh_access_token()
            headers['Authorization'] = f'Bearer {self.access_token}'
            response = requests.get(url, headers=headers)
        
        response.raise_for_status()
        return response.json().get('accounts', [])
    
    def get_transactions(self, account_id: str, 
                        date_from: str = None, 
                        date_to: str = None) -> List[Dict[str, Any]]:
        """
        Get transactions for an account
        
        Args:
            account_id: Account identifier
            date_from: Start date (ISO format)
            date_to: End date (ISO format)
            
        Returns:
            List of transaction objects
        """
        if not self.access_token:
            raise ValueError("Not authenticated. Call exchange_code first.")
        
        url = f"{self.base_url}/accounts/{account_id}/transactions"
        
        headers = {
            'Authorization': f'Bearer {self.access_token}',
            'Accept': 'application/json'
        }
        
        params = {}
        if date_from:
            params['dateFrom'] = date_from
        if date_to:
            params['dateTo'] = date_to
        
        response = requests.get(url, headers=headers, params=params)
        
        if response.status_code == 401:
            # Token expired, try refresh
            self.refresh_access_token()
            headers['Authorization'] = f'Bearer {self.access_token}'
            response = requests.get(url, headers=headers, params=params)
        
        response.raise_for_status()
        return response.json().get('transactions', {}).get('booked', [])
    
    def get_mock_transactions(self) -> List[Dict[str, Any]]:
        """
        Get mock transactions for testing (Mock ASPSP)
        
        Returns:
            List of mock transactions
        """
        if self.sandbox:
            # Return predefined mock transactions for testing
            return [
                {
                    "transactionId": "mock_001",
                    "bookingDate": "2024-01-15",
                    "valueDate": "2024-01-15",
                    "transactionAmount": {
                        "amount": "45.20",
                        "currency": "GBP"
                    },
                    "creditorName": "Tesco",
                    "remittanceInformationUnstructured": "Groceries shopping"
                },
                {
                    "transactionId": "mock_002",
                    "bookingDate": "2024-01-15",
                    "valueDate": "2024-01-15",
                    "transactionAmount": {
                        "amount": "1200.00",
                        "currency": "GBP"
                    },
                    "creditorName": "Property Management Ltd",
                    "remittanceInformationUnstructured": "Monthly rent"
                },
                {
                    "transactionId": "mock_003",
                    "bookingDate": "2024-01-16",
                    "valueDate": "2024-01-16",
                    "transactionAmount": {
                        "amount": "65.00",
                        "currency": "GBP"
                    },
                    "creditorName": "Pizza Express",
                    "remittanceInformationUnstructured": "Dinner"
                }
            ]
        else:
            # Use real API
            accounts = self.get_accounts()
            if accounts:
                return self.get_transactions(accounts[0]['resourceId'])
            return []
    
    def transform_transaction(self, eb_transaction: Dict) -> Dict:
        """
        Transform Enable Banking transaction to internal format
        
        Args:
            eb_transaction: Enable Banking transaction object
            
        Returns:
            Internal transaction format
        """
        return {
            "id": eb_transaction.get("transactionId"),
            "date": eb_transaction.get("bookingDate"),
            "amount": float(eb_transaction.get("transactionAmount", {}).get("amount", 0)),
            "currency": eb_transaction.get("transactionAmount", {}).get("currency", "GBP"),
            "merchant": eb_transaction.get("creditorName", ""),
            "description": eb_transaction.get("remittanceInformationUnstructured", ""),
            "account_id": eb_transaction.get("accountId", "default"),
            "reference": eb_transaction.get("endToEndId", eb_transaction.get("transactionId"))
        }


class MockASPSPConnector:
    """Mock ASPSP connector for testing without real bank connection"""
    
    def __init__(self):
        """Initialize mock connector"""
        self.accounts = [
            {
                "resourceId": "mock-account-001",
                "iban": "GB33BUKB20201555555555",
                "currency": "GBP",
                "name": "Current Account",
                "product": "Current",
                "cashAccountType": "CACC"
            }
        ]
        
        self.transactions = []
        self.seed_transactions()
    
    def seed_transactions(self):
        """Seed mock transactions for testing"""
        base_date = datetime.now() - timedelta(days=30)
        
        # Generate 30 days of transactions
        for day in range(30):
            date = base_date + timedelta(days=day)
            date_str = date.strftime("%Y-%m-%d")
            
            # Daily transactions
            daily_transactions = [
                {
                    "transactionId": f"tx_{date_str}_001",
                    "bookingDate": date_str,
                    "transactionAmount": {"amount": "12.50", "currency": "GBP"},
                    "creditorName": "Transport for London",
                    "remittanceInformationUnstructured": "Daily commute"
                },
                {
                    "transactionId": f"tx_{date_str}_002",
                    "bookingDate": date_str,
                    "transactionAmount": {"amount": "8.99", "currency": "GBP"},
                    "creditorName": "Pret a Manger",
                    "remittanceInformationUnstructured": "Lunch"
                }
            ]
            
            # Weekly shopping (Sundays)
            if date.weekday() == 6:
                daily_transactions.append({
                    "transactionId": f"tx_{date_str}_003",
                    "bookingDate": date_str,
                    "transactionAmount": {"amount": "85.43", "currency": "GBP"},
                    "creditorName": "Tesco",
                    "remittanceInformationUnstructured": "Weekly shopping"
                })
            
            # Monthly rent (1st of month)
            if date.day == 1:
                daily_transactions.append({
                    "transactionId": f"tx_{date_str}_004",
                    "bookingDate": date_str,
                    "transactionAmount": {"amount": "1200.00", "currency": "GBP"},
                    "creditorName": "Property Management",
                    "remittanceInformationUnstructured": "Monthly rent"
                })
            
            self.transactions.extend(daily_transactions)
    
    def get_accounts(self) -> List[Dict]:
        """Get mock accounts"""
        return self.accounts
    
    def get_transactions(self, account_id: str = None) -> List[Dict]:
        """Get mock transactions"""
        return self.transactions