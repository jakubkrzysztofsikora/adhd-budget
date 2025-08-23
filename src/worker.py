#!/usr/bin/env python3
"""
Worker Service for Enable Banking Data Ingestion
Implements T2 Gate: Data flow integrity with idempotent upserts
"""

import os
import time
import logging
import schedule
import psycopg2
import psycopg2.extras
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
import json
import uuid

from enable_banking import EnableBankingClient, MockASPSPConnector
from categorizer import TransactionCategorizer
from projector import MonthlyProjector
from outlier_detector import OutlierDetector


# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class WorkerService:
    """Worker service for Enable Banking data processing"""
    
    def __init__(self):
        """Initialize worker service"""
        self.db_config = {
            'host': os.getenv('DB_HOST', 'localhost'),
            'port': int(os.getenv('DB_PORT', 5432)),
            'database': os.getenv('DB_NAME', 'adhd_budget'),
            'user': os.getenv('DB_USER', 'budget_user'),
            'password': os.getenv('DB_PASSWORD', '')
        }
        
        # Initialize Enable Banking client for sandbox
        self.eb_client = EnableBankingClient(sandbox=True)
        self.mock_connector = MockASPSPConnector()
        
        # Initialize processing components
        self.categorizer = TransactionCategorizer()
        self.projector = MonthlyProjector()
        self.outlier_detector = OutlierDetector()
        
        # Initialize database
        self.init_database()
        
        logger.info("Worker service initialized")
    
    def init_database(self):
        """Initialize database tables"""
        try:
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor() as cursor:
                    # Create tables if they don't exist
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS transactions (
                            id UUID PRIMARY KEY,
                            external_id VARCHAR(255) UNIQUE NOT NULL,
                            account_id VARCHAR(255),
                            amount DECIMAL(10,2),
                            currency VARCHAR(3),
                            category VARCHAR(100),
                            merchant VARCHAR(255),
                            transaction_date DATE,
                            description TEXT,
                            is_outlier BOOLEAN DEFAULT FALSE,
                            raw_data JSONB,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS daily_summaries (
                            id UUID PRIMARY KEY,
                            summary_date DATE UNIQUE,
                            total_spent DECIMAL(10,2),
                            category_breakdown JSONB,
                            pace_projection DECIMAL(10,2),
                            outlier_adjusted_pace DECIMAL(10,2),
                            projected_balance DECIMAL(10,2),
                            sent_at TIMESTAMP,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS budget_goals (
                            id UUID PRIMARY KEY,
                            category VARCHAR(100),
                            monthly_limit DECIMAL(10,2),
                            priority INTEGER,
                            active BOOLEAN DEFAULT TRUE,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS oauth_tokens (
                            id UUID PRIMARY KEY,
                            user_id VARCHAR(255) UNIQUE,
                            access_token TEXT,
                            refresh_token TEXT,
                            expires_at TIMESTAMP,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                    
                    # Create indexes for performance
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_transactions_date 
                        ON transactions(transaction_date);
                    """)
                    
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_transactions_external_id 
                        ON transactions(external_id);
                    """)
                    
                    conn.commit()
                    logger.info("Database initialized successfully")
                    
        except Exception as e:
            logger.error(f"Database initialization error: {str(e)}")
            raise
    
    def sync_transactions(self) -> Dict[str, Any]:
        """
        Sync transactions from Enable Banking with idempotent upserts
        Implements T2 gate requirement
        """
        logger.info("Starting transaction sync...")
        
        try:
            # Get transactions from Mock ASPSP (sandbox)
            raw_transactions = self.mock_connector.get_transactions()
            
            sync_stats = {
                'processed': 0,
                'inserted': 0,
                'updated': 0,
                'errors': 0,
                'start_time': datetime.now()
            }
            
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    
                    for raw_transaction in raw_transactions:
                        try:
                            # Transform transaction to internal format
                            transaction = self._transform_transaction(raw_transaction)
                            
                            # Categorize transaction
                            transaction['category'] = self.categorizer.categorize(
                                transaction['description'], 
                                transaction['merchant']
                            )
                            
                            # Detect outliers
                            transaction['is_outlier'] = self.outlier_detector.is_outlier(
                                transaction['amount'],
                                transaction['category']
                            )
                            
                            # Idempotent upsert
                            upsert_result = self._upsert_transaction(cursor, transaction)
                            
                            if upsert_result == 'inserted':
                                sync_stats['inserted'] += 1
                            elif upsert_result == 'updated':
                                sync_stats['updated'] += 1
                                
                            sync_stats['processed'] += 1
                            
                        except Exception as e:
                            logger.error(f"Error processing transaction {raw_transaction.get('transactionId', 'unknown')}: {str(e)}")
                            sync_stats['errors'] += 1
                    
                    conn.commit()
            
            sync_stats['end_time'] = datetime.now()
            sync_stats['duration'] = (sync_stats['end_time'] - sync_stats['start_time']).total_seconds()
            
            logger.info(f"Transaction sync completed: {sync_stats}")
            return sync_stats
            
        except Exception as e:
            logger.error(f"Transaction sync failed: {str(e)}")
            raise
    
    def _transform_transaction(self, raw_transaction: Dict) -> Dict:
        """Transform Enable Banking transaction to internal format"""
        return {
            'id': str(uuid.uuid4()),
            'external_id': raw_transaction['transactionId'],
            'account_id': raw_transaction.get('accountId', 'mock-account-001'),
            'amount': float(raw_transaction['transactionAmount']['amount']),
            'currency': raw_transaction['transactionAmount']['currency'],
            'merchant': raw_transaction.get('creditorName', ''),
            'transaction_date': raw_transaction['bookingDate'],
            'description': raw_transaction.get('remittanceInformationUnstructured', ''),
            'raw_data': raw_transaction
        }
    
    def _upsert_transaction(self, cursor, transaction: Dict) -> str:
        """
        Perform idempotent upsert of transaction
        Returns: 'inserted', 'updated', or 'unchanged'
        """
        # Check if transaction exists
        cursor.execute(
            "SELECT id, updated_at FROM transactions WHERE external_id = %s",
            (transaction['external_id'],)
        )
        existing = cursor.fetchone()
        
        if existing:
            # Update existing transaction
            cursor.execute("""
                UPDATE transactions SET
                    amount = %s,
                    currency = %s,
                    category = %s,
                    merchant = %s,
                    transaction_date = %s,
                    description = %s,
                    is_outlier = %s,
                    raw_data = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE external_id = %s
            """, (
                transaction['amount'],
                transaction['currency'],
                transaction['category'],
                transaction['merchant'],
                transaction['transaction_date'],
                transaction['description'],
                transaction['is_outlier'],
                json.dumps(transaction['raw_data']),
                transaction['external_id']
            ))
            return 'updated'
        else:
            # Insert new transaction
            cursor.execute("""
                INSERT INTO transactions (
                    id, external_id, account_id, amount, currency, category,
                    merchant, transaction_date, description, is_outlier, raw_data
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                transaction['id'],
                transaction['external_id'],
                transaction['account_id'],
                transaction['amount'],
                transaction['currency'],
                transaction['category'],
                transaction['merchant'],
                transaction['transaction_date'],
                transaction['description'],
                transaction['is_outlier'],
                json.dumps(transaction['raw_data'])
            ))
            return 'inserted'
    
    def generate_daily_summary(self, target_date: str = None) -> Dict[str, Any]:
        """
        Generate daily summary for specified date (T5 gate requirement)
        
        Args:
            target_date: Date in YYYY-MM-DD format (defaults to yesterday)
        """
        if not target_date:
            yesterday = datetime.now() - timedelta(days=1)
            target_date = yesterday.strftime('%Y-%m-%d')
        
        logger.info(f"Generating daily summary for {target_date}")
        
        try:
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    
                    # Get transactions for the target date
                    cursor.execute("""
                        SELECT * FROM transactions 
                        WHERE transaction_date = %s AND amount > 0
                        ORDER BY amount DESC
                    """, (target_date,))
                    
                    transactions = cursor.fetchall()
                    
                    if not transactions:
                        logger.info(f"No transactions found for {target_date}")
                        return {"error": f"No transactions for {target_date}"}
                    
                    # Calculate totals
                    total_spent = sum(float(t['amount']) for t in transactions)
                    
                    # Category breakdown
                    category_breakdown = {}
                    for t in transactions:
                        category = t['category'] or 'uncategorized'
                        category_breakdown[category] = category_breakdown.get(category, 0) + float(t['amount'])
                    
                    # Get monthly projection
                    pace_projection = self.projector.calculate_monthly_pace(transactions)
                    
                    # Outlier analysis
                    outliers = [t for t in transactions if t['is_outlier']]
                    outlier_adjusted_pace = self.projector.calculate_outlier_adjusted_pace(transactions)
                    
                    # Budget comparison
                    monthly_budget = 3500.00  # TODO: Get from budget_goals table
                    projected_balance = monthly_budget - pace_projection
                    
                    summary = {
                        'date': target_date,
                        'total_spent': round(total_spent, 2),
                        'category_breakdown': {k: round(v, 2) for k, v in category_breakdown.items()},
                        'pace_projection': round(pace_projection, 2),
                        'outlier_adjusted_pace': round(outlier_adjusted_pace, 2),
                        'projected_balance': round(projected_balance, 2),
                        'transaction_count': len(transactions),
                        'outlier_count': len(outliers),
                        'vs_budget': {
                            'monthly_budget': monthly_budget,
                            'pace_status': 'over' if pace_projection > monthly_budget else 'under',
                            'variance': round(pace_projection - monthly_budget, 2)
                        }
                    }
                    
                    # Store summary in database (idempotent)
                    self._upsert_daily_summary(cursor, summary)
                    conn.commit()
                    
                    logger.info(f"Daily summary generated: {summary}")
                    return summary
                    
        except Exception as e:
            logger.error(f"Daily summary generation failed: {str(e)}")
            raise
    
    def _upsert_daily_summary(self, cursor, summary: Dict):
        """Upsert daily summary to database"""
        cursor.execute("""
            INSERT INTO daily_summaries (
                id, summary_date, total_spent, category_breakdown,
                pace_projection, outlier_adjusted_pace, projected_balance
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (summary_date) DO UPDATE SET
                total_spent = EXCLUDED.total_spent,
                category_breakdown = EXCLUDED.category_breakdown,
                pace_projection = EXCLUDED.pace_projection,
                outlier_adjusted_pace = EXCLUDED.outlier_adjusted_pace,
                projected_balance = EXCLUDED.projected_balance
        """, (
            str(uuid.uuid4()),
            summary['date'],
            summary['total_spent'],
            json.dumps(summary['category_breakdown']),
            summary['pace_projection'],
            summary['outlier_adjusted_pace'],
            summary['projected_balance']
        ))
    
    def run_daily_jobs(self):
        """Run daily scheduled jobs (T5 gate: 08:00-08:10)"""
        logger.info("Running daily jobs...")
        
        try:
            # 1. Sync transactions
            sync_stats = self.sync_transactions()
            
            # 2. Generate daily summary
            summary = self.generate_daily_summary()
            
            # 3. TODO: Send WhatsApp summary (M1 gate)
            # self.send_whatsapp_summary(summary)
            
            logger.info("Daily jobs completed successfully")
            return {
                'status': 'success',
                'sync_stats': sync_stats,
                'summary': summary,
                'timestamp': datetime.now().isoformat()
            }
            
        except Exception as e:
            logger.error(f"Daily jobs failed: {str(e)}")
            return {
                'status': 'error',
                'error': str(e),
                'timestamp': datetime.now().isoformat()
            }
    
    def health_check(self) -> Dict[str, Any]:
        """Health check for worker service"""
        try:
            # Check database connection
            with psycopg2.connect(**self.db_config) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT 1")
            
            db_status = "healthy"
        except Exception as e:
            db_status = f"error: {str(e)}"
        
        return {
            'status': 'healthy' if db_status == 'healthy' else 'unhealthy',
            'database': db_status,
            'timestamp': datetime.now().isoformat(),
            'version': '1.0.0'
        }


def main():
    """Main worker loop"""
    logger.info("Starting Enable Banking Worker Service")
    
    # Initialize worker
    worker = WorkerService()
    
    # Schedule daily job between 08:00-08:10
    import random
    daily_minute = random.randint(0, 10)  # Random minute between 08:00-08:10
    schedule_time = f"08:{daily_minute:02d}"
    
    schedule.every().day.at(schedule_time).do(worker.run_daily_jobs)
    logger.info(f"Daily jobs scheduled at {schedule_time}")
    
    # Run initial sync
    logger.info("Running initial transaction sync...")
    worker.sync_transactions()
    
    # Main loop
    while True:
        try:
            schedule.run_pending()
            time.sleep(60)  # Check every minute
            
        except KeyboardInterrupt:
            logger.info("Worker service shutting down...")
            break
        except Exception as e:
            logger.error(f"Worker loop error: {str(e)}")
            time.sleep(60)


if __name__ == "__main__":
    main()