"""
Test Suite: T3 - Categorization Accuracy (≥80% required)
Gate: T3
"""

import json
import pytest
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'src'))

from categorizer import TransactionCategorizer


class TestCategorization:
    """Test suite for T3 - Categorization accuracy gate"""
    
    @pytest.fixture
    def categorizer(self):
        """Initialize categorizer instance"""
        return TransactionCategorizer()
    
    @pytest.fixture
    def labeled_transactions(self):
        """Load labeled test data"""
        fixtures_path = Path(__file__).parent.parent / 'fixtures' / 'transactions.json'
        if fixtures_path.exists():
            with open(fixtures_path, 'r') as f:
                return json.load(f)
        return []
    
    def test_categorization_accuracy(self, categorizer, labeled_transactions):
        """
        T3 Gate Test: Verify categorization accuracy ≥ 80%
        """
        if not labeled_transactions:
            pytest.skip("No test data available")
            
        correct = 0
        total = len(labeled_transactions)
        mismatches = []
        
        for transaction in labeled_transactions:
            predicted = categorizer.categorize(transaction)
            expected = transaction['expected_category']
            
            if predicted == expected:
                correct += 1
            else:
                mismatches.append({
                    'transaction': transaction['description'],
                    'expected': expected,
                    'predicted': predicted
                })
        
        accuracy = (correct / total) * 100
        
        # Log mismatches for debugging
        if mismatches:
            print(f"\nMismatched categories ({len(mismatches)}):")
            for m in mismatches:
                print(f"  - {m['transaction']}: expected '{m['expected']}', got '{m['predicted']}'")
        
        print(f"\nCategorization Accuracy: {accuracy:.1f}% ({correct}/{total} correct)")
        
        # T3 GATE: Require ≥80% accuracy
        assert accuracy >= 80.0, f"T3 FAILED: Categorization accuracy {accuracy:.1f}% < 80% required"
    
    def test_category_distribution(self, categorizer, labeled_transactions):
        """Test that all major categories are represented"""
        if not labeled_transactions:
            pytest.skip("No test data available")
            
        predicted_categories = set()
        
        for transaction in labeled_transactions:
            category = categorizer.categorize(transaction)
            predicted_categories.add(category)
        
        required_categories = {'groceries', 'transport', 'eating_out', 'bills'}
        missing = required_categories - predicted_categories
        
        assert not missing, f"Missing required categories: {missing}"
    
    def test_deterministic_categorization(self, categorizer):
        """Test that categorization is deterministic"""
        test_transaction = {
            "merchant": "Tesco",
            "description": "Tesco Groceries",
            "amount": 45.20
        }
        
        # Run 10 times and ensure same result
        results = [categorizer.categorize(test_transaction) for _ in range(10)]
        assert len(set(results)) == 1, "Categorization is not deterministic"
    
    def test_edge_cases(self, categorizer):
        """Test edge cases and malformed inputs"""
        edge_cases = [
            {"merchant": "", "description": ""},  # Empty
            {"merchant": None, "description": None},  # None values
            {"description": "UBER EATS"},  # Uppercase
            {"merchant": "uber/taxi", "description": "Transport: Uber"},  # Special chars
        ]
        
        for transaction in edge_cases:
            # Should not raise exception
            category = categorizer.categorize(transaction)
            assert isinstance(category, str)
            assert category in ['transport', 'eating_out', 'other']


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])