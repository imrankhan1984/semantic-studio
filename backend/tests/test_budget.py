"""
================================================================================
FILE: backend/tests/test_budget.py
================================================================================

SUMMARY
    AC-17 (visual-modeling): the perf tests' limits read BUDGET_FACTOR,
    default 1.

BASIC IDEA
    budget.py reads the variable when it is imported, so each case sets the
    environment and reloads it; the module is reloaded once more afterwards so
    the rest of the run sees the real environment.

INPUTS / INPUT SOURCES
    - tests/budget.py, under a monkeypatched environment.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
"""

import importlib

import pytest

import budget


@pytest.fixture
def reload(monkeypatch):
    def with_factor(value):
        if value is None:
            monkeypatch.delenv("BUDGET_FACTOR", raising=False)
        else:
            monkeypatch.setenv("BUDGET_FACTOR", value)
        return importlib.reload(budget)

    yield with_factor
    monkeypatch.undo()
    importlib.reload(budget)


def test_unset_keeps_the_limit_as_measured(reload):
    assert reload(None).limit_ms(50) == 50


def test_set_scales_every_millisecond_limit(reload):
    assert reload("2").limit_ms(50) == 100


@pytest.mark.parametrize("value", ["0", "-1", "fast", "inf", "nan"])
def test_nonsense_is_ignored(reload, value):
    assert reload(value).BUDGET_FACTOR == 1.0
