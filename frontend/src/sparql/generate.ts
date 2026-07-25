/**
 * Turns visual query builder state into a SPARQL SELECT query.
 *
 * Pure and dependency-free so it can be unit tested on its own. The shape
 * of a query mirrors the shape the user built: steps form a tree (each
 * step hangs off an earlier one), an OPTIONAL hop wraps its whole subtree
 * so nothing downstream can reference an unbound variable, and "paths
 * mode" collapses hops through steps that carry no data of their own.
 */

import type { LinkPredicate, QueryState, SelectedProp, StepLink } from "./types";

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

interface Ctx {
  namespaces: Record<string, string>;
  usedPrefixes: Set<string>;
}

/** Shorten an IRI to `prefix:local`, or wrap it in angle brackets. */
function shorten(iri: string, ctx: Ctx): string {
  let bestPrefix: string | null = null;
  let bestNs = "";
  for (const [prefix, ns] of Object.entries(ctx.namespaces)) {
    if (ns && iri.startsWith(ns) && ns.length > bestNs.length) {
      bestPrefix = prefix;
      bestNs = ns;
    }
  }
  if (bestPrefix !== null) {
    const local = iri.slice(bestNs.length);
    // Deliberately conservative: anything with a dot, slash or exotic
    // character is safer as a full IRI than as a possibly invalid QName.
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(local)) {
      ctx.usedPrefixes.add(bestPrefix);
      return `${bestPrefix}:${local}`;
    }
  }
  return `<${iri}>`;
}

export function localName(iri: string): string {
  const match = iri.match(/[^#/:]+$/);
  return match ? match[0] : iri;
}

function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function makeVarName(base: string, used: Set<string>): string {
  let name = base.replace(/[^A-Za-z0-9_]/g, "");
  if (!name) name = "x";
  if (/^[0-9]/.test(name)) name = `v${name}`;
  name = name[0].toLowerCase() + name.slice(1);
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
  const used = new Set<string>();
  const stepVars: string[] = [];
  const propVars: string[][] = [];
  state.steps.forEach((step) => {
    const stepVar = makeVarName(localName(step.classIri), used);
    stepVars.push(stepVar);
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

function filterLine(prop: SelectedProp, varName: string, ctx: Ctx): string | null {
  const filter = prop.filter;
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
    default: {
      if (datatype && NUMERIC_TYPES.has(datatype) && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return `FILTER(?${varName} ${op} ${value.trim()})`;
      }
      if (datatype === `${XSD}boolean`) {
        const bool = value.trim().toLowerCase() === "true" ? "true" : "false";
        return `FILTER(?${varName} ${op} ${bool})`;
      }
      if (datatype && TYPED_COMPARABLE.has(datatype)) {
        return `FILTER(?${varName} ${op} "${escapeLiteral(value)}"^^${shorten(datatype, ctx)})`;
      }
      // Lexical comparison also keeps plain, typed and language-tagged
      // strings interchangeable, which is what picking "equals" implies.
      return `FILTER(STR(?${varName}) ${op} "${escapeLiteral(value)}")`;
    }
  }
}

interface EmitContext extends Ctx {
  state: QueryState;
  stepVars: string[];
  propVars: string[][];
  children: number[][];
  projected: string[];
  lines: string[];
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

/** Typing assertion, instance pin, and data properties of one step. */
function emitStepBody(index: number, depth: number, ec: EmitContext): void {
  const step = ec.state.steps[index];
  const varName = ec.stepVars[index];
  const pad = indent(depth);
  ec.projected.push(varName);
  ec.lines.push(`${pad}?${varName} a ${shorten(step.classIri, ec)} .`);
  if (step.pin) {
    ec.lines.push(`${pad}VALUES ?${varName} { ${shorten(step.pin.iri, ec)} }`);
  }
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
  // fold their hops into one property path.
  const segments: string[] = [pathExpression(link, ec)];
  let target = index;
  while (canCollapse(target, ec)) {
    const next = ec.children[target][0];
    segments.push(pathExpression(ec.state.steps[next].link as StepLink, ec));
    target = next;
  }

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
    ec.lines.push(`${pad}?${anchorVar} ${segments.join("/")} ?${ec.stepVars[target]} .`);
  }

  emitStepBody(target, depth, ec);
  emitChildren(target, depth, ec);
}

function emitChildren(index: number, depth: number, ec: EmitContext): void {
  for (const child of ec.children[index]) {
    const link = ec.state.steps[child].link as StepLink;
    if (link.optional) {
      ec.lines.push(`${indent(depth)}OPTIONAL {`);
      emitBranch(child, depth + 1, ec);
      ec.lines.push(`${indent(depth)}}`);
    } else {
      emitBranch(child, depth, ec);
    }
  }
}

export function generateSparql(
  state: QueryState,
  namespaces: Record<string, string> = {},
): string {
  if (state.steps.length === 0) return "";

  const ctx: Ctx = {
    namespaces: { ...DEFAULT_NAMESPACES, ...namespaces },
    usedPrefixes: new Set<string>(),
  };
  const { stepVars, propVars } = assignVarNames(state);

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
    lines: [],
  };

  emitStepBody(0, 1, ec);
  emitChildren(0, 1, ec);

  const prefixLines = [...ec.usedPrefixes]
    .sort()
    .map((prefix) => `PREFIX ${prefix}: <${ctx.namespaces[prefix]}>`);

  const selectClause = `SELECT ${state.distinct ? "DISTINCT " : ""}${ec.projected
    .map((v) => `?${v}`)
    .join(" ")}`;

  return [
    ...prefixLines,
    ...(prefixLines.length ? [""] : []),
    selectClause,
    "WHERE {",
    ...ec.lines,
    "}",
    `LIMIT ${state.limit}`,
  ].join("\n");
}
