/*
================================================================================
FILE: frontend/src/sparql/generate.ts
================================================================================

SUMMARY
    Turns the visual query-builder state (QueryState) into a SPARQL SELECT
    query string. Pure and dependency-free so it can be unit tested on its own
    (see generate.test.ts).

BASIC IDEA
    The generated query mirrors the shape the user built:
      - Steps form a TREE (each step hangs off an "anchor" step), so a class
        can fan out to several others.
      - An OPTIONAL hop wraps its whole subtree, so nothing downstream can
        reference an unbound variable.
      - "Paths mode" collapses hops through steps that carry no data of their
        own into a single compact property path (e.g. (:a)/(:b)).
      - "Count" mode emits COUNT(DISTINCT ...) with GROUP BY instead of rows.
    Variable names are derived deterministically from class/predicate names so
    the same query always produces the same text, and the UI can label chips
    with the exact variables the query will use.

INPUTS / INPUT SOURCES
    - state: the QueryState from the builder.
    - namespaces: prefix -> IRI map from the ontology's schema (merged over the
      built-in RDF/RDFS/OWL/SKOS/XSD prefixes).

EXPECTED OUTPUT
    - generateSparql -> the query text (empty string when there are no steps).
    - assignVarNames -> the variables the query will use (for chip labels).
    - Exported NUMERIC_TYPES / TEMPORAL_TYPES / localName reused by the UI.
================================================================================
*/

import type { LinkPredicate, QueryState, SelectedProp, StepLink } from "./types";

// Prefixes always available; the ontology's own namespaces are merged over these.
const DEFAULT_NAMESPACES: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

const XSD = DEFAULT_NAMESPACES.xsd;

/** Datatypes whose values are ordered, so comparison operators make sense. */
export const NUMERIC_TYPES = new Set(
  [
    "integer",
    "decimal",
    "float",
    "double",
    "long",
    "int",
    "short",
    "byte",
    "nonNegativeInteger",
    "positiveInteger",
    "nonPositiveInteger",
    "negativeInteger",
    "unsignedInt",
    "unsignedLong",
    "unsignedShort",
    "unsignedByte",
  ].map((t) => XSD + t),
);

export const TEMPORAL_TYPES = new Set(
  ["date", "dateTime", "time", "gYear", "gYearMonth", "duration"].map((t) => XSD + t),
);

/**
 * Temporal types that SPARQL engines reliably order as typed literals.
 * Others (notably xsd:gYear) silently match nothing when compared that
 * way, so they are compared on their lexical form instead — correct for
 * the zero-padded forms these datatypes use.
 */
const TYPED_COMPARABLE = new Set([`${XSD}date`, `${XSD}dateTime`]);

// Working context threaded through generation: the available prefixes, and the
// set of prefixes actually used (so only those become PREFIX lines).
interface Ctx {
  namespaces: Record<string, string>;
  usedPrefixes: Set<string>;
}

/** Shorten an IRI to `prefix:local`, or wrap it in angle brackets. */
function shorten(iri: string, ctx: Ctx): string {
  // Find the longest namespace that prefixes this IRI (longest = most specific).
  let bestPrefix: string | null = null;
  let bestNs = "";
  for (const [prefix, ns] of Object.entries(ctx.namespaces)) {
    if (ns && iri.startsWith(ns) && ns.length > bestNs.length) {
      bestPrefix = prefix;
      bestNs = ns;
    }
  }
  // bestPrefix can be "" (the empty prefix), so compare against null explicitly.
  if (bestPrefix !== null) {
    const local = iri.slice(bestNs.length);
    // Deliberately conservative: anything with a dot, slash or exotic
    // character is safer as a full IRI than as a possibly invalid QName.
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(local)) {
      ctx.usedPrefixes.add(bestPrefix);  // remember to emit this PREFIX line
      return `${bestPrefix}:${local}`;
    }
  }
  // No usable prefix: fall back to a full IRI in angle brackets.
  return `<${iri}>`;
}

