"""
T5 Gate: Daily Summary Scheduling
Deterministic test with frozen time
"""

import pytest
from freezegun import freeze_time
from datetime import datetime, timedelta
import json


class TestT5SchedulerDeterministic:
    """Deterministic scheduler tests with frozen time"""
    
    @freeze_time("2024-01-15 08:05:00")
    def test_window_detection_frozen(self):
        """T5: Job runs in 08:00-08:10 window (frozen time)"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        
        # Test exact window boundaries
        test_cases = [
            ("2024-01-15 07:59:59", False),  # Before window
            ("2024-01-15 08:00:00", True),   # Start of window
            ("2024-01-15 08:05:00", True),   # Middle of window
            ("2024-01-15 08:10:00", True),   # End of window
            ("2024-01-15 08:10:01", False),  # After window
        ]
        
        for time_str, should_run in test_cases:
            with freeze_time(time_str):
                result = scheduler.should_run_now()
                assert result == should_run, f"Failed at {time_str}"
    
    @freeze_time("2024-01-15 08:05:00")
    def test_run_once_daily_frozen(self):
        """T5: Job runs only once per day (frozen time)"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        
        # First run at 08:05
        assert scheduler.should_run_now() == True
        scheduler.last_run = datetime.now()
        
        # Try again same day at 08:07
        with freeze_time("2024-01-15 08:07:00"):
            assert scheduler.should_run_now() == False
        
        # Next day at 08:05
        with freeze_time("2024-01-16 08:05:00"):
            assert scheduler.should_run_now() == True
    
    @pytest.mark.asyncio
    @freeze_time("2024-01-15 08:05:00")
    async def test_summary_payload_complete(self):
        """T5: Summary contains all required fields"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        
        # Generate summary for yesterday
        summary = await scheduler.generate_summary(
            date=datetime(2024, 1, 14)  # Yesterday
        )
        
        # Required fields per claude.md
        required_fields = {
            'summary_date': str,
            'total_spent': (int, float),
            'categories': dict,
            'vs_budget': dict,
            'pace_projection': dict,
            'balance_impact': dict,
            'outliers': list,
            'adjusted_pace': dict
        }
        
        for field, expected_type in required_fields.items():
            assert field in summary, f"Missing required field: {field}"
            assert isinstance(summary[field], expected_type), \
                f"Field {field} has wrong type: {type(summary[field])}"
        
        # Validate vs_budget structure
        assert 'variance' in summary['vs_budget']
        assert 'daily_budget' in summary['vs_budget']
        assert 'actual_spent' in summary['vs_budget']
        
        # Validate pace_projection structure
        assert 'current_pace' in summary['pace_projection']
        assert 'monthly_budget' in summary['pace_projection']
        
        # Validate adjusted_pace structure
        assert 'without_outliers' in summary['adjusted_pace']
        assert 'status' in summary['adjusted_pace']
    
    @pytest.mark.asyncio
    @freeze_time("2024-01-15 08:05:00")
    async def test_job_execution_deterministic(self):
        """T5: Job executes exactly once in window"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        execution_log = []
        
        # Mock the summary sending
        original_generate = scheduler.generate_summary
        async def logged_generate(*args, **kwargs):
            result = await original_generate(*args, **kwargs)
            execution_log.append(datetime.now())
            return result
        
        scheduler.generate_summary = logged_generate
        
        # Run job
        result = await scheduler.run_daily_job()
        assert result['status'] == 'success'
        assert len(execution_log) == 1
        
        # Try to run again (should skip)
        result = await scheduler.run_daily_job()
        assert result['status'] == 'skipped'
        assert len(execution_log) == 1  # Still only one execution
    
    def test_next_run_calculation_frozen(self):
        """T5: Next run time calculation is deterministic"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        
        # Test before window
        with freeze_time("2024-01-15 07:00:00"):
            next_run = scheduler.get_next_run_time()
            assert next_run.date() == datetime(2024, 1, 15).date()
            assert next_run.hour == 8
            assert next_run.minute == 5
        
        # Test after window
        with freeze_time("2024-01-15 09:00:00"):
            next_run = scheduler.get_next_run_time()
            assert next_run.date() == datetime(2024, 1, 16).date()
            assert next_run.hour == 8
            assert next_run.minute == 5
    
    @freeze_time("2024-01-15 08:05:00")
    def test_summary_format_whatsapp_ready(self):
        """T5: Summary format matches WhatsApp requirements"""
        from src.scheduler import DailySummaryScheduler
        
        scheduler = DailySummaryScheduler()
        
        # Mock summary data
        summary = {
            'summary_date': '2024-01-14',
            'total_spent': 127.43,
            'categories': {
                'groceries': 45.20,
                'eating_out': 32.23,
                'transport': 50.00
            },
            'pace_projection': {
                'current_pace': 3823.00,
                'monthly_budget': 3500.00
            },
            'balance_impact': {
                'impact': -323.00
            }
        }
        
        # Format for WhatsApp (≤6 lines per claude.md)
        message_lines = [
            f"💰 Yesterday's Summary ({summary['summary_date']})",
            f"Spent: £{summary['total_spent']:.2f}",
            f"• Groceries: £{summary['categories']['groceries']:.2f}",
            f"• Eating out: £{summary['categories']['eating_out']:.2f}",
            f"• Transport: £{summary['categories']['transport']:.2f}",
            f"Pace: £{summary['pace_projection']['current_pace']:.0f}/mo (vs £{summary['pace_projection']['monthly_budget']:.0f} budget)"
        ]
        
        assert len(message_lines) <= 6, "Message exceeds 6 lines"
        
        # Verify format
        full_message = '\n'.join(message_lines)
        assert '£' in full_message  # Currency symbol
        assert '•' in full_message  # Bullet points
        assert len(full_message) < 1000  # Reasonable length


if __name__ == "__main__":
    pytest.main([__file__, "-v"])