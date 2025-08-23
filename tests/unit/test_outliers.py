"""
Test Suite: T3 - Outlier Detection (<10% false positives required)
Gate: T3
"""

import json
import pytest
import statistics
from pathlib import Path
from typing import Dict, List, Tuple

# Mock implementation - replace with actual imports
class OutlierDetector:
    """Mock outlier detector - replace with actual implementation"""
    
    def __init__(self, zscore_threshold: float = 2.0, budget_percentage: float = 0.2):
        """
        Initialize outlier detector
        Args:
            zscore_threshold: Number of standard deviations for outlier (default 2.0)
            budget_percentage: Percentage of monthly budget for outlier (default 20%)
        """
        self.zscore_threshold = zscore_threshold
        self.budget_percentage = budget_percentage
    
    def detect_outliers(self, transactions: List[Dict], monthly_budget: float = 3000.0) -> List[Dict]:
        """
        Detect outliers using statistical and budget-based rules
        Rules:
        1. Transaction > mean + (zscore_threshold * std_dev)
        2. Transaction > budget_percentage * monthly_budget
        """
        if not transactions:
            return []
        
        amounts = [t['amount'] for t in transactions]
        
        # Statistical outliers (z-score)
        mean = statistics.mean(amounts)
        std_dev = statistics.stdev(amounts) if len(amounts) > 1 else 0
        statistical_threshold = mean + (self.zscore_threshold * std_dev)
        
        # Budget-based outliers
        budget_threshold = monthly_budget * self.budget_percentage
        
        outliers = []
        for transaction in transactions:
            amount = transaction['amount']
            is_outlier = False
            reason = []
            
            if std_dev > 0 and amount > statistical_threshold:
                is_outlier = True
                reason.append(f"statistical (>{statistical_threshold:.2f})")
            
            if amount > budget_threshold:
                is_outlier = True
                reason.append(f"budget (>{budget_threshold:.2f})")
            
            if is_outlier:
                outliers.append({
                    **transaction,
                    'is_outlier': True,
                    'outlier_reason': ', '.join(reason)
                })
        
        return outliers
    
    def calculate_adjusted_pace(self, 
                               daily_spend: float,
                               outlier_total: float,
                               day_of_month: int) -> float:
        """Calculate pace excluding outliers"""
        adjusted_daily = daily_spend - (outlier_total / day_of_month) if day_of_month > 0 else 0
        return adjusted_daily * 30  # Simplified monthly projection


