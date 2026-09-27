"""
================================================================================
FILE: backend/app/sparql_service.py
================================================================================

SUMMARY
    SPARQL `SERVICE`, run by Semantic Studio rather than by rdflib
    (external-access Stage 3, backlog Q-10, decision D-069). Finds a query's
    SERVICE blocks before anything runs, decides the exact text each one will
    send, and evaluates every block through a handler in rdflib's CUSTOM_EVALS
    hook that sends only that text, once per block per run, through the
    network broker, under per-call caps.

BASIC IDEA
    rdflib's own `evalServiceQuery` is unsafe to switch on: it calls urlopen
    directly (no address check, no size cap, no timeout) and appends every
    local binding to the remote query as a VALUES clause, once per local row.
    So a query joining 100 local rows to one SERVICE made 100 requests and
    handed the endpoint 100 values from the user's ontology. Here, instead:

      1. Plan. Every SERVICE block is found and checked before any request:
         the endpoint must be a fixed IRI (`SERVICE ?var` is refused), it must
         be an http(s) address the broker would not refuse on sight, and there
         may be at most MAX_SERVICE_BLOCKS distinct blocks. The text each block
         sends is fixed now: the query's PREFIX lines the block uses, then
         `SELECT * WHERE { <the block as written> }`. That string is what the
         approval dialog shows and, byte for byte, what goes out.
      2. Run. `evaluate_service` is registered in CUSTOM_EVALS at import, like
         the S-4 guard, and answers every ServiceGraphPattern, so rdflib's
         native code is unreachable. It calls the endpoint at most once per
         distinct block per run -- the result is memoised on the run -- and
         joins the remote rows to the local ones on this machine, filtering
         for compatibility with whatever the local side has already bound.
         Nothing local is ever sent: the text was fixed before a row existed.

    **The block text is taken from the query by our own scanner, never from
    rdflib's `service_string`.** rdflib 7.6 builds that attribute with a
    search over the *whole* query from the start (parserutils.py), so every
    block in a query with two carries the first block's text; and a SERVICE
    nested in a SERVICE sends that search into unbounded recursion. The
    scanner here understands strings, IRIs and comments, finds the top-level
    blocks in text order, and they are paired with the parse tree's SERVICE
    nodes, which are also in text order. A pairing that does not agree on
    count, term and SILENT refuses the query rather than guessing: an
    approval shown for one block and a request made for another would break
    the one promise this module exists to keep.

    A SERVICE inside a SERVICE is part of the outer block's text: it runs on
    the remote endpoint, not here, and is shown in the dialog like the rest.

    SILENT follows the standard: a failed call evaluates to a single empty
    solution, the join identity, so the local rows come through unchanged. A
    refused approval is not a failure -- asking happens before anything is
    sent -- so a SILENT block still asks.

INPUTS / INPUT SOURCES
    - The query text and its parse tree and algebra, from sparql_exec.
    - The network broker, as capability `sparql:service`, for every call.
    - rdflib's QueryContext during evaluation (the local bindings, used only to
      filter remote rows here, never sent).

EXPECTED OUTPUT
    - `match_blocks(...)` then `plan_services(...)` -> a ServicePlan: the distinct blocks, their exact
      text, and a map from each algebra node to its block. Raises
      ServiceRefused with the sentence the user sees.
    - `ServiceRun`: the per-run memo and the `services` report, one entry per
      block called: {endpoint, host, rows, truncated, ms, error}.
    - Raises ServiceFailed for a failed call that is not SILENT, and lets the
      broker's own refusals (ApprovalRequired, HostBlocked, Offline) through.
================================================================================
"""

from __future__ import annotations

import contextvars
import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Iterator, Optional
from urllib.parse import urlencode

from pyparsing import ParseResults
from rdflib import BNode, Literal, URIRef, Variable
from rdflib.plugins.sparql import CUSTOM_EVALS
from rdflib.plugins.sparql.sparql import FrozenBindings, QueryContext

from . import net_guard
from .network_broker import (
    CAPABILITIES,
    ApprovalRequired,
    FetchFailed,
    HostBlocked,
    NetworkDecision,
    Offline,
    TooLarge,
    broker,
)

CAPABILITY = "sparql:service"

