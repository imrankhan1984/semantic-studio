/*
================================================================================
FILE: frontend/src/canvas/useCanvasData.ts
================================================================================

SUMMARY
    The modeling canvas's data (visual-modeling 5.4 to 5.6): the view fetched
    for each revision and display language, every box's position, and the
    layout saved a second after the last move. Also the shown set past 300
    boxes, and Tidy up.

BASIC IDEA
    The server's layout file is where positions live (D-087); this holds the
    browser's copy. Every fetch brings the server's layout with it, and it
    is taken as the base, with only the positions not yet saved laid over it:
    a rename moves its box's entry on the server, and a copy read once and
    kept would have lost that move and then written the stale copy back over
    it (found in review). So every box keeps where it was across a command's
    refetch, and follows its IRI across a rename. A box with no position gets
    one from layered.ts -- below its parent, or below everything -- and that
    position is saved too, so the next open draws the same diagram.

    "Not yet saved" means until the server says the save succeeded, not until
    it is sent. A box created on the canvas is saved at its drop point at
    once, and the command's refetch can read the layout before that save
    lands; the drop point was then taken for missing and the box re-placed by
    the layered layout, and that was saved instead (PR #47 review: 4 of 8
    drops on a 280-class model in Chrome). So a save records exactly what it
    sent, and a position leaves the unsaved set only when that save has
    succeeded and the box has not moved again since. A failed save keeps
    everything pending and says so; the next move or flush tries again.

    That alone still depended on the order responses arrive in: a refetch
    could read the file just before the save wrote it, the save's answer
    arrive first and settle the box, and the older refetch then arrive
    without it (PR #47 re-review, 4 of 10 drops). So the file carries a
    generation the server increases on every write, and this remembers the
    generation of its last successful save: a response older than that
    brings its boxes and lines, but none of its positions or shown set,
    which the browser already knows better. A rename's move is a write
    after the save, so a newer generation, and is taken as before.

    Positions of IRIs that are no longer drawn stay in the copy and in the
    file: undoing a delete then finds the box's old place. The server prunes
    them when the project is next opened.

    Saving is debounced by a second. flush() writes what is pending now and
    waits for it: the project store awaits it before a project closes,
    because a closed project refuses the write and a move made just before
    Close was lost (PR #47 review). It never touches the model: no revision,
    no dirty flag, no undo step.

INPUTS / INPUT SOURCES
    - projectId, doc, revision, language: which view to fetch and when.
    - api.ts: getCanvas, putLayout.

EXPECTED OUTPUT
    - { view, positions, error, saveError, loading, retry, move, place, show,
        hide, tidy, setViewport, flush }.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { getCanvas, putLayout } from "../api";
import type { CanvasLayout, CanvasView, ProjectDocName } from "../types";
import { layered, placeMissing, type Box, type Link, type Positions } from "./layered";

/** How long the layout waits after the last move before it is written. */
export const SAVE_DELAY_MS = 1000;

function boxes(view: CanvasView): Box[] {
  return view.nodes.map((n) => ({ iri: n.iri, label: n.label, imported: Boolean(n.imported) }));
}

