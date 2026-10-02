/*
================================================================================
FILE: frontend/src/components/HierarchyView.tsx
================================================================================

SUMMARY
    The Hierarchy view: the ontology's structure as indented, expandable trees —
    a class hierarchy over rdfs:subClassOf, a concept hierarchy over skos:broader
    rooted at concept schemes, and (v0.3) one property hierarchy per property
    kind (object / datatype / annotation) over rdfs:subPropertyOf. Each section
    is shown only when its forest is non-empty. It is the force graph's
    accessible structural equivalent (D-025): a WAI-ARIA `tree` a screen reader
    and the keyboard can operate, which the WebGL canvas cannot be.

    The detail panel that explains a selected row is NOT here — App renders the
    reused Explore DetailPanel beside this tree, driven by the same shared
    selection (D-047), so this component stays the tree alone.

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

    With imports on (external-access Stage 2) the forests come from the merged
    view. A row for an entity defined only in an import carries a "from FOAF"
    suffix, in text, and the edge leading to it the origin "imported" -- the
    same seam, a third value.

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology's hierarchy to fetch (null renders nothing).
    - theme: for the kind swatches, via the same kindColor the legend uses.
    - selected: the shared selection, so the matching row is aria-selected.
    - onSelect: select an entity in the app's shared model, exactly as a graph
      click or a search pick does — so Explore shows its detail and the graph can
      draw it even when the budget left it out (AC-13).
    - imports: fetch the forests over the ontology plus its resolved imports.
    - revision, language: a project document's revision and display language;
      either moving refetches the forests and keeps expansion and filter.
    - editing: the open project's model.ttl (visual-modeling 5.2). The class
      section then always shows, with New class; the concept section has New
      concept; and each row has a menu (HierarchyActions.tsx) to add a child,
      rename in place in the primary language, or delete with its impact.
      A new entity is selected, its parent expanded, and focus moved to its
      row once the refreshed tree holds it.

      Its `kind` (relationships 5.1, D-089) decides which: an ontology's
      tree leads with its classes and offers New class, a taxonomy's with
      its concept scheme and offers New concept. The other kind's rows are
      still listed, never hidden, with no actions, under one line saying how
      many there are and where they are changed. And in a project the
      property sections are *Relationships* and *Attributes*, listing every
      object and datatype property with its ends -- *works for (Person →
      Organization)*, *name (Person, text)* -- so every line on the canvas
      has a row (5.5, D-078).
      A project's data snapshots (csv-data-import 5.1, 5.6) show in the
      Examples section beside the examples, each such row carrying its
      snapshot's label -- *from people.csv, imported 2 October 2026*, and a
      sample's words -- and no actions: snapshot data is read-only. The
      section's header offers *Import data from CSV…*, and in a project
      the section is there to offer it even before there is an example.

      A project's examples (shacl-authoring 5.8) have a section of their
      own, *Examples*, each under its class. The class rows there are
      headings, open from the start and with no actions, and the section
      keeps its own expansion, so opening Person there leaves the class
      tree as it was.
    - onDeleted: an entity was deleted from the tree.
    - canvas: past 300 boxes, the row menu's *Show on canvas* and *Hide from
      canvas* (visual-modeling 5.6).
    - canvasSwitch: the *Canvas* toggle in the toolbar (5.4), shown with the
      canvas beside the tree; the choice itself is App's to keep.

    The tree's forms and its delete run through one command runner, so a
    command in flight shows the view busy (5.8 item 1); they close when the
    document changes (item 6); and a new entity is selected only if the
    selection has not moved while it was being made (item 4).

EXPECTED OUTPUT
    - The rendered tree(s), an empty state, or the loading / error treatments.
    - onSelect(iri) when a row is activated by click, Enter or Space.
    - In a project, commands through the project store.
================================================================================
*/

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, fetchHierarchy } from "../api";
import type { CanvasSet, DataSource, Hierarchy, HierarchyForest, HierarchyNode, HierarchyOrigin, Theme } from "../types";
import { dataLabel } from "../modeling/dataSentences";
import { KIND_LABELS, kindColor } from "../types";
import type { ProjectKind } from "../types";
import { otherKindNote, otherKindReason, rowEnds } from "../modeling/sentences";
import DeleteDialog from "./DeleteDialog";
import { useRunner } from "./EditParts";
import { RowMenu, rowActions, type RowAction } from "./HierarchyActions";
import NewEntityForm, { type NewEntity } from "./NewEntityForm";

