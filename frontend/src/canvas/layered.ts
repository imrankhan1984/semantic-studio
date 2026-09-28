/*
================================================================================
FILE: frontend/src/canvas/layered.ts
================================================================================

SUMMARY
    First placement for the modeling canvas (visual-modeling 5.5): a small
    hand-written layered layout. Roots at the top, each subclass or narrower
    level below its parents, siblings side by side, imported boxes at the edge
    of their level. Also the rule for boxes with no saved position: below
    their parent when the parent has a place, otherwise below everything.

BASIC IDEA
    No layout library (the spec's Section 4 rules one out), in the spirit of
    the Home miniature's hand-written spring layout. A box's level is one more
    than its deepest parent's; a cycle in malformed data is broken by giving a
    box on its own ancestor path the level it already has, so nothing loops.
    Within a level, boxes are ordered by the mean position of their parents
    (the barycentre, one sweep down), which keeps a child under its parent,
    then by label and IRI, so the same model always lays out the same way.

    Positions are the box's top-left corner in canvas units, the numbers the
    layout file stores.

INPUTS / INPUT SOURCES
    - The canvas's boxes (IRI, label, imported or not) and its hierarchy
      lines (child to parent: subClassOf and broader).
    - For placeMissing: the positions already saved.

EXPECTED OUTPUT
    - layered(boxes, links) -> { iri: [x, y] } for every box.
    - placeMissing(boxes, links, saved) -> saved plus a place for each box
      without one.
================================================================================
*/

export interface Box {
  iri: string;
  label: string;
  imported?: boolean;
}

/** A hierarchy line: `child` is a kind of, or narrower than, `parent`. */
export interface Link {
  child: string;
  parent: string;
}

export type Positions = Record<string, [number, number]>;

/** Box size and spacing, in canvas units; the box components are this wide. */
export const BOX_WIDTH = 190;
export const BOX_HEIGHT = 90;
// Room between boxes in a row for a relationship name, read on its line.
const GAP_X = 120;
const LEVEL_HEIGHT = 170;

function levelsOf(boxes: Box[], links: Link[]): Map<string, number> {
  const ids = new Set(boxes.map((b) => b.iri));
  const parents = new Map<string, string[]>();
  for (const { child, parent } of links) {
    if (!ids.has(child) || !ids.has(parent) || child === parent) continue;
    const list = parents.get(child);
    if (list) list.push(parent);
    else parents.set(child, [parent]);
  }
  const level = new Map<string, number>();
  const onPath = new Set<string>();
  const visit = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (onPath.has(id)) return 0; // a cycle: this edge adds no depth
    onPath.add(id);
    let depth = 0;
    for (const parent of parents.get(id) ?? []) depth = Math.max(depth, visit(parent) + 1);
    onPath.delete(id);
    level.set(id, depth);
    return depth;
  };
  for (const box of boxes) visit(box.iri);
  return level;
}

/** Every box placed by level, deterministically. */
export function layered(boxes: Box[], links: Link[]): Positions {
  const level = levelsOf(boxes, links);
  const parentsOf = new Map<string, string[]>();
  for (const { child, parent } of links) {
    const list = parentsOf.get(child);
    if (list) list.push(parent);
    else parentsOf.set(child, [parent]);
  }
  const rows = new Map<number, Box[]>();
  for (const box of boxes) {
    const l = level.get(box.iri) ?? 0;
    const row = rows.get(l);
    if (row) row.push(box);
    else rows.set(l, [box]);
  }
  const x = new Map<string, number>();
  const out: Positions = {};
  for (const l of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(l)!;
    const centre = (box: Box): number => {
      const placed = (parentsOf.get(box.iri) ?? []).filter((p) => x.has(p)).map((p) => x.get(p)!);
      return placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : Number.POSITIVE_INFINITY;
    };
    const keyed = row.map((box) => ({ box, c: centre(box) }));
    keyed.sort(
      (a, b) =>
        // The document's own boxes first; imported ones at the edge.
        Number(Boolean(a.box.imported)) - Number(Boolean(b.box.imported)) ||
        a.c - b.c ||
        a.box.label.localeCompare(b.box.label) ||
        (a.box.iri < b.box.iri ? -1 : a.box.iri > b.box.iri ? 1 : 0),
    );
    keyed.forEach(({ box }, i) => {
      const px = i * (BOX_WIDTH + GAP_X);
      x.set(box.iri, px);
      out[box.iri] = [px, l * LEVEL_HEIGHT];
    });
  }
  return out;
}

function overlaps(p: [number, number], taken: [number, number][]): boolean {
  return taken.some(([x, y]) => Math.abs(x - p[0]) < BOX_WIDTH + GAP_X / 2 && Math.abs(y - p[1]) < BOX_HEIGHT);
}

/**
 * Saved positions kept; every box without one gets a place. A box made from
 * the tree or the form goes below its parent, stepped right past anything
 * already there; a box with no placed parent goes below everything, where the
 * layered layout would put it.
 */
export function placeMissing(boxes: Box[], links: Link[], saved: Positions): Positions {
  const out: Positions = {};
  const missing: Box[] = [];
  for (const box of boxes) {
    if (saved[box.iri]) out[box.iri] = saved[box.iri];
    else missing.push(box);
  }
  if (missing.length === 0) return out;
  const taken = Object.values(out);
  const bottom = taken.length ? Math.max(...taken.map(([, y]) => y)) + LEVEL_HEIGHT : 0;
  const fresh = layered(missing, links);
  const parentOf = new Map(links.map((l) => [l.child, l.parent]));
  for (const box of missing) {
    const parent = parentOf.get(box.iri);
    let place: [number, number];
    if (parent && out[parent]) {
      place = [out[parent][0], out[parent][1] + LEVEL_HEIGHT];
    } else {
      const [fx, fy] = fresh[box.iri];
      place = [fx, bottom + fy];
    }
    while (overlaps(place, Object.values(out))) place = [place[0] + BOX_WIDTH + GAP_X, place[1]];
    out[box.iri] = place;
  }
  return out;
}
