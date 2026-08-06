/*
================================================================================
FILE: frontend/src/components/HierarchyView.tsx
================================================================================

SUMMARY
    The Hierarchy view: the ontology's structure as one or two indented,
    expandable trees — a class hierarchy over rdfs:subClassOf and a concept
    hierarchy over skos:broader, rooted at concept schemes. It is the force
    graph's accessible structural equivalent (D-025): a WAI-ARIA `tree` a screen
    reader and the keyboard can operate, which the WebGL canvas cannot be.

BASIC IDEA
    A tree is the natural shape for a hierarchy and the cheap one. The whole
    forest is fetched unbudgeted — it is a fraction of the graph — and the rows
    are VIRTUALIZED: only the rows in and near the viewport are in the DOM, so a
    4,000-concept thesaurus renders the same handful of rows as a 40-class demo.
    Windowing is hand-rolled over the flattened visible-row sequence (D-045), no
    new dependency.

    The forest is a flat node map plus a parent->children adjacency, so a class
    with two parents is stored once and rendered under each — marked as appearing
    in more than one place. A subClassOf cycle in malformed data is broken while
    flattening: a child already on the current path is shown once, marked, and
    not descended into, so no expansion can loop.

    Every child edge carries an `origin`, "asserted" today. The rendering path
    for an "inferred" edge — a derived badge, a non-colour cue, and an aria
    mention — is present and exercised by a test, so adding real inference later
    is data, not new rendering code (D-046).

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology's hierarchy to fetch (null renders nothing).
    - theme: for the kind swatches, via the same kindColor the legend uses.
    - selected: the shared selection, so the matching row is aria-selected.
    - onSelect: select an entity in the app's shared model, exactly as a graph
      click or a search pick does — so Explore shows its detail and the graph can
      draw it even when the budget left it out (AC-13).

EXPECTED OUTPUT
    - The rendered tree(s), an empty state, or the loading / error treatments.
    - onSelect(iri) when a row is activated by click, Enter or Space.
================================================================================
*/

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchHierarchy } from "../api";
import type { Hierarchy, HierarchyForest, Theme } from "../types";
import { KIND_LABELS, kindColor } from "../types";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  selected: string | null;
  onSelect: (iri: string) => void;
}

/** Fixed row height, in pixels, shared by the CSS and the windowing maths. */
const ROW_HEIGHT = 28;
/** Rows kept above and below the viewport so a small scroll shows no gap. */
const OVERSCAN = 6;
/** Viewport height used when the container reports none — jsdom always does,
 *  and a bounded default keeps a virtualized window bounded there too. */
const DEFAULT_VIEWPORT = 480;
/** Indentation per level; capped past this depth so a 40-deep chain does not
 *  push rows off the right and the depth number is shown instead. */
const INDENT = 16;
const MAX_VISUAL_DEPTH = 12;

/** The heading the whole view is named by, where the skip link lands. */
const HEADING_ID = "hierarchy-view-heading";

/** The trailing local name of an IRI, for label-or-local-name filtering. */
function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"), iri.lastIndexOf(":"));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

/** child id -> the ids that list it as a child. Built once per forest, for the
 *  filter's ancestor walk. */
function parentsOf(forest: HierarchyForest): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const [parent, kids] of Object.entries(forest.children)) {
    for (const ref of kids) {
      const list = parents.get(ref.id);
      if (list) list.push(parent);
      else parents.set(ref.id, [parent]);
    }
  }
  return parents;
}

/** How many distinct places a node appears — the count that decides the
 *  "also appears under N" marker. A node's parents plus one if it is a root. */
function appearanceCounts(forest: HierarchyForest): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kids of Object.values(forest.children)) {
    for (const ref of kids) counts.set(ref.id, (counts.get(ref.id) ?? 0) + 1);
  }
  for (const root of forest.roots) counts.set(root, (counts.get(root) ?? 0) + 1);
  return counts;
}

/** The ids to keep for a filter term: every node whose label or local name
 *  matches, plus all of their ancestors so a match keeps its place. Null when
 *  there is no filter. */
function keepForFilter(forest: HierarchyForest, query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const keep = new Set<string>();
  const stack: string[] = [];
  for (const [id, node] of Object.entries(forest.nodes)) {
    if (node.label.toLowerCase().includes(q) || localName(id).toLowerCase().includes(q)) {
      keep.add(id);
      stack.push(id);
    }
  }
  const parents = parentsOf(forest);
  while (stack.length) {
    const id = stack.pop()!;
    for (const parent of parents.get(id) ?? []) {
      if (!keep.has(parent)) {
        keep.add(parent);
        stack.push(parent);
      }
    }
  }
  return keep;
}

