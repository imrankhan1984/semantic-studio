/*
================================================================================
FILE: frontend/src/explain/explainSentences.test.ts
================================================================================

SUMMARY
    The In plain words block's wording (explain-panel 5.2, AC-2): each
    kind's first sentence, each fact with and without its parts, the
    article from modeling/sentences.ts, a property's label never read as a
    verb, the authors' description quoted, and *more than 10,000*.

BASIC IDEA
    Pure strings from the structure the server sends. The examples are
    Space Exploration's, as the spec writes them; a sentence is compared as
    text, and its names are checked to be parts of their own, which is what
    lets the panel draw each one as a link.

INPUTS / INPUT SOURCES
    - explain/explainSentences.ts.

EXPECTED OUTPUT
    - Pass/fail per case.
================================================================================
*/

import { describe, expect, it } from "vitest";
import type { Explain, ExplainRef } from "../types";
import {
  descriptionSentence,
  explainSentences,
  factSentences,
  kindSentence,
  sentenceText,
} from "./explainSentences";

const ref = (label: string): ExplainRef => ({ iri: `http://example.org/space#${label.replace(/ /g, "")}`, label });
const none = { count: 0, capped: false, names: [] };
const texts = (label: string, explain: Explain) => factSentences(label, explain).map(sentenceText);

describe("the kind's sentence", () => {
  it.each([
    ["class", "Crewed mission", "Crewed mission is a class: a category of things."],
    [
      "objectProperty",
      "crew member",
      "crew member is an object property, also called a relationship: it links one thing to another.",
    ],
    [
      "datatypeProperty",
      "launch date",
      "launch date is a datatype property, also called an attribute: it gives a thing a value, such as a number, a date or a piece of text.",
    ],
    [
      "annotationProperty",
      "named after",
      "named after is an annotation property: it adds a note for people, such as a label or a comment, and does not change what the ontology means.",
    ],
    ["property", "near", "near is a property: it links a thing to another thing or to a value."],
    ["individual", "Apollo 11", "Apollo 11 is an individual: one particular thing, not a category."],
    ["concept", "Crewed spaceflight", "Crewed spaceflight is a concept: one term in a vocabulary."],
    [
      "conceptScheme",
      "Mission types",
      "Mission types is a concept scheme: a vocabulary that holds concepts, arranged from broad to narrow.",
    ],
    ["collection", "Surface missions", "Surface missions is a collection: a named group of concepts."],
    [
      "ontology",
      "Space Exploration",
      "Space Exploration is the ontology itself: the record that names this vocabulary and who made it.",
    ],
    ["other", "CC BY 4.0", "CC BY 4.0 is named in this file, but the file does not say what kind of thing it is."],
  ])("%s", (kind, label, sentence) => {
    expect(sentenceText(kindSentence(label, kind))).toBe(sentence);
  });

  it("an unknown kind, or one named like Object.prototype's, is other (X-6)", () => {
    expect(sentenceText(kindSentence("X", "constructor"))).toContain("does not say what kind");
    expect(sentenceText(kindSentence("X", "somethingNew"))).toContain("does not say what kind");
  });
});