/** The trailing name of an IRI (used to seed variable names and labels). */
export function localName(iri: string): string {
  const match = iri.match(/[^#/:]+$/);
  return match ? match[0] : iri;
}

/** Escape a string so it is safe inside a double-quoted SPARQL literal. */
function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Turn a base name into a valid, unique SPARQL variable name. */
function makeVarName(base: string, used: Set<string>): string {
  // Strip characters SPARQL variables cannot contain.
  let name = base.replace(/[^A-Za-z0-9_]/g, "");
  if (!name) name = "x";                       // never empty
  if (/^[0-9]/.test(name)) name = `v${name}`;  // must not start with a digit
  name = name[0].toLowerCase() + name.slice(1); // lower-camel by convention
  // Deduplicate by appending 2, 3, ... until the name is free.
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${name}${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Variable names for every step and selected property. Exported so the UI
 * can label chips with exactly the names the query will use.
 */
export function assignVarNames(state: QueryState): {
  stepVars: string[];
  propVars: string[][];
} {
  // One shared "used" set guarantees every variable (steps and props) is unique.
  const used = new Set<string>();
  const stepVars: string[] = [];
  const propVars: string[][] = [];
  state.steps.forEach((step) => {
    // Step variable from the class local name (e.g. Planet -> ?planet).
    const stepVar = makeVarName(localName(step.classIri), used);
    stepVars.push(stepVar);
    // Prop variables combine the step and property names (?planetDiameterKm).
    propVars.push(
      step.props.map((prop) => {
        const suffix = localName(prop.predicateIri);
        const capitalized = suffix ? suffix[0].toUpperCase() + suffix.slice(1) : "value";
        return makeVarName(`${stepVar}${capitalized}`, used);
      }),
    );
  });
  return { stepVars, propVars };
}

/** One predicate as a path term, prefixed with ^ when the hop is inverse. */
function predicateTerm(predicate: LinkPredicate, ctx: Ctx): string {
  const term = shorten(predicate.iri, ctx);
  return predicate.inverse ? `^${term}` : term;
}

/** A hop as a property-path expression, e.g. `(:a|^:b)+`. */
function pathExpression(link: StepLink, ctx: Ctx): string {
  const terms = link.predicates.map((p) => predicateTerm(p, ctx));
  const base = terms.length > 1 ? `(${terms.join("|")})` : `(${terms[0]})`;
  return link.modifier ? `${base}${link.modifier}` : base;
}

/** True when the hop is a single plain predicate needing no path syntax. */
function isSimpleHop(link: StepLink): boolean {
  return link.predicates.length === 1 && link.modifier === "";
}

/**
 * Build the FILTER(...) line for a property, or null if there is no filter.
 * Chooses a comparison form appropriate to the datatype so it actually matches:
 * bare numbers/booleans, typed date/dateTime literals, string functions for
 * contains/starts-with/lang, and STR() comparison for everything else
 * (including xsd:gYear, which engines mis-handle as a typed literal).
 */
function filterLine(prop: SelectedProp, varName: string, ctx: Ctx): string | null {
  const filter = prop.filter;
  // No filter, or an empty value, means no FILTER line at all.
  if (!filter || filter.value.trim() === "") return null;
  const { op, value } = filter;
  const datatype = prop.datatype;

  switch (op) {
    case "contains":
      return `FILTER(CONTAINS(LCASE(STR(?${varName})), "${escapeLiteral(value.toLowerCase())}"))`;
    case "startsWith":
      return `FILTER(STRSTARTS(LCASE(STR(?${varName})), "${escapeLiteral(value.toLowerCase())}"))`;
    case "lang":
      return `FILTER(LANG(?${varName}) = "${escapeLiteral(value)}")`;
    // =, !=, >, >=, <, <=
    default: {
      // Numbers compare as bare numeric literals.
      if (datatype && NUMERIC_TYPES.has(datatype) && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return `FILTER(?${varName} ${op} ${value.trim()})`;
      }
      // Booleans compare as the true/false keyword.
      if (datatype === `${XSD}boolean`) {
        const bool = value.trim().toLowerCase() === "true" ? "true" : "false";
        return `FILTER(?${varName} ${op} ${bool})`;
      }
      // Reliably-orderable temporal types compare as typed literals.
      if (datatype && TYPED_COMPARABLE.has(datatype)) {
        return `FILTER(?${varName} ${op} "${escapeLiteral(value)}"^^${shorten(datatype, ctx)})`;
      }
      // Lexical comparison also keeps plain, typed and language-tagged
      // strings interchangeable, which is what picking "equals" implies.
      return `FILTER(STR(?${varName}) ${op} "${escapeLiteral(value)}")`;
    }
  }
}

// Mutable state carried through the recursive emission of the WHERE body.
interface EmitContext extends Ctx {
  state: QueryState;
  stepVars: string[];         // variable name per step index
  propVars: string[][];       // variable names per step's properties
  children: number[][];       // child step indices per step (the branch tree)
  projected: string[];        // all variables to SELECT, in order
  /** Step variables only, in emission order — what counting groups by. */
  stepProjected: string[];
  lines: string[];            // the accumulated WHERE-clause lines
}

/** Two spaces per depth level, for readable nested OPTIONAL blocks. */
function indent(depth: number): string {
  return "  ".repeat(depth);
}

/** Typing assertion, instance pin, and data properties of one step. */
function emitStepBody(index: number, depth: number, ec: EmitContext): void {
  const step = ec.state.steps[index];
  const varName = ec.stepVars[index];
  const pad = indent(depth);
  // This step's variable is projected (and is a grouping candidate for Count).
  ec.projected.push(varName);
  ec.stepProjected.push(varName);
  // Every step asserts its class: `?x a :Class .`
  ec.lines.push(`${pad}?${varName} a ${shorten(step.classIri, ec)} .`);
  // A pinned individual constrains the step to exactly that resource.
  if (step.pin) {
    ec.lines.push(`${pad}VALUES ?${varName} { ${shorten(step.pin.iri, ec)} }`);
  }
  // Emit each selected data property, as OPTIONAL unless it carries a filter.
  step.props.forEach((prop, propIndex) => {
    const propVar = ec.propVars[index][propIndex];
    const pattern = `?${varName} ${shorten(prop.predicateIri, ec)} ?${propVar} .`;
    const filter = filterLine(prop, propVar, ec);
    // A filter implies the property must be present, so it is never optional.
    if (prop.optional && !filter) {
      ec.lines.push(`${pad}OPTIONAL { ${pattern} }`);
    } else {
      ec.lines.push(`${pad}${pattern}`);
      if (filter) ec.lines.push(`${pad}${filter}`);
    }
    ec.projected.push(propVar);
  });
}

/**
 * In paths mode, can the step at `index` be folded into its parent's path?
 * Only when it carries no data of its own (no props, not pinned) and has
 * exactly one non-optional child to continue the path through.
 */
function canCollapse(index: number, ec: EmitContext): boolean {
  if (!ec.state.pathsMode) return false;
  const step = ec.state.steps[index];
  if (step.props.length > 0 || step.pin) return false;
  const kids = ec.children[index];
  if (kids.length !== 1) return false;
  const childLink = ec.state.steps[kids[0]].link;
  return !!childLink && !childLink.optional;
}

/** Emit the hop reaching `index`, that step's body, and its subtree. */
function emitBranch(index: number, depth: number, ec: EmitContext): void {
  const link = ec.state.steps[index].link as StepLink;
  const anchorVar = ec.stepVars[link.anchor];
  const pad = indent(depth);

  // In paths mode, walk through steps that carry no data of their own and
  // fold their hops into one property path. `target` ends at the last folded
  // step, and `segments` collects each hop's path expression.
  const segments: string[] = [pathExpression(link, ec)];
  let target = index;
  while (canCollapse(target, ec)) {
    const next = ec.children[target][0];
    segments.push(pathExpression(ec.state.steps[next].link as StepLink, ec));
    target = next;
  }

  // A single plain predicate is emitted as a bare triple (cleaner than a path).
  if (segments.length === 1 && isSimpleHop(link)) {
    const predicate = link.predicates[0];
    const term = shorten(predicate.iri, ec);
    const targetVar = ec.stepVars[target];
    ec.lines.push(
      predicate.inverse
        ? `${pad}?${targetVar} ${term} ?${anchorVar} .`
        : `${pad}?${anchorVar} ${term} ?${targetVar} .`,
    );
  } else {
    // Otherwise join the collected segments with "/" into one property path.
    ec.lines.push(`${pad}?${anchorVar} ${segments.join("/")} ?${ec.stepVars[target]} .`);
  }

  // Emit the (folded) target step's body and then recurse into its children.
  emitStepBody(target, depth, ec);
  emitChildren(target, depth, ec);
}

/** Recurse into a step's children; an optional child's whole subtree is wrapped. */
function emitChildren(index: number, depth: number, ec: EmitContext): void {
  for (const child of ec.children[index]) {
    const link = ec.state.steps[child].link as StepLink;
    if (link.optional) {
      // Wrap the entire branch so downstream vars can't be referenced unbound.
      ec.lines.push(`${indent(depth)}OPTIONAL {`);
      emitBranch(child, depth + 1, ec);
      ec.lines.push(`${indent(depth)}}`);
    } else {
      emitBranch(child, depth, ec);
    }
  }
}

/** Public entry point: render the whole QueryState as a SPARQL query string. */
export function generateSparql(
  state: QueryState,
  namespaces: Record<string, string> = {},
): string {
  // Nothing built yet -> no query.
  if (state.steps.length === 0) return "";

  // Merge the ontology's namespaces over the built-in defaults.
  const ctx: Ctx = {
    namespaces: { ...DEFAULT_NAMESPACES, ...namespaces },
    usedPrefixes: new Set<string>(),
  };
  const { stepVars, propVars } = assignVarNames(state);

  // Build the branch tree: for each step, the indices of steps that hang off it.
  // Steps hang off an anchor; anything with a broken anchor is ignored.
  const children: number[][] = state.steps.map(() => []);
  state.steps.forEach((step, index) => {
    const link = step.link;
    if (index > 0 && link && link.anchor >= 0 && link.anchor < index) {
      children[link.anchor].push(index);
    }
  });

  const ec: EmitContext = {
    ...ctx,
    state,
    stepVars,
    propVars,
    children,
    projected: [],
    stepProjected: [],
    lines: [],
  };

  // Emit the root step (index 0) and then the whole tree beneath it.
  emitStepBody(0, 1, ec);
  emitChildren(0, 1, ec);

  // Only the prefixes actually used become PREFIX lines, sorted for stability.
  const prefixLines = [...ec.usedPrefixes]
    .sort()
    .map((prefix) => `PREFIX ${prefix}: <${ctx.namespaces[prefix]}>`);

  // tail holds GROUP BY / ORDER BY when counting; selectClause is built next.
  const tail: string[] = [];
  let selectClause: string;

  if (state.aggregate === "count") {
    // "How many": count the last step, grouped by the first when the path
    // has more than one step. Data properties still constrain the match
    // through their filters, but are not projected — they would otherwise
    // have to join the GROUP BY and split the counts.
    const groupVar = ec.stepProjected[0];
    const countVar = ec.stepProjected[ec.stepProjected.length - 1];
    if (ec.stepProjected.length > 1) {
      selectClause = `SELECT ?${groupVar} (COUNT(DISTINCT ?${countVar}) AS ?count)`;
      tail.push(`GROUP BY ?${groupVar}`, "ORDER BY DESC(?count)");
    } else {
      selectClause = `SELECT (COUNT(DISTINCT ?${countVar}) AS ?count)`;
    }
  } else {
    // Normal rows: project every step and property variable (DISTINCT optional).
    selectClause = `SELECT ${state.distinct ? "DISTINCT " : ""}${ec.projected
      .map((v) => `?${v}`)
      .join(" ")}`;
  }

  // Assemble the final query: prefixes, a blank line, SELECT, the WHERE body,
  // any GROUP/ORDER tail, and LIMIT.
  return [
    ...prefixLines,
    ...(prefixLines.length ? [""] : []),
    selectClause,
    "WHERE {",
    ...ec.lines,
    "}",
    ...tail,
    `LIMIT ${state.limit}`,
  ].join("\n");
}