/** One row in the flattened, expansion-aware sequence the tree renders. */
interface Row {
  id: string;
  depth: number;
  label: string;
  prefixed: string;
  kind: string;
  origin: "asserted" | "inferred";
  /** Has children AND this occurrence is not a cycle repeat. */
  expandable: boolean;
  expanded: boolean;
  /** How many direct children a collapsed node has, shown beside it. */
  childCount: number;
  /** This occurrence is its own ancestor (a broken cycle), or the node is. */
  cyclic: boolean;
  /** The node appears under more than one parent somewhere in the forest. */
  appearsElsewhere: boolean;
  posinset: number;
  setsize: number;
}

/**
 * Flatten a forest into the visible row sequence, honouring expansion, the
 * filter, and cycle breaking. A per-path set marks a child already on the path
 * as a broken cycle: it is shown once, not descended into, so nothing loops.
 */
function flatten(
  forest: HierarchyForest,
  expanded: Set<string>,
  keep: Set<string> | null,
  appears: Map<string, number>,
): Row[] {
  const rows: Row[] = [];
  const path = new Set<string>();

  const visit = (id: string, depth: number, origin: "asserted" | "inferred") => {
    if (keep && !keep.has(id)) return;
    const node = forest.nodes[id];
    if (!node) return;
    const onPath = path.has(id);
    const cyclic = Boolean(node.cyclic) || onPath;
    const rawKids = forest.children[id] ?? [];
    const keptKids = keep ? rawKids.filter((c) => keep.has(c.id)) : rawKids;
    const expandable = node.hasChildren && keptKids.length > 0 && !cyclic;
    // A filter forces every kept internal node open, so the path to a match is
    // visible; otherwise expansion is the user's own set.
    const isExpanded = expandable && (keep ? true : expanded.has(id));
    rows.push({
      id,
      depth,
      label: node.label,
      prefixed: node.prefixed,
      kind: node.kind,
      origin,
      expandable,
      expanded: isExpanded,
      childCount: keptKids.length,
      cyclic,
      appearsElsewhere: (appears.get(id) ?? 0) > 1,
      posinset: 0, // filled in by the caller's sibling loop
      setsize: 0,
    });
    if (isExpanded) {
      path.add(id);
      keptKids.forEach((child, i) => {
        const before = rows.length;
        visit(child.id, depth + 1, child.origin);
        // Set sibling position on the child's own row (the first pushed).
        if (rows.length > before) {
          rows[before].posinset = i + 1;
          rows[before].setsize = keptKids.length;
        }
      });
      path.delete(id);
    }
  };

  const roots = keep ? forest.roots.filter((r) => keep.has(r)) : forest.roots;
  roots.forEach((rootId, i) => {
    const before = rows.length;
    visit(rootId, 0, "asserted");
    if (rows.length > before) {
      rows[before].posinset = i + 1;
      rows[before].setsize = roots.length;
    }
  });
  return rows;
}

/** Every node id that has children, across a forest — for expand-all. */
function internalIds(forest: HierarchyForest): string[] {
  return Object.entries(forest.children)
    .filter(([, kids]) => kids.length > 0)
    .map(([id]) => id);
}

