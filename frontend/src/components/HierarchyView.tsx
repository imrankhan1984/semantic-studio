/*
================================================================================
FILE: frontend/src/components/HierarchyView.tsx
================================================================================

SUMMARY
    The Edit page's outline (edit-page-rework 5.3; the Hierarchy view before
    it): the ontology's structure as indented, expandable trees -- classes
    over rdfs:subClassOf, concepts over skos:broader rooted at concept
    schemes, and (v0.3) one property tree per property kind (object /
    datatype / annotation) over rdfs:subPropertyOf -- each a folding section
    whose header names its count and, in a project, has a + that makes one of
    its kind. A library ontology lists the sections it has. It is the force graph's
    accessible structural equivalent (D-025): a WAI-ARIA `tree` a screen reader
    and the keyboard can operate, which the WebGL canvas cannot be.

    The detail panel that explains a selected row is NOT here — App renders the
    reused Explore DetailPanel in the side panel, driven by the same shared
    selection (D-047), so this component stays the outline alone. Nor are the
    New … forms: a + or a row's *Add subclass* begins the project store's one
    draft, whose form is the side panel's and whose box is the canvas's; the
    outline shows the draft's row, in italics, under its parent.

    The height rule (CF-9): a folded section is its 32 px header; open ones
    share what is left, at least 120 px each, and clip and scroll inside
    themselves; past that the column scrolls. By default the kind's own
    section and Relationships are open, and which are open is remembered
    per ontology for the session (module state, so a test calls
    _resetOutline).

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

    Every child edge carries an `origin`. An "inferred" edge -- a reasoning
    result's new kind, or a new membership in the Examples section -- renders
    with the derived badge, a non-colour cue and an aria mention (D-046); the
    tree asks for them with `inferred` while a current result exists and
    Show inferred is on (axioms-and-reasoning 5.7), and an inferred row's
    menu offers no edit.

    With imports on (external-access Stage 2) the forests come from the merged
    view. A row for an entity defined only in an import carries a "from FOAF"
    suffix, in text, and the edge leading to it the origin "imported" -- the
    same seam, a third value.

INPUTS / INPUT SOURCES (props)
    - ontologyId: which ontology's hierarchy to fetch (null renders nothing).
    - selected: the shared selection, so the matching row is aria-selected.
    - onSelect: select an entity in the app's shared model, exactly as a graph
      click or a search pick does — so Explore shows its detail and the graph can
      draw it even when the budget left it out (AC-13).
    - imports: fetch the forests over the ontology plus its resolved imports.
    - revision, language: a project document's revision and display language;
      either moving refetches the forests and keeps expansion and filter.
    - editing: the open project's model.ttl (visual-modeling 5.2). The class
      section then always shows, with its + (New class); the concept section
      has New concept; Relationships, Attributes and Examples have theirs;
      and each row has a menu (HierarchyActions.tsx) to add a child, rename
      in place in the primary language, or delete with its impact. A new
      entity's section and parent open, and focus moves to its row once the
      refreshed tree holds it, unless its canvas box takes it.

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
      section's + offers *Import data from CSV or Excel…*, and in a project
      the section is there to offer it even before there is an example.

      A project's examples (shacl-authoring 5.8) have a section of their
      own, *Examples*, each under its class. The class rows there are
      headings, open from the start and with no actions, and the section
      keeps its own expansion, so opening Person there leaves the class
      tree as it was.
    - onDeleted: an entity was deleted from the tree.
    - canvas: past 300 boxes, the row menu's *Show on canvas* and *Hide from
      canvas* (visual-modeling 5.6).
    - inferred: fetch the forests with a current reasoning result's edges.
    - canvasShown: a new class or concept takes focus on its canvas box;
      without the canvas, and for anything else, on its row here.
    - onCounts: the model's counts, for the side panel's summary (5.4).
    Each row's dot is in the Edit page's kind colours (5.8), by class.

    The tree's rename and delete run through one command runner, so a
    command in flight shows the view busy (5.8 item 1); they, and a draft,
    end when the document changes (item 6).

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
} from "react";
import { ApiError, fetchHierarchy } from "../api";
import type { CanvasSet, DataSource, Hierarchy, HierarchyForest, HierarchyNode, HierarchyOrigin } from "../types";
import { dataLabel } from "../modeling/dataSentences";
import { kindLabel } from "../types";
import type { CreatingKind, ProjectKind } from "../types";
import { otherKindNote, otherKindReason, rowEnds } from "../modeling/sentences";
import DeleteDialog from "./DeleteDialog";
import { useRunner } from "./EditParts";
import { RowMenu, rowActions, type RowAction } from "./HierarchyActions";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ModelCounts } from "./NothingSelected";

interface Props {
  ontologyId: string | null;
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
  /** The project's data snapshots, whose labels name the rows they made
   *  (csv-data-import 5.6). */
  dataSources?: DataSource[];
  /** Import data from CSV or Excel (csv-data-import 5.1), offered in the Examples
   *  section's header. */
  onImportData?: () => void;
  /** A current reasoning result's edges, shown (axioms-and-reasoning 5.7). */
  inferred?: boolean;
  /** Which result: a new one refetches even when its basis is the same. */
  inferredToken?: number;
  /** The canvas is beside the outline: a new class or concept then takes
   *  focus on its box, anything else on its row here (Section 6). */
  canvasShown?: boolean;
  /** The model's counts for the side panel's summary (5.4). */
  onCounts?: (counts: ModelCounts) => void;
}

