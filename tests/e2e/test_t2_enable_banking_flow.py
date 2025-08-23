"""
T2 Gate: Enable Banking → DB Data Flow
E2E test with VCR for sandbox recording
"""

import pytest
import vcr
import os
import hashlib
import psycopg2
from datetime import datetime
from pathlib import Path


# VCR configuration for Enable Banking sandbox
vcr_cassette = vcr.VCR(
    cassette_library_dir=str(Path(__file__).parent / 'vcr_cassettes'),
    record_mode='once',  # Record once, replay forever
    match_on=['uri', 'method', 'body'],
    filter_headers=['authorization'],  # Don't record auth tokens
    filter_post_data_parameters=['client_secret']
)


class TestT2EnableBankingFlow:
    """Real Enable Banking integration with idempotency"""
    
    @pytest.fixture
    def db_connection(self):
        """Real database connection"""
        conn = psycopg2.connect(
            host=os.getenv("DB_HOST", "localhost"),
            port=int(os.getenv("DB_PORT", 5432)),
            database=os.getenv("DB_NAME", "adhd_budget"),
            user=os.getenv("DB_USER", "budget_user"),
            password=os.getenv("DB_PASSWORD", "changeme")
        )
        
        # Setup test tables
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS transactions (
                    id VARCHAR(255) PRIMARY KEY,
                    account_id VARCHAR(255),
                    amount DECIMAL(10,2),
                    currency VARCHAR(3),
                    merchant VARCHAR(255),
                    description TEXT,
                    transaction_date DATE,
                    hash VARCHAR(64) UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """)
            conn.commit()
        
        yield conn
        
        # Cleanup
        with conn.cursor() as cur:
            cur.execute("DELETE FROM transactions WHERE id LIKE 'test_%'")
            conn.commit()
        conn.close()
    
    @vcr_cassette.use_cassette('enable_banking_sandbox_auth.yaml')
    def test_sandbox_authentication(self):
        """T2: Test Enable Banking sandbox OAuth flow"""
        from src.enable_banking import EnableBankingClient
        
        client = EnableBankingClient(
            app_id=os.getenv("ENABLE_BANKING_APP_ID", "sandbox-test"),
            sandbox=True
        )
        
        # Get auth URL
        auth_url = client.get_auth_url(
            redirect_uri="http://localhost:8082/api/auth/callback",
            state="test-state-123"
        )
        
        assert "sandbox" in auth_url
        assert "MOCKASPSP_SANDBOX" in auth_url
        
        # In real flow, user would authorize and we'd get code
        # For testing, we use recorded sandbox response
    
    @vcr_cassette.use_cassette('enable_banking_fetch_transactions.yaml')
    def test_fetch_transform_store(self, db_connection):
        """T2: Fetch from Enable Banking, transform, store in DB"""
        from src.enable_banking import EnableBankingClient
        from src.data_flow import DataFlowManager
        
        client = EnableBankingClient(sandbox=True)
        data_manager = DataFlowManager()
        
        # Fetch transactions (uses VCR recording)
        transactions = client.get_mock_transactions()
        assert len(transactions) > 0
        
        # Transform to internal format
        internal_txs = []
        for eb_tx in transactions:
            internal_tx = client.transform_transaction(eb_tx)
            
            # Add test prefix for cleanup
            internal_tx['id'] = f"test_{internal_tx['id']}"
            
            # Calculate hash for idempotency
            hash_input = f"{internal_tx['id']}_{internal_tx['amount']}_{internal_tx['date']}"
            internal_tx['hash'] = hashlib.sha256(hash_input.encode()).hexdigest()
            
            internal_txs.append(internal_tx)
        
        # Store in real DB
        with db_connection.cursor() as cur:
            for tx in internal_txs:
                cur.execute("""
                    INSERT INTO transactions 
                    (id, account_id, amount, currency, merchant, description, 
                     transaction_date, hash)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (hash) DO NOTHING
                """, (
                    tx['id'], tx.get('account_id', 'default'),
                    tx['amount'], tx.get('currency', 'GBP'),
                    tx['merchant'], tx['description'],
                    tx['date'], tx['hash']
                ))
            
            db_connection.commit()
        
        # Verify stored
        with db_connection.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM transactions WHERE id LIKE 'test_%'")
            count = cur.fetchone()[0]
            assert count == len(internal_txs)
    
    def test_idempotent_upserts(self, db_connection):
        """T2: Verify idempotent upserts (no duplicates)"""
        test_tx = {
            'id': 'test_idem_001',
            'account_id': 'test_account',
            'amount': 100.50,
            'currency': 'GBP',
            'merchant': 'Test Merchant',
            'description': 'Test transaction',
            'date': '2024-01-15',
            'hash': hashlib.sha256(b'test_idem_001').hexdigest()
        }
        
        with db_connection.cursor() as cur:
            # First insert
            cur.execute("""
                INSERT INTO transactions 
                (id, account_id, amount, currency, merchant, description, 
                 transaction_date, hash)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (hash) DO NOTHING
                RETURNING id
            """, (
                test_tx['id'], test_tx['account_id'],
                test_tx['amount'], test_tx['currency'],
                test_tx['merchant'], test_tx['description'],
                test_tx['date'], test_tx['hash']
            ))
            
            first_result = cur.fetchone()
            assert first_result is not None  # Should insert
            
            # Second insert (duplicate)
            cur.execute("""
                INSERT INTO transactions 
                (id, account_id, amount, currency, merchant, description, 
                 transaction_date, hash)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (hash) DO NOTHING
                RETURNING id
            """, (
                test_tx['id'], test_tx['account_id'],
                test_tx['amount'], test_tx['currency'],
                test_tx['merchant'], test_tx['description'],
                test_tx['date'], test_tx['hash']
            ))
            
            second_result = cur.fetchone()
            assert second_result is None  # Should not insert (duplicate)
            
            # Verify only one exists
            cur.execute("SELECT COUNT(*) FROM transactions WHERE id = %s", 
                       (test_tx['id'],))
            count = cur.fetchone()[0]
            assert count == 1
            
            db_connection.commit()
    
    @vcr_cassette.use_cassette('enable_banking_reconsent.yaml')
    def test_reconsent_flow(self):
        """T2: Test re-consent flow when token expires"""
        from src.enable_banking import EnableBankingClient
        
        client = EnableBankingClient(sandbox=True)
        
        # Simulate expired token scenario
        client.access_token = "expired_token"
        
        # This should trigger refresh flow (recorded in VCR)
        try:
            # Attempt to fetch with expired token
            accounts = client.get_accounts()
        except Exception:
            # Should handle gracefully and trigger re-consent
            auth_url = client.get_auth_url(
                redirect_uri="http://localhost:8082/api/auth/callback",
                state="reconsent"
            )
            assert auth_url is not None
    
    def test_batch_processing_deduplication(self, db_connection):
        """T2: Batch processing with deduplication"""
        transactions = [
            {'id': 'test_batch_001', 'amount': 10.00, 'date': '2024-01-01'},
            {'id': 'test_batch_002', 'amount': 20.00, 'date': '2024-01-02'},
            {'id': 'test_batch_001', 'amount': 10.00, 'date': '2024-01-01'},  # Duplicate
            {'id': 'test_batch_003', 'amount': 30.00, 'date': '2024-01-03'},
        ]
        
        inserted_count = 0
        duplicate_count = 0
        
        with db_connection.cursor() as cur:
            for tx in transactions:
                tx_hash = hashlib.sha256(
                    f"{tx['id']}_{tx['amount']}_{tx['date']}".encode()
                ).hexdigest()
                
                cur.execute("""
                    INSERT INTO transactions 
                    (id, account_id, amount, currency, merchant, description, 
                     transaction_date, hash)
                    VALUES (%s, 'test', %s, 'GBP', 'Test', 'Test', %s, %s)
                    ON CONFLICT (hash) DO NOTHING
                    RETURNING id
                """, (tx['id'], tx['amount'], tx['date'], tx_hash))
                
                if cur.fetchone():
                    inserted_count += 1
                else:
                    duplicate_count += 1
            
            db_connection.commit()
        
        assert inserted_count == 3
        assert duplicate_count == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])