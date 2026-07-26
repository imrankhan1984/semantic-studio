import { describe, expect, it } from "vitest";
import { describeQuery } from "./describe";
import { emptyQueryState } from "./types";
import type { QueryState, QueryStep } from "./types";

const NS = "http://example.org/space#";
const labels: Record<string, string> = {
  [`${NS}uses`]: "uses",
  [`${NS}operatedBy`]: "operated by",
  [`${NS}broader`]: "broader",
};
const labelFor = (iri: string) => labels[iri] ?? iri;

function step(name: string, extra: Partial<QueryStep> = {}): QueryStep {
  return { classIri: NS + name, label: name, props: [], ...extra };
}

function state(steps: QueryStep[], extra: Partial<QueryState> = {}): QueryState {
  return { ...emptyQueryState(), steps, ...extra };
}

describe("describeQuery", () => {
  it("says nothing for an empty query", () => {
    expect(describeQuery(state([]), labelFor)).toBe("");
  });

  it("describes a single class", () => {
    expect(describeQuery(state([step("Planet")]), labelFor)).toBe(
      "Start from every planet. Return at most 100 rows.",
    );
  });

  it("describes a pinned start", () => {
    const sparql = describeQuery(
      state([step("Concept", { pin: { iri: `${NS}Exploration`, label: "Exploration" } })]),
      labelFor,
    );
    expect(sparql).toContain("Start from Exploration (a concept).");
  });

  it("describes hops in order", () => {
    const sentence = describeQuery(
      state([
        step("Mission"),
        step("Spacecraft", {
          link: {
            anchor: 0,
            predicates: [{ iri: `${NS}uses`, inverse: false }],
            modifier: "",
            optional: false,
          },
        }),
      ]),
      labelFor,
    );
    expect(sentence).toContain("follow uses from each mission to its spacecrafts");
  });

  it("marks reversed, repeated and optional hops", () => {
    const sentence = describeQuery(
      state([
        step("Concept"),
        step("Concept", {
          link: {
            anchor: 0,
            predicates: [{ iri: `${NS}broader`, inverse: true }],
            modifier: "+",
            optional: true,
          },
        }),
      ]),
      labelFor,
    );
    expect(sentence).toContain("optionally follow");
    expect(sentence).toContain("broader (reversed)");
    expect(sentence).toContain("one or more times");
  });

  it("lists shown properties and filter conditions separately", () => {
    const sentence = describeQuery(
      state([
        step("Spacecraft", {
          props: [
            { predicateIri: `${NS}label`, label: "label", optional: true },
            {
              predicateIri: `${NS}launchYear`,
              label: "launch year",
              optional: false,
              filter: { op: ">", value: "1980" },
            },
          ],
        }),
      ]),
      labelFor,
    );
    expect(sentence).toContain("Also show spacecraft’s label.");
    expect(sentence).toContain("Only where the spacecraft’s launch year is greater than “1980”.");
  });

  it("describes counting", () => {
    const single = describeQuery(state([step("Planet")], { aggregate: "count" }), labelFor);
    expect(single).toContain("Report how many planets there are.");
    expect(single).not.toContain("Return at most");

    const grouped = describeQuery(
      state(
        [
          step("SpaceAgency"),
          step("Spacecraft", {
            link: {
              anchor: 0,
              predicates: [{ iri: `${NS}operatedBy`, inverse: true }],
              modifier: "",
              optional: false,
            },
          }),
        ],
        { aggregate: "count" },
      ),
      labelFor,
    );
    expect(grouped).toContain("how many spacecrafts each SpaceAgency has");
  });

  it("pluralises awkward labels sensibly", () => {
    const sentence = describeQuery(
      state([
        step("Class"),
        step("Property", {
          link: {
            anchor: 0,
            predicates: [{ iri: `${NS}uses`, inverse: false }],
            modifier: "",
            optional: false,
          },
        }),
      ]),
      labelFor,
    );
    expect(sentence).toContain("properties");
    expect(describeQuery(state([step("Class")], { aggregate: "count" }), labelFor)).toContain(
      "classes",
    );
  });
});