/** Fixed row height, in pixels, shared by the CSS and the windowing maths. */
const ROW_HEIGHT = 28;
/** A section's header, as the CSS draws it (.hierarchy-section-head). */
const SECTION_HEAD = 32;
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

/** A row's dot, in the Edit page's kind colours (edit-page-rework 5.8), the
 *  canvas's own: an OWL or RDFS class, a concept, a scheme, an example, an
 *  attribute, a relationship. The tokens are index.css's, which say what
 *  the portal's one palette says (theme/kinds.ts, D-109); this file must
 *  not import canvas/ (App reaches canvas/ only through React.lazy). */
function dotKind(kind: string, classType?: string): string {
  switch (kind) {
    case "class":
      return classType === "rdfs" ? "rdfs" : "owl";
    case "concept":
      return "concept";
    case "conceptScheme":
      return "scheme";
    case "individual":
      return "example";
    case "datatypeProperty":
      return "attribute";
    case "objectProperty":
      return "relationship";
    default:
      return "other";
  }
}

/** One row in the flattened, expansion-aware sequence the tree renders. */
interface Row {
  id: string;
  /** The row's path from its root: unique where the id is not, since a node
   *  under two parents is two rows. React keys on it; keyed on the id, the
   *  duplicate rows were left behind in the DOM when the tree changed --
   *  found when inferred memberships put Bea under Person and Agent and the
   *  inferred rows outlived Show inferred (axioms-and-reasoning R5). */
  key: string;
  depth: number;
  label: string;
  prefixed: string;
  kind: string;
  /** A class row's typing (edit-page-rework 5.8), for its dot. */
  classType?: string;
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
  /** A draft being named, not yet in the model (edit-page-rework 5.5). */
  pending?: boolean;
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

