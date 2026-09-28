"""
================================================================================
FILE: backend/tests/budget.py
================================================================================

SUMMARY
    BUDGET_FACTOR: the one allowance every wall-clock budget in the backend
    suite multiplies its limit by (visual-modeling 5.7, AC-17).

BASIC IDEA
    A limit is measured on a developer's machine. CI's shared runners are
    slower and busier, and a budget that fails there on every pull request
    teaches everyone to ignore the budgets job -- which is how a real
    regression would later go unseen. So the limit stays as measured, and the
    budgets job sets BUDGET_FACTOR=2 to allow for the machine, not the code.

    Only milliseconds are multiplied. A byte count, and a ratio of two timings
    taken on the same machine, do not depend on how fast the machine is.

INPUTS / INPUT SOURCES
    - The BUDGET_FACTOR environment variable; 1 when unset or not a positive
      number.

EXPECTED OUTPUT
    - BUDGET_FACTOR, and limit_ms(), a measured limit scaled by it.
================================================================================
"""

import math
import os


def _factor() -> float:
    try:
        value = float(os.environ.get("BUDGET_FACTOR", "1"))
    except ValueError:
        return 1.0
    return value if math.isfinite(value) and value > 0 else 1.0


BUDGET_FACTOR = _factor()


def limit_ms(measured: float) -> float:
    """A budget's limit on this machine: as measured, times the allowance."""
    return measured * BUDGET_FACTOR
