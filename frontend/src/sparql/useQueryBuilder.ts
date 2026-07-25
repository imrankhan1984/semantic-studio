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

export interface LinkOption {
  predicate: string;
  label: string;
  prefixed: string;
  inverse: boolean;
  declared: boolean;
  count: number;
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
): LinkOption[] {
  if (!schema) return [];
  const byKey = new Map<string, LinkOption>();
  for (const link of schema.links) {
    const candidates: LinkOption[] = [];
    if (link.source === fromClass && link.target === toClass) {
      candidates.push({ ...link, predicate: link.predicate, inverse: false });
    }
    if (link.source === toClass && link.target === fromClass) {
      candidates.push({ ...link, predicate: link.predicate, inverse: true });
    }
    for (const option of candidates) {
      const key = `${option.predicate}|${option.inverse}`;
      const existing = byKey.get(key);
      if (!existing || option.count > existing.count) byKey.set(key, option);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      Number(b.declared) - Number(a.declared) ||
      b.count - a.count ||
      a.label.localeCompare(b.label),
  );
}

export function useQueryBuilder(ontologyId: string | null, active: boolean) {
  const [schema, setSchema] = useState<QuerySchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [state, setState] = useState<QueryState>(emptyQueryState);
  const [hint, setHint] = useState<string | null>(null);
  const [openQuery, setOpenQuery] = useState<{ id: string; name: string } | null>(null);
  const requestedFor = useRef<string | null>(null);
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

  const sparql = useMemo(
    () => generateSparql(state, schema?.namespaces ?? {}),
    [state, schema],
  );

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
      const inPath = new Set(state.steps.map((s) => s.classIri));
      for (const link of schema.links) {
        if (inPath.has(link.source)) classes.add(link.target);
        if (inPath.has(link.target)) classes.add(link.source);
      }
    }
    for (const iri of classes) {
      const kind = KIND_OF_CLASS[iri];
      if (kind) kinds.add(kind);
    }
    return { classes, kinds };
  }, [schema, state.steps]);

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
        const options = linkOptionsBetween(currentSchema, current.steps[i].classIri, classIri);
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
    [],
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
      for (const link of schema.links) {
        const forward = link.source === step.classIri;
        const backward = link.target === step.classIri;
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
  }, [schema, state.steps]);

  /** Remove a step together with everything hanging off it. */
  const removeStep = useCallback((index: number) => {
    const current = stateRef.current;
    const doomed = new Set<number>([index]);
    current.steps.forEach((step, i) => {
      if (step.link && doomed.has(step.link.anchor)) doomed.add(i);
    });
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

  const clear = useCallback(() => {
    setState((prev) => ({ ...prev, steps: [] }));
    setHint(null);
    setOpenQuery(null);
  }, []);

  const loadState = useCallback((next: QueryState, opened: { id: string; name: string }) => {
    setState({ ...emptyQueryState(), ...next });
    setOpenQuery(opened);
    setHint(null);
  }, []);

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
    removeStep,
    updateStep,
    updateLink,
    clear,
    openQuery,
    setOpenQuery,
    loadState,
  };
}
