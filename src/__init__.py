"""
ADHD Budget Assistant - Core Modules
"""

from .categorizer import TransactionCategorizer
from .projector import SpendingProjector
from .outlier_detector import OutlierDetector
from .mcp_server import MCPServer
from .scheduler import DailySummaryScheduler
from .data_flow import DataFlowManager

__all__ = [
    'TransactionCategorizer',
    'SpendingProjector',
    'OutlierDetector',
    'MCPServer',
    'DailySummaryScheduler',
    'DataFlowManager',
]

__version__ = '0.1.0'