interface Props {
  ontologyId: string | null;
  theme: Theme;
  selected: string | null;
  onSelect: (iri: string) => void;
  imports?: boolean;
  /** A project document's revision and display language (authoring-
   *  foundations). A change refetches the forests but keeps what the user
   *  expanded and typed, so an edit does not collapse the tree. */
  revision?: number;
  language?: string | null;
  /** The open project's model.ttl: New buttons and the row menu (5.2), and
   *  the project's kind, which decides them (relationships 5.1). */
  editing?: { primaryLanguage: string; kind?: ProjectKind | null } | null;
  onDeleted?: (iri: string) => void;
  canvas?: CanvasSet | null;
  canvasSwitch?: { on: boolean; onToggle: () => void } | null;
  /** The project's data snapshots, whose labels name the rows they made
   *  (csv-data-import 5.6). */
  dataSources?: DataSource[];
  /** Import data from CSV (csv-data-import 5.1), offered in the Examples
   *  section's header. */
  onImportData?: () => void;
}

/** A "New ..." form open at the top of a section. */
interface Creating {
  section: "class" | "concept";
  parent?: { iri: string; label: string };
  /** The row the menu was opened on, for focus when the form is cancelled. */
  from?: string;
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
  /** A relationship's or attribute's ends, read as text (relationships 5.5). */
  ends?: string;
  origin: HierarchyOrigin;
  /** The import that defines this entity, with imports on; else undefined. */
  importedFrom?: string;
  /** A data snapshot's label, for a row its data made (csv-data-import 5.6). */
  fromData?: string;
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