class TestOutliers:
    """Test suite for T3 - Outlier detection gate"""
    
    @pytest.fixture
    def detector(self):
        """Initialize outlier detector"""
        return OutlierDetector(zscore_threshold=2.0, budget_percentage=0.2)
    
    @pytest.fixture
    def synthetic_dataset(self):
        """14-day synthetic dataset with known outliers"""
        # Load from fixtures if available
        fixtures_path = Path(__file__).parent.parent / 'fixtures' / 'synthetic_14day.json'
        if fixtures_path.exists():
            with open(fixtures_path, 'r') as f:
                data = json.load(f)
                # Flatten transactions from daily structure
                all_transactions = []
                for day in data['days']:
                    all_transactions.extend(day['transactions'])
                # Add expected_outlier field based on is_outlier
                for t in all_transactions:
                    t['expected_outlier'] = t.get('is_outlier', False)
                return {
                    'transactions': all_transactions,
                    'monthly_budget': data['monthly_budget'],
                    'total_outliers': data['summary']['total_outliers'],
                    'total_transactions': len(all_transactions)
                }
        
        # Fallback synthetic data
        return {
            'transactions': [
                # Normal daily transactions
                {'id': '1', 'amount': 45.20, 'description': 'Groceries', 'expected_outlier': False},
                {'id': '2', 'amount': 12.50, 'description': 'Transport', 'expected_outlier': False},
                {'id': '3', 'amount': 65.00, 'description': 'Eating out', 'expected_outlier': False},
                {'id': '4', 'amount': 34.99, 'description': 'Shopping', 'expected_outlier': False},
                {'id': '5', 'amount': 24.99, 'description': 'Subscription', 'expected_outlier': False},
                {'id': '6', 'amount': 78.43, 'description': 'Weekly shop', 'expected_outlier': False},
                {'id': '7', 'amount': 15.00, 'description': 'Coffee', 'expected_outlier': False},
                {'id': '8', 'amount': 89.00, 'description': 'Utilities', 'expected_outlier': False},
                {'id': '9', 'amount': 42.30, 'description': 'Fuel', 'expected_outlier': False},
                {'id': '10', 'amount': 28.50, 'description': 'Pharmacy', 'expected_outlier': False},
                # Known outliers
                {'id': '11', 'amount': 1200.00, 'description': 'Monthly Rent', 'expected_outlier': True},
                {'id': '12', 'amount': 650.00, 'description': 'Car Insurance', 'expected_outlier': True},
                {'id': '13', 'amount': 450.00, 'description': 'Holiday Booking', 'expected_outlier': True},
                # Edge cases
                {'id': '14', 'amount': 150.00, 'description': 'Large grocery shop', 'expected_outlier': False},
            ],
            'monthly_budget': 3000.0,
            'total_outliers': 3,
            'total_transactions': 14
        }
    
    def test_outlier_detection_accuracy(self, detector, synthetic_dataset):
        """
        T3 Gate Test: Verify outlier detection with <10% false positives
        """
        transactions = synthetic_dataset['transactions']
        detected = detector.detect_outliers(transactions, synthetic_dataset['monthly_budget'])
        detected_ids = {t['id'] for t in detected}
        
        # Calculate metrics
        true_positives = 0
        false_positives = 0
        false_negatives = 0
        true_negatives = 0
        
        for transaction in transactions:
            is_detected = transaction['id'] in detected_ids
            is_expected = transaction['expected_outlier']
            
            if is_detected and is_expected:
                true_positives += 1
            elif is_detected and not is_expected:
                false_positives += 1
            elif not is_detected and is_expected:
                false_negatives += 1
            else:
                true_negatives += 1
        
        total = len(transactions)
        false_positive_rate = (false_positives / (false_positives + true_negatives)) * 100 if (false_positives + true_negatives) > 0 else 0
        
        print(f"\nOutlier Detection Metrics:")
        print(f"  True Positives: {true_positives}")
        print(f"  False Positives: {false_positives}")
        print(f"  False Negatives: {false_negatives}")
        print(f"  True Negatives: {true_negatives}")
        print(f"  False Positive Rate: {false_positive_rate:.1f}%")
        
        # Log false positives for debugging
        if false_positives > 0:
            print("\nFalse Positives:")
            for t in transactions:
                if t['id'] in detected_ids and not t['expected_outlier']:
                    print(f"  - {t['description']}: £{t['amount']:.2f}")
        
        # T3 GATE: False positive rate must be <10%
        assert false_positive_rate < 10.0, f"T3 FAILED: False positive rate {false_positive_rate:.1f}% >= 10%"
    
    def test_statistical_outlier_detection(self, detector):
        """Test z-score based outlier detection"""
        # Create dataset with clear statistical outlier
        transactions = [
            {'id': '1', 'amount': 10.0},
            {'id': '2', 'amount': 12.0},
            {'id': '3', 'amount': 11.0},
            {'id': '4', 'amount': 13.0},
            {'id': '5', 'amount': 10.5},
            {'id': '6', 'amount': 100.0},  # Clear outlier
        ]
        
        outliers = detector.detect_outliers(transactions)
        outlier_ids = {t['id'] for t in outliers}
        
        assert '6' in outlier_ids, "Failed to detect statistical outlier"
        assert len(outlier_ids) == 1, "Detected too many outliers"
    
    def test_budget_based_outlier_detection(self, detector):
        """Test budget percentage based outlier detection"""
        transactions = [
            {'id': '1', 'amount': 50.0},
            {'id': '2', 'amount': 60.0},
            {'id': '3', 'amount': 700.0},  # >20% of £3000 budget
        ]
        
        outliers = detector.detect_outliers(transactions, monthly_budget=3000.0)
        outlier_ids = {t['id'] for t in outliers}
        
        assert '3' in outlier_ids, "Failed to detect budget-based outlier"
    
    def test_adjusted_pace_calculation(self, detector):
        """Test pace calculation excluding outliers"""
        # Daily spend: £200, with £1200 outlier over 10 days
        daily_spend = 200.0
        outlier_total = 1200.0
        day_of_month = 10
        
        adjusted_pace = detector.calculate_adjusted_pace(daily_spend, outlier_total, day_of_month)
        
        # Expected: (200 - 120) * 30 = 2400
        expected = 2400.0
        assert abs(adjusted_pace - expected) < 1.0, f"Adjusted pace {adjusted_pace} != {expected}"
    
    def test_no_outliers_scenario(self, detector):
        """Test when no outliers exist"""
        transactions = [
            {'id': str(i), 'amount': 50.0 + i}
            for i in range(10)
        ]
        
        outliers = detector.detect_outliers(transactions)
        assert len(outliers) == 0, "Incorrectly detected outliers in normal distribution"
    
    def test_all_outliers_scenario(self, detector):
        """Test when all transactions are potential outliers"""
        transactions = [
            {'id': '1', 'amount': 1000.0},
            {'id': '2', 'amount': 1200.0},
            {'id': '3', 'amount': 1100.0},
        ]
        
        outliers = detector.detect_outliers(transactions, monthly_budget=3000.0)
        # All should be budget outliers (>£600)
        assert len(outliers) == 3, "Failed to detect all budget outliers"
    
    def test_recurring_large_transactions(self, detector):
        """Test that recurring large transactions (rent, bills) are properly flagged"""
        transactions = [
            {'id': '1', 'amount': 45.0, 'description': 'Groceries'},
            {'id': '2', 'amount': 1200.0, 'description': 'Rent'},
            {'id': '3', 'amount': 35.0, 'description': 'Transport'},
            {'id': '4', 'amount': 180.0, 'description': 'Council Tax'},
            {'id': '5', 'amount': 25.0, 'description': 'Lunch'},
        ]
        
        outliers = detector.detect_outliers(transactions)
        outlier_amounts = {t['amount'] for t in outliers}
        
        assert 1200.0 in outlier_amounts, "Rent should be detected as outlier"
        # Council tax might not be outlier depending on thresholds
        print(f"Detected outlier amounts: {outlier_amounts}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])