# Section 5.4 of external-access.md. Five distinct blocks is more than any
# hand-written federated query uses and few enough that the dialog stays
# readable; the per-call caps bound what one endpoint can push into this
# process while the whole query keeps its own 30 s and 1,000-row limits.
MAX_SERVICE_BLOCKS = 5
MAX_ROWS_PER_CALL = 10_000
MAX_BYTES_PER_CALL = 10 * 1024 * 1024
CALL_TIMEOUT_SECONDS = 20.0

SERVICE_NODE_NAME = "ServiceGraphPattern"

# The key under which the handler sits in CUSTOM_EVALS. A test asserts it is
# there, and removing it is the mutation AC-31 runs.
HANDLER_KEY = "semantic_studio_service"

VARIABLE_ENDPOINT_DETAIL = (
    "The endpoint must be written as a fixed address. "
    "SERVICE with a variable, such as SERVICE ?endpoint, is not supported."
)
TOO_MANY_BLOCKS_DETAIL = (
    f"This query calls more than {MAX_SERVICE_BLOCKS} different SERVICE blocks. "
    f"Semantic Studio runs at most {MAX_SERVICE_BLOCKS} in one query."
)
NESTED_DETAIL = (
    "A SERVICE block inside another SERVICE block is not supported. "
    "Write each endpoint's block separately."
)
UNMATCHED_DETAIL = (
    "Semantic Studio could not tell exactly which text each SERVICE block would "
    "send, so the query was not run. This can happen when the word SERVICE "
    "appears inside a string or a comment near a block."
)
NOT_PUBLIC_DETAIL = (
    "The SERVICE endpoint {endpoint} is not a public web address, so the query "
    "was not run. Semantic Studio only calls public http or https endpoints."
)

SERVICE_REASON = "Your query asks this site to answer part of it."


class ServiceRefused(Exception):
    """The query's SERVICE use is not allowed. Nothing was sent."""


class ServiceFailed(Exception):
    """A call to an endpoint failed and the block was not SILENT."""


@dataclass(frozen=True)
class ServiceBlock:
    endpoint: str
    host: str
    text: str
    encrypted: bool

    @property
    def key(self) -> tuple[str, str]:
        # Two blocks sending the same text to the same endpoint are one call.
        return (self.endpoint, self.text)

    def approval(self) -> dict:
        """The approval request, in the broker's shape plus the exact text."""
        return {
            "capability": CAPABILITY,
            "host": self.host,
            "url": self.endpoint,
            "reason": SERVICE_REASON,
            "sends": CAPABILITIES[CAPABILITY]["sends"],
            "encrypted": self.encrypted,
            "text": self.text,
        }


@dataclass
class ServicePlan:
    blocks: list[ServiceBlock]                     # distinct, in text order
    by_node: dict[int, tuple[ServiceBlock, bool]]  # id(algebra node) -> (block, silent)
    # The nodes themselves, so the ids above cannot be reused while the plan
    # lives: an id is only unique among objects alive at the same time.
    nodes: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Finding the blocks in the text.
# ---------------------------------------------------------------------------

# SPARQL's IRIREF: no whitespace or any of <>"{}|^`\ inside. Anything else
# starting with `<` is the less-than operator.
_IRIREF = re.compile(r'<[^<>"{}|^`\\\x00-\x20]*>')
_PN_CHARS = re.compile(r"[\w\-.:%\\\u00B7\u0300-\u036F\u203F-\u2040]*")
_SPACE = re.compile(r"\s+")
_KEYWORD_BEFORE = re.compile(r"[\w:?$]")
_KEYWORD_AFTER = re.compile(r"[\w:\-]")


@dataclass
class _Found:
    silent: bool
    term: str        # as written: <iri>, prefix:local or ?var
    body: str        # between the block's own braces, exactly as written


def _skip_string(text: str, i: int) -> int:
    """``i`` is at a quote; return the index just past the string."""
    quote = text[i]
    if text.startswith(quote * 3, i):
        end = i + 3
        while end < len(text):
            if text[end] == "\\":
                end += 2
                continue
            if text.startswith(quote * 3, end):
                return end + 3
            end += 1
        return len(text)
    end = i + 1
    while end < len(text) and text[end] not in (quote, "\n"):
        end += 2 if text[end] == "\\" else 1
    return end + 1


