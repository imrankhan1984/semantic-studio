/*
================================================================================
FILE: frontend/src/sparql/inheritance.test.ts
================================================================================

SUMMARY
    Tests the class-hierarchy resolution that makes FIBO-style ontologies
    usable: ancestor resolution (including cycle safety), and that
    linkOptionsBetween offers a relationship declared on an ancestor to the
    specific subclass, marks it inherited, ranks direct links above inherited
    ones, and prefers domain/range links over restriction-derived ones.

BASIC IDEA
    A hand-built schema mirrors the FIBO shape (relationships declared on a
    broad Party/Contract, with Bank/Loan several subclasses below). The tests
    assert that without resolution a subclass pair finds nothing, but with it
    the inherited link is offered.

INPUTS / INPUT SOURCES
    - A fixed, hand-constructed QuerySchema with a subclass hierarchy.

EXPECTED OUTPUT
    - Pass/fail per assertion; failures indicate an inheritance-resolution bug.
================================================================================
*/

import { describe, expect, it } from "vitest";
import { linkOptionsBetween, makeAncestorResolver } from "./useQueryBuilder";
import type { QuerySchema } from "../types";

const NS = "http://example.org/f#";

/**
 * Mirrors how FIBO is built: relationships are declared once on a broad
 * domain and range, and the classes people actually pick are subclasses
 * several levels below.
 */
const schema: QuerySchema = {
  classes: [
    { iri: `${NS}Party`, label: "Party", prefixed: ":Party", instances: 0, kind: "class" },
    { iri: `${NS}LegalEntity`, label: "Legal Entity", prefixed: ":LegalEntity", instances: 5, kind: "class" },
    { iri: `${NS}Bank`, label: "Bank", prefixed: ":Bank", instances: 3, kind: "class" },
    { iri: `${NS}Contract`, label: "Contract", prefixed: ":Contract", instances: 0, kind: "class" },
    { iri: `${NS}Loan`, label: "Loan", prefixed: ":Loan", instances: 2, kind: "class" },
  ],
  links: [
    {
      source: `${NS}Party`,
      target: `${NS}Contract`,
      predicate: `${NS}isPartyTo`,
      label: "is party to",
      prefixed: ":isPartyTo",
      declared: true,
      count: 0,
    },
  ],
  superClasses: {
    [`${NS}LegalEntity`]: [`${NS}Party`],
    [`${NS}Bank`]: [`${NS}LegalEntity`],
    [`${NS}Loan`]: [`${NS}Contract`],
  },
  dataProperties: {},
  namespaces: { "": NS },
  truncated: false,
};

describe("ancestor resolution", () => {
  const ancestorsOf = makeAncestorResolver(schema);

  it("includes the class itself and every ancestor", () => {
    expect([...ancestorsOf(`${NS}Bank`)].sort()).toEqual(
      [`${NS}Bank`, `${NS}LegalEntity`, `${NS}Party`].sort(),
    );
  });

  it("returns just the class when it has no parents", () => {
    expect([...ancestorsOf(`${NS}Party`)]).toEqual([`${NS}Party`]);
  });

  it("survives a cyclic hierarchy", () => {
    const cyclic = makeAncestorResolver({
      ...schema,
      superClasses: { [`${NS}A`]: [`${NS}B`], [`${NS}B`]: [`${NS}A`] },
    });
    expect([...cyclic(`${NS}A`)].sort()).toEqual([`${NS}A`, `${NS}B`].sort());
  });

  it("copes with a schema that has no superClasses at all", () => {
    const bare = makeAncestorResolver({ ...schema, superClasses: {} });
    expect([...bare(`${NS}Bank`)]).toEqual([`${NS}Bank`]);
  });
});

describe("linkOptionsBetween with inheritance", () => {
  const ancestorsOf = makeAncestorResolver(schema);

  it("finds nothing without inheritance — the FIBO failure mode", () => {
    expect(linkOptionsBetween(schema, `${NS}Bank`, `${NS}Loan`)).toHaveLength(0);
  });

  it("offers a link declared on ancestors of both ends", () => {
    const options = linkOptionsBetween(schema, `${NS}Bank`, `${NS}Loan`, ancestorsOf);
    expect(options).toHaveLength(1);
    expect(options[0].predicate).toBe(`${NS}isPartyTo`);
    expect(options[0].inverse).toBe(false);
    expect(options[0].inherited).toBe(true);
  });

  it("offers the reverse direction too", () => {
    const options = linkOptionsBetween(schema, `${NS}Loan`, `${NS}Bank`, ancestorsOf);
    expect(options[0].inverse).toBe(true);
  });

  it("marks a link declared directly on the class as not inherited", () => {
    const options = linkOptionsBetween(schema, `${NS}Party`, `${NS}Contract`, ancestorsOf);
    expect(options[0].inherited).toBe(false);
  });

  it("ranks domain/range links above ones read from restrictions", () => {
    const extended: QuerySchema = {
      ...schema,
      links: [
        ...schema.links,
        {
          source: `${NS}Party`,
          target: `${NS}Contract`,
          predicate: `${NS}signs`,
          label: "signs",
          prefixed: ":signs",
          declared: false,
          restriction: true,
          count: 0,
        },
      ],
    };
    const options = linkOptionsBetween(extended, `${NS}Bank`, `${NS}Loan`, ancestorsOf);
    expect(options.map((o) => o.predicate)).toEqual([`${NS}isPartyTo`, `${NS}signs`]);
    expect(options[1].restriction).toBe(true);
  });

  it("ranks direct links above inherited ones", () => {
    const extended: QuerySchema = {
      ...schema,
      links: [
        ...schema.links,
        {
          source: `${NS}Bank`,
          target: `${NS}Loan`,
          predicate: `${NS}originates`,
          label: "originates",
          prefixed: ":originates",
          declared: true,
          count: 4,
        },
      ],
    };
    const options = linkOptionsBetween(extended, `${NS}Bank`, `${NS}Loan`, ancestorsOf);
    expect(options[0].predicate).toBe(`${NS}originates`);
    expect(options[1].predicate).toBe(`${NS}isPartyTo`);
  });
});
