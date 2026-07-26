/** Minimal SPARQL tokenizer for the read-only preview (no dependencies). */

export interface Token {
  text: string;
  cls: string;
}

const KEYWORDS =
  "PREFIX|SELECT|DISTINCT|REDUCED|WHERE|OPTIONAL|FILTER|VALUES|LIMIT|OFFSET|ORDER|BY|ASC|DESC|GROUP|HAVING|UNION|MINUS|BIND|AS|GRAPH|SERVICE";
const FUNCTIONS = "CONTAINS|STRSTARTS|STRENDS|LCASE|UCASE|STR|LANG|DATATYPE|REGEX|BOUND|COUNT|SUM|AVG|MIN|MAX";

const PATTERN = new RegExp(
  [
    "(#[^\\n]*)", // 1 comment
    "(<[^>\\s]*>)", // 2 full IRI
    '("(?:\\\\.|[^"\\\\])*")', // 3 string literal
    "(\\?[A-Za-z0-9_]+)", // 4 variable
    `\\b(${KEYWORDS})\\b`, // 5 keyword
    `\\b(${FUNCTIONS})\\b`, // 6 function
    "(\\^\\^[A-Za-z][\\w-]*:[\\w-]*)", // 7 datatype suffix
    "([A-Za-z][\\w-]*:[\\w-]*)", // 8 prefixed name
    "\\b(a)\\b", // 9 rdf:type shorthand
    "(-?\\d+(?:\\.\\d+)?)", // 10 number
  ].join("|"),
  "gi",
);

const GROUP_CLASSES = [
  "sparql-comment",
  "sparql-iri",
  "sparql-string",
  "sparql-var",
  "sparql-keyword",
  "sparql-fn",
  "sparql-type",
  "sparql-prefixed",
  "sparql-keyword",
  "sparql-number",
];

const TURTLE_PATTERN = new RegExp(
  [
    "(#[^\\n]*)", // 1 comment
    "(<[^>\\s]*>)", // 2 full IRI
    '("""[\\s\\S]*?"""|"(?:\\\\.|[^"\\\\])*")', // 3 string literal
    "(@prefix|@base|PREFIX|BASE)", // 4 directive
    "(\\^\\^[A-Za-z][\\w.-]*:[\\w.-]*)", // 5 datatype suffix
    "(@[a-zA-Z][\\w-]*)", // 6 language tag
    "([A-Za-z][\\w.-]*:[\\w.-]*|:[\\w.-]+)", // 7 prefixed name
    "\\b(a|true|false)\\b", // 8 keyword
    "(-?\\d+(?:\\.\\d+)?)", // 9 number
    "(_:[\\w-]+)", // 10 blank node
  ].join("|"),
  "g",
);

const TURTLE_CLASSES = [
  "sparql-comment",
  "sparql-iri",
  "sparql-string",
  "sparql-keyword",
  "sparql-type",
  "sparql-type",
  "sparql-prefixed",
  "sparql-keyword",
  "sparql-number",
  "sparql-var",
];

/** Tokenizer for Turtle / N-Triples source shown in the View tab. */
export function highlightTurtle(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  TURTLE_PATTERN.lastIndex = 0;
  let match = TURTLE_PATTERN.exec(line);
  while (match) {
    if (match.index > last) {
      tokens.push({ text: line.slice(last, match.index), cls: "sparql-plain" });
    }
    const groupIndex = TURTLE_CLASSES.findIndex((_, i) => match![i + 1] !== undefined);
    tokens.push({
      text: match[0],
      cls: groupIndex >= 0 ? TURTLE_CLASSES[groupIndex] : "sparql-plain",
    });
    last = match.index + match[0].length;
    match = TURTLE_PATTERN.exec(line);
  }
  if (last < line.length) {
    tokens.push({ text: line.slice(last), cls: "sparql-plain" });
  }
  return tokens;
}

/** Very rough XML/RDF-XML highlighting: tags, attributes and values. */
const XML_PATTERN = /(<!--[\s\S]*?-->)|(<\/?[\w:.-]+)|([\w:.-]+)=("[^"]*")|(\/?>)/g;

export function highlightXml(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  XML_PATTERN.lastIndex = 0;
  let match = XML_PATTERN.exec(line);
  while (match) {
    if (match.index > last) {
      tokens.push({ text: line.slice(last, match.index), cls: "sparql-plain" });
    }
    if (match[1]) tokens.push({ text: match[0], cls: "sparql-comment" });
    else if (match[2]) tokens.push({ text: match[0], cls: "sparql-keyword" });
    else if (match[3]) {
      tokens.push({ text: match[3], cls: "sparql-prefixed" });
      tokens.push({ text: "=", cls: "sparql-plain" });
      tokens.push({ text: match[4], cls: "sparql-string" });
    } else tokens.push({ text: match[0], cls: "sparql-keyword" });
    last = match.index + match[0].length;
    match = XML_PATTERN.exec(line);
  }
  if (last < line.length) {
    tokens.push({ text: line.slice(last), cls: "sparql-plain" });
  }
  return tokens;
}

/** Picks a tokenizer for an RDF serialization. */
export function highlighterFor(format: string): (line: string) => Token[] {
  if (format === "xml" || format === "rdf" || format === "owl") return highlightXml;
  return highlightTurtle;
}

export function highlightSparql(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  PATTERN.lastIndex = 0;
  let match = PATTERN.exec(line);
  while (match) {
    if (match.index > last) {
      tokens.push({ text: line.slice(last, match.index), cls: "sparql-plain" });
    }
    const groupIndex = GROUP_CLASSES.findIndex((_, i) => match![i + 1] !== undefined);
    tokens.push({
      text: match[0],
      cls: groupIndex >= 0 ? GROUP_CLASSES[groupIndex] : "sparql-plain",
    });
    last = match.index + match[0].length;
    match = PATTERN.exec(line);
  }
  if (last < line.length) {
    tokens.push({ text: line.slice(last), cls: "sparql-plain" });
  }
  return tokens;
}