  const visit = (id: string, depth: number, origin: HierarchyOrigin) => {
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
      ends: node.ends ? rowEnds(node.ends, node.kind === "datatypeProperty") : undefined,
      origin,
      importedFrom: node.importedFrom,
      fromData: node.fromData,
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

/** The forests to render, in order, with their section titles — each present
 *  only when its forest carries nodes. The class forest and the property forests
 *  (the T-box schema) come before the concept forest (the SKOS vocabulary),
 *  matching the spec's layout. `objectProperties` and friends are absent from the
 *  payload unless the ontology has that kind, so the optional chaining stands in
 *  for a missing key. */
function sectionsOf(
  data: Hierarchy,
  editing: { kind?: ProjectKind | null } | null = null,
  keepExamples = false,
): { title: string; forest: HierarchyForest }[] {
  // A project names its property sections as the learner does (5.5).
  const project = editing !== null;
  const candidates: { title: string; forest: HierarchyForest | undefined }[] = [
    { title: CLASS_SECTION, forest: data.classes },
    { title: project ? "Relationships" : "Object properties", forest: data.objectProperties },
    { title: project ? "Attributes" : "Datatype properties", forest: data.datatypeProperties },
    { title: "Annotation properties", forest: data.annotationProperties },
    // A project's examples, by class (shacl-authoring 5.8). Before the
    // concepts, which a taxonomy moves to the front.
    // With an import to offer, it is there before the first example.
    {
      title: EXAMPLES_SECTION,
      forest: project ? (data.examples ?? (keepExamples ? EMPTY_FOREST : undefined)) : undefined,
    },
    { title: CONCEPT_SECTION, forest: data.concepts },
  ];
  // A taxonomy leads with its scheme: it is the model (5.1).
  if (editing?.kind === "taxonomy") candidates.unshift(candidates.pop()!);
  // In a project the kind's own section stays, empty or not: it is where New
  // class or New concept lives, and an empty model has to start somewhere.
  // A project from before kinds keeps the class section, as it always did.
  const kept = !project ? null : editing?.kind === "taxonomy" ? CONCEPT_SECTION : CLASS_SECTION;
  return candidates.filter(
    (c): c is { title: string; forest: HierarchyForest } =>
      c.forest !== undefined &&
      (Object.keys(c.forest.nodes).length > 0 || c.title === kept || (keepExamples && c.title === EXAMPLES_SECTION)),
  );
}

const EMPTY_FOREST: HierarchyForest = { nodes: {}, children: {}, roots: [] };

/** The tree with each snapshot row's id replaced by its snapshot's label. */
function withDataLabels(data: Hierarchy | null, sources: DataSource[] | undefined): Hierarchy | null {
  if (!data || !sources?.length) return data;
  const labels = new Map(sources.map((source) => [source.id, dataLabel(source)]));
  const relabel = (forest: HierarchyForest | undefined): HierarchyForest | undefined => {
    if (!forest || !Object.values(forest.nodes).some((n) => n.fromData)) return forest;
    const nodes: Record<string, HierarchyNode> = {};
    for (const [id, node] of Object.entries(forest.nodes)) {
      nodes[id] = node.fromData ? { ...node, fromData: labels.get(node.fromData) ?? "from imported data" } : node;
    }
    return { ...forest, nodes };
  };
  return { ...data, examples: relabel(data.examples), concepts: relabel(data.concepts)!, classes: relabel(data.classes)! };
}

const CLASS_SECTION = "Class hierarchy";
const CONCEPT_SECTION = "Concept hierarchy";
const EXAMPLES_SECTION = "Examples";

export default function HierarchyView({
  ontologyId,
  theme,
  selected,
  onSelect,
  imports = false,
  revision = 0,
  language = null,
  editing = null,
  onDeleted,
  canvas = null,
  canvasSwitch = null,
  dataSources,
  onImportData,
}: Props) {
  const [fetched, setData] = useState<Hierarchy | null>(null);
  // Snapshot rows named by their snapshot's label (csv-data-import 5.6).
  const data = useMemo(() => withDataLabels(fetched, dataSources), [fetched, dataSources]);
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
    fetchHierarchy(ontologyId, imports)
      .then((h) => !cancelled && setData(h))
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ontologyId, imports]);

