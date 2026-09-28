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
    browser's copy. It is read once per document, and from then on the
    browser's copy is the truth: a refetch after a command brings new boxes
    and lines, and every box keeps where it was. A box with no position gets
    one from layered.ts -- below its parent, or below everything -- and that
    position is saved too, so the next open draws the same diagram.

    Positions of IRIs that are no longer drawn stay in the copy and in the
    file: undoing a delete then finds the box's old place. The server prunes
    them when the project is next opened.

    Saving is debounced by a second and flushed on unmount, so a drag writes
    once, and leaving the view loses nothing. It never touches the model: no
    revision, no dirty flag, no undo step.

INPUTS / INPUT SOURCES
    - projectId, doc, revision, language: which view to fetch and when.
    - api.ts: getCanvas, putLayout.

EXPECTED OUTPUT
    - { view, positions, error, loading, retry, move, place, show, hide,
        tidy, setViewport }.
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

export function useCanvasData(projectId: string, doc: ProjectDocName, revision: number, language: string | null) {
  const [view, setView] = useState<CanvasView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [positions, setPositions] = useState<Positions>({});
  // The browser's copy of the layout file, read once per document.
  const layout = useRef<CanvasLayout | null>(null);
  const timer = useRef<number | null>(null);

  const save = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (layout.current) void putLayout(projectId, doc, layout.current).catch(() => undefined);
  }, [projectId, doc]);

  const scheduleSave = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, SAVE_DELAY_MS);
  }, [save]);

  // Leaving the canvas writes what is pending rather than dropping it.
  useEffect(() => () => {
    if (timer.current !== null) save();
  }, [save]);

  useEffect(() => {
    layout.current = null;
  }, [projectId, doc]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getCanvas(projectId, doc)
      .then((fetched) => {
        if (cancelled) return;
        const first = layout.current === null;
        if (first) layout.current = fetched.layout;
        const current = layout.current!;
        const placed = placeMissing(boxes(fetched), links(fetched), current.positions);
        const added = Object.keys(placed).some((iri) => !current.positions[iri]);
        // Keep positions of boxes not drawn now: an undone delete returns.
        current.positions = { ...current.positions, ...placed };
        setPositions({ ...current.positions });
        setView(fetched);
        if (added) scheduleSave();
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, doc, revision, language, attempt, scheduleSave]);

  /** A box moved by drag or arrow key. */
  const move = useCallback(
    (iri: string, at: [number, number]) => {
      if (!layout.current) return;
      layout.current.positions = { ...layout.current.positions, [iri]: at };
      setPositions({ ...layout.current.positions });
      scheduleSave();
    },
    [scheduleSave],
  );

  /** A box made on the canvas goes where it was dropped. */
  const place = useCallback(
    (iri: string, at: [number, number]) => {
      if (!layout.current) return;
      layout.current.positions = { ...layout.current.positions, [iri]: at };
      setPositions({ ...layout.current.positions });
      save();
    },
    [save],
  );

  /** Show on canvas / Hide from canvas (5.6): written at once, then refetched,
   *  because the server decides what the shown set brings with it. */
  const setShown = useCallback(
    async (next: string[]) => {
      if (!layout.current) return;
      layout.current.shown = next;
      await putLayout(projectId, doc, layout.current);
      setAttempt((a) => a + 1);
    },
    [projectId, doc],
  );
  const show = useCallback(
    (iri: string) => {
      const shown = layout.current?.shown ?? [];
      return shown.includes(iri) ? Promise.resolve() : setShown([...shown, iri]);
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
    setPositions({ ...layout.current.positions });
    save();
  }, [view, save]);

  const setViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (!layout.current) return;
      layout.current.viewport = viewport;
      scheduleSave();
    },
    [scheduleSave],
  );

  return {
    view,
    positions,
    error,
    loading: view === null && error === null,
    savedViewport: layout.current?.viewport ?? null,
    shown: layout.current?.shown ?? null,
    retry: () => setAttempt((a) => a + 1),
    move,
    place,
    show,
    hide,
    tidy,
    setViewport,
  };
}
