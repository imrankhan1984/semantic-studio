/*
================================================================================
FILE: frontend/src/sparql/useQueryBuilder.ts
================================================================================

SUMMARY
    The React hook that owns all query-builder state and behaviour. It fetches
    the ontology's query schema, holds the current QueryState, derives the live
    SPARQL and the graph highlighting, and exposes the actions the UI calls to
    build the query (add a class, add a next step, remove a step, edit a hop,
    load a saved query, etc.).

BASIC IDEA
    Both the graph (GraphView) and the panel (QueryPanel) need to build the SAME
    query and stay in sync. Centralising everything in one hook, shared by App,
    guarantees that. The hook also resolves the class hierarchy so a relationship
    declared on a broad ancestor (as FIBO does) is offered on the specific
    subclass the user actually picked.

    Beside the builder state sits a text query (spec sparql-text-and-query-
    files, D-071). While one is set, the query is text: graph clicks and
    search picks no longer change anything, and the builder state is left
    exactly as it was. That is the whole mechanism of "Back to the visual
    version" -- nothing restores the builder, because nothing touched it; the
    state a query forked from is only written back when a saved text query is
    reopened, and then it is the saved state. There is no SPARQL parser, so
    text never flows back into the builder (D-008).

    The live text is held in a ref, not in state. Typing re-renders the editor
    and nothing else: App, the graph and the results table are not rendered
    per keystroke. State changes only when a text query starts or ends.

INPUTS / INPUT SOURCES
    - ontologyId: which ontology to build against.
    - active: whether Query mode is on (the schema is only fetched then).
    - imports: build against the ontology plus its resolved imports
      (external-access Stage 2); the schema is fetched again when it changes.
    - The backend /query-schema and /query-node endpoints (via api.ts).
    - User actions dispatched from the query components.

EXPECTED OUTPUT
    - A bag of state and callbacks consumed by App / GraphView / QueryPanel:
      schema, current state, live sparql, candidate highlighting, the builder
      actions, and the text query with its start / end actions.
    - Also exports pure helpers: makeAncestorResolver, linkOptionsBetween.
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getQueryNode, getQuerySchema } from "../api";
import type { QueryNodeInfo, QuerySchema } from "../types";
import { generateSparql } from "./generate";
import { emptyQueryState } from "./types";
import type { QueryState, QueryStep, StepLink } from "./types";

/**
 * SKOS types whose instances carry their own visualization "kind". They let
 * the graph highlight candidate concepts without shipping a per-node type
 * map for every entity in a large taxonomy.
 */
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const KIND_OF_CLASS: Record<string, string> = {
  [`${SKOS}Concept`]: "concept",
  [`${SKOS}ConceptScheme`]: "conceptScheme",
  [`${SKOS}Collection`]: "collection",
  [`${SKOS}OrderedCollection`]: "collection",
};

// One selectable relationship between two classes in the predicate menu.
export interface LinkOption {
  predicate: string;
  label: string;
  prefixed: string;
  inverse: boolean;
  declared: boolean;
  restriction?: boolean;
  count: number;
  /** True when the link comes from an ancestor rather than the class itself. */
  inherited?: boolean;
}

/**
 * A class plus every ancestor, so a link declared on a broad domain (FIBO
 * declares most of them that way) is offered on the specific subclasses
 * users actually pick. Memoized because it is consulted per chip render.
 */
export function makeAncestorResolver(schema: QuerySchema | null) {
  const cache = new Map<string, Set<string>>();
  return (classIri: string): Set<string> => {
    const hit = cache.get(classIri);
    if (hit) return hit;
    const result = new Set<string>([classIri]);
    if (schema) {
      const queue = [classIri];
      // Guarded against cycles by the visited set, and against pathological
      // hierarchies by a depth budget.
      let budget = 200;
      while (queue.length > 0 && budget-- > 0) {
        const current = queue.shift() as string;
        for (const parent of schema.superClasses?.[current] ?? []) {
          if (!result.has(parent)) {
            result.add(parent);
            queue.push(parent);
          }
        }
      }
    }
    cache.set(classIri, result);
    return result;
  };
}

/**
 * Every predicate that can connect two classes, in either direction.
 * Self-links legitimately appear twice (e.g. skos:broader forward and
 * inverse), which is how "broader" and "narrower" are both offered.
 */