def _skip_atom(text: str, i: int) -> Optional[int]:
    """If a string, IRI or comment starts at ``i``, the index past it."""
    ch = text[i]
    if ch in "\"'":
        return _skip_string(text, i)
    if ch == "#":
        newline = text.find("\n", i)
        return len(text) if newline < 0 else newline + 1
    if ch == "<":
        match = _IRIREF.match(text, i)
        if match:
            return match.end()
    return None


def _skip_space(text: str, i: int) -> int:
    while i < len(text):
        match = _SPACE.match(text, i)
        if match:
            i = match.end()
            continue
        if text[i] == "#":
            i = _skip_atom(text, i)
            continue
        break
    return i


def _match_braces(text: str, i: int) -> Optional[int]:
    """``i`` is at `{`; return the index of its matching `}`."""
    depth = 0
    while i < len(text):
        skipped = _skip_atom(text, i)
        if skipped is not None:
            i = skipped
            continue
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _is_keyword(text: str, i: int, word: str) -> bool:
    if text[i:i + len(word)].upper() != word:
        return False
    if i > 0 and _KEYWORD_BEFORE.match(text[i - 1]):
        return False
    after = i + len(word)
    return not (after < len(text) and _KEYWORD_AFTER.match(text[after]))


def _read_block(text: str, i: int) -> Optional[tuple[_Found, int]]:
    """Read `SERVICE [SILENT] term { ... }` starting at ``i``."""
    i = _skip_space(text, i + len("SERVICE"))
    silent = _is_keyword(text, i, "SILENT")
    if silent:
        i = _skip_space(text, i + len("SILENT"))
    if i >= len(text):
        return None
    if text[i] == "<":
        match = _IRIREF.match(text, i)
        if not match:
            return None
        term_end = match.end()
    elif text[i] in "?$":
        term_end = _PN_CHARS.match(text, i + 1).end()
    else:
        term_end = _PN_CHARS.match(text, i).end()
    term = text[i:term_end]
    i = _skip_space(text, term_end)
    if i >= len(text) or text[i] != "{":
        return None
    close = _match_braces(text, i)
    if close is None:
        return None
    return _Found(silent, term, text[i + 1:close]), close + 1


def find_service_blocks(text: str) -> Optional[list[_Found]]:
    """The top-level SERVICE blocks of ``text``, in order. None if one of them
    cannot be read; the caller refuses the query then."""
    found: list[_Found] = []
    i = 0
    while i < len(text):
        skipped = _skip_atom(text, i)
        if skipped is not None:
            i = skipped
            continue
        if text[i] in "Ss" and _is_keyword(text, i, "SERVICE"):
            read = _read_block(text, i)
            if read is None:
                return None
            block, i = read
            found.append(block)
            continue
        i += 1
    return found


def refuse_nested(query: str) -> None:
    """Refuse a SERVICE inside a SERVICE before rdflib parses the query.

    rdflib 7.6 cannot parse one at all: its service_string search re-enters
    itself until Python's recursion limit, and the user would be shown
    "maximum recursion depth exceeded". Said plainly here instead.
    """
    for block in find_service_blocks(query) or ():
        if find_service_blocks(block.body):
            raise ServiceRefused(NESTED_DETAIL)


# ---------------------------------------------------------------------------
# Pairing them with the parse tree, and fixing each block's text.
# ---------------------------------------------------------------------------


def services_in_parse_order(parsed) -> list:
    """The parse tree's top-level SERVICE nodes in text order.

    Must run on the tree from parseQuery, before translateQuery: the algebra
    reorders patterns (a FILTER's EXISTS moves ahead of the patterns it
    filters), while the parse tree keeps every node where the text put it.

    Iterative, so no depth can exhaust the stack, and deliberately unbounded:
    it cannot fail open, because plan_services refuses any query whose
    algebra holds a SERVICE node this walk did not find. The one depth bound
    that decides anything is sparql_exec's, CF-1's.
    """
    found = []
    stack = [parsed]
    while stack:
        node = stack.pop()
        if getattr(node, "name", None) == SERVICE_NODE_NAME:
            found.append(node)
            continue
        if isinstance(node, dict):
            children = list(node.values())
        elif isinstance(node, (list, tuple, ParseResults)) and not isinstance(node, str):
            children = list(node)
        else:
            continue
        stack.extend(reversed(children))
    return found