  const visit = (id: string, depth: number, origin: HierarchyOrigin, parentKey: string) => {
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
    const key = `${parentKey}>${id}`;
    rows.push({
      id,
      key,
      depth,
      label: node.label,
      prefixed: node.prefixed,
      kind: node.kind,
      classType: node.classType,
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
        visit(child.id, depth + 1, child.origin, key);
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
    visit(rootId, 0, "asserted", "");
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

/** One folding section of the outline (edit-page-rework 5.3). */
type SectionId = "classes" | "concepts" | "relationships" | "attributes" | "annotations" | "examples";

interface OutlineSection {
  id: SectionId;
  title: string;
  forest: HierarchyForest;
  /** What its + makes, in a project; null for none. */
  add: CreatingKind | "examples" | null;
}

/** The node kind a section counts in its header. */
const COUNTED: Record<SectionId, string> = {
  classes: "class",
  concepts: "concept",
  relationships: "objectProperty",
  attributes: "datatypeProperty",
  annotations: "annotationProperty",
  examples: "individual",
};

/** The section a new thing's row is in. */
const CREATED_IN: Record<CreatingKind, SectionId> = {
  class: "classes",
  concept: "concepts",
  objectProperty: "relationships",
  datatypeProperty: "attributes",
  example: "examples",
};

/** Each + by its accessible name (Section 6). */
const ADD_LABELS: Record<CreatingKind | "examples", string> = {
  class: "New class",
  concept: "New concept",
  objectProperty: "New relationship",
  datatypeProperty: "New attribute",
  example: "New example",
  examples: "New example or import",
};

/** The outline's sections, in order (5.3). In a project: the kind's own
 *  section first (Classes, or Concepts in a taxonomy), then Relationships,
 *  Attributes and Examples, always there so their + is; then annotation
 *  properties when there are any, and the other kind's content, read-only,
 *  when the file has some (D-089). A library ontology lists what it has,
 *  with no +. `objectProperties` and friends are absent from the payload
 *  unless the ontology has that kind. */
function sectionsOf(
  data: Hierarchy,
  editing: { kind?: ProjectKind | null } | null = null,
  keepExamples = false,
): OutlineSection[] {
  const has = (forest: HierarchyForest | undefined): forest is HierarchyForest =>
    forest !== undefined && Object.keys(forest.nodes).length > 0;
  if (editing === null) {
    const library: (OutlineSection | null)[] = [
      has(data.classes) ? { id: "classes", title: "Classes", forest: data.classes, add: null } : null,
      has(data.objectProperties) ? { id: "relationships", title: "Object properties", forest: data.objectProperties, add: null } : null,
      has(data.datatypeProperties) ? { id: "attributes", title: "Datatype properties", forest: data.datatypeProperties, add: null } : null,
      has(data.annotationProperties) ? { id: "annotations", title: "Annotation properties", forest: data.annotationProperties, add: null } : null,
      has(data.concepts) ? { id: "concepts", title: "Concepts", forest: data.concepts, add: null } : null,
    ];
    return library.filter((x): x is OutlineSection => x !== null);
  }
  const kind = editing.kind ?? null;
  const taxonomy = kind === "taxonomy";
  // A project from before kinds keeps both New buttons, as it always did.
  const classes: OutlineSection = { id: "classes", title: "Classes", forest: data.classes, add: kind === "taxonomy" ? null : "class" };
  const concepts: OutlineSection = { id: "concepts", title: "Concepts", forest: data.concepts, add: kind === "ontology" ? null : "concept" };
  const relationships: OutlineSection = {
    id: "relationships", title: "Relationships", forest: data.objectProperties ?? EMPTY_FOREST, add: taxonomy ? null : "objectProperty",
  };
  const attributes: OutlineSection = {
    id: "attributes", title: "Attributes", forest: data.datatypeProperties ?? EMPTY_FOREST, add: taxonomy ? null : "datatypeProperty",
  };
  const examples: OutlineSection = {
    id: "examples", title: "Examples", forest: data.examples ?? EMPTY_FOREST, add: taxonomy || !keepExamples ? null : "examples",
  };
  const annotations: OutlineSection = {
    id: "annotations", title: "Annotation properties", forest: data.annotationProperties ?? EMPTY_FOREST, add: null,
  };
  const out: OutlineSection[] = taxonomy
    ? [concepts, ...[relationships, attributes].filter((x) => has(x.forest))]
    : [classes, relationships, attributes];
  if (has(examples.forest) || (keepExamples && !taxonomy)) out.push(examples);
  if (has(annotations.forest)) out.push(annotations);
  // The other kind's content: listed, never hidden (D-089).
  if (taxonomy && has(data.classes)) out.push(classes);
  if (!taxonomy && has(data.concepts)) out.push(concepts);
  return out;
}

/** Which sections a view starts with open (5.3): the kind's own and
 *  Relationships. Kept per ontology for the session, in module state. */
function defaultOpen(sections: OutlineSection[], kind: ProjectKind | null | undefined): Set<SectionId> {
  const ids = new Set(sections.map((x) => x.id));
  const own: SectionId = kind === "taxonomy" || (!ids.has("classes") && ids.has("concepts")) ? "concepts" : "classes";
  return new Set<SectionId>([own, "relationships"]);
}
const openSections = new Map<string, Set<SectionId>>();

/** Forget every remembered section, for a test's clean start. */
export function _resetOutline(): void {
  openSections.clear();
}

/** How many of a section's own kind it holds, or match the filter; with
 *  `ownOnly`, only the model's own: no import's and no snapshot's. */
function countOf(forest: HierarchyForest, kind: string, query: string, ownOnly = false): number {
  const q = query.trim().toLowerCase();
  let n = 0;
  for (const [id, node] of Object.entries(forest.nodes)) {
    if (node.kind !== kind) continue;
    if (ownOnly && (node.importedFrom || node.fromData)) continue;
    if (!q || node.label.toLowerCase().includes(q) || localName(id).toLowerCase().includes(q)) n++;
  }
  return n;
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

/** The tree without a reasoning result's edges. The marks leave at once
 *  when the result goes stale or Show inferred is turned off (5.3), not when
 *  the refetch lands: found in Chrome (R5), where the last forests kept four
 *  inferred rows for the length of a request. A class the result alone had
 *  made a heading in the Examples section goes with its last inferred row. */
export function withoutInferred(data: Hierarchy | null): Hierarchy | null {
  if (!data) return data;
  const strip = (forest: HierarchyForest | undefined): HierarchyForest | undefined => {
    if (!forest || !Object.values(forest.children).some((kids) => kids.some((k) => k.origin === "inferred"))) {
      return forest;
    }
    const children: Record<string, HierarchyForest["children"][string]> = {};
    const emptied = new Set<string>();
    for (const [parent, kids] of Object.entries(forest.children)) {
      const kept = kids.filter((k) => k.origin !== "inferred");
      if (kept.length) children[parent] = kept;
      else emptied.add(parent);
    }
    const nodes = { ...forest.nodes };
    for (const id of emptied) nodes[id] = { ...nodes[id], hasChildren: false };
    return { ...forest, nodes, children };
  };
  const out: Hierarchy = { ...data, classes: strip(data.classes)!, concepts: strip(data.concepts)! };
  if (data.examples) {
    const examples = strip(data.examples)!;
    // A heading whose every member is inferred is one the result added.
    const added = (id: string) => (data.examples!.children[id] ?? []).length > 0 &&
      data.examples!.children[id].every((k) => k.origin === "inferred");
    out.examples = { ...examples, roots: examples.roots.filter((id) => !added(id)) };
  }
  return out;
}

export default function HierarchyView({
  ontologyId,
  selected,
  onSelect,
  imports = false,
  revision = 0,
  language = null,
  editing = null,
  onDeleted,
  canvas = null,
  dataSources,
  onImportData,
  inferred = false,
  inferredToken = 0,
  canvasShown = false,
  onCounts,
}: Props) {
  const [fetched, setData] = useState<Hierarchy | null>(null);
  // Snapshot rows named by their snapshot's label (csv-data-import 5.6).
  const data = useMemo(
    () => withDataLabels(inferred ? fetched : withoutInferred(fetched), dataSources),
    [fetched, dataSources, inferred],
  );
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
    fetchHierarchy(ontologyId, imports, inferred)
      .then((h) => !cancelled && setData(h))
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `inferred` is read here but refetches through refreshKey below, so
    // turning the marks on or off keeps what is expanded.
  }, [ontologyId, imports]);

  // An edit, a language switch, or the inferred marks coming or going: the
  // same ontology, new forests. Only the data is replaced; the first run is
  // the effect above's.
  const refreshKey = `${revision}|${language}|${inferred ? inferredToken : "off"}`;
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (!ontologyId || lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    let cancelled = false;
    fetchHierarchy(ontologyId, imports, inferred)
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

  // Every section currently present, in render order. Computed once and
  // reused by expand-all, the empty-state check and the render.
  const sections = useMemo(
    () => (data ? sectionsOf(data, editing, onImportData !== undefined) : []),
    [data, editing, onImportData],
  );
  const kind = editing?.kind ?? null;

  // Which sections are open (5.3): remembered per ontology for the session.
  const [open, setOpen] = useState<Set<SectionId> | null>(() =>
    ontologyId ? (openSections.get(ontologyId) ?? null) : null,
  );
  useEffect(() => {
    setOpen(ontologyId ? (openSections.get(ontologyId) ?? null) : null);
  }, [ontologyId]);
  const openNow = useMemo(() => open ?? defaultOpen(sections, kind), [open, sections, kind]);
  const toggleSection = useCallback(
    (id: SectionId) => {
      const next = new Set(openNow);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (ontologyId) openSections.set(ontologyId, next);
      setOpen(next);
    },
    [openNow, ontologyId],
  );

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
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ iri: string; label: string } | null>(null);
  const [menu, setMenu] = useState<{ row: Row; anchor: { top: number; left: number }; fixed: boolean } | null>(null);
  const [examplesMenu, setExamplesMenu] = useState<{ anchor: { top: number; left: number }; button: HTMLElement } | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const runner = useRunner();
  const { busy, run, clear } = runner;
  const actionError = runner.errors.tree || null;
  const setActionError = (_: null) => clear("tree");
  // A draft being named (edit-page-rework 5.5): its row, in italics, under
  // its parent while it is named on the canvas or in the side panel.
  const creating = useProjectSelector((s) => s.creating);
  const created = useProjectSelector((s) => s.created);

  // Another document: whatever was open in the tree was about the old one,
  // and so was a draft being named (only on a change, not on mount: a draft
  // begun before the outline mounted is still about this document).
  const shownDocument = useRef(ontologyId);
  useEffect(() => {
    if (shownDocument.current !== ontologyId) projectStore.cancelCreating(false);
    shownDocument.current = ontologyId;
    setRenaming(null);
    setDeleting(null);
    setMenu(null);
    setExamplesMenu(null);
    setReveal(null);
    clear("tree");
  }, [ontologyId, clear]);

  // Something a draft made: its section and its parent open so its row is
  // in sight, and unless its box on the canvas takes focus, its row does
  // (Section 6), App selecting it.
  const lastCreated = useRef(created?.token ?? 0);
  useEffect(() => {
    if (!created || created.token === lastCreated.current) return;
    lastCreated.current = created.token;
    if (created.parent) setExpanded((prev) => new Set(prev).add(created.parent!));
    const home = CREATED_IN[created.kind];
    if (!openNow.has(home)) toggleSection(home);
    const box = created.kind === "class" || created.kind === "concept";
    if (!(box && canvasShown)) setReveal(created.iri);
    // openNow and toggleSection are read, not followed: only a new thing made moves this.
  }, [created, canvasShown]);

  // The side panel's *This model* counts, from this fetch: no request of
  // its own (5.4, Section 10).
  useEffect(() => {
    if (!data || !onCounts) return;
    // The model's own: an import's classes and a snapshot's rows are listed
    // in the outline, but they are not what *This model* holds (code review).
    const count = (forest: HierarchyForest | undefined, kind: string) => (forest ? countOf(forest, kind, "", true) : 0);
    onCounts({
      classes: count(data.classes, "class"),
      concepts: count(data.concepts, "concept"),
      relationships: count(data.objectProperties, "objectProperty"),
      attributes: count(data.datatypeProperties, "datatypeProperty"),
      examples: count(data.examples, "individual"),
    });
  }, [data, onCounts]);

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
      // The one draft (5.5): a box under the parent on the canvas, and the
      // side panel's form; Cancel gives focus back to this row.
      const element = sectionRef.current?.querySelector<HTMLElement>(`[role="treeitem"][data-key="${cssAttr(row.key)}"]`);
      projectStore.startCreating(row.kind === "concept" ? "concept" : "class", {
        parent: { iri: row.id, label: row.label },
        from: element ?? null,
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

  /** A section's +: one of its kind, by the one draft (5.5). Examples'
   *  offers a new example or an import. */
  const add = (section: OutlineSection, button: HTMLElement) => {
    if (section.add === "examples") {
      if (!onImportData) {
        projectStore.startCreating("example", { from: button });
        return;
      }
      const rect = button.getBoundingClientRect();
      setExamplesMenu({ anchor: { top: rect.bottom, left: Math.max(0, rect.right - 220) }, button });
      return;
    }
    if (section.add) projectStore.startCreating(section.add, { from: button });
  };

  const anyExpanded = expanded.size > 0;
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
          Outline
        </h2>
        <input
          type="search"
          className="hierarchy-filter"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter the outline by name"
        />
        {/* One button, its name the action it takes: it stays put and keeps
            focus as the name changes. */}
        <button
          type="button"
          className="ghost hierarchy-expand"
          aria-disabled={!data}
          onClick={() => data && (anyExpanded ? collapseAll() : expandAll())}
        >
          {anyExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {editing && (
        <p className="detail-note edit-status" role="status">
          {busy ? "Saving change…" : ""}
        </p>
      )}
      {otherNote && <p className="detail-note hierarchy-other-kind">{otherNote}</p>}
      {renaming && actionError && (
        <p className="edit-error" role="alert">
          {actionError}
        </p>
      )}

      {loading && <p className="hint hierarchy-status">Loading the outline…</p>}
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
            const isExamples = section.id === "examples";
            const fixed = isExamples ? fixedExampleRow : fixedRow;
            const draftHere =
              creating &&
              ((creating.kind === "class" && section.id === "classes") ||
                (creating.kind === "concept" && section.id === "concepts"))
                ? {
                    parent: creating.parent?.iri ?? null,
                    label: creating.name.trim() || (creating.kind === "class" ? "New class" : "New concept"),
                  }
                : null;
            return (
              <Forest
                key={section.id}
                section={section}
                open={openNow.has(section.id)}
                onFold={() => toggleSection(section.id)}
                onAdd={editing && section.add ? (button) => add(section, button) : undefined}
                filter={filter}
                expanded={isExamples ? examplesOpen : expanded}
                selected={selected}
                onToggle={isExamples ? toggleExamples : toggle}
                onSelect={onSelect}
                editable={editing !== null}
                renaming={renaming}
                renameValue={(row) => (language === null || language === editing?.primaryLanguage ? row.label : "")}
                busy={busy}
                onRename={(row, value) => void rename(row, value)}
                onMenu={(row, anchor) => setMenu({ row, anchor, fixed: fixed(row) })}
                fixedRow={fixed}
                reveal={reveal}
                onRevealed={() => setReveal(null)}
                pending={draftHere}
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
            // An inferred row is a conclusion: none of its own actions (5.7).
            menu.fixed || menu.row.origin === "inferred",
          )}
          anchor={menu.anchor}
          onChoose={(action) => choose(menu.row, action)}
          onClose={closeMenu}
        />
      )}
      {examplesMenu && (
        <RowMenu<"example" | "import">
          label="Examples"
          name="New example or import"
          items={[
            { action: "example", label: "New example" },
            { action: "import", label: "Import data from CSV or Excel…" },
          ]}
          anchor={examplesMenu.anchor}
          onChoose={(action) => {
            const button = examplesMenu.button;
            setExamplesMenu(null);
            if (action === "example") projectStore.startCreating("example", { from: button });
            else onImportData?.();
          }}
          onClose={() => {
            const button = examplesMenu.button;
            setExamplesMenu(null);
            window.setTimeout(() => button.focus(), 0);
          }}
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
  section: OutlineSection;
  /** Folded sections show their header only (5.3). */
  open: boolean;
  onFold: () => void;
  /** In a project: the section's +, handed the button pressed. */
  onAdd?: (button: HTMLElement) => void;
  filter: string;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (id: string, next: boolean) => void;
  onSelect: (iri: string) => void;
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
  /** A draft being named here: a row in italics under its parent (5.5). */
  pending?: { parent: string | null; label: string } | null;
}

/** The empty sentence of a section (Section 6). */
const EMPTY_WORDS: Record<SectionId, string> = {
  classes: "No classes yet. Drag Class onto the canvas, or press +.",
  concepts: "No concepts yet. Drag Concept onto the canvas, or press +.",
  relationships: "No relationships yet. Draw a line between two classes, or press +.",
  attributes: "No attributes yet. Press +.",
  annotations: "No annotation properties.",
  examples: "No examples or imported data yet.",
};

/** The draft row's id: no IRI looks like it. */
const PENDING_ID = " pending";

/** One folding section: a header button with its count and +, then, when
 *  open, a labelled forest -- a WAI-ARIA `tree`, virtualized, with one tab
 *  stop and full arrow-key navigation. */
function Forest({
  section,
  open,
  onFold,
  onAdd,
  filter,
  expanded,
  selected,
  onToggle,
  onSelect,
  editable = false,
  renaming = null,
  renameValue,
  busy = false,
  onRename,
  onMenu,
  fixedRow,
  reveal = null,
  onRevealed,
  pending = null,
}: ForestProps) {
  const { forest, title } = section;
  const actionsOf = (row: Row) =>
    rowActions(row.kind, Boolean(row.importedFrom || row.fromData), null, (fixedRow?.(row) ?? false) || row.origin === "inferred");
  const appears = useMemo(() => appearanceCounts(forest), [forest]);
  const keep = useMemo(() => keepForFilter(forest, filter), [forest, filter]);
  const treeRows = useMemo(
    () => flatten(forest, expanded, keep, appears),
    [forest, expanded, keep, appears],
  );
  // The draft's row, under its parent's (or last, for a top-level one).
  const rows = useMemo(() => {
    if (!pending) return treeRows;
    const at = pending.parent === null ? -1 : treeRows.findIndex((r) => r.id === pending.parent);
    const row: Row = {
      id: PENDING_ID,
      key: PENDING_ID,
      depth: at >= 0 ? treeRows[at].depth + 1 : 0,
      label: pending.label,
      prefixed: "",
      kind: section.id === "concepts" ? "concept" : "class",
      origin: "asserted",
      expandable: false,
      expanded: false,
      childCount: 0,
      cyclic: false,
      appearsElsewhere: false,
      posinset: 0,
      setsize: 0,
      pending: true,
    };
    const out = [...treeRows];
    out.splice(at >= 0 ? at + 1 : out.length, 0, row);
    return out;
  }, [treeRows, pending, section.id]);
  const count = useMemo(() => countOf(forest, COUNTED[section.id], filter), [forest, section.id, filter]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  // The roving tab stop: which row is focusable, by its path key -- a node
  // under two parents is two rows, and by id the keyboard landed on the
  // first of them (Shift+F10 opened the other row's menu). It follows
  // navigation and is clamped back onto the visible rows whenever they
  // change under it.
  const [focusId, setFocusId] = useState<string | null>(null);
  // Set on a keyboard move so the layout effect focuses the new row once it is
  // rendered, without stealing focus on an ordinary re-render.
  const pendingFocus = useRef<string | null>(null);

  // Keep the roving stop valid: default to the first row, and if the focused row
  // scrolled out of existence (a collapse, a filter) fall back to the first.
  useEffect(() => {
    if (rows.length === 0) {
      setFocusId(null);
    } else if (focusId === null || !rows.some((r) => r.key === focusId)) {
      setFocusId(rows[0].key);
    }
  }, [rows, focusId]);

  // Measure the real viewport (jsdom reports 0, so keep the default). The
  // section's height changes as others fold and the window resizes, so it
  // is watched rather than read once.
  const hasTree = open && rows.length > 0;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.clientHeight > 0) setViewport(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewport(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasTree]);

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
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-key="${cssAttr(target)}"]`);
    el?.focus();
  }, [windowRows]);

  const focusIndex = focusId === null ? -1 : rows.findIndex((r) => r.key === focusId);

  /** Move the roving stop to a row by index, scrolling it into view. */
  const moveTo = (index: number) => {
    if (index < 0 || index >= rows.length) return;
    const key = rows[index].key;
    setFocusId(key);
    pendingFocus.current = key;
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
    if (!reveal || !open) return;
    const index = rows.findIndex((r) => r.id === reveal);
    if (index >= 0) {
      moveTo(index);
      onRevealed?.();
    }
  }, [rows, reveal, open]);

  /** Open the row menu beside a row, from its button or the keyboard. */
  const openMenu = (row: Row, element: Element | null) => {
    if (!onMenu || row.pending || actionsOf(row).length === 0) return;
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
        if (!row.pending) onSelect(row.id);
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

  const headingId = `hierarchy-${section.id}`;
  const bodyId = `${headingId}-body`;
  const empty = rows.length === 0;
  const filtering = filter.trim() !== "";

  return (
    <section
      className={open ? "hierarchy-section open" : "hierarchy-section"}
      aria-labelledby={headingId}
      // An open section never takes more than its rows need, so the height
      // it leaves goes to the other open sections: with two short sections
      // and a long one, the long one shows its 8 rows at 1280x720 (E1),
      // where an equal share gave each 6.8.
      style={open ? { maxHeight: SECTION_HEAD + Math.max(rows.length, 2) * ROW_HEIGHT + 8 } : undefined}
    >
      <div className="hierarchy-section-head">
        <h3>
          <button
            type="button"
            id={headingId}
            className="hierarchy-fold"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onFold}
            // The count in the name, *Classes, 3* (Section 6); with a filter,
            // the matches.
            aria-label={`${title}, ${count.toLocaleString()}${filtering ? " shown" : ""}`}
          >
            <span className="hierarchy-chevron" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="hierarchy-section-title">{title}</span>
            <span className="hierarchy-section-count">{count.toLocaleString()}</span>
            {filtering && <span className="hierarchy-match-count"> shown</span>}
          </button>
        </h3>
        {onAdd && (
          <button
            type="button"
            className="hierarchy-add"
            aria-label={ADD_LABELS[section.add!]}
            title={ADD_LABELS[section.add!]}
            aria-haspopup={section.add === "examples" ? "menu" : undefined}
            onClick={(e) => onAdd(e.currentTarget)}
          >
            +
          </button>
        )}
      </div>
      {open && (
        <div className="hierarchy-section-body" id={bodyId}>
          {empty ? (
            <p className="hint hierarchy-status">
              {filtering ? "No matches in this section." : EMPTY_WORDS[section.id]}
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
                      key={row.key}
                      row={row}
                      index={index}
                      isSelected={row.id === selected}
                      isFocus={row.key === focusId}
                      onToggle={onToggle}
                      onSelect={onSelect}
                      onFocus={setFocusId}
                      menu={editable && !row.pending && actionsOf(row).length > 0 ? openMenu : undefined}
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
        </div>
      )}
    </section>
  );
}

interface TreeRowProps {
  row: Row;
  index: number;
  isSelected: boolean;
  isFocus: boolean;
  onToggle: (id: string, next: boolean) => void;
  onSelect: (iri: string) => void;
  /** Keeps the roving tab stop on a row focused by script or pointer. */
  /** Called with the row's path key, the roving stop's identity. */
  onFocus?: (key: string) => void;
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
      data-key={row.key}
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
        (inferred ? " inferred" : "") +
        (row.pending ? " pending" : "")
      }
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      title={row.prefixed || row.id}
      onClick={() => !row.pending && onSelect(row.id)}
      onFocus={(e) => e.target === e.currentTarget && onFocus?.(row.key)}
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
      <span className={`hierarchy-dot kind-${dotKind(row.kind, row.classType)}`} aria-hidden="true" />
      {rename ? (
        <RenameField label={row.label} initial={rename.initial} busy={rename.busy} onDone={rename.onDone} />
      ) : (
        <span className="hierarchy-label">{row.label}</span>
      )}
      {row.pending && <span className="visually-hidden">, being created</span>}
      {row.ends && !rename && <span className="hierarchy-ends">({row.ends})</span>}
      <span className="hierarchy-kind">{kindLabel(row.kind)}</span>
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
