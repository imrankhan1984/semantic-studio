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
