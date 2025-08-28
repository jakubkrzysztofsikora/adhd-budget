#!/usr/bin/env python3
"""
Database-backed state mapping for OAuth flow.
Stores state mappings persistently to survive container restarts.
"""

import os
import json
import time
import logging
from typing import Optional

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False
    # Create dummy classes for type hints
    class psycopg2:
        class OperationalError(Exception):
            pass
    class RealDictCursor:
        pass

logger = logging.getLogger(__name__)

class StateMapper:
    """Persistent state mapping for OAuth flows"""
    
    def __init__(self):
        self.db_params = {
            "host": os.environ.get("DB_HOST", "db"),
            "port": int(os.environ.get("DB_PORT", 5432)),
            "database": os.environ.get("DB_NAME", "adhd_budget"),
            "user": os.environ.get("DB_USER", "budget_user"),
            "password": os.environ.get("DB_PASSWORD", "")
        }
        # In-memory fallback
        self.memory_mapping = {}
        
        if HAS_PSYCOPG2:
            self._ensure_table()
        else:
            logger.warning("psycopg2 not available, using in-memory state mapping")
    
    def _get_connection(self):
        """Get database connection"""
        return psycopg2.connect(**self.db_params)
    
    def _ensure_table(self):
        """Create state mapping table if it doesn't exist"""
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cursor:
                    cursor.execute("""
                        CREATE TABLE IF NOT EXISTS oauth_state_mapping (
                            eb_state VARCHAR(255) PRIMARY KEY,
                            claude_state VARCHAR(255) NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '10 minutes'
                        )
                    """)
                    # Create index for faster lookups
                    cursor.execute("""
                        CREATE INDEX IF NOT EXISTS idx_oauth_state_mapping_expires 
                        ON oauth_state_mapping(expires_at)
                    """)
                    conn.commit()
                    logger.info("OAuth state mapping table ensured")
        except Exception as e:
            logger.error(f"Failed to create state mapping table: {e}")
            # Fall back to in-memory if DB not available
            pass
    
    def set_mapping(self, eb_state: str, claude_state: str):
        """Store state mapping in database"""
        if not HAS_PSYCOPG2:
            self.memory_mapping[eb_state] = claude_state
            logger.info(f"Stored state mapping in memory: {eb_state} -> {claude_state}")
            return
        
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cursor:
                    # Delete any expired mappings first
                    cursor.execute("""
                        DELETE FROM oauth_state_mapping 
                        WHERE expires_at < CURRENT_TIMESTAMP
                    """)
                    
                    # Insert new mapping
                    cursor.execute("""
                        INSERT INTO oauth_state_mapping (eb_state, claude_state)
                        VALUES (%s, %s)
                        ON CONFLICT (eb_state) 
                        DO UPDATE SET claude_state = EXCLUDED.claude_state,
                                     created_at = CURRENT_TIMESTAMP,
                                     expires_at = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
                    """, (eb_state, claude_state))
                    conn.commit()
                    logger.info(f"Stored state mapping: {eb_state} -> {claude_state}")
        except Exception as e:
            logger.error(f"Failed to store state mapping: {e}")
            raise
    
    def get_mapping(self, eb_state: str) -> Optional[str]:
        """Retrieve Claude state from Enable Banking state"""
        if not HAS_PSYCOPG2:
            return self.memory_mapping.pop(eb_state, None)
        
        try:
            with self._get_connection() as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                    # Get mapping if not expired
                    cursor.execute("""
                        SELECT claude_state FROM oauth_state_mapping 
                        WHERE eb_state = %s AND expires_at > CURRENT_TIMESTAMP
                    """, (eb_state,))
                    result = cursor.fetchone()
                    
                    if result:
                        claude_state = result['claude_state']
                        logger.info(f"Retrieved state mapping: {eb_state} -> {claude_state}")
                        
                        # Delete the mapping after use (one-time use)
                        cursor.execute("""
                            DELETE FROM oauth_state_mapping 
                            WHERE eb_state = %s
                        """, (eb_state,))
                        conn.commit()
                        
                        return claude_state
                    else:
                        logger.warning(f"No mapping found for state: {eb_state}")
                        return None
        except Exception as e:
            logger.error(f"Failed to retrieve state mapping: {e}")
            return None
    
    def cleanup_expired(self):
        """Remove expired state mappings"""
        if not HAS_PSYCOPG2:
            # No expiry in memory mapping
            return
        
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cursor:
                    cursor.execute("""
                        DELETE FROM oauth_state_mapping 
                        WHERE expires_at < CURRENT_TIMESTAMP
                    """)
                    deleted = cursor.rowcount
                    conn.commit()
                    if deleted > 0:
                        logger.info(f"Cleaned up {deleted} expired state mappings")
        except Exception as e:
            logger.error(f"Failed to cleanup expired mappings: {e}")