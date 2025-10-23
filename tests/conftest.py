"""Test configuration for ensuring project package imports work consistently."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure the repository root (which contains the `src` package) is importable.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
