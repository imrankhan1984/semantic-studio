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

INPUTS / INPUT SOURCES
    - ontologyId: which ontology to build against.
    - active: whether Query mode is on (the schema is only fetched then).
    - The backend /query-schema and /query-node endpoints (via api.ts).
    - User actions dispatched from the query components.

EXPECTED OUTPUT
    - A bag of state and callbacks consumed by App / GraphView / QueryPanel:
      schema, current state, live sparql, candidate highlighting, and the
      builder actions.
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

/** The hook itself: owns the builder state and exposes state + actions. */
export function useQueryBuilder(ontologyId: string | null, active: boolean) {
  const [schema, setSchema] = useState<QuerySchema | null>(null);      // class-level schema
  const [schemaError, setSchemaError] = useState<string | null>(null); // schema fetch error
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [state, setState] = useState<QueryState>(emptyQueryState);     // the query being built
  const [hint, setHint] = useState<string | null>(null);               // transient user guidance
  const [openQuery, setOpenQuery] = useState<{ id: string; name: string } | null>(null); // saved query being edited
  const requestedFor = useRef<string | null>(null);  // ontology whose schema we already fetched
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
    requestedFor.current = null;
  }, [ontologyId]);

  // The schema is only computed when the user actually enters Query mode.
  useEffect(() => {
    if (!active || !ontologyId || requestedFor.current === ontologyId) return;
    requestedFor.current = ontologyId;
    setLoadingSchema(true);
    let cancelled = false;
    getQuerySchema(ontologyId)
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
  }, [active, ontologyId]);

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
      if (!ontologyId || !schema) return;
      setHint(null);
      let info: QueryNodeInfo;
      try {
        info = await getQueryNode(ontologyId, nodeIri);
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
    [ontologyId, schema, appendClass],
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
  };
}