def _term_agrees(written: str, parsed_term) -> bool:
    """The scanned term and the parse tree's term name the same thing."""
    if isinstance(parsed_term, Variable):
        return written[:1] in "?$" and written[1:] == str(parsed_term)
    if isinstance(parsed_term, URIRef):
        return written.startswith("<") and written[1:-1] == str(parsed_term)
    if getattr(parsed_term, "name", None) == "pname":
        prefix = parsed_term.get("prefix") if "prefix" in parsed_term else ""
        local = parsed_term.get("localname") if "localname" in parsed_term else ""
        return written == f"{prefix or ''}:{local or ''}"
    return False


_RELATIVE_IRI = re.compile(r"<(?![A-Za-z][A-Za-z0-9+.\-]*:)[^<>\s]*>")


def _prologue(parsed) -> tuple[Optional[str], list[tuple[str, str]]]:
    base = None
    prefixes: list[tuple[str, str]] = []
    for decl in parsed[0] if len(parsed) else ():
        name = getattr(decl, "name", None)
        if name == "Base":
            base = str(decl["iri"])
        elif name == "PrefixDecl":
            prefix = decl["prefix"] if "prefix" in decl else ""
            prefixes.append((prefix or "", str(decl["iri"])))
    return base, prefixes


def _uses_prefix(body: str, prefix: str) -> bool:
    # Checked against the text with strings, IRIs and comments blanked out,
    # so `<http://x>` does not count as a use of the empty prefix.
    return re.search(r"(?<![\w.\-:])" + re.escape(prefix) + r":", body) is not None


def _code_only(text: str) -> str:
    """``text`` with every string, IRI and comment replaced by spaces."""
    out = []
    i = 0
    while i < len(text):
        skipped = _skip_atom(text, i)
        if skipped is not None:
            out.append(" " * (skipped - i))
            i = skipped
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def block_text(body: str, base: Optional[str], prefixes: list[tuple[str, str]]) -> str:
    """Exactly what is sent for one block.

    Only the PREFIX lines the block uses, so a query that declares a private
    namespace for its local part does not hand that namespace to a public
    endpoint. BASE only when the block writes a relative IRI.
    """
    code = _code_only(body)
    lines = []
    if base is not None and _RELATIVE_IRI.search(body):
        lines.append(f"BASE <{base}>")
    for prefix, iri in prefixes:
        if _uses_prefix(code, prefix):
            lines.append(f"PREFIX {prefix}: <{iri}>")
    lines.append("SELECT * WHERE {\n  " + body.strip() + "\n}")
    return "\n".join(lines)


@dataclass
class MatchedBlocks:
    """The text's blocks paired with their parse nodes, and the prologue, taken
    before translateQuery: translation resolves each node's term in place, and
    the term as written is what the pairing is checked against."""

    pairs: list[tuple[_Found, object]]
    base: Optional[str]
    prefixes: list[tuple[str, str]]


def match_blocks(query: str, parsed) -> MatchedBlocks:
    """Pair the text's blocks with the parse tree's, or refuse. Sends nothing."""
    parse_nodes = services_in_parse_order(parsed)
    if not parse_nodes:
        return MatchedBlocks([], None, [])
    found = find_service_blocks(query)
    if found is None or len(found) != len(parse_nodes):
        raise ServiceRefused(UNMATCHED_DETAIL)
    for written, node in zip(found, parse_nodes):
        # Read with `in`: CompValue.get returns the key itself when it is
        # missing, so node.get("silent") is truthy on every node.
        if written.silent != ("silent" in node) or not _term_agrees(written.term, node["term"]):
            raise ServiceRefused(UNMATCHED_DETAIL)
    base, prefixes = _prologue(parsed)
    return MatchedBlocks(list(zip(found, parse_nodes)), base, prefixes)


