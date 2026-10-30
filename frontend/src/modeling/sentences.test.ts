/*
================================================================================
FILE: frontend/src/modeling/sentences.test.ts
================================================================================

SUMMARY
    The sentences a relationship is read as (relationships 5.2, 5.3, 5.5):
    the sentence while naming, the link sentences, the announcement, and a
    tree row's ends. And the two shared rules (X-12, T-18 to T-20): a or an,
    and a label read as a verb, against sentences.table.json -- the table
    backend/tests/test_sentences.py reads too -- with a scan that fails if
    any other module defines its own; and an attribute's type after *as*.
    attribute-reuse 5.6 to 5.8: the Kind of class words, a change of kind,
    and the line in place of a rule on an RDFS class.

BASIC IDEA
    Pure strings, so every case is one line. The scan reads every
    production source as text, asserting first that they loaded: a scan
    over nothing finds nothing and passes.

INPUTS / INPUT SOURCES
    - modeling/sentences.ts.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import TABLE from "./sentences.table.json";
import * as S from "./sentences";
import {
  article,
  createdAnnouncement,
  existingSentence,
  linkSentence,
  relationshipSentence,
  asType,
  rowEnds,
  typeWord,
} from "./sentences";

describe("sentences", () => {
  it.each(TABLE.article)("chooses the article of %j by its sound: %s (T-18)", (word, expected) => {
    expect(article(word)).toBe(expected);
    expect(S.a(word)).toBe(`${expected} ${word}`);
  });

  it.each(TABLE.verb)("reads %j as a verb: %j after a subject, %j after must (T-19)", (label, after, must) => {
    expect(S.verb(label)).toBe(after);
    expect(S.mustVerb(label)).toBe(must);
  });

  it("reads an attribute's type after as with its article, text and yes or no without (T-20)", () => {
    expect(S.attributeSentence("Person", "birth date", "xsd:date")).toBe("A Person has a birth date, as a date.");
    expect(S.attributeSentence("Person", "name", "xsd:string")).toBe("A Person has a name, as text.");
    expect(S.attributeSentence("Person", "age", "xsd:integer")).toBe("A Person has an age, as a whole number.");
    expect(S.attributeSentence("Person", "active", "xsd:boolean")).toBe("A Person has an active, as yes or no.");
    expect(S.attributeSentence("Person", "home page", "xsd:anyURI")).toBe("A Person has a home page, as a web address.");
    // A type without a word is its name, with no article guessed.
    expect(S.attributeSentence("Person", "year", "xsd:gYear")).toBe("A Person has a year, as a year.");
    expect(S.attributeSentence("Person", "code", "xsd:hexBinary")).toBe("A Person has a code, as xsd:hexBinary.");
  });

  it("reads a relationship as it is named, with the gap before the first key", () => {
    expect(relationshipSentence("Person", "works for", "Organization")).toBe("A Person works for an Organization.");
    expect(relationshipSentence("Employee", "reports to", "Employee")).toBe("An Employee reports to an Employee.");
    expect(relationshipSentence("Person", "  ", "Organization")).toBe("A Person … an Organization.");
  });

  it("reads a noun-named relationship after has, in the relate menu and as an existing one (wording 5.2, AC-3)", () => {
    expect(relationshipSentence("Crewed mission", "crew member", "Astronaut")).toBe(
      "A Crewed mission has crew member an Astronaut.",
    );
    expect(relationshipSentence("Mission", "has destination", "Place")).toBe("A Mission has destination a Place.");
    expect(relationshipSentence("Unit", "part of", "Organization")).toBe("A Unit is part of an Organization.");
    expect(existingSentence("Crewed mission", "crew member", "Astronaut")).toBe(
      "Crewed mission has crew member Astronaut (existing relationship)",
    );
    expect(existingSentence("Mission", "has destination", "Place")).toBe(
      "Mission has destination Place (existing relationship)",
    );
  });

  it("reads each line the way it points", () => {
    expect(linkSentence("subClassOf", "Employee", "Person")).toBe("Employee is a kind of Person");
    expect(linkSentence("broader", "Apple", "Fruit")).toBe("Apple is narrower than Fruit");
    expect(existingSentence("Person", "works for", "Organization")).toBe(
      "Person works for Organization (existing relationship)",
    );
    expect(createdAnnouncement("works for", "Person", "Organization")).toBe(
      "Created relationship works for, from Person to Organization.",
    );
  });

  it("reads a tree row's ends, a missing one included", () => {
    expect(rowEnds({ domain: "Person", range: "Organization" }, false)).toBe("Person → Organization");
    expect(rowEnds({ domain: null, range: null }, false)).toBe("no start yet → no end yet");
    expect(rowEnds({ domain: "Person", range: "xsd:string" }, true)).toBe("Person, text");
    expect(rowEnds({ domain: "Invoice", range: "xsd:decimal" }, true)).toBe("Invoice, decimal number");
    expect(rowEnds({ domain: null, range: null }, true)).toBe("no start yet, no type yet");
  });

  it("names the seven types in words and leaves any other as written", () => {
    expect(
      ["xsd:string", "xsd:integer", "xsd:decimal", "xsd:boolean", "xsd:date", "xsd:dateTime", "xsd:anyURI"].map(typeWord),
    ).toEqual(["text", "whole number", "decimal number", "yes or no", "date", "date and time", "web address"]);
    expect(typeWord("xsd:hexBinary")).toBe("xsd:hexBinary");
  });

  it("names the common other types in words, by own key only (wording 5.4, AC-5)", () => {
    expect(
      [
        "xsd:gYear", "xsd:gYearMonth", "xsd:time", "xsd:float", "xsd:double",
        "xsd:nonNegativeInteger", "xsd:positiveInteger",
      ].map(typeWord),
    ).toEqual([
      "year", "year and month", "time of day", "decimal number", "decimal number",
      "whole number, zero or more", "whole number above zero",
    ]);
    expect(rowEnds({ domain: "Planet", range: "xsd:gYear" }, true)).toBe("Planet, year");
    // A datatype named for a prototype member is its own name, not a function.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(typeWord(name)).toBe(name);
      expect(asType(name)).toBe(name);
    }
    expect(asType("xsd:gYear")).toBe("a year");
  });
});

describe("Stage B sentences (relationships 5.6 to 5.8)", () => {
  it("reads the relationship back, with the missing end said", () => {
    expect(S.formSentence("Person", "works for", "Organization")).toBe("A Person works for an Organization.");
    expect(S.formSentence(null, "works for", "Organization")).toBe("(no start yet) works for an Organization.");
    expect(S.formSentence("Person", "works for", null)).toBe("A Person works for (no end yet).");
  });

  it("reads the other way round with the ends swapped", () => {
    expect(S.inverseSentence("employs", "Person", "Organization")).toBe("An Organization employs a Person.");
  });

  it("writes every characteristic's example from the relationship's own names, as 5.6 shows them", () => {
    const example = (id: S.Characteristic) => S.characteristicExample(id, "works for", "Person", "Organization");
    expect(S.CHARACTERISTICS.map((c) => [c.name, example(c.id)])).toEqual([
      ["At most one", "A Person works for at most one Organization."],
      ["Identifies its start", "An Organization is linked by works for to at most one Person."],
      ["Works both ways", "If A works for B, then B works for A."],
      ["Chains", "If A works for B and B works for C, then A works for C."],
      ["Never both ways", "If A works for B, then B never works for A."],
      ["Never to itself", "Nothing works for itself."],
      ["Always to itself", "Everything works for itself."],
    ]);
    // Four always shown, three under More.
    expect(S.CHARACTERISTICS.filter((c) => c.more).map((c) => c.id)).toEqual(["asymmetric", "irreflexive", "reflexive"]);
  });

  it("gives an example even before the ends are set", () => {
    expect(S.characteristicExample("functional", "owns", null, null)).toBe("Something owns at most one thing.");
    expect(S.characteristicExample("inverseFunctional", "owns", null, null)).toBe(
      "Something is linked by owns to at most one thing.",
    );
  });

  it("names the more general relationship and why there is one start and one end", () => {
    expect(S.parentSentence("works for", "member of")).toBe("works for is a more specific kind of member of");
    expect(S.oneStartOneEnd("works for", "Person")).toContain('To use "works for" from another class too, make Person and that class');
  });

  it("reads an attribute and one value only", () => {
    expect(S.attributeSentence("Person", "name", "xsd:string")).toBe("A Person has a name, as text.");
    expect(S.attributeSentence(null, "age", null)).toBe("Something has an age.");
    expect(S.oneValueExample("Person", "name")).toBe("A Person has at most one name.");
  });

  it("reads related lines, top concepts and the five mappings", () => {
    expect(S.linkSentence("related", "Apple", "Orchard")).toBe("Apple is related to Orchard");
    expect(S.topConceptSentence("Fruits")).toBe("Top concept of Fruits");
    expect(S.MAPPINGS.map((m) => m.id)).toEqual(["exactMatch", "closeMatch", "broadMatch", "narrowMatch", "relatedMatch"]);
    expect(S.MAPPINGS.every((m) => m.means.endsWith("."))).toBe(true);
  });

  it("keeps relationships and attributes read-only in a taxonomy, and only there (5.10 item 2)", () => {
    expect(S.otherKindReason("taxonomy", "objectProperty")).toMatch(/^A relationship, read-only in a taxonomy/);
    expect(S.otherKindReason("taxonomy", "datatypeProperty")).toMatch(/^An attribute, read-only in a taxonomy/);
    expect(S.otherKindReason("ontology", "objectProperty")).toBeNull();
    expect(S.otherKindReason(null, "objectProperty")).toBeNull();
  });
});

describe("one a/an rule and one verb rule (X-12)", () => {
  // From the root, so every key reads /src/...: relative to this folder,
  // its own files would be ./sentences.ts.
  const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const PRODUCTION = Object.entries(SOURCES).filter(
    ([path]) => !/\.test\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path),
  );
  // What a module of its own would write: an article or verb function, the
  // first-letter ternary, or the verb rule's word lists.
  const OWN = [
    /\bfunction\s+(article|a|an|withArticle|verb|mustVerb|mustPhrase)\s*\(/,
    /\b(const|let)\s+(article|a|an|withArticle|verb|mustVerb|mustPhrase)\s*=\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /\?\s*["']an["']\s*:/,
    /["']an["']\s*:\s*["']a["']/,
    /["']a["']\s*:\s*["']an["']/,
    /\b(AUXILIARIES|PREPOSITIONS)\b/,
  ];

  it("no module but sentences.ts defines its own", () => {
    const own = PRODUCTION.find(([path]) => path === "/src/modeling/sentences.ts");
    // The scan read the sources, the rule's own module among them.
    expect(PRODUCTION.length).toBeGreaterThan(50);
    expect(own?.[1]).toContain("export function article(");
    expect(own?.[1]).toContain("export function mustVerb(");
    const offenders = PRODUCTION.filter(([path]) => path !== own?.[0]).flatMap(([path, text]) =>
      OWN.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("reuse (attribute-reuse 5.1, 5.2, 5.4)", () => {
  it("words a suggestion with the domain as read, and its type or end", () => {
    expect(S.suggestionLine("attribute", "hasName", "Employee", "xsd:string")).toBe("hasName, an attribute of Employee (text).");
    expect(S.suggestionLine("attribute", "hasName", "Employee or Contractor", null)).toBe("hasName, an attribute of Employee or Contractor.");
    expect(S.suggestionLine("attribute", "hasName", null, null)).toBe("hasName, an attribute of no class yet.");
    expect(S.suggestionLine("relationship", "reportsTo", "Employee", "Manager")).toBe("reportsTo, from Employee to Manager.");
    expect(S.useOn("Manager")).toBe("Use it on Manager");
    expect(S.matchesSaid(1, "attribute")).toBe("1 existing attribute matches");
    expect(S.matchesSaid(3, "relationship")).toBe("3 existing relationships match");
  });

  it("words each case of the plan with the a/an rule", () => {
    expect(S.planNoClass("hasName", "Manager")).toBe("hasName belongs to no class yet. Make it Manager's?");
    expect(S.planAlready("hasName", "Manager", "Employee")).toBe("Manager already has hasName, because a Manager is an Employee.");
    expect(S.planAlready("hasName", "Employee", "Employee")).toBe("Employee already has hasName.");
    expect(S.planMoveUp("hasName", "Employee", ["Manager"])).toBe(
      "hasName moves up to Employee. Every Manager keeps it, because a Manager is an Employee.",
    );
    expect(S.planSubclass("hasName", "Contractor", "Employee")).toBe(
      "Is every Contractor an Employee? Then make Contractor a kind of Employee, and it gets hasName through Employee.",
    );
    expect(S.makeKindOf("Contractor", "Employee")).toBe("Make Contractor a kind of Employee");
  });

  it("says what a union means, an attribute's and a relationship's, the label read as a verb", () => {
    expect(S.planUnion("attribute", "hasName", ["Employee", "Contractor"])).toBe(
      "Share hasName between Employee and Contractor. It means: whatever has a value for hasName is an Employee or a Contractor.",
    );
    expect(S.planUnion("relationship", "part of", ["Engine", "Wheel", "Unit"])).toBe(
      "Share part of between Engine, Wheel and Unit. It means: whatever is part of something is an Engine, a Wheel or a Unit.",
    );
  });

  it("words the shared parent, the import's refusal and moving up", () => {
    expect(S.planRdfsParent("hasName", ["Employee", "Contractor"])).toBe(
      'RDFS has no way to say "either". Give Employee and Contractor a shared parent, and hasName belongs to it:',
    );
    expect(S.parentQuestion(["Employee", "Contractor"])).toBe("What is every Employee and Contractor? For example, Worker");
    expect(S.giveParent(["Employee", "Contractor"])).toBe("Give Employee and Contractor this parent");
    expect(S.importedParentNote("Contractor", "HR-Core")).toBe("Contractor comes from HR-Core, so it cannot be given a new parent here.");
    expect(S.importedParentNote("Contractor", null)).toBe("Contractor comes from an imported ontology, so it cannot be given a new parent here.");
    expect(S.moveUpTo("hasName", "Worker")).toBe("Move hasName up to Worker");
    expect(S.gainsSentence("hasName", "Worker", ["Intern"], 1)).toBe("Every Intern gets hasName too, because an Intern is a Worker.");
    expect(S.gainsSentence("hasName", "Agent", ["Intern", "Robot"], 4)).toBe(
      "Intern, Robot and 2 more get hasName too, because each is an Agent.",
    );
    expect(S.gainsSentence("hasName", "Worker", [], 0)).toBe("Nothing else gets hasName: only these classes are kinds of Worker.");
  });

  it("announces what changed, and words the canvas's entry and question", () => {
    expect(S.sharedAnnouncement("hasName", ["Employee", "Contractor"])).toBe("hasName is now shared by Employee and Contractor.");
    expect(S.removedAnnouncement("hasName", "Contractor")).toBe("Contractor no longer has hasName.");
    expect(S.shareEntry("reportsTo", "Contractor", "Manager")).toBe("Share reportsTo: a Contractor reportsTo a Manager too.");
    expect(S.shareEntry("part of", "Engine", "Unit")).toBe("Share part of: an Engine is part of a Unit too.");
    expect(S.memberDeleteQuestion("Contractor", "reportsTo")).toBe("Remove Contractor from reportsTo, or delete reportsTo?");
    expect(S.domainListNote("union")).toBe("Any one of these classes:");
    expect(S.domainListNote("separate")).toBe("All of these classes at once (see the warning):");
  });
});

describe("a domain in words (attribute-reuse 5.3)", () => {
  it("is one rule for a union and for two domain lines", () => {
    expect(S.domainWords("union", ["Employee", "Contractor"])).toBe("Employee or Contractor");
    expect(S.domainWords("union", ["Employee", "Intern", "Manager"])).toBe("Employee, Intern or Manager");
    expect(S.domainWords("separate", ["Employee", "Manager"])).toBe("Employee and Manager");
  });
});

describe("OWL or RDFS for each class (attribute-reuse 5.6 to 5.8)", () => {
  it("words the Kind of class group and its hint", () => {
    expect(S.CLASS_KIND_LEGEND).toBe("Kind of class");
    expect(S.CLASS_KINDS).toEqual([
      { id: "owl", name: "OWL class", means: "Can take rules, and works with the reasoner." },
      { id: "rdfs", name: "RDFS class", means: "The simpler standard. No rules." },
    ]);
    expect(S.classKindHint("rdfs")).toBe("RDFS class, as last time.");
    expect(S.classKindHint("owl")).toBe("OWL class, as last time.");
    expect(S.classKindHint(null)).toBeNull();
  });

  it("words a change of kind through the one a/an rule", () => {
    expect(S.makeItKind("rdfs")).toBe("Make it an RDFS class");
    expect(S.makeItKind("owl")).toBe("Make it an OWL class");
    expect(S.makeClassKind("Manager", "owl")).toBe("Make Manager an OWL class");
    expect(S.becomesRdfs("Manager", 2)).toBe(
      "Manager becomes an RDFS class. These go with it, because RDFS has no words for them:",
    );
    expect(S.becomesRdfs("Manager", 1)).toBe("Manager becomes an RDFS class. This goes with it, because RDFS has no words for it:");
    expect(S.becomesRdfs("Manager", 0)).toBe("Manager becomes an RDFS class. Nothing else changes: it has no rules.");
    expect(S.kindChangedAnnouncement("Invoice", "rdfs")).toBe("Invoice is now an RDFS class.");
  });

  it("words 5.8's line, its note and the relate menu's entry", () => {
    expect(S.RULES_NEED_OWL).toBe("Rules need an OWL class; RDFS has no words for them.");
    expect(S.rdfsRuleNote("Manager", 1)).toBe(
      "This rule is about an RDFS class. OWL tools such as Protégé will not read Manager as a class until it is an OWL class.",
    );
    expect(S.rdfsRuleNote("Manager", 2)).toMatch(/^These rules are about an RDFS class\./);
    expect(S.checkInDataNote("Manager", true)).toBe("To check your data instead, use Check it in data too.");
    expect(S.checkInDataNote("Manager", false)).toBe("To check your data instead, give Manager a shape in Shapes (SHACL).");
    expect(S.makeOwlEntry("Contractor")).toBe(
      "Rules need an OWL class; RDFS has no words for them. Make Contractor an OWL class",
    );
    expect(S.wizardKindNote("owl")).toBe("It is made as an OWL class, the project's default.");
    expect(S.wizardKindLine("Ticket", "rdfs")).toBe("Ticket is a new RDFS class, the project's default kind of class.");
  });
});