export default function HierarchyView({ ontologyId, theme, selected, onSelect }: Props) {
  const [data, setData] = useState<Hierarchy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // One expansion set for both forests; IRIs are unique, so no collision.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetch the forests when the ontology changes. Cached server-side, so
  // re-entering the tab is cheap. Reset expansion and filter with the ontology.
  useEffect(() => {
    if (!ontologyId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    setFilter("");
    setExpanded(new Set());
    let cancelled = false;
    fetchHierarchy(ontologyId)
      .then((h) => !cancelled && setData(h))
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ontologyId]);

  const toggle = useCallback((id: string, next: boolean) => {
    setExpanded((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!data) return;
    setExpanded(new Set([...internalIds(data.classes), ...internalIds(data.concepts)]));
  }, [data]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const hasClasses = data ? Object.keys(data.classes.nodes).length > 0 : false;
  const hasConcepts = data ? Object.keys(data.concepts.nodes).length > 0 : false;

  if (!ontologyId) return null;

  return (
    <section className="hierarchy-view" aria-labelledby={HEADING_ID}>
      <div className="hierarchy-toolbar">
        <h2 id={HEADING_ID} tabIndex={-1}>
          Hierarchy
        </h2>
        <input
          type="search"
          className="hierarchy-filter"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter the hierarchy by name"
        />
        <button className="ghost" onClick={expandAll} disabled={!data}>
          Expand all
        </button>
        <button className="ghost" onClick={collapseAll} disabled={!data}>
          Collapse all
        </button>
      </div>
      {/* Not colour-only: aria-expanded carries expansion and the note is text,
          so nothing here depends on a triangle glyph being seen. */}
      <p className="hierarchy-note">
        Showing <strong>asserted</strong> {" "}
        <code>rdfs:subClassOf</code> and <code>skos:broader</code>, not inferred
        relationships.
      </p>

      {loading && <p className="hint hierarchy-status">Loading the hierarchy…</p>}
      {error && (
        <div className="error-bar" onClick={() => setError(null)} title="Click to dismiss">
          {error}
        </div>
      )}

      {data && !hasClasses && !hasConcepts && (
        <p className="hint hierarchy-status">
          This ontology declares no <code>subClassOf</code> or <code>broader</code>{" "}
          structure to show as a tree.
        </p>
      )}

      {data && (hasClasses || hasConcepts) && (
        <div className="hierarchy-forests">
          {hasClasses && (
            <Forest
              title="Class hierarchy"
              forest={data.classes}
              filter={filter}
              expanded={expanded}
              selected={selected}
              theme={theme}
              onToggle={toggle}
              onSelect={onSelect}
            />
          )}
          {hasConcepts && (
            <Forest
              title="Concept hierarchy"
              forest={data.concepts}
              filter={filter}
              expanded={expanded}
              selected={selected}
              theme={theme}
              onToggle={toggle}
              onSelect={onSelect}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface ForestProps {
  title: string;
  forest: HierarchyForest;
  filter: string;
  expanded: Set<string>;
  selected: string | null;
  theme: Theme;
  onToggle: (id: string, next: boolean) => void;
  onSelect: (iri: string) => void;
}

/** One labelled forest: a WAI-ARIA `tree`, virtualized, with one tab stop and
 *  full arrow-key navigation. */
function Forest({
  title,
  forest,
  filter,
  expanded,
  selected,
  theme,
  onToggle,
  onSelect,
}: ForestProps) {
  const appears = useMemo(() => appearanceCounts(forest), [forest]);
  const keep = useMemo(() => keepForFilter(forest, filter), [forest, filter]);
  const rows = useMemo(
    () => flatten(forest, expanded, keep, appears),
    [forest, expanded, keep, appears],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  // The roving tab stop: which row id is focusable. It follows navigation and is
  // clamped back onto the visible rows whenever they change under it.
  const [focusId, setFocusId] = useState<string | null>(null);
  // Set on a keyboard move so the layout effect focuses the new row once it is
  // rendered, without stealing focus on an ordinary re-render.
  const pendingFocus = useRef<string | null>(null);

  // Keep the roving stop valid: default to the first row, and if the focused row
  // scrolled out of existence (a collapse, a filter) fall back to the first.
  useEffect(() => {
    if (rows.length === 0) {
      setFocusId(null);
    } else if (focusId === null || !rows.some((r) => r.id === focusId)) {
      setFocusId(rows[0].id);
    }
  }, [rows, focusId]);

  // Measure the real viewport once mounted (jsdom reports 0, so keep the default).
  useLayoutEffect(() => {
    const h = containerRef.current?.clientHeight ?? 0;
    if (h > 0) setViewport(h);
  }, [rows.length]);

  const total = rows.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(total, first + visible);
  const windowRows = rows.slice(first, last);

  // After a keyboard move, focus the target row and scroll it into view.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-id="${cssAttr(target)}"]`);
    el?.focus();
  }, [windowRows]);

  const focusIndex = focusId === null ? -1 : rows.findIndex((r) => r.id === focusId);

  /** Move the roving stop to a row by index, scrolling it into view. */
  const moveTo = (index: number) => {
    if (index < 0 || index >= rows.length) return;
    const id = rows[index].id;
    setFocusId(id);
    pendingFocus.current = id;
    const container = containerRef.current;
    if (!container) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    let next = scrollTop;
    if (top < scrollTop) next = top;
    else if (bottom > scrollTop + viewport) next = bottom - viewport;
    if (next !== scrollTop) {
      setScrollTop(next);
      container.scrollTop = next;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (focusIndex < 0) return;
    const row = rows[focusIndex];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(focusIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(focusIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        moveTo(0);
        break;
      case "End":
        e.preventDefault();
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        // Expand a collapsed node; on an already-open one, step to its first
        // child. On a leaf, nothing — matching the WAI-ARIA tree pattern.
        if (row.expandable && !row.expanded) onToggle(row.id, true);
        else if (row.expanded) moveTo(focusIndex + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        // Collapse an open node; on a closed one or a leaf, step to the parent
        // (the nearest previous row one level shallower).
        if (row.expanded) onToggle(row.id, false);
        else {
          for (let i = focusIndex - 1; i >= 0; i--) {
            if (rows[i].depth < row.depth) {
              moveTo(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(row.id);
        break;
      default:
        // Type-ahead: a printable key jumps to the next row whose label starts
        // with it, wrapping. One character is enough to be useful and avoids a
        // timed multi-key buffer.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          for (let step = 1; step <= rows.length; step++) {
            const i = (focusIndex + step) % rows.length;
            if (rows[i].label.toLowerCase().startsWith(ch)) {
              moveTo(i);
              break;
            }
          }
        }
    }
  };

  const headingId = `hierarchy-${title.replace(/\s+/g, "-").toLowerCase()}`;
  const empty = rows.length === 0;

  return (
    <section className="hierarchy-section">
      <h3 id={headingId}>
        {title}
        {filter.trim() && !empty && (
          <span className="hierarchy-match-count"> · {rows.length} shown</span>
        )}
      </h3>
      {empty ? (
        <p className="hint hierarchy-status">No matches in this section.</p>
      ) : (
        <div
          className="hierarchy-tree"
          role="tree"
          aria-labelledby={headingId}
          ref={containerRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
        >
          {/* Sized to the full row count so the scrollbar reflects the whole
              tree; only the window's rows are in the DOM, positioned by index. */}
          <div className="hierarchy-scroll" style={{ height: total * ROW_HEIGHT }}>
            {windowRows.map((row, i) => {
              const index = first + i;
              return (
                <TreeRow
                  key={row.id}
                  row={row}
                  index={index}
                  theme={theme}
                  isSelected={row.id === selected}
                  isFocus={row.id === focusId}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

interface TreeRowProps {
  row: Row;
  index: number;
  theme: Theme;
  isSelected: boolean;
  isFocus: boolean;
  onToggle: (id: string, next: boolean) => void;
  onSelect: (iri: string) => void;
}

function TreeRow({ row, index, theme, isSelected, isFocus, onToggle, onSelect }: TreeRowProps) {
  const level = row.depth + 1; // aria-level is 1-based
  const cappedDepth = Math.min(row.depth, MAX_VISUAL_DEPTH);
  const inferred = row.origin === "inferred";
  return (
    <div
      role="treeitem"
      data-id={row.id}
      aria-level={level}
      aria-posinset={row.posinset || undefined}
      aria-setsize={row.setsize || undefined}
      aria-selected={isSelected}
      aria-expanded={row.expandable ? row.expanded : undefined}
      tabIndex={isFocus ? 0 : -1}
      className={
        "hierarchy-row" +
        (isSelected ? " selected" : "") +
        (inferred ? " inferred" : "")
      }
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      title={row.prefixed || row.id}
      onClick={() => onSelect(row.id)}
    >
      <span className="hierarchy-indent" style={{ width: cappedDepth * INDENT }} aria-hidden="true" />
      {row.depth > MAX_VISUAL_DEPTH && (
        <span className="hierarchy-depth" aria-label={`depth ${level}`}>
          {level}
        </span>
      )}
      {row.expandable ? (
        <button
          type="button"
          className="hierarchy-twistie"
          // The button is decorative for state — aria-expanded on the row is the
          // source of truth — so it is hidden and the row stays the one control.
          aria-hidden="true"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.id, !row.expanded);
          }}
        >
          {row.expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="hierarchy-twistie spacer" aria-hidden="true" />
      )}
      <span
        className="hierarchy-dot"
        aria-hidden="true"
        style={{ background: kindColor(row.kind, theme) }}
      />
      <span className="hierarchy-label">{row.label}</span>
      <span className="hierarchy-kind">{KIND_LABELS[row.kind] ?? KIND_LABELS.other}</span>
      {inferred && (
        // The derived channel (D-046): a badge, a non-colour cue (the dashed
        // row border in CSS) and this aria mention. Dormant while every edge is
        // asserted; a synthetic inferred edge lights it up with no code change.
        <span className="hierarchy-inferred" aria-label="inferred, derived">
          inferred
        </span>
      )}
      {row.cyclic && (
        <span className="hierarchy-flag" title="This entity is its own ancestor (a cycle in the data).">
          cycle
        </span>
      )}
      {row.appearsElsewhere && (
        <span className="hierarchy-flag" aria-label="also appears elsewhere in the tree">
          also elsewhere
        </span>
      )}
      {!row.expanded && row.expandable && (
        <span
          className="hierarchy-count"
          aria-label={`${row.childCount} ${row.childCount === 1 ? "child" : "children"}`}
        >
          {row.childCount.toLocaleString()}
        </span>
      )}
    </div>
  );
}

/** Escape an IRI for use inside a QUOTED CSS attribute selector,
 *  `[data-id="…"]`. Only the backslash and the double quote need escaping there
 *  — not CSS.escape, whose identifier-context output would wrongly escape the
 *  `/ : #` an IRI is full of and never match. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