def plan_services(matched: MatchedBlocks, algebra_nodes: list) -> ServicePlan:
    """Check every block's endpoint and fix the text it sends. Sends nothing.

    ``algebra_nodes`` come from sparql_exec's algebra walk. Translation keeps
    the node objects, so they must be exactly the matched parse nodes, in
    another order; anything else is refused rather than guessed at.
    """
    if {id(node) for node in algebra_nodes} != {id(node) for _, node in matched.pairs}:
        raise ServiceRefused(UNMATCHED_DETAIL)
    blocks: dict[tuple[str, str], ServiceBlock] = {}
    by_node: dict[int, tuple[ServiceBlock, bool]] = {}
    for written, node in matched.pairs:
        term = node["term"]
        if isinstance(term, Variable):
            raise ServiceRefused(VARIABLE_ENDPOINT_DETAIL)
        if not isinstance(term, URIRef):
            raise ServiceRefused(UNMATCHED_DETAIL)
        endpoint = str(term)
        try:
            host = broker.check_url(endpoint)
        except net_guard.BlockedAddress:
            raise ServiceRefused(NOT_PUBLIC_DETAIL.format(endpoint=endpoint)) from None
        block = ServiceBlock(
            endpoint=endpoint,
            host=host,
            text=block_text(written.body, matched.base, matched.prefixes),
            encrypted=endpoint.lower().startswith("https:"),
        )
        block = blocks.setdefault(block.key, block)
        by_node[id(node)] = (block, written.silent)
    if len(blocks) > MAX_SERVICE_BLOCKS:
        raise ServiceRefused(TOO_MANY_BLOCKS_DETAIL)
    return ServicePlan(list(blocks.values()), by_node, [node for _, node in matched.pairs])


def check_before_running(plan: ServicePlan) -> None:
    """Ask, block or go offline for every block at once, before anything is sent.

    Every host that needs a question is named in one 409, so the dialog asks
    once for the whole query rather than once per endpoint per retry.
    Offline and Block refuse the query unless every block they touch is
    SILENT, in which case the run turns those blocks into empty results.
    """
    silent_only: dict[tuple[str, str], bool] = {}
    for block, silent in plan.by_node.values():
        silent_only[block.key] = silent_only.get(block.key, True) and silent
    asks = []
    for block in plan.blocks:
        decision = broker.decision_for(CAPABILITY, block.host)
        if decision == "ask":
            asks.append(block.approval())
        elif decision == "offline" and not silent_only[block.key]:
            raise Offline()
        elif decision == "block" and not silent_only[block.key]:
            raise HostBlocked(block.host)
    if asks:
        raise ApprovalRequired(asks)


# ---------------------------------------------------------------------------
# Running them.
# ---------------------------------------------------------------------------


def _term_from_json(cell) -> object:
    """One cell of a SPARQL JSON result, or ValueError."""
    if not isinstance(cell, dict) or not isinstance(cell.get("value"), str):
        raise ValueError("a result cell is not in the SPARQL JSON results shape")
    kind, value = cell.get("type"), cell["value"]
    if kind == "uri":
        return URIRef(value)
    if kind == "bnode":
        return BNode(value)
    if kind in ("literal", "typed-literal"):
        lang = cell.get("xml:lang")
        datatype = cell.get("datatype")
        if lang is not None and not isinstance(lang, str):
            raise ValueError("a language tag is not a string")
        if datatype is not None and not isinstance(datatype, str):
            raise ValueError("a datatype is not a string")
        if lang:
            return Literal(value, lang=lang)
        return Literal(value, datatype=URIRef(datatype) if datatype else None)
    raise ValueError(f"a result cell has an unknown type {kind!r}")


