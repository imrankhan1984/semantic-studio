/*
================================================================================
FILE: frontend/src/naming/address.test.ts
================================================================================

SUMMARY
    The address rule's page side (design-checks 5.1, AC-15, AC-17), against
    the table backend/tests/test_naming.py reads too: every example built
    from its parts, the namespace's accepted and refused values, the
    identifier slug, and a name's refusals.

BASIC IDEA
    One table for both sides, so the two rules cannot drift. Reading an
    address back is the server's alone and is tested there.

INPUTS / INPUT SOURCES
    - naming/address.ts; address.table.json.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import table from "./address.table.json";
import {
  NAMESPACE_REFUSED,
  NAMESPACE_VERSION,
  SEGMENT_REFUSED,
  SEGMENT_VERSION,
  artifactIri,
  dataIri,
  namespaceError,
  projectAddresses,
  segmentError,
  slug,
  termIri,
  type ArtifactType,
  type Layer,
} from "./address";

const NS = table.namespace;

describe("the address rule (5.1)", () => {
  it("loaded the table", () => {
    expect(table.built).toHaveLength(11);
  });

  for (const row of table.built) {
    it(`builds ${row.what} from its parts`, () => {
      const p = row.parts as unknown as Record<string, string>;
      const built =
        row.role === "artifact"
          ? artifactIri(NS, p.layer as Layer, p.area, p.subject, p.type as ArtifactType)
          : row.role === "term"
            ? termIri(p.artifact, p.name)
            : dataIri(NS, p.dataDomain, p.class, p.id);
      expect(built).toBe(row.address);
    });
  }

  for (const value of table.namespaces.accepted) {
    it(`accepts the namespace ${value}`, () => {
      expect(namespaceError(value)).toBeNull();
    });
  }

  for (const [value, why] of table.namespaces.refused) {
    it(`refuses the namespace "${value}"`, () => {
      expect(namespaceError(value)).toBe(why === "version" ? NAMESPACE_VERSION : NAMESPACE_REFUSED);
    });
  }

  for (const [text, expected] of table.slugs) {
    it(`slugs "${text}"`, () => {
      expect(slug(text)).toBe(expected);
    });
  }

  it("refuses a name that is not one lowercase segment, or is a version", () => {
    for (const value of ["Finance", "fin_ance", "", "-x", "a b", "finance\n"]) {
      expect(segmentError(value)).toBe(SEGMENT_REFUSED);
    }
    expect(segmentError("v2")).toBe(SEGMENT_VERSION);
    expect(segmentError("2026")).toBe(SEGMENT_VERSION);
    expect(segmentError("payment-terms")).toBeNull();
  });

  it("gives New project's three lines (AC-15)", () => {
    const lines = projectAddresses(NS, {
      layer: "domain",
      area: "finance",
      subject: "invoice",
      type: "ontology",
      dataDomain: "finance",
    });
    expect(lines).toEqual({
      model: "https://w3id.org/acme/domain/finance/invoice-ontology#",
      shapes: "https://w3id.org/acme/domain/finance/invoice-shapes#",
      data: "https://w3id.org/acme/data/finance/{class}/{id}",
    });
    expect(projectAddresses(NS, { layer: "core", area: "", subject: "invoice", type: "ontology", dataDomain: "x" }).model).toBe(
      "https://w3id.org/acme/core/invoice-ontology#",
    );
  });
});
