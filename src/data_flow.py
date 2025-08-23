"""
Data Flow Manager Module
Implements T2 Gate: Data flow integrity (Enable Banking → DB)
"""

from typing import Dict, List, Any, Optional
from datetime import datetime
import hashlib
import json


class DataFlowManager:
    """Manages data flow from Enable Banking to database"""
    
    def __init__(self):
        """Initialize data flow manager"""
        self.processed_transactions = {}  # Simple in-memory store for testing
        self.consent_status = "active"
        self.last_fetch = None
    
    def fetch_from_enable_banking(self, account_id: str) -> List[Dict[str, Any]]:
        """
        Fetch transactions from Enable Banking API
        
        Args:
            account_id: Bank account identifier
            
        Returns:
            List of transaction dicts
        """
        from enable_banking import EnableBankingClient
        
        # Use Enable Banking client
        client = EnableBankingClient(sandbox=True)
        
        # Get mock transactions for testing
        eb_transactions = client.get_mock_transactions()
        
        # Transform to internal format
        return [client.transform_transaction(tx) for tx in eb_transactions]
    
    def upsert_transaction(self, transaction: Dict[str, Any]) -> bool:
        """
        Idempotent upsert of transaction
        
        Args:
            transaction: Transaction dict
            
        Returns:
            True if inserted/updated, False if duplicate
        """
        # Generate hash for idempotency
        tx_hash = self._generate_transaction_hash(transaction)
        
        # Check if already processed
        if tx_hash in self.processed_transactions:
            existing = self.processed_transactions[tx_hash]
            # Check if identical
            if existing == transaction:
                return False  # Duplicate, no action
        
        # Store transaction
        self.processed_transactions[tx_hash] = transaction
        return True
    
    def process_batch(self, transactions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Process batch of transactions
        
        Args:
            transactions: List of transactions
            
        Returns:
            Processing result stats
        """
        results = {
            "total": len(transactions),
            "inserted": 0,
            "duplicates": 0,
            "errors": 0
        }
        
        for transaction in transactions:
            try:
                if self.upsert_transaction(transaction):
                    results["inserted"] += 1
                else:
                    results["duplicates"] += 1
            except Exception as e:
                results["errors"] += 1
        
        return results
    
    def check_consent_status(self) -> str:
        """
        Check Enable Banking consent status
        
        Returns:
            Consent status: active, expired, or needs_refresh
        """
        # Mock implementation
        return self.consent_status
    
    def refresh_consent(self) -> bool:
        """
        Refresh Enable Banking consent
        
        Returns:
            True if successful
        """
        # Mock re-consent flow
        self.consent_status = "active"
        return True
    
    def _generate_transaction_hash(self, transaction: Dict[str, Any]) -> str:
        """
        Generate unique hash for transaction
        
        Args:
            transaction: Transaction dict
            
        Returns:
            SHA256 hash string
        """
        # Use key fields for hash
        key_fields = {
            "account_id": transaction.get("account_id"),
            "date": transaction.get("date"),
            "amount": transaction.get("amount"),
            "reference": transaction.get("reference")
        }
        
        # Create stable JSON string
        json_str = json.dumps(key_fields, sort_keys=True)
        
        # Generate hash
        return hashlib.sha256(json_str.encode()).hexdigest()
    
    def get_transaction_count(self) -> int:
        """Get count of processed transactions"""
        return len(self.processed_transactions)
    
    def clear_all(self):
        """Clear all stored transactions (for testing)"""
        self.processed_transactions.clear()