def _parse_results(body: bytes) -> tuple[list[dict], bool]:
    try:
        data = json.loads(body)
        names = data["head"]["vars"]
        bindings = data["results"]["bindings"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError("the answer was not SPARQL JSON results") from exc
    if not isinstance(names, list) or not isinstance(bindings, list):
        raise ValueError("the answer was not SPARQL JSON results")
    truncated = len(bindings) > MAX_ROWS_PER_CALL
    rows = []
    for binding in bindings[:MAX_ROWS_PER_CALL]:
        if not isinstance(binding, dict):
            raise ValueError("a result row is not an object")
        rows.append(
            {Variable(name): _term_from_json(cell) for name, cell in binding.items()
             if isinstance(name, str)}
        )
    return rows, truncated


@dataclass
class _Outcome:
    rows: list[dict]
    error: Optional[Exception] = None


class ServiceRun:
    """One query run: the memo that makes one call per block, and the report."""

    def __init__(self, plan: ServicePlan) -> None:
        self.plan = plan
        self._lock = threading.Lock()
        self._outcomes: dict[tuple[str, str], _Outcome] = {}
        self.report: list[dict] = []

    def outcome(self, block: ServiceBlock) -> _Outcome:
        # The lock is held across the call on purpose: a second evaluation of
        # the same block must wait for the first answer, not make its own call.
        with self._lock:
            held = self._outcomes.get(block.key)
            if held is None:
                held = self._call(block)
                self._outcomes[block.key] = held
            return held

    def _call(self, block: ServiceBlock) -> _Outcome:
        started = time.perf_counter()
        entry = {"endpoint": block.endpoint, "host": block.host, "rows": 0,
                 "truncated": False, "ms": 0.0, "error": None}
        try:
            response = broker.request(
                CAPABILITY,
                block.endpoint,
                reason=SERVICE_REASON,
                method="POST",
                headers={
                    "Accept": "application/sparql-results+json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "SemanticStudio",
                },
                # The form field is the protocol's; its value is the approved
                # text and nothing else.
                body=urlencode({"query": block.text}).encode("utf-8"),
                max_bytes=MAX_BYTES_PER_CALL,
                timeout=CALL_TIMEOUT_SECONDS,
                total_timeout=CALL_TIMEOUT_SECONDS,
            )
            if response.status != 200:
                raise ServiceFailed(f"{block.host} answered with HTTP {response.status}.")
            try:
                rows, truncated = _parse_results(response.body)
            except ValueError as exc:
                raise ServiceFailed(f"{block.host}: {exc}.") from exc
            entry.update(rows=len(rows), truncated=truncated)
            return _Outcome(rows)
        except ApprovalRequired:
            # A redirect to a host nobody approved. Asking is not a failure,
            # SILENT or not; the question goes back to the user.
            raise
        except (ServiceFailed, NetworkDecision, net_guard.BlockedAddress) as exc:
            entry["error"] = str(exc)
            return _Outcome([], exc)
        except TooLarge:
            error = ServiceFailed(
                f"{block.host} sent more than {MAX_BYTES_PER_CALL // (1024 * 1024)} MB."
            )
            entry["error"] = str(error)
            return _Outcome([], error)
        except FetchFailed as exc:
            error = ServiceFailed(f"{block.host} could not be reached: {exc}")
            entry["error"] = str(error)
            return _Outcome([], error)
        finally:
            entry["ms"] = round((time.perf_counter() - started) * 1000, 1)
            self.report.append(entry)


# The run the current evaluation belongs to. Set by sparql_exec inside the
# worker's context, for exactly the length of one query.
_current_run: contextvars.ContextVar[Optional[ServiceRun]] = contextvars.ContextVar(
    "semantic_studio_service_run", default=None
)


def begin_run(run: ServiceRun):
    return _current_run.set(run)


def end_run(token) -> None:
    _current_run.reset(token)


def _compatible(ctx: QueryContext, row: dict) -> bool:
    for var, value in row.items():
        bound = ctx[var]
        if bound is not None and bound != value:
            return False
    return True


def evaluate_service(ctx: QueryContext, part) -> Iterator[FrozenBindings]:
    """The CUSTOM_EVALS handler. Every other algebra node is rdflib's.

    For a ServiceGraphPattern it never raises NotImplementedError, whatever
    happens: that is the signal for rdflib to fall through to its own
    evalServiceQuery, which is the code this module exists to keep from
    running.
    """
    if getattr(part, "name", None) != SERVICE_NODE_NAME:
        raise NotImplementedError()
    return _evaluate(ctx, part)


def _evaluate(ctx: QueryContext, part) -> Iterator[FrozenBindings]:
    run = _current_run.get()
    if run is None:
        raise ServiceFailed("SERVICE runs only through Semantic Studio's query runner.")
    planned = run.plan.by_node.get(id(part))
    if planned is None:
        raise ServiceFailed(UNMATCHED_DETAIL)
    block, silent = planned
    outcome = run.outcome(block)
    if outcome.error is not None:
        if silent:
            # The join identity: the local rows pass through unchanged.
            yield FrozenBindings(ctx, {})
            return
        if isinstance(outcome.error, NetworkDecision):
            raise outcome.error
        raise ServiceFailed(str(outcome.error))
    # The local side may already have bound some of the block's variables (a
    # join evaluated row by row, an OPTIONAL); only rows that agree with those
    # bindings join. This is where the join happens instead of in a VALUES
    # clause sent to the endpoint.
    for row in outcome.rows:
        if _compatible(ctx, row):
            yield FrozenBindings(ctx, row)


def install() -> None:
    """Register the handler. Idempotent; called once at import."""
    CUSTOM_EVALS[HANDLER_KEY] = evaluate_service


install()
