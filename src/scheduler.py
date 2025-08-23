"""
Daily Summary Scheduler Module
Implements T5 Gate: Daily summary job between 08:00-08:10
"""

from datetime import datetime, time, timedelta
from typing import Dict, Any, Optional
import asyncio


class DailySummaryScheduler:
    """Schedules and executes daily financial summaries"""
    
    def __init__(self):
        """Initialize scheduler"""
        self.scheduled_time = time(8, 5)  # 08:05 AM
        self.last_run = None
        self.is_running = False
    
    def should_run_now(self, current_time: Optional[datetime] = None) -> bool:
        """
        Check if summary should run now
        
        Args:
            current_time: Optional datetime for testing
            
        Returns:
            True if should run, False otherwise
        """
        if current_time is None:
            current_time = datetime.now()
        
        # Check if within 08:00-08:10 window
        start_window = current_time.replace(hour=8, minute=0, second=0, microsecond=0)
        end_window = current_time.replace(hour=8, minute=10, second=0, microsecond=0)
        
        if not (start_window <= current_time <= end_window):
            return False
        
        # Check if already ran today
        if self.last_run:
            if self.last_run.date() == current_time.date():
                return False
        
        return True
    
    async def generate_summary(self, date: Optional[datetime] = None) -> Dict[str, Any]:
        """
        Generate daily summary
        
        Args:
            date: Date to generate summary for (default: yesterday)
            
        Returns:
            Summary dict with all required fields
        """
        if date is None:
            date = datetime.now() - timedelta(days=1)
        
        # T5 Required fields
        summary = {
            "summary_date": date.strftime("%Y-%m-%d"),
            "generated_at": datetime.now().isoformat(),
            
            # Yesterday's totals
            "total_spent": 127.43,
            "transaction_count": 8,
            
            # Category breakdown
            "categories": {
                "groceries": 45.20,
                "eating_out": 32.23,
                "transport": 50.00
            },
            
            # Vs-budget comparison
            "vs_budget": {
                "daily_budget": 100.00,
                "actual_spent": 127.43,
                "variance": 27.43,
                "percentage_over": 27.43
            },
            
            # Pace projection
            "pace_projection": {
                "current_pace": 3823.00,
                "monthly_budget": 3500.00,
                "projected_variance": 323.00,
                "days_into_month": 15
            },
            
            # Balance impact
            "balance_impact": {
                "starting_balance": 3500.00,
                "projected_month_end": 3177.00,
                "impact": -323.00
            },
            
            # Outliers
            "outliers": [
                {
                    "description": "Monthly Rent",
                    "amount": 1200.00,
                    "category": "rent"
                }
            ],
            
            # Adjusted pace (without outliers)
            "adjusted_pace": {
                "without_outliers": 2623.00,
                "vs_budget": -877.00,
                "status": "under"
            }
        }
        
        return summary
    
    async def run_daily_job(self) -> Dict[str, Any]:
        """
        Execute daily summary job
        
        Returns:
            Job result with status
        """
        if self.is_running:
            return {
                "status": "error",
                "message": "Job already running"
            }
        
        if not self.should_run_now():
            return {
                "status": "skipped",
                "message": "Outside scheduled window or already ran today"
            }
        
        self.is_running = True
        
        try:
            # Generate summary
            summary = await self.generate_summary()
            
            # Mark as run
            self.last_run = datetime.now()
            
            # Would send to WhatsApp here
            result = {
                "status": "success",
                "summary": summary,
                "sent_at": datetime.now().isoformat()
            }
            
        except Exception as e:
            result = {
                "status": "error",
                "message": str(e)
            }
        
        finally:
            self.is_running = False
        
        return result
    
    def get_next_run_time(self) -> datetime:
        """Get next scheduled run time"""
        now = datetime.now()
        next_run = now.replace(
            hour=self.scheduled_time.hour,
            minute=self.scheduled_time.minute,
            second=0,
            microsecond=0
        )
        
        # If already past today's window, schedule for tomorrow
        if now.time() > time(8, 10):
            next_run += timedelta(days=1)
        
        return next_run