export function linkOptionsBetween(
  schema: QuerySchema | null,
  fromClass: string,
  toClass: string,
  ancestorsOf: (iri: string) => Set<string> = (iri) => new Set([iri]),
): LinkOption[] {
  if (!schema) return [];
  const fromFamily = ancestorsOf(fromClass);
  const toFamily = ancestorsOf(toClass);
  const byKey = new Map<string, LinkOption>();

  for (const link of schema.links) {
    const candidates: LinkOption[] = [];
    // A link declared on an ancestor applies to the subclass too.
    if (fromFamily.has(link.source) && toFamily.has(link.target)) {
      candidates.push({
        ...link,
        inverse: false,
        inherited: link.source !== fromClass || link.target !== toClass,
      });
    }
    if (fromFamily.has(link.target) && toFamily.has(link.source)) {
      candidates.push({
        ...link,
        inverse: true,
        inherited: link.target !== fromClass || link.source !== toClass,
      });
    }
    for (const option of candidates) {
      const key = `${option.predicate}|${option.inverse}`;
      const existing = byKey.get(key);
      if (!existing || option.count > existing.count) byKey.set(key, option);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      // Links on the class itself before ones inherited from an ancestor.
      Number(!!a.inherited) - Number(!!b.inherited) ||
      // Then whatever the data actually contains.
      Number(b.count > 0) - Number(a.count > 0) ||
      // Then rdfs:domain/range, then relationships read from restrictions.
      Number(b.declared) - Number(a.declared) ||
      Number(!!a.restriction) - Number(!!b.restriction) ||
      b.count - a.count ||
      a.label.localeCompare(b.label),
  );
}

/**
 * A query being written as text. What it was started from decides what the
 * editor offers: a fork has a visual version to go back to, a query from
 * nothing, a file or the ontology itself does not.
 */
export interface TextQuery {
  /** The builder state to go back to, or null when there is none. */
  forkedFrom: QueryState | null;
  /** Shown above the editor: a file's or an embedded query's name. */
  name: string | null;
  /** The text as last opened or saved, so leaving can tell whether work is lost. */
  baseline: string;
  /** Set for an embedded query that cannot run here: the editor is read-only
   *  and Run is disabled with this sentence as its reason. */
  runBlocked: string | null;
  /** A one-line note shown above the editor, e.g. about $this. */
  note: string | null;
  /** Bumped for each new text query, so the editor starts afresh; a fork
   *  keeps the number, so the editor the user is typing in is not replaced. */
  session: number;
  /** The saved query that was open behind this one. The builder still holds
   *  its state, so leaving puts it back rather than leaving an Update that
   *  would overwrite some other entry. */
  resume: { id: string; name: string } | null;
}

/** The hook itself: owns the builder state and exposes state + actions. */
export function useQueryBuilder(
  ontologyId: string | null,
  active: boolean,
  imports = false,
  // A project document's revision (authoring-foundations): the schema is
  // fetched again when an edit moves it. 0 for the library, which never does.
  revision = 0,
) {
  const [schema, setSchema] = useState<QuerySchema | null>(null);      // class-level schema
  const [schemaError, setSchemaError] = useState<string | null>(null); // schema fetch error
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [state, setState] = useState<QueryState>(emptyQueryState);     // the query being built
  const [hint, setHint] = useState<string | null>(null);               // transient user guidance
  const [openQuery, setOpenQuery] = useState<{ id: string; name: string } | null>(null); // saved query being edited
  const [textQuery, setTextQuery] = useState<TextQuery | null>(null);  // set while the query is text
  const textRef = useRef("");                        // the live text; a ref so typing renders nothing here
  const textQueryRef = useRef(textQuery);            // read by addNode without re-binding it
  textQueryRef.current = textQuery;
  const openQueryRef = useRef(openQuery);
  openQueryRef.current = openQuery;
  const sessionRef = useRef(0);
  const requestedFor = useRef<string | null>(null);  // "ontology|imports" whose schema we already fetched
  // A ref mirror of state so async callbacks read the latest without re-binding.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Everything is per-ontology; switching ontologies starts a fresh query.
  useEffect(() => {
    setState(emptyQueryState());
    setSchema(null);
    setSchemaError(null);
    setHint(null);
    setOpenQuery(null);
    setTextQuery(null);
    requestedFor.current = null;
  }, [ontologyId]);

  // The schema is only computed when the user actually enters Query mode.
  //
  // Keyed on the imports switch as well (external-access Stage 2): with the
  // merged view on, the schema carries the imported classes, and a schema
  // fetched for the other setting would offer steps the query cannot use. The
  // query being built is kept across the switch; only the schema is replaced.
  useEffect(() => {
    const key = `${ontologyId}|${imports}|${revision}`;
    if (!active || !ontologyId || requestedFor.current === key) return;
    requestedFor.current = key;
    setLoadingSchema(true);
    let cancelled = false;
    getQuerySchema(ontologyId, imports)
      .then((result) => !cancelled && setSchema(result))
      .catch((e: unknown) => {
        if (cancelled) return;
        requestedFor.current = null;
        setSchemaError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoadingSchema(false));
    return () => {
      cancelled = true;
    };
  }, [active, ontologyId, imports, revision]);

  // The live SPARQL, regenerated whenever the state or namespaces change.
  const sparql = useMemo(
    () => generateSparql(state, schema?.namespaces ?? {}),
    [state, schema],
  );

  // A memoized ancestor resolver for the current schema (used all over below).
  const ancestorsOf = useMemo(() => makeAncestorResolver(schema), [schema]);

  /** Node IRIs that belong to the current path (classes and pinned nodes). */
  const pathIris = useMemo(() => {
    const set = new Set<string>();
    for (const step of state.steps) {
      set.add(step.classIri);
      if (step.pin) set.add(step.pin.iri);
    }
    return set;
  }, [state.steps]);

  /** Classes (and SKOS-instance kinds) that can extend the path next. */
  const candidates = useMemo(() => {
    const classes = new Set<string>();
    const kinds = new Set<string>();
    if (!schema) return { classes, kinds };
    if (state.steps.length === 0) {
      for (const cls of schema.classes) classes.add(cls.iri);
    } else {
      // Inherited links count: a step on a subclass can still use a link
      // declared on one of its ancestors.
      const family = new Set<string>();
      for (const step of state.steps) {
        for (const iri of ancestorsOf(step.classIri)) family.add(iri);
      }
      for (const link of schema.links) {
        if (family.has(link.source)) classes.add(link.target);
        if (family.has(link.target)) classes.add(link.source);
      }
    }
    for (const iri of classes) {
      const kind = KIND_OF_CLASS[iri];
      if (kind) kinds.add(kind);
    }
    return { classes, kinds };
  }, [schema, state.steps, ancestorsOf]);

  /** Append a class, attaching it to the nearest step that relates to it. */
  const appendClass = useCallback(
    (
      classIri: string,
      label: string,
      pin: { iri: string; label: string } | null,
      currentSchema: QuerySchema,
    ): boolean => {
      const current = stateRef.current;
      if (current.steps.length === 0) {
        setState({ ...current, steps: [{ classIri, label, pin, props: [] }] });
        return true;
      }
      for (let i = current.steps.length - 1; i >= 0; i -= 1) {
        const options = linkOptionsBetween(
          currentSchema,
          current.steps[i].classIri,
          classIri,
          ancestorsOf,
        );
        if (options.length === 0) continue;
        const primary = options[0];
        setState({
          ...current,
          steps: [
            ...current.steps,
            {
              classIri,
              label,
              pin,
              props: [],
              link: {
                anchor: i,
                predicates: [{ iri: primary.predicate, inverse: primary.inverse }],
                modifier: "",
                optional: false,
              },
            },
          ],
        });
        return true;
      }
      return false;
    },
    [ancestorsOf],
  );

  /** Start (or extend) the query from a class picked in the panel. */
  const addClass = useCallback(
    (classIri: string, label: string) => {
      if (!schema) return;
      setHint(null);
      if (!appendClass(classIri, label, null, schema)) {
        setHint(`No relationship connects “${label}” to the current path.`);
      }
    },
    [schema, appendClass],
  );

  /** Add a specific continuation chosen from the panel's suggestions. */
  const addNextStep = useCallback(
    (option: {
      anchor: number;
      predicate: string;
      inverse: boolean;
      targetClass: string;
      targetLabel: string;
    }) => {
      setHint(null);
      const current = stateRef.current;
      setState({
        ...current,
        steps: [
          ...current.steps,
          {
            classIri: option.targetClass,
            label: option.targetLabel,
            pin: null,
            props: [],
            link: {
              anchor: option.anchor,
              predicates: [{ iri: option.predicate, inverse: option.inverse }],
              modifier: "",
              optional: false,
            },
          },
        ],
      });
    },
    [],
  );

  const addNode = useCallback(
    async (nodeIri: string) => {
      // A text query is not built by clicking: the graph stays explorable,
      // but nothing it does reaches the text or the builder behind it.
      if (!ontologyId || !schema || textQueryRef.current) return;
      setHint(null);
      let info: QueryNodeInfo;
      try {
        info = await getQueryNode(ontologyId, nodeIri, imports);
      } catch {
        setHint("That node has no type, so it cannot be used as a query step.");
        return;
      }
      const target = info.isClass ? null : info.types[0];
      const classIri = info.isClass ? info.iri : target?.iri;
      if (!classIri) {
        setHint("That node has no type, so it cannot be used as a query step.");
        return;
      }
      const label = info.isClass ? info.label : target?.label ?? classIri;
      const pin = info.isClass ? null : { iri: info.iri, label: info.label };

      // Attaches to the most recent step that actually relates to this class.
      if (!appendClass(classIri, label, pin, schema)) {
        setHint(
          `No relationship in this ontology connects “${label}” to the current path. ` +
            "Pick a highlighted node, or choose one of the suggested next steps.",
        );
      }
    },
    [ontologyId, schema, appendClass, imports],
  );

  /** Every continuation available from the current path, best first. */
  const nextStepOptions = useMemo(() => {
    if (!schema || state.steps.length === 0) return [];
    const byKey = new Map<
      string,
      {
        anchor: number;
        anchorLabel: string;
        predicate: string;
        predicateLabel: string;
        inverse: boolean;
        targetClass: string;
        targetLabel: string;
        count: number;
        declared: boolean;
      }
    >();
    const classLabels = new Map(schema.classes.map((c) => [c.iri, c.label]));

    state.steps.forEach((step, index) => {
      const family = ancestorsOf(step.classIri);
      for (const link of schema.links) {
        // Inherited links included: FIBO declares most relationships on a
        // broad domain, so a subclass would otherwise offer nothing.
        const forward = family.has(link.source);
        const backward = family.has(link.target);
        if (!forward && !backward) continue;
        const targetClass = forward ? link.target : link.source;
        const targetLabel = classLabels.get(targetClass);
        if (!targetLabel) continue;
        const inverse = !forward;
        const key = `${index}|${link.predicate}|${inverse}|${targetClass}`;
        const existing = byKey.get(key);
        if (!existing || link.count > existing.count) {
          byKey.set(key, {
            anchor: index,
            anchorLabel: step.label,
            predicate: link.predicate,
            predicateLabel: link.label,
            inverse,
            targetClass,
            targetLabel,
            count: link.count,
            declared: link.declared,
          });
        }
      }
    });

    return [...byKey.values()].sort(
      (a, b) =>
        b.anchor - a.anchor || // continuing from the newest step feels natural
        b.count - a.count ||
        Number(b.declared) - Number(a.declared) ||
        a.predicateLabel.localeCompare(b.predicateLabel),
    );
  }, [schema, state.steps, ancestorsOf]);

  /** Data properties of a class, including those declared on ancestors. */
  const dataPropertiesFor = useCallback(
    (classIri: string) => {
      if (!schema) return [];
      const seen = new Set<string>();
      const result = [];
      for (const iri of ancestorsOf(classIri)) {
        for (const prop of schema.dataProperties[iri] ?? []) {
          if (seen.has(prop.predicate)) continue;
          seen.add(prop.predicate);
          result.push(prop);
        }
      }
      return result.sort((a, b) => a.label.localeCompare(b.label));
    },
    [schema, ancestorsOf],
  );

  /** Remove a step together with everything hanging off it. */
  const removeStep = useCallback((index: number) => {
    const current = stateRef.current;
    // Mark the step and, transitively, every step anchored to a doomed one.
    const doomed = new Set<number>([index]);
    current.steps.forEach((step, i) => {
      if (step.link && doomed.has(step.link.anchor)) doomed.add(i);
    });
    // Keep the survivors, and remap old indices to their new positions so each
    // surviving link's anchor still points at the right step.
    const kept = current.steps.map((_, i) => i).filter((i) => !doomed.has(i));
    const remap = new Map(kept.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    const steps = kept.map((oldIndex) => {
      const step = current.steps[oldIndex];
      if (!step.link) return step;
      return { ...step, link: { ...step.link, anchor: remap.get(step.link.anchor) ?? 0 } };
    });
    setState({ ...current, steps });
  }, []);

  const updateStep = useCallback((index: number, patch: Partial<QueryStep>) => {
    setState((prev) => ({
      ...prev,
      steps: prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }, []);

  const updateLink = useCallback((index: number, patch: Partial<StepLink>) => {
    setState((prev) => ({
      ...prev,
      steps: prev.steps.map((step, i) =>
        i === index && step.link ? { ...step, link: { ...step.link, ...patch } } : step,
      ),
    }));
  }, []);

  /** Empty the path back to a blank query. */
  const clear = useCallback(() => {
    setState((prev) => ({ ...prev, steps: [] }));
    setHint(null);
    setOpenQuery(null);
  }, []);

  /** Load a saved query's state and remember which saved query it is. */
  const loadState = useCallback((next: QueryState, opened: { id: string; name: string }) => {
    setState({ ...emptyQueryState(), ...next });
    setOpenQuery(opened);
    setHint(null);
    setTextQuery(null);
  }, []);

  /**
   * The first change to the builder's text: the query becomes text. The
   * session is kept, because the editor already holds what was typed.
   */
  const forkToText = useCallback((text: string, baseline: string) => {
    textRef.current = text;
    setTextQuery({
      forkedFrom: stateRef.current,
      name: null,
      baseline,
      runBlocked: null,
      note: null,
      session: sessionRef.current,
      // A fork keeps the open saved query: it is the same query, now text,
      // and Update stores it that way with the state to go back to.
      resume: openQueryRef.current,
    });
  }, []);

  /**
   * A new text query: from nothing, a file, the ontology, or a saved text
   * query. `forkedFrom`, when given, becomes the builder state only on the
   * way back, never now.
   */
  const openTextQuery = useCallback(
    (
      text: string,
      options: Partial<Pick<TextQuery, "forkedFrom" | "name" | "runBlocked" | "note">> & {
        /** The saved text query being opened, if it is one. */
        opened?: { id: string; name: string } | null;
      } = {},
    ) => {
      textRef.current = text;
      sessionRef.current += 1;
      // From one text query to another, the query to resume is still the one
      // behind the first: that is whose state the builder is holding.
      const resume = textQueryRef.current ? textQueryRef.current.resume : openQueryRef.current;
      setOpenQuery(options.opened ?? null);
      setTextQuery({
        forkedFrom: options.forkedFrom ?? null,
        name: options.name ?? null,
        baseline: text,
        runBlocked: options.runBlocked ?? null,
        note: options.note ?? null,
        session: sessionRef.current,
        resume,
      });
    },
    [],
  );

  /** The editor reports each keystroke here; nothing renders. */
  const setText = useCallback((text: string) => {
    textRef.current = text;
  }, []);

  /**
   * After a save, the saved text is what leaving without loss means. The text
   * that was sent, not the live one: anything typed while the request was in
   * flight never reached the server and must still count as unsaved.
   */
  const markTextSaved = useCallback((saved: string) => {
    setTextQuery((prev) => (prev ? { ...prev, baseline: saved } : prev));
  }, []);

  /**
   * Leave text mode. With a visual version to go back to, the builder shows
   * it; for a fork made in this session that is the untouched state already,
   * and for a saved text query it is the state stored with it. Without one,
   * the builder is left as it was, and so is the saved query behind it.
   */
  const leaveText = useCallback(() => {
    const current = textQueryRef.current;
    if (!current) return;
    if (!current.forkedFrom) setOpenQuery(current.resume);
    // Identity, not equality: a fork from this session holds the builder's own
    // state object, and handing back a copy would re-run everything keyed on it.
    else if (current.forkedFrom !== stateRef.current) {
      setState({ ...emptyQueryState(), ...current.forkedFrom });
    }
    textRef.current = "";
    setTextQuery(null);
  }, []);

  /** Whether leaving now would lose typed text. */
  const textIsDirty = useCallback(() => {
    const current = textQueryRef.current;
    return !!current && textRef.current !== current.baseline;
  }, []);

  // Everything the graph and the panel need, in one object.
  return {
    schema,
    schemaError,
    loadingSchema,
    state,
    setState,
    sparql,
    hint,
    setHint,
    pathIris,
    candidates,
    addNode,
    addClass,
    addNextStep,
    nextStepOptions,
    dataPropertiesFor,
    ancestorsOf,
    removeStep,
    updateStep,
    updateLink,
    clear,
    openQuery,
    setOpenQuery,
    loadState,
    textQuery,
    // The editor's identity: the session a fork from here would keep, so the
    // editor open on the builder's text is the same one after the fork.
    editorSession: textQuery ? textQuery.session : sessionRef.current,
    textRef,
    forkToText,
    openTextQuery,
    setText,
    markTextSaved,
    leaveText,
    textIsDirty,
  };
}
