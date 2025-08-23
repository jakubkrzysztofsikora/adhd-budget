"""
Spending Projector Module
Implements T3 Gate: Projection accuracy ±5%
"""

from typing import Dict
from decimal import Decimal


class SpendingProjector:
    """Projects monthly spending and calculates budget variance"""
    
    def calculate_monthly_pace(self, daily_spend: float, day_of_month: int) -> float:
        """
        Project monthly spending based on current pace
        
        Args:
            daily_spend: Total spending so far this month
            day_of_month: Current day of the month
            
        Returns:
            Projected monthly spend
        """
        if day_of_month == 0:
            return 0.0
        
        # Calculate average daily rate from total spending so far
        daily_rate = daily_spend / day_of_month
        
        # Project for full month (assume 30 days)
        days_in_month = 30
        return daily_rate * days_in_month
    
    def calculate_month_end_balance(self, 
                                   starting_balance: float,
                                   spent_so_far: float,
                                   projected_spend: float) -> float:
        """
        Calculate projected month-end balance
        
        Args:
            starting_balance: Balance at start of month
            spent_so_far: Amount already spent this month
            projected_spend: Total projected spend for month
            
        Returns:
            Projected end balance
        """
        remaining_spend = projected_spend - spent_so_far
        return starting_balance - remaining_spend
    
    def calculate_vs_budget(self, projected_spend: float, budget: float) -> Dict:
        """
        Calculate budget variance
        
        Args:
            projected_spend: Projected monthly spend
            budget: Monthly budget
            
        Returns:
            Dict with variance details
        """
        variance = projected_spend - budget
        percentage = (abs(variance) / budget * 100) if budget > 0 else 0
        
        return {
            'projected': projected_spend,
            'budget': budget,
            'variance': variance,
            'percentage': percentage,
            'status': 'over' if variance > 0 else 'under'
        }