describe("a class's facts", () => {
  it("its more general classes, through parentSentence", () => {
    expect(texts("Crewed mission", { kind: "class", description: null, parents: [ref("Mission")] })).toEqual([
      "Crewed mission is a more specific kind of Mission.",
    ]);
    expect(
      texts("Rover", { kind: "class", description: null, parents: [ref("Robotic mission"), ref("Lander")] }),
    ).toEqual(["Rover is a more specific kind of Robotic mission and Lander."]);
  });

  it("its more specific classes, named when they are few", () => {
    const children = { count: 2, capped: false, names: [ref("Crewed mission"), ref("Robotic mission")] };
    expect(texts("Mission", { kind: "class", description: null, parents: [], children, members: none })).toEqual([
      "It has 2 more specific classes, Crewed mission and Robotic mission.",
    ]);
    const one = { count: 1, capped: false, names: [ref("Star")] };
    expect(texts("Body", { kind: "class", description: null, children: one })).toEqual([
      "It has 1 more specific class, Star.",
    ]);
  });

  it("three names among more, and none past what the server sorts", () => {
    const some = { count: 7, capped: false, names: [ref("A"), ref("B"), ref("C")] };
    expect(texts("X", { kind: "class", description: null, children: some })).toEqual([
      "It has 7 more specific classes, among them A, B and C.",
    ]);
    expect(texts("X", { kind: "class", description: null, children: { count: 120, capped: false, names: [] } })).toEqual([
      "It has 120 more specific classes.",
    ]);
  });

  it("its own individuals, and that its subclasses' are not counted", () => {
    const members = { count: 1, capped: false, names: [ref("Apollo 11")] };
    expect(texts("Crewed mission", { kind: "class", description: null, children: none, members })).toEqual([
      "It has 1 individual of its own, Apollo 11.",
    ]);
    const children = { count: 2, capped: false, names: [ref("Crewed mission"), ref("Robotic mission")] };
    const own = { count: 1, capped: false, names: [ref("Vostok 1")] };
    expect(texts("Mission", { kind: "class", description: null, children, members: own })[1]).toBe(
      "It has 1 individual of its own, Vostok 1, not counting those of its more specific classes.",
    );
  });

  it("more than 10,000, with no names", () => {
    const members = { count: 10_000, capped: true, names: [] };
    expect(texts("Thing", { kind: "class", description: null, members })).toEqual([
      "It has more than 10,000 individuals of its own.",
    ]);
    expect(texts("Thing", { kind: "class", description: null, members: { count: 2500, capped: false } })).toEqual([
      "It has 2,500 individuals of its own.",
    ]);
  });

  it("says nothing for what is not there", () => {
    expect(texts("Lonely", { kind: "class", description: null, parents: [], children: none, members: none })).toEqual([]);
  });
});

describe("a property's facts", () => {
  it("links a domain to a range, the label never read as a verb", () => {
    const crew = { kind: "objectProperty", description: null, domains: [ref("Crewed mission")], ranges: [ref("Astronaut")], inverse: null };
    expect(texts("crew member", crew)).toEqual(["crew member links a Crewed mission to an Astronaut."]);
    // relationshipSentence would write "A Crewed mission crew member an
    // Astronaut."; nothing here conjugates or follows the label.
    expect(texts("crew member", crew)[0]).not.toContain("Crewed mission crew member");
  });

  it("a thing for a missing end", () => {
    expect(
      texts("orbits", { kind: "objectProperty", description: null, domains: [], ranges: [ref("Celestial body")], inverse: null }),
    ).toEqual(["orbits links a thing to a Celestial body."]);
    expect(texts("near", { kind: "property", description: null, domains: [], ranges: [], inverse: null })).toEqual([
      "near links a thing to a thing.",
    ]);
  });

  it("an end given only as a blank node is not a thing", () => {
    expect(
      texts("has part", { kind: "objectProperty", description: null, domains: [], unnamedDomain: true, ranges: [ref("Part")] }),
    ).toEqual(["has part links something the statements below describe to a Part."]);
    expect(texts("size", { kind: "datatypeProperty", description: null, domains: [], unnamedDomain: true, datatype: null })).toEqual([
      "size gives something the statements below describe a value.",
    ]);
  });

  it("several ends are all of them at once", () => {
    expect(
      texts("p", { kind: "objectProperty", description: null, domains: [ref("Person"), ref("Agent")], ranges: [ref("Item")] }),
    ).toEqual(["p links a thing that is a Person and an Agent to an Item."]);
  });

  it("its other way round", () => {
    const orbits = { kind: "objectProperty", description: null, domains: [], ranges: [], inverse: ref("is orbited by") };
    expect(texts("orbits", orbits)[1]).toBe('Its other way round is "is orbited by".');
  });

  it("an attribute's value in the Edit page's words, or its datatype as written", () => {
    const launch = { kind: "datatypeProperty", description: null, domains: [ref("Mission")], datatype: "xsd:date" };
    expect(texts("launch date", launch)).toEqual(["launch date gives a Mission a value: a date."]);
    expect(texts("acronym", { kind: "datatypeProperty", description: null, domains: [], datatype: "xsd:string" })).toEqual([
      "acronym gives a thing a value: text.",
    ]);
    expect(
      texts("year", { kind: "datatypeProperty", description: null, domains: [ref("Organization")], datatype: "xsd:gYear" }),
    ).toEqual(["year gives an Organization a value: xsd:gYear."]);
    expect(texts("note", { kind: "datatypeProperty", description: null, domains: [], datatype: null })).toEqual([
      "note gives a thing a value.",
    ]);
  });
});

describe("the other kinds' facts", () => {
  it("an individual is each of its classes, an before a vowel", () => {
    expect(texts("Apollo 11", { kind: "individual", description: null, types: [ref("Crewed mission")] })).toEqual([
      "Apollo 11 is a Crewed mission.",
    ]);
    expect(texts("NASA", { kind: "individual", description: null, types: [ref("Organization"), ref("Space agency")] })).toEqual([
      "NASA is an Organization and a Space agency.",
    ]);
    expect(texts("X", { kind: "individual", description: null, types: [] })).toEqual([]);
  });

  it("a concept's broader, its scheme and its narrower count", () => {
    const crewed = {
      kind: "concept",
      description: null,
      broader: [ref("Space mission")],
      schemes: [ref("Mission types")],
      narrower: { count: 2, capped: false },
    };
    expect(texts("Crewed spaceflight", crewed)).toEqual([
      "Crewed spaceflight is narrower than Space mission.",
      "It belongs to Mission types.",
      "It has 2 narrower concepts.",
    ]);
    expect(texts("Leaf", { kind: "concept", description: null, broader: [], schemes: [], narrower: { count: 1, capped: false } })).toEqual([
      "It has 1 narrower concept.",
    ]);
  });

  it("a scheme's top concepts and a collection's members", () => {
    expect(texts("Mission types", { kind: "conceptScheme", description: null, topConcepts: { count: 1, capped: false } })).toEqual([
      "It has 1 top concept.",
    ]);
    const members = { count: 3, capped: false, names: [ref("Crewed lunar landing"), ref("Lander mission"), ref("Rover mission")] };
    expect(texts("Surface missions", { kind: "collection", description: null, members })).toEqual([
      "It has 3 members, Crewed lunar landing, Lander mission and Rover mission.",
    ]);
  });

  it("the ontology, an annotation property and an other state no facts", () => {
    for (const kind of ["ontology", "annotationProperty", "other"]) {
      expect(texts("X", { kind, description: null })).toEqual([]);
    }
  });
});

describe("names and the description", () => {
  it("every name is a part of its own, so the panel can link it", () => {
    const mission = ref("Mission");
    const [sentence] = factSentences("Crewed mission", { kind: "class", description: null, parents: [mission] });
    expect(sentence).toContain(mission);
    const astronaut = ref("Astronaut");
    const [links] = factSentences("crew member", {
      kind: "objectProperty",
      description: null,
      domains: [ref("Crewed mission")],
      ranges: [astronaut],
    });
    expect(links).toContain(astronaut);
    // The article is text, written by `a`, beside the name.
    expect(links[links.indexOf(astronaut) - 1]).toBe("an ");
  });

  it("the authors' description, quoted", () => {
    const explain = { kind: "class", description: { text: "A mission that carries people into space.", lang: "en" } };
    expect(sentenceText(descriptionSentence(explain)!)).toBe(
      'Its authors describe it: "A mission that carries people into space."',
    );
    expect(sentenceText(descriptionSentence({ kind: "class", description: { text: "No stop", lang: null } })!)).toBe(
      'Its authors describe it: "No stop".',
    );
    expect(descriptionSentence({ kind: "class", description: null })).toBeNull();
  });

  it("marks a description in another language than the one shown", () => {
    const german = { kind: "class", description: { text: "Ein Ding.", lang: "de" } };
    expect(sentenceText(descriptionSentence(german)!)).toBe('Its authors describe it (de): "Ein Ding."');
    const english = { kind: "class", description: { text: "A thing.", lang: "en-GB" } };
    expect(sentenceText(descriptionSentence(english)!)).toBe('Its authors describe it: "A thing."');
    // A project shown in French: its English comment says so.
    expect(sentenceText(descriptionSentence({ kind: "class", description: { text: "A thing.", lang: "en" } }, "fr")!)).toBe(
      'Its authors describe it (en): "A thing."',
    );
    expect(sentenceText(descriptionSentence({ kind: "class", description: { text: "Une chose.", lang: "fr" } }, "fr")!)).toBe(
      'Its authors describe it: "Une chose."',
    );
  });

  it("the block's order: kind, facts, description", () => {
    const sentences = explainSentences("Crewed mission", {
      kind: "class",
      description: { text: "A mission that carries people into space.", lang: "en" },
      parents: [ref("Mission")],
      children: none,
      members: { count: 1, capped: false, names: [ref("Apollo 11")] },
    }).map(sentenceText);
    expect(sentences).toEqual([
      "Crewed mission is a class: a category of things.",
      "Crewed mission is a more specific kind of Mission.",
      "It has 1 individual of its own, Apollo 11.",
      'Its authors describe it: "A mission that carries people into space."',
    ]);
  });
});
