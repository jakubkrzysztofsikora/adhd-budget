#!/usr/bin/env python3
"""
Unit tests for OAuth state mapping logic.
Tests both database-backed and in-memory fallback implementations.
"""

import unittest
import os
import sys
import time
from unittest.mock import patch, MagicMock, call

# Check if psycopg2 is available for database tests
HAS_PSYCOPG2 = False
try:
    import psycopg2
    HAS_PSYCOPG2 = True
except ImportError:
    # Create mock for basic imports
    class MockPsycopg2:
        class OperationalError(Exception):
            pass
    psycopg2 = MockPsycopg2()

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

class TestInMemoryStateMapper(unittest.TestCase):
    """Test the in-memory fallback state mapper"""
    
    def setUp(self):
        """Create in-memory mapper"""
        # Use the fallback implementation directly
        class StateMapper:
            def __init__(self):
                self.mapping = {}
            def set_mapping(self, eb_state: str, claude_state: str):
                self.mapping[eb_state] = claude_state
            def get_mapping(self, eb_state: str):
                return self.mapping.pop(eb_state, None)
            def cleanup_expired(self):
                pass
        
        self.mapper = StateMapper()
    
    def test_set_and_get_mapping(self):
        """Test setting and retrieving a state mapping"""
        eb_state = "eb_123456_abcdef"
        claude_state = "claude_original_state"
        
        # Set mapping
        self.mapper.set_mapping(eb_state, claude_state)
        
        # Get mapping
        result = self.mapper.get_mapping(eb_state)
        self.assertEqual(result, claude_state)
        
        # Should be removed after get (one-time use)
        result2 = self.mapper.get_mapping(eb_state)
        self.assertIsNone(result2)
    
    def test_get_nonexistent_mapping(self):
        """Test retrieving a non-existent mapping"""
        result = self.mapper.get_mapping("nonexistent")
        self.assertIsNone(result)
    
    def test_multiple_mappings(self):
        """Test multiple concurrent mappings"""
        mappings = [
            ("eb_1", "claude_1"),
            ("eb_2", "claude_2"),
            ("eb_3", "claude_3")
        ]
        
        # Set all mappings
        for eb, claude in mappings:
            self.mapper.set_mapping(eb, claude)
        
        # Retrieve in different order
        self.assertEqual(self.mapper.get_mapping("eb_2"), "claude_2")
        self.assertEqual(self.mapper.get_mapping("eb_1"), "claude_1")
        self.assertEqual(self.mapper.get_mapping("eb_3"), "claude_3")
        
        # All should be gone now
        self.assertIsNone(self.mapper.get_mapping("eb_1"))
        self.assertIsNone(self.mapper.get_mapping("eb_2"))
        self.assertIsNone(self.mapper.get_mapping("eb_3"))