function links(view: CanvasView): Link[] {
  return view.edges
    .filter((e) => e.kind === "subClassOf" || e.kind === "broader")
    .map((e) => ({ child: e.source, parent: e.target }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useCanvasData(projectId: string, doc: ProjectDocName, revision: number, language: string | null) {
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [positions, setPositions] = useState<Positions>({});
  const [shown, setShownState] = useState<string[] | null>(null);
  // The browser's copy of the layout file, and what it knows better than the
  // server: positions not yet saved, and the viewport.
  const layout = useRef<CanvasLayout | null>(null);
  const unsaved = useRef(new Set<string>());
  const viewportUnsaved = useRef(false);
  const timer = useRef<number | null>(null);
  // The save in flight, so flush() can wait for it and a second save waits
  // its turn rather than racing the first.
  const inFlight = useRef<Promise<void> | null>(null);
  // The generation of this browser's last successful write of the layout.
  const savedGeneration = useRef(0);
  const settle = (generation: number | undefined) => {
    if (typeof generation === "number") savedGeneration.current = Math.max(savedGeneration.current, generation);
  };

  const save = useCallback((): Promise<void> => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const run = async () => {
      // One at a time: the file is replaced whole, so the later write must
      // be the one that lands last.
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      const current = layout.current;
      if (!current) return;
      const sent = { ...current, positions: { ...current.positions } };
      const sentIris = [...unsaved.current];
      const sentViewport = viewportUnsaved.current;
      try {
        settle((await putLayout(projectId, doc, sent))?.generation);
      } catch (e) {
        setSaveError(`The canvas layout could not be saved: ${message(e)} Your boxes stay where they are.`);
        return;
      }
      setSaveError(null);
      // Settled only if nothing moved it again while the save was out.
      for (const iri of sentIris) {
        const now = layout.current?.positions[iri];
        const then = sent.positions[iri];
        if (now && then && now[0] === then[0] && now[1] === then[1]) unsaved.current.delete(iri);
      }
      if (sentViewport && layout.current?.viewport === sent.viewport) viewportUnsaved.current = false;
    };
    const promise = run();
    inFlight.current = promise;
    void promise.finally(() => {
      if (inFlight.current === promise) inFlight.current = null;
    });
    return promise;
  }, [projectId, doc]);

  const scheduleSave = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  /** Write what is pending now, and wait for it (and for any save already
   *  out). Resolves whether or not the write succeeded; a failure is in
   *  saveError. */
  const flush = useCallback(async (): Promise<void> => {
    const pending = timer.current !== null || unsaved.current.size > 0 || viewportUnsaved.current;
    if (pending) await save();
    else if (inFlight.current) await inFlight.current.catch(() => undefined);
  }, [save]);

  // Leaving the canvas writes what is pending rather than dropping it.
  useEffect(() => () => {
    if (timer.current !== null) void save();
  }, [save]);

  useEffect(() => {
    layout.current = null;
    unsaved.current = new Set();
    viewportUnsaved.current = false;
    savedGeneration.current = 0;
  }, [projectId, doc]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getCanvas(projectId, doc)
      .then((fetched) => {
        if (cancelled) return;
        const local = layout.current;
        // Read before a save this browser has seen succeed: its boxes and
        // lines are current, its positions are not.
        const stale = local !== null && fetched.layout.generation < savedGeneration.current;
        const current: CanvasLayout = stale
          ? { ...local, positions: { ...local.positions } }
          : { ...fetched.layout, positions: { ...fetched.layout.positions } };
        if (local && !stale) {
          for (const iri of unsaved.current) {
            if (local.positions[iri]) current.positions[iri] = local.positions[iri];
          }
          if (viewportUnsaved.current) current.viewport = local.viewport;
        }
        layout.current = current;
        const placed = placeMissing(boxes(fetched), links(fetched), current.positions);
        const added = Object.keys(placed).filter((iri) => !current.positions[iri]);
        for (const iri of added) unsaved.current.add(iri);
        // Keep positions of boxes not drawn now: an undone delete returns.
        current.positions = { ...current.positions, ...placed };
        setPositions({ ...current.positions });
        setShownState(current.shown);
        setView(fetched);
        if (added.length) scheduleSave();
      })
      .catch((e: unknown) => !cancelled && setError(message(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, doc, revision, language, attempt, scheduleSave]);

  /** A box moved by drag or arrow key. */
  const move = useCallback(
    (iri: string, at: [number, number]) => {
      if (!layout.current) return;
      layout.current.positions = { ...layout.current.positions, [iri]: at };
      unsaved.current.add(iri);
      setPositions({ ...layout.current.positions });
      scheduleSave();
    },
    [scheduleSave],
  );

  /** A box made on the canvas goes where it was dropped, and stays there
   *  through the command's refetch until the save has landed. */
  const place = useCallback(
    (iri: string, at: [number, number]) => {
      if (!layout.current) return;
      layout.current.positions = { ...layout.current.positions, [iri]: at };
      unsaved.current.add(iri);
      setPositions({ ...layout.current.positions });
      void save();
    },
    [save],
  );

  /** Show on canvas / Hide from canvas (5.6): written at once, then refetched,
   *  because the server decides what the shown set brings with it. A failed
   *  write leaves the set as it was and says so; it never rejects. */
  const setShown = useCallback(
    async (next: string[]) => {
      const current = layout.current;
      if (!current) return;
      const before = current.shown;
      try {
        await flush();
        settle((await putLayout(projectId, doc, { ...current, positions: { ...current.positions }, shown: next }))?.generation);
      } catch (e) {
        current.shown = before;
        setShownState(before);
        setSaveError(`The canvas could not change what it shows: ${message(e)}`);
        return;
      }
      current.shown = next;
      setShownState(next);
      setSaveError(null);
      setAttempt((a) => a + 1);
    },
    [projectId, doc, flush],
  );
  const show = useCallback(
    (iri: string) => {
      const list = layout.current?.shown ?? [];
      return list.includes(iri) ? Promise.resolve() : setShown([...list, iri]);
    },
    [setShown],
  );
  const hide = useCallback(
    (iri: string) => setShown((layout.current?.shown ?? []).filter((i) => i !== iri)),
    [setShown],
  );

  /** Tidy up: every box through the layered layout again, and saved. */
  const tidy = useCallback(() => {
    if (!view || !layout.current) return;
    const fresh = layered(boxes(view), links(view));
    layout.current.positions = { ...layout.current.positions, ...fresh };
    for (const iri of Object.keys(fresh)) unsaved.current.add(iri);
    setPositions({ ...layout.current.positions });
    void save();
  }, [view, save]);

  const setViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (!layout.current) return;
      layout.current.viewport = viewport;
      viewportUnsaved.current = true;
      scheduleSave();
    },
    [scheduleSave],
  );

  return {
    view,
    positions,
    error,
    saveError,
    loading: view === null && error === null,
    savedViewport: layout.current?.viewport ?? null,
    shown,
    retry: () => setAttempt((a) => a + 1),
    move,
    place,
    show,
    hide,
    tidy,
    setViewport,
    flush,
  };
}
