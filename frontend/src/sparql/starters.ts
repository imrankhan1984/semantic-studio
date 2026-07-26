/**
 * Suggested starting points, derived from the ontology's own schema.
 *
 * A newcomer facing an empty builder has no idea what the data can answer.
 * These give concrete, one-click queries that already work against the
 * loaded ontology, and stay editable afterwards — learning by example
 * rather than by guessing at the graph.
 */

import type { QuerySchema, SchemaClass, SchemaLink } from "../types";
import { plural } from "./describe";
import { emptyQueryState } from "./types";
import type { QueryState } from "./types";

/** "Concept" -> "Concepts", capitalised for use in a title. */
function pluralTitle(label: string): string {
  const word = plural(label);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const SKOS = "http://www.w3.org/2004/02/skos/core#";

export interface Starter {
  id: string;
  title: string;
  detail: string;
  state: QueryState;
}

function classOf(schema: QuerySchema, iri: string): SchemaClass | undefined {
  return schema.classes.find((c) => c.iri === iri);
}

function singleStep(cls: SchemaClass, extra: Partial<QueryState> = {}): QueryState {
  return {
    ...emptyQueryState(),
    ...extra,
    steps: [{ classIri: cls.iri, label: cls.label, props: [] }],
  };
}

function twoStep(source: SchemaClass, link: SchemaLink, target: SchemaClass): QueryState {
  return {
    ...emptyQueryState(),
    steps: [
      { classIri: source.iri, label: source.label, props: [] },
      {
        classIri: target.iri,
        label: target.label,
        props: [],
        link: {
          anchor: 0,
          predicates: [{ iri: link.predicate, inverse: false }],
          modifier: "",
          optional: false,
        },
      },
    ],
  };
}

/** Links worth suggesting: real connections, richest first. */
function rankedLinks(schema: QuerySchema): SchemaLink[] {
  return [...schema.links]
    .filter((link) => link.count > 0 || link.declared)
    .sort((a, b) => Number(b.declared) - Number(a.declared) || b.count - a.count)
    .slice(0, 40);
}

export function buildStarters(schema: QuerySchema | null, max = 5): Starter[] {
  if (!schema) return [];
  // Sorted here rather than trusting the caller's ordering.
  const populated = schema.classes
    .filter((c) => c.instances > 0)
    .sort((a, b) => b.instances - a.instances || a.label.localeCompare(b.label));
  const starters: Starter[] = [];
  const seen = new Set<string>();

  const push = (starter: Starter) => {
    if (starters.length >= max || seen.has(starter.id)) return;
    seen.add(starter.id);
    starters.push(starter);
  };

  // 1. Everything of the most populated type — the simplest useful query.
  const biggest = populated[0];
  if (biggest) {
    push({
      id: `all:${biggest.iri}`,
      title: `All ${pluralTitle(biggest.label)}`,
      detail: `${biggest.instances.toLocaleString()} in this ontology`,
      state: singleStep(biggest),
    });
  }

  // 2. How many of each type — counting questions come first for newcomers.
  if (biggest) {
    push({
      id: `count:${biggest.iri}`,
      title: `How many ${pluralTitle(biggest.label)}?`,
      detail: "Counts rather than rows",
      state: singleStep(biggest, { aggregate: "count" }),
    });
  }

  // 3. SKOS taxonomies: the two questions people actually ask of one.
  const concept = classOf(schema, `${SKOS}Concept`);
  if (concept && concept.instances > 0) {
    const scheme = classOf(schema, `${SKOS}ConceptScheme`);
    push({
      id: "skos:narrower",
      title: "Concepts and their narrower concepts",
      detail: "Walks the hierarchy downwards",
      state: {
        ...emptyQueryState(),
        steps: [
          { classIri: concept.iri, label: concept.label, props: [] },
          {
            classIri: concept.iri,
            label: concept.label,
            props: [],
            link: {
              anchor: 0,
              predicates: [{ iri: `${SKOS}broader`, inverse: true }],
              modifier: "",
              optional: false,
            },
          },
        ],
      },
    });
    if (scheme && scheme.instances > 0) {
      push({
        id: "skos:perScheme",
        title: "How many concepts per scheme?",
        detail: "Counts each vocabulary",
        state: {
          ...emptyQueryState(),
          aggregate: "count",
          steps: [
            { classIri: scheme.iri, label: scheme.label, props: [] },
            {
              classIri: concept.iri,
              label: concept.label,
              props: [],
              link: {
                anchor: 0,
                predicates: [{ iri: `${SKOS}inScheme`, inverse: true }],
                modifier: "",
                optional: false,
              },
            },
          ],
        },
      });
    }
  }

  // 4. The richest relationships in the data, as two-step paths.
  for (const link of rankedLinks(schema)) {
    if (starters.length >= max) break;
    const source = classOf(schema, link.source);
    const target = classOf(schema, link.target);
    if (!source || !target) continue;
    if (source.iri.startsWith(SKOS) || target.iri.startsWith(SKOS)) continue;
    push({
      id: `link:${link.source}|${link.predicate}|${link.target}`,
      title: `${source.label} → ${link.label} → ${target.label}`,
      detail: link.count > 0 ? `${link.count.toLocaleString()} in the data` : "Declared in the schema",
      state: twoStep(source, link, target),
    });
  }

  return starters;
}

/** Classes worth offering as a first step, most useful first. */
export function entryPoints(schema: QuerySchema | null, max = 10): SchemaClass[] {
  if (!schema) return [];
  const connected = new Set<string>();
  for (const link of schema.links) {
    connected.add(link.source);
    connected.add(link.target);
  }
  return [...schema.classes]
    .sort(
      (a, b) =>
        Number(connected.has(b.iri)) - Number(connected.has(a.iri)) ||
        b.instances - a.instances ||
        a.label.localeCompare(b.label),
    )
    .slice(0, max);
}