  // An edit or a language switch: the same ontology, new forests. Only the
  // data is replaced; the first run is the effect above's.
  const refreshKey = `${revision}|${language}`;
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (!ontologyId || lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    let cancelled = false;
    fetchHierarchy(ontologyId, imports)
      .then((h) => !cancelled && setData(h))
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const toggle = useCallback((id: string, next: boolean) => {
    setExpanded((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }, []);

  // Every forest currently present, in render order. Computed once and reused by
  // expand-all, the empty-state check and the render.
  const sections = useMemo(
    () => (data ? sectionsOf(data, editing, onImportData !== undefined) : []),
    [data, editing, onImportData],
  );
  const kind = editing?.kind ?? null;
  // The other kind's content, counted for its one line (5.1).
  const otherNote = useMemo(() => {
    if (!data || !kind) return null;
    const forest = kind === "ontology" ? data.concepts : data.classes;
    const other = kind === "ontology" ? "concept" : "class";
    return otherKindNote(kind, Object.values(forest.nodes).filter((n) => n.kind === other && !n.importedFrom).length);
  }, [data, kind]);
  /** A row of the other kind: shown, never changed here (D-089). */
  const fixedRow = useCallback((row: Row) => otherKindReason(kind, row.kind) !== null, [kind]);

  // The Examples section (5.8) names classes the class tree names too, so it
  // keeps its own expansion: opening Person here must not open it there.
  // Its classes start open, since they are only headings for the examples,
  // and they carry no actions: a class is changed in the class tree.
  const [examplesClosed, setExamplesClosed] = useState<Set<string>>(new Set());
  const examplesOpen = useMemo(
    () => new Set((data?.examples?.roots ?? []).filter((id) => !examplesClosed.has(id))),
    [data, examplesClosed],
  );
  const toggleExamples = useCallback((id: string, next: boolean) => {
    setExamplesClosed((prev) => {
      const set = new Set(prev);
      if (next) set.delete(id);
      else set.add(id);
      return set;
    });
  }, []);
  const fixedExampleRow = useCallback((row: Row) => row.kind !== "individual" || fixedRow(row), [fixedRow]);

  // --- the project's actions (5.2) ------------------------------------------
  const sectionRef = useRef<HTMLElement>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ iri: string; label: string } | null>(null);
  const [menu, setMenu] = useState<{ row: Row; anchor: { top: number; left: number }; fixed: boolean } | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const runner = useRunner();
  const { busy, run, clear } = runner;
  const actionError = runner.errors.tree || null;
  const setActionError = (_: null) => clear("tree");
  // The selection as it is now, for a create that answers after it moved.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;

  // Another document: whatever was open in the tree was about the old one.
  useEffect(() => {
    setCreating(null);
    setRenaming(null);
    setDeleting(null);
    setMenu(null);
    setReveal(null);
    clear("tree");
  }, [ontologyId, clear]);

  const focusRow = useCallback((id: string) => {
    window.setTimeout(() => {
      sectionRef.current
        ?.querySelector<HTMLElement>(`[role="treeitem"][data-id="${cssAttr(id)}"]`)
        ?.focus();
    }, 0);
  }, []);

  const closeMenu = useCallback(() => {
    setMenu((open) => {
      if (open) focusRow(open.row.id);
      return null;
    });
  }, [focusRow]);

  const choose = (row: Row, action: RowAction) => {
    setMenu(null);
    setActionError(null);
    if (action === "addChild") {
      setCreating({
        section: row.kind === "concept" ? "concept" : "class",
        parent: { iri: row.id, label: row.label },
        from: row.id,
      });
    } else if (action === "rename") {
      setRenaming(row.id);
    } else if (action === "show" || action === "hide") {
      focusRow(row.id);
      void (action === "show" ? canvas?.show(row.id) : canvas?.hide(row.id));
    } else {
      // The dialog gives focus back to what held it when it opened.
      focusRow(row.id);
      setDeleting({ iri: row.id, label: row.label });
    }
  };

  const create = async ({ name, iri }: NewEntity) => {
    if (!creating || busy || !data) return;
    const { section, parent } = creating;
    const scheme = Object.entries(data.concepts.nodes).find(([, n]) => n.kind === "conceptScheme")?.[0];
    const args =
      section === "class"
        ? { label: name, iri, parent: parent?.iri }
        : { prefLabel: name, iri, ...(parent ? { broader: parent.iri } : scheme ? { scheme } : {}) };
    const before = selectedNow.current;
    const result = await run("tree", section === "class" ? "CreateClass" : "CreateConcept", args);
    if (!result || !runner.alive()) return;
    setCreating(null);
    if (parent) setExpanded((prev) => new Set(prev).add(parent.iri));
    // Only if nothing else was selected while the command ran (5.8 item 4).
    if (result.created && selectedNow.current === before) {
      onSelect(result.created);
      setReveal(result.created);
    }
  };

  const cancelCreate = () => {
    const from = creating?.from;
    setCreating(null);
    setActionError(null);
    if (from) focusRow(from);
  };

  const rename = async (row: Row, value: string | null) => {
    if (value === null || !value.trim() || !editing) {
      setRenaming(null);
      setActionError(null);
      focusRow(row.id);
      return;
    }
    if (await run("tree", "SetLabel", { iri: row.id, value: value.trim(), lang: editing.primaryLanguage })) {
      setRenaming(null);
      focusRow(row.id);
    }
  };

  const header = (title: string): ReactNode => {
    if (!editing) return null;
    if (title === EXAMPLES_SECTION && onImportData) {
      return (
        <div className="hierarchy-actions">
          <button type="button" className="ghost" onClick={onImportData}>
            Import data from CSV…
          </button>
        </div>
      );
    }
    const section = title === CLASS_SECTION ? "class" : title === CONCEPT_SECTION ? "concept" : null;
    if (!section) return null;
    // The kind's own New button only; a project from before kinds has both.
    if ((kind === "ontology" && section === "concept") || (kind === "taxonomy" && section === "class")) return null;
    const open = creating?.section === section;
    return (
      <div className="hierarchy-actions">
        {!open && (
          <button type="button" className="ghost" onClick={() => setCreating({ section })}>
            {section === "class" ? "New class" : "New concept"}
          </button>
        )}
        {open && creating && (
          <NewEntityForm
            title={
              creating.parent
                ? `New ${section === "class" ? "subclass" : "narrower concept"} of ${creating.parent.label}`
                : section === "class"
                  ? "New class"
                  : "New concept"
            }
            primaryLanguage={editing.primaryLanguage}
            busy={busy}
            error={actionError}
            onSubmit={(entity) => void create(entity)}
            onCancel={cancelCreate}
          />
        )}
      </div>
    );
  };

  const expandAll = useCallback(() => {
    if (!data) return;
    setExpanded(new Set(sections.flatMap((s) => internalIds(s.forest))));
  }, [data, sections]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  if (!ontologyId) return null;

  return (
    <section
      className="hierarchy-view"
      aria-labelledby={HEADING_ID}
      ref={sectionRef}
      // A command in flight, as the form's section says it (PR #47 review).
      aria-busy={busy}
    >
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
        {canvasSwitch && (
          <button
            type="button"
            className="ghost"
            aria-pressed={canvasSwitch.on}
            onClick={canvasSwitch.onToggle}
            title={canvasSwitch.on ? "Show the tree only" : "Show the canvas beside the tree"}
          >
            {/* The state in sight as well as in aria-pressed; not by colour alone. */}
            <span aria-hidden="true">{canvasSwitch.on ? "✓ " : ""}</span>
            Canvas
          </button>
        )}
      </div>
      {editing && (
        <p className="detail-note edit-status" role="status">
          {busy ? "Saving change…" : ""}
        </p>
      )}
      {/* Not colour-only: aria-expanded carries expansion and the note is text,
          so nothing here depends on a triangle glyph being seen. */}
      <p className="hierarchy-note">
        Showing <strong>asserted</strong> {" "}
        <code>rdfs:subClassOf</code>, <code>skos:broader</code> and{" "}
        <code>rdfs:subPropertyOf</code>, not inferred relationships.
        {editing && (
          <>
            {" "}
            A row's actions open with its <kbd>⋯</kbd> button, or <kbd>Shift</kbd>+<kbd>F10</kbd>{" "}
            on the focused row.
          </>
        )}
      </p>
      {otherNote && <p className="detail-note hierarchy-other-kind">{otherNote}</p>}
      {renaming && actionError && (
        <p className="edit-error" role="alert">
          {actionError}
        </p>
      )}

      {loading && <p className="hint hierarchy-status">Loading the hierarchy…</p>}
      {error && (
        <div className="error-bar" onClick={() => setError(null)} title="Click to dismiss">
          {error}
        </div>
      )}

      {data && sections.length === 0 && (
        <p className="hint hierarchy-status">
          This ontology declares no <code>subClassOf</code>, <code>broader</code> or{" "}
          <code>subPropertyOf</code> structure to show as a tree.
        </p>
      )}

      {data && sections.length > 0 && (
        <div className="hierarchy-forests">
          {sections.map((section) => {
            const isExamples = section.title === EXAMPLES_SECTION;
            const fixed = isExamples ? fixedExampleRow : fixedRow;
            return (
            <Forest
              key={section.title}
              title={section.title}
              forest={section.forest}
              filter={filter}
              expanded={isExamples ? examplesOpen : expanded}
              selected={selected}
              theme={theme}
              onToggle={isExamples ? toggleExamples : toggle}
              onSelect={onSelect}
              header={header(section.title)}
              editable={editing !== null}
              renaming={renaming}
              renameValue={(row) => (language === null || language === editing?.primaryLanguage ? row.label : "")}
              busy={busy}
              onRename={(row, value) => void rename(row, value)}
              onMenu={(row, anchor) => setMenu({ row, anchor, fixed: fixed(row) })}
              fixedRow={fixed}
              reveal={reveal}
              onRevealed={() => setReveal(null)}
            />
            );
          })}
        </div>
      )}
      {menu && (
        <RowMenu
          label={menu.row.label}
          items={rowActions(
            menu.row.kind,
            Boolean(menu.row.importedFrom || menu.row.fromData),
            canvas ? { limited: canvas.limited, shown: canvas.shown.includes(menu.row.id) } : null,
            menu.fixed,
          )}
          anchor={menu.anchor}
          onChoose={(action) => choose(menu.row, action)}
          onClose={closeMenu}
        />
      )}
      {deleting && (
        <DeleteDialog
          iri={deleting.iri}
          label={deleting.label}
          runner={runner}
          onDone={(deleted) => {
            setDeleting(null);
            if (deleted) {
              onDeleted?.(deleting.iri);
              // Its row is gone; the view's heading is the nearest stable place.
              window.setTimeout(() => document.getElementById(HEADING_ID)?.focus(), 0);
            }
          }}
        />
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
  /** In a project: the New button and its form, above the tree. */
  header?: ReactNode;
  /** In a project: rows carry a menu, and one may be renamed in place. */
  editable?: boolean;
  renaming?: string | null;
  renameValue?: (row: Row) => string;
  busy?: boolean;
  onRename?: (row: Row, value: string | null) => void;
  onMenu?: (row: Row, anchor: { top: number; left: number }) => void;
  /** A row of the project's other kind, which has no actions (D-089). */
  fixedRow?: (row: Row) => boolean;
  /** A row to focus once it is in this forest (a new entity). */
  reveal?: string | null;
  onRevealed?: () => void;
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
  header = null,
  editable = false,
  renaming = null,
  renameValue,
  busy = false,
  onRename,
  onMenu,
  fixedRow,
  reveal = null,
  onRevealed,
}: ForestProps) {
  const actionsOf = (row: Row) =>
    rowActions(row.kind, Boolean(row.importedFrom || row.fromData), null, fixedRow?.(row) ?? false);
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

  // A new entity: focus its row once the refreshed forest holds it.
  useEffect(() => {
    if (!reveal) return;
    const index = rows.findIndex((r) => r.id === reveal);
    if (index >= 0) {
      moveTo(index);
      onRevealed?.();
    }
  }, [rows, reveal]);

  /** Open the row menu beside a row, from its button or the keyboard. */
  const openMenu = (row: Row, element: Element | null) => {
    if (!onMenu || actionsOf(row).length === 0) return;
    const rect = element?.getBoundingClientRect();
    onMenu(row, { top: rect ? rect.bottom : 0, left: rect ? Math.max(0, rect.right - 200) : 0 });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (focusIndex < 0) return;
    const row = rows[focusIndex];
    if (editable && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      openMenu(row, e.target as Element);
      return;
    }
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
  const filtering = filter.trim() !== "";

  return (
    <section className="hierarchy-section">
      <h3 id={headingId}>
        {title}
        {filter.trim() && !empty && (
          <span className="hierarchy-match-count"> · {rows.length} shown</span>
        )}
      </h3>
      {header}
      {empty ? (
        <p className="hint hierarchy-status">
          {filtering
            ? "No matches in this section."
            : title === CONCEPT_SECTION
              ? "No concepts yet. New concept makes the first."
              : title === EXAMPLES_SECTION
                ? "No examples or imported data yet."
                : "No classes yet. New class makes the first."}
        </p>
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
                  onFocus={setFocusId}
                  menu={editable && actionsOf(row).length > 0 ? openMenu : undefined}
                  rename={
                    renaming === row.id && onRename
                      ? { initial: renameValue?.(row) ?? row.label, busy, onDone: (v) => onRename(row, v) }
                      : undefined
                  }
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
  /** Keeps the roving tab stop on a row focused by script or pointer. */
  onFocus?: (id: string) => void;
  /** In a project: open this row's menu. */
  menu?: (row: Row, element: Element | null) => void;
  /** This row is being renamed. `onDone(null)` cancels. */
  rename?: { initial: string; busy: boolean; onDone: (value: string | null) => void };
}

/** The name field of a row being renamed. Keys stay in it: the tree's own
 *  arrow keys and type-ahead must not act while the user is typing. */
function RenameField({
  label,
  initial,
  busy,
  onDone,
}: {
  label: string;
  initial: string;
  busy: boolean;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="hierarchy-rename"
      aria-label={`New name for ${label}`}
      autoFocus
      value={value}
      readOnly={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          // Unchanged is a cancel: the server would refuse "That would
          // change nothing" (found in review).
          if (!busy) onDone(value.trim() === initial.trim() ? null : value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
      onBlur={() => !busy && onDone(null)}
    />
  );
}

function TreeRow({
  row,
  index,
  theme,
  isSelected,
  isFocus,
  onToggle,
  onSelect,
  onFocus,
  menu,
  rename,
}: TreeRowProps) {
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
      aria-keyshortcuts={menu ? "Shift+F10" : undefined}
      className={
        "hierarchy-row" +
        (isSelected ? " selected" : "") +
        (inferred ? " inferred" : "")
      }
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      title={row.prefixed || row.id}
      onClick={() => onSelect(row.id)}
      onFocus={(e) => e.target === e.currentTarget && onFocus?.(row.id)}
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
      {rename ? (
        <RenameField label={row.label} initial={rename.initial} busy={rename.busy} onDone={rename.onDone} />
      ) : (
        <span className="hierarchy-label">{row.label}</span>
      )}
      {row.ends && !rename && <span className="hierarchy-ends">({row.ends})</span>}
      <span className="hierarchy-kind">{KIND_LABELS[row.kind] ?? KIND_LABELS.other}</span>
      {row.importedFrom && (
        // Text, not a tint: imported and read-only has to survive being read
        // aloud (AC-21, AC-35).
        <span className="hierarchy-imported">from {row.importedFrom}</span>
      )}
      {row.fromData && (
        // Snapshot data is never mistaken for the model (Section 7): its
        // label, a sample's words included, is on the row itself.
        <span className="hierarchy-imported hierarchy-data">{row.fromData}</span>
      )}
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
      {menu && !rename && (
        // For the pointer only. Out of the tab order, because the row is the
        // tree's one stop, and out of the accessibility tree, because a
        // treeitem is named by its contents and "Person Class More actions
        // for Person" was what Chrome read (measured). The row declares
        // Shift+F10, which opens the same menu (HierarchyActions.tsx).
        <button
          type="button"
          className="hierarchy-menu-btn"
          tabIndex={-1}
          aria-hidden="true"
          aria-haspopup="menu"
          aria-label={`More actions for ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            menu(row, e.currentTarget);
          }}
        >
          ⋯
        </button>
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