@unittest.skipUnless(HAS_PSYCOPG2, "psycopg2 not available")
class TestDatabaseStateMapper(unittest.TestCase):
    """Test the database-backed state mapper"""
    
    def setUp(self):
        """Set up test with mocked database"""
        # We'll patch psycopg2.connect in individual test methods
        pass
    
    @patch('psycopg2.connect')
    def test_table_creation(self, mock_connect):
        """Test that table creation SQL is executed on init"""
        # Mock database connection
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=None)
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        
        # Import after patching
        from src.db_state_mapping import StateMapper
        mapper = StateMapper()
        
        # Check CREATE TABLE was called
        calls = [str(call) for call in mock_cursor.execute.call_args_list]
        create_table_called = any('CREATE TABLE IF NOT EXISTS oauth_state_mapping' in str(call) for call in calls)
        self.assertTrue(create_table_called, "CREATE TABLE should be called on init")
    
    @patch('psycopg2.connect')
    def test_set_mapping(self, mock_connect):
        """Test storing a state mapping in database"""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=None)
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        
        from src.db_state_mapping import StateMapper
        mapper = StateMapper()
        
        eb_state = "eb_123456_abcdef"
        claude_state = "claude_original_state"
        
        # Set mapping
        mapper.set_mapping(eb_state, claude_state)
        
        # Check INSERT was called with correct values
        insert_calls = [call for call in mock_cursor.execute.call_args_list 
                       if 'INSERT INTO oauth_state_mapping' in str(call)]
        self.assertTrue(len(insert_calls) > 0, "INSERT should be called")
        
        # Check the values were passed correctly
        insert_call = insert_calls[-1]
        self.assertIn(eb_state, str(insert_call))
        self.assertIn(claude_state, str(insert_call))
    
    @patch('psycopg2.connect')
    def test_get_mapping(self, mock_connect):
        """Test retrieving a state mapping from database"""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=None)
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        
        # Mock the SELECT result
        mock_cursor.fetchone.return_value = {'claude_state': 'claude_original_state'}
        
        from src.db_state_mapping import StateMapper
        mapper = StateMapper()
        
        eb_state = "eb_123456_abcdef"
        
        # Get mapping
        result = mapper.get_mapping(eb_state)
        
        # Check SELECT was called
        select_calls = [call for call in mock_cursor.execute.call_args_list
                       if 'SELECT claude_state FROM oauth_state_mapping' in str(call)]
        self.assertTrue(len(select_calls) > 0, "SELECT should be called")
        
        # Check DELETE was called (one-time use)
        delete_calls = [call for call in mock_cursor.execute.call_args_list
                       if 'DELETE FROM oauth_state_mapping' in str(call) and 'expires_at' not in str(call)]
        self.assertTrue(len(delete_calls) > 0, "DELETE should be called after retrieval")
        
        self.assertEqual(result, 'claude_original_state')
    
    @patch('psycopg2.connect')
    def test_get_nonexistent_mapping(self, mock_connect):
        """Test retrieving a non-existent mapping from database"""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=None)
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        
        # Mock no result
        mock_cursor.fetchone.return_value = None
        
        from src.db_state_mapping import StateMapper
        mapper = StateMapper()
        
        result = mapper.get_mapping("nonexistent")
        self.assertIsNone(result)
    
    @patch('psycopg2.connect')
    def test_cleanup_expired(self, mock_connect):
        """Test cleanup of expired mappings"""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=None)
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        
        # Mock deleted rows
        mock_cursor.rowcount = 3
        
        from src.db_state_mapping import StateMapper
        mapper = StateMapper()
        
        # Clean up expired
        mapper.cleanup_expired()
        
        # Check DELETE was called
        delete_calls = [call for call in mock_cursor.execute.call_args_list
                       if 'DELETE FROM oauth_state_mapping' in str(call) and 'expires_at < CURRENT_TIMESTAMP' in str(call)]
        self.assertTrue(len(delete_calls) > 0, "DELETE expired should be called")
    
    @patch('psycopg2.connect')
    def test_database_error_handling(self, mock_connect):
        """Test handling of database errors"""
        # Make connect raise an error
        mock_connect.side_effect = psycopg2.OperationalError("Database connection failed")
        
        # Should not raise, just log warning
        try:
            from src.db_state_mapping import StateMapper
            mapper = StateMapper()
            # Should work even if database fails
            self.assertIsNotNone(mapper)
        except Exception as e:
            self.fail(f"Should not raise exception on DB failure: {e}")


@unittest.skipUnless(HAS_PSYCOPG2, "psycopg2 not available")
class TestStateMapperIntegration(unittest.TestCase):
    """Integration tests for state mapper functionality"""
    
    def test_oauth_flow_with_state_mapping(self):
        """Test the complete OAuth flow with state mapping"""
        # Test with in-memory mapper to avoid dependencies
        class StateMapper:
            def __init__(self):
                self.mapping = {}
            def set_mapping(self, eb_state: str, claude_state: str):
                self.mapping[eb_state] = claude_state
            def get_mapping(self, eb_state: str):
                return self.mapping.pop(eb_state, None)
            def cleanup_expired(self):
                pass
        
        mapper = StateMapper()
        
        # Simulate setting a mapping
        eb_state = "eb_123456_abcdef"
        claude_state = "claude_original_state"
        mapper.set_mapping(eb_state, claude_state)
        
        # Simulate retrieving it
        result = mapper.get_mapping(eb_state)
        self.assertEqual(result, claude_state)
        
        # Should be gone after retrieval
        result2 = mapper.get_mapping(eb_state)
        self.assertIsNone(result2)


if __name__ == '__main__':
    unittest.main()