/*
================================================================================
FILE: frontend/src/links.ts
================================================================================

SUMMARY
    linkTarget: the one gate an IRI passes before it becomes a link (D-088,
    closes CF-7). Only http: and https: IRIs are linked; anything else is
    shown as text with Copy.

BASIC IDEA
    IRIs come out of loaded files, which are untrusted input, and an IRI can
    have any scheme. `javascript:alert(1)` is a perfectly good IRI to rdflib,
    and as an href it runs script when clicked. Chrome and Edge refuse it in a
    new tab today; that is the browser's policy, not ours, and it is not the
    only dangerous scheme (data:, file:, and whatever comes next). So the rule
    is an allow-list of two schemes, not a block-list.

    The raw text is checked as well as the parsed URL. The URL parser strips
    leading spaces and control characters and would read " javascript:" as
    javascript:, while a prefix test alone would trust a string the parser
    reads some other way. Requiring both to agree leaves nothing between them.

    Every href in the source goes through here; links.test.ts scans the
    source and fails on one that does not.

INPUTS / INPUT SOURCES
    - An IRI or a link annotation's value, from the server.

EXPECTED OUTPUT
    - The IRI unchanged when it may be a link; undefined otherwise.
================================================================================
*/

const WEB = /^https?:\/\//i;

/** The IRI as an href when its scheme is http: or https:, else undefined. */
export function linkTarget(iri: string | null | undefined): string | undefined {
  if (typeof iri !== "string" || !WEB.test(iri)) return undefined;
  try {
    const { protocol } = new URL(iri);
    return protocol === "http:" || protocol === "https:" ? iri : undefined;
  } catch {
    return undefined;
  }
}
