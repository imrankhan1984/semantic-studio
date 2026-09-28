"""
================================================================================
FILE: backend/tests/test_no_direct_mutation.py
================================================================================

SUMMARY
    AC-14: no code path other than the command and apply endpoints mutates a
    project document. A source scan over backend/app fails if any module but
    editing.py changes an ontology's graph, and a second check proves the
    only routes calling into editing's mutators are the ones 5.4 names.

BASIC IDEA
    A document's graph is reached as `something.graph`, `something.ensure_loaded()`
    or a name bound from either. The scan parses every module with `ast` and
    flags a mutating call (add, remove, set, parse, update, addN, remove_graph)
    on any of those, and any assignment to `.graph`, outside the modules
    allowed to do it: editing.py (the mutators) and store.py (which binds the
    parsed graph once, at load). A scan that finds nothing proves nothing, so
    it is run first against a planted violation and must catch it.

INPUTS / INPUT SOURCES
    - The source files under backend/app.

EXPECTED OUTPUT
    - Pass/fail for AC-14.
================================================================================
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
ALLOWED = {"editing.py", "store.py"}
MUTATORS = {"add", "addN", "remove", "set", "parse", "update", "remove_graph", "__iadd__", "__isub__"}

# The routes that may reach editing's mutating methods, and those methods.
MUTATING_SERVICE_CALLS = {"command", "apply_text", "undo", "redo", "recover"}
ALLOWED_ROUTES = {"run_command", "put_source", "undo", "redo", "recover"}


def _graph_source(node: ast.AST, bound: set[str]) -> bool:
    """Is this expression an ontology's graph?"""
    if isinstance(node, ast.Attribute) and node.attr == "graph":
        return True
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr in ("ensure_loaded", "_graph"):
            return True
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_graph":
        return True
    return isinstance(node, ast.Name) and node.id in bound


def violations(source: str) -> list[str]:
    tree = ast.parse(source)
    found: list[str] = []
    # Per function: a name bound from a graph in one function says nothing
    # about the same name in another. Module-level code in this application
    # builds singletons and never touches an ontology's graph.
    for function in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        bound: set[str] = set()
        body = list(ast.walk(function))
        # Names bound from a graph source, anywhere in this scope.
        for node in body:
            if isinstance(node, ast.Assign) and _graph_source(node.value, set()):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        bound.add(target.id)
        for node in body:
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in MUTATORS and _graph_source(node.func.value, bound):
                    found.append(f"line {node.lineno}: .{node.func.attr}() on an ontology's graph")
            if isinstance(node, ast.AugAssign) and _graph_source(node.target, bound):
                found.append(f"line {node.lineno}: augmented assignment to an ontology's graph")
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Attribute) and target.attr == "graph":
                        found.append(f"line {node.lineno}: assignment to .graph")
    return sorted(set(found))


def test_the_scan_catches_a_planted_violation():
    planted = '''
def sneaky(ontology, triple):
    ontology.ensure_loaded().add(triple)

def sneakier(ontology, triple):
    g = ontology.graph
    g.remove(triple)

def blunt(ontology, other):
    ontology.graph = other

def plus(ontology, other):
    graph = ontology.ensure_loaded()
    graph += other
'''
    found = violations(planted)
    assert len(found) == 4, found


def test_the_scan_leaves_a_fresh_graph_alone():
    fresh = '''
def fine(data):
    parsed = Graph()
    parsed.parse(data=data, format="turtle")
    parsed.add((1, 2, 3))
'''
    assert violations(fresh) == []


def test_only_editing_mutates_a_document_graph():
    files = sorted(APP.rglob("*.py"))
    assert len(files) > 15, "the scan found too few files to mean anything"
    offenders = {}
    for path in files:
        if path.name in ALLOWED:
            continue
        found = violations(path.read_text(encoding="utf-8"))
        if found:
            offenders[str(path.relative_to(APP))] = found
    assert offenders == {}


def test_only_the_command_and_apply_routes_call_the_mutators():
    """Undo, redo and recovery are the same stack or the same draft, so they
    count as the command and apply paths; nothing else may call in."""
    callers: dict[str, set[str]] = {}
    for path in sorted(APP.rglob("*.py")):
        if path.name == "editing.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            for node in ast.walk(function):
                if (
                    isinstance(node, ast.Attribute)
                    and node.attr in MUTATING_SERVICE_CALLS
                    and isinstance(node.value, ast.Name)
                    and node.value.id == "editing_service"
                ):
                    callers.setdefault(f"{path.name}:{function.name}", set()).add(node.attr)
    assert callers, "found no caller at all, so the check is not looking"
    assert {key.split(":")[0] for key in callers} == {"projects.py"}
    assert {key.split(":")[1] for key in callers} == ALLOWED_ROUTES
