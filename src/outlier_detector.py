"""
Outlier Detection Module
Implements T3 Gate: Outlier detection with <10% false positives
"""

import statistics
from typing import Dict, List


class OutlierDetector:
    """Detects spending outliers using statistical and budget-based rules"""
    
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
        
        Args:
            transactions: List of transaction dicts with 'amount' field
            monthly_budget: Monthly budget for comparison
            
        Returns:
            List of outlier transactions
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
        """
        Calculate spending pace excluding outliers
        
        Args:
            daily_spend: Total daily spending
            outlier_total: Sum of outlier amounts
            day_of_month: Current day of month
            
        Returns:
            Adjusted monthly pace projection
        """
        if day_of_month == 0:
            return 0
            
        adjusted_daily = daily_spend - (outlier_total / day_of_month)
        return adjusted_daily * 30  # Simplified monthly projection