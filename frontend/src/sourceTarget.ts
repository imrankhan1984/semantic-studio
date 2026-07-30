/*
================================================================================
FILE: frontend/src/sourceTarget.ts
================================================================================

SUMMARY
    Locating one entity in the raw source text, and the sentence to say when it
    cannot be located. Two pure functions, kept out of SourceView so the rule
    they carry can be tested without rendering a 2 MB document into jsdom.

BASIC IDEA
    "View in source" hands over an entity's full IRI and the prefixed form the
    backend computed for it. The document may be the original file or the
    re-serialized Turtle, and which form appears depends on which: pretty
    Turtle writes `ex:Thing`, an N-Triples original writes the IRI in full. So
    both are tried, full IRI first, and the first line containing either wins.

    The search is `indexOf` over each line and nothing else. The needle comes
    out of the ontology, so building a regular expression from it would let an
    IRI containing regex metacharacters decide what gets matched — see the
    security note in result-navigation.md section 9.

INPUTS / INPUT SOURCES
    - The document already split into lines by SourceView.
    - An entity's IRI and its prefixed form, from a SPARQL result term.

EXPECTED OUTPUT
    - findTargetLine: the zero-based index of the first line containing the
      entity, or -1.
    - targetMissingMessage: what to announce when that is -1.
================================================================================
*/

/** What "View in source" is looking for: one entity, in both written forms. */
export interface SourceTarget {
  iri: string;
  /** The backend's shortened form, e.g. `fibo-fbc:FinancialInstrument`. */
  prefixed?: string;
}

/**
 * Characters that continue an RDF name, so a match ending before one of them is
 * a prefix of a longer term rather than the term itself.
 *
 * Found in a browser, not in a test: asking for `:Mars` in the re-serialized
 * Turtle landed on `ns1:Mars2020`, three declarations above the real one. A
 * plain substring search is right about the *characters* and wrong about the
 * *term*, and a reader sent to the wrong line has no way to tell.
 */
const CONTINUES_A_NAME = /[A-Za-z0-9_\-%~]/;

/**
 * Whether `needle` occurs in `line` as a whole term rather than as the opening
 * of a longer one.
 *
 * Only the character *after* the match is checked, deliberately. Requiring a
 * boundary before it as well would reject `ns1:Mars` for the needle `:Mars`,
 * and that is the common case, not an edge one: the prefixed form comes from
 * the ontology's own namespace bindings while the Formatted view is rdflib's
 * re-serialization, which is free to bind a different prefix to the same
 * namespace. Matching the suffix is what makes both views work.
 */
function mentions(line: string, needle: string): boolean {
  let from = line.indexOf(needle);
  while (from !== -1) {
    const after = line[from + needle.length];
    if (after === undefined || !CONTINUES_A_NAME.test(after)) return true;
    from = line.indexOf(needle, from + 1);
  }
  return false;
}

/**
 * What to search for, in the order to try it: the full IRI, then the prefixed
 * form with its colon guaranteed.
 *
 * The colon is the second thing browser verification caught. `prefixed` comes
 * from rdflib's `namespace_manager.qname`, which shortens a term in the
 * **default** namespace to a bare local name — `Mars`, not `:Mars`. Searching a
 * document for `Mars` matches `rdfs:label "Mars 2020"`, so the reader lands in
 * the middle of a different entity's description. Putting the colon back makes
 * the needle a term reference again, and it costs nothing when the prefixed
 * form already has one (or is the full IRI, which the backend falls back to).
 */
function needlesFor(target: SourceTarget): string[] {
  const needles = [target.iri];
  const short = target.prefixed;
  if (short) needles.push(short.includes(":") ? short : `:${short}`);
  return needles.filter((needle) => needle.length > 0);
}

/**
 * The first line of `lines` that mentions `target`, or -1.
 *
 * The two needles are tried in separate passes rather than together per line,
 * because the order is a preference about the whole document and not about one
 * line: a file that writes the IRI out in full somewhere should land there
 * rather than on an unrelated line that happens to share a prefix. Two passes
 * over 60,000 lines is a few milliseconds; see the budget in SourceView.test.tsx.
 */
export function findTargetLine(lines: string[], target: SourceTarget): number {
  for (const needle of needlesFor(target)) {
    for (let i = 0; i < lines.length; i += 1) {
      // indexOf, never a RegExp built from the needle: it is ontology-
      // controlled text. CONTINUES_A_NAME is a fixed pattern over one
      // character and interpolates nothing.
      if (mentions(lines[i], needle)) return i;
    }
  }
  return -1;
}

/**
 * Why the entity could not be shown, in one sentence for the live region.
 *
 * The truncated case is the one worth separating. `GET /source` caps the text
 * at 2 MB, so on a large file "not found" usually means "further down than
 * this pane goes", and telling the user it is absent would be false.
 */
export function targetMissingMessage(truncated: boolean): string {
  if (truncated) return "That entity is past the part of the file shown here.";
  return (
    "That entity does not appear in the source text shown here — " +
    "try the other of Original and Formatted Turtle."
  );
}
