/*
================================================================================
FILE: frontend/src/modeling/sentences.ts
================================================================================

SUMMARY
    The sentences a relationship is read as (relationships 5.2, 5.3, 5.5):
    *A Person works for an Organization.* while it is being named, *Person is
    a kind of Organization* in the relate menu, *Employee is a kind of
    Person* in the link panel, the announcement once one is created, a
    tree row's ends, *Person → Organization* or *Person, text*, and the one
    line that says a project holds content of its other kind (5.1).

    Stage B's forms read back the same way (5.6 to 5.8): the relationship's
    sentence with *(no start yet)* or *(no end yet)* where an end is
    missing, its other way round, each characteristic's example written with
    the relationship's own names, its more general relationship, the
    attribute's sentence and *one value only*, a concept's related line, and
    what each kind of mapping means.

    attribute-reuse 5.1, 5.2 and 5.4 read the same way: a suggestion under
    the name (*hasName, an attribute of Employee (text).*), each case of the
    reuse plan in the person's names, what a union means (*whatever has
    hasName is an Employee or a Contractor*), the shared parent's question,
    who else gains a property moved up, the canvas's *Share* entry and its
    two-way Delete question, and what the live region says after.

    And the two grammar rules every sentence shares (X-12, T-18, T-19): *a*
    or *an* before a name, and a relationship's label read as a verb, after
    a subject or after *must*. backend/app/sentences.py holds the same two,
    and both sides are tested with one table (sentences.table.json); no
    other module may define its own (sentences.test.ts scans for one).

BASIC IDEA
    Every relationship reads as a sentence, before and after it is created
    (Section 7), so the sentence is built in one place and tested without
    drawing anything. *an* goes before a vowel sound, judged from the first
    word: a vowel letter, except words starting *uni*, *use*, *usu*, *eu*,
    *one* or *once*; words starting *hour*, *honest*, *honor* or *heir*; and
    a word in capitals, read letter by letter, whose first letter's name
    starts with a vowel sound (*an XML file*, *a URL*). Four copies chose by
    the first letter alone and wrote *an University*.

    A label is a verb when its first word is one (*is*, *has*, *can*) or ends
    in a single *s* (*uses*); one ending in a preposition or starting with a
    participle reads after *is* or *be* (*part of*, *located in*); a bare
    noun (*holder*) is left as written. No article is guessed before a label:
    *Ann is member of Team A* stays. A name is used exactly as written;
    nothing here reads ontology text as markup or as a pattern.

INPUTS / INPUT SOURCES
    - Names: a class's, a concept's, a relationship's, already chosen in the
      display language by the server; null for an end not set yet.

EXPECTED OUTPUT
    - Strings.
================================================================================
*/

// Letters whose names start with a vowel sound: "an F", "an H", "an X".
const VOWEL_NAMED_LETTERS = "AEFHILMNORSX";
// A vowel letter sounded as a consonant, and a silent h.
const CONSONANT_STARTS = ["uni", "use", "usu", "eu", "one", "once"];
const SILENT_H = ["hour", "honest", "honor", "heir"];

/** *a* or *an* before a name, by how its first word sounds. */
export function article(name: string): string {
  const first = /^[A-Za-z]+/.exec(name.trim())?.[0];
  if (!first) return "a";
  // Capitals to start (XML, URLs, a lone X): read letter by letter.
  const two = first.slice(0, 2);
  if (two === two.toUpperCase()) return VOWEL_NAMED_LETTERS.includes(first[0]) ? "an" : "a";
  const lower = first.toLowerCase();
  if (SILENT_H.some((start) => lower.startsWith(start))) return "an";
  if (CONSONANT_STARTS.some((start) => lower.startsWith(start))) return "a";
  return "aeiou".includes(lower[0]) ? "an" : "a";
}

/** A name with its article: *a Person*, *an Organization*. */
export function a(name: string): string {
  return `${article(name)} ${name}`;
}

// First words that already read as a verb.
const AUXILIARIES = new Set([
  "is", "are", "was", "were", "be", "been", "has", "have", "had", "can", "could",
  "may", "might", "must", "shall", "should", "will", "would", "does", "do", "did",
]);
// Last words that mark a label needing *is*.
const PREPOSITIONS = new Set([
  "of", "to", "in", "at", "by", "for", "with", "from", "on", "into", "onto", "about",
  "above", "below", "under", "over", "inside", "near", "before", "after", "within", "than",
]);

/** A label's words, split as the server splits them: *worksFor* is *works*
 *  and *For*. */
function words(label: string): RegExpMatchArray[] {
  return [...label.matchAll(/[A-Za-z][a-z]*/g)];
}

function thirdPerson(word: string): boolean {
  return word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us");
}

function readsAfterIs(lower: string[]): boolean {
  return PREPOSITIONS.has(lower[lower.length - 1]) || lower[0].endsWith("ed");
}

/** A relationship's label as the verb after a subject: *uses* and *has
 *  part* stay, *part of* and *located in* read after *is*, a bare noun
 *  (*holder*) is left alone. */
export function verb(label: string): string {
  const lower = words(label).map((m) => m[0].toLowerCase());
  if (!lower.length) return label;
  if (AUXILIARIES.has(lower[0]) || thirdPerson(lower[0])) return label;
  return readsAfterIs(lower) ? `is ${label}` : label;
}

/** The same label after *must* or *may*: *uses* -> *use*, *has part* ->
 *  *have part*, *is part of* and *part of* -> *be part of*; a bare noun is
 *  left alone. */
export function mustVerb(label: string): string {
  const found = words(label);
  if (!found.length) return label;
  const lower = found.map((m) => m[0].toLowerCase());
  const head = found[0];
  const start = head.index ?? 0;
  const rest = label.slice(start + head[0].length);
  if (lower[0] === "is" || lower[0] === "are") return `be${rest}`;
  if (lower[0] === "has") return `have${rest}`;
  if (AUXILIARIES.has(lower[0])) return label;
  if (thirdPerson(lower[0])) {
    const written = head[0];
    let base: string;
    if (lower[0].endsWith("ies") && lower[0].length > 4) base = `${written.slice(0, -3)}y`;
    else if (/(ches|shes|sses|xes|zes|oes)$/.test(lower[0])) base = written.slice(0, -2);
    else base = written.slice(0, -1);
    return `${label.slice(0, start)}${base}${rest}`;
  }
  return readsAfterIs(lower) ? `be ${label}` : label;
}

/** A new relationship read as it is named: *A Person works for an
 *  Organization.* With no name yet, the gap is shown, so the sentence has
 *  its shape before the first key. */
export function relationshipSentence(from: string, name: string, to: string): string {
  const said = name.trim() || "…";
  const first = article(from);
  return `${first[0].toUpperCase()}${first.slice(1)} ${from} ${said} ${article(to)} ${to}.`;
}

/** The link a line would make, or has made, as the relate menu and the link
 *  panel read it. */
export function linkSentence(kind: "subClassOf" | "broader" | "related", from: string, to: string): string {
  if (kind === "related") return `${from} is related to ${to}`;
  return kind === "subClassOf" ? `${from} is a kind of ${to}` : `${from} is narrower than ${to}`;
}

/** An existing relationship the line would complete. */
export function existingSentence(from: string, name: string, to: string): string {
  return `${from} ${name} ${to} (existing relationship)`;
}

/** What the live region says once a relationship is made (5.2). */
export function createdAnnouncement(name: string, from: string, to: string): string {
  return `Created relationship ${name}, from ${from} to ${to}.`;
}

/** An attribute's datatype as a word, for *name (Person, text)*: the seven
 *  types of E-6, and the prefixed name for any other. */
const TYPE_WORDS: Record<string, string> = {
  "xsd:string": "text",
  "rdf:langString": "text",
  "xsd:integer": "whole number",
  "xsd:decimal": "decimal number",
  "xsd:boolean": "yes or no",
  "xsd:date": "date",
  "xsd:dateTime": "date and time",
  "xsd:anyURI": "web address",
};

export function typeWord(datatype: string | null): string {
  if (!datatype) return "no type yet";
  return TYPE_WORDS[datatype] ?? datatype;
}

/** A tree row's ends: *Person → Organization* for a relationship, *Person,
 *  text* for an attribute; a missing end says so rather than vanishing. */
export function rowEnds(
  ends: { domain: string | null; range: string | null },
  attribute: boolean,
): string {
  const start = ends.domain ?? "no start yet";
  if (attribute) return `${start}, ${typeWord(ends.range)}`;
  return `${start} → ${ends.range ?? "no end yet"}`;
}

/** The one line shown when a document holds the other kind's content
 *  (5.1): how much, and where it is changed. Null when there is none. */
export function otherKindNote(kind: "ontology" | "taxonomy" | null, count: number): string | null {
  if (!kind || count === 0) return null;
  const them = count === 1 ? "it" : "them";
  return kind === "ontology"
    ? `This ontology also contains ${count} SKOS ${count === 1 ? "concept" : "concepts"}. Edit ${them} in Turtle, or change the project to a taxonomy.`
    : `This taxonomy also contains ${count} ${count === 1 ? "class" : "classes"}. Edit ${them} in Turtle, or change the project to an ontology.`;
}

/** Why one entity of the other kind is not changed in the visual doors. */
export function otherKindReason(kind: "ontology" | "taxonomy" | null, entityKind: string): string | null {
  if (kind === "ontology" && entityKind === "concept") {
    return "A SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.";
  }
  if (kind === "taxonomy" && entityKind === "class") {
    return "A class, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  // Relationships and attributes belong to classes, so a taxonomy shows them
  // as it shows classes (5.10 item 2).
  if (kind === "taxonomy" && entityKind === "objectProperty") {
    return "A relationship, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  if (kind === "taxonomy" && entityKind === "datatypeProperty") {
    return "An attribute, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage B: the relationship and attribute forms (5.6, 5.7), concepts (5.8)
// ---------------------------------------------------------------------------

function capital(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** *a Person*, or what stands in for an end not set yet. */
function end(name: string | null, missing: string): string {
  return name ? a(name) : missing;
}

/** The Sentence block (5.6): what the blocks below say, read back. */
export function formSentence(from: string | null, name: string, to: string | null): string {
  return `${capital(end(from, "(no start yet)"))} ${name.trim() || "…"} ${end(to, "(no end yet)")}.`;
}

/** The other way round read as a sentence: *An Organization employs a
 *  Person.* Its start is this relationship's end. */
export function inverseSentence(inverse: string, from: string | null, to: string | null): string {
  return formSentence(to, inverse, from);
}

export type Characteristic =
  | "functional"
  | "inverseFunctional"
  | "symmetric"
  | "transitive"
  | "asymmetric"
  | "irreflexive"
  | "reflexive";

/** The seven, in the order the form offers them: four always, three under
 *  *More* (5.6). The OWL term is shown small beside each (Section 7). */
export const CHARACTERISTICS: { id: Characteristic; name: string; owl: string; more: boolean }[] = [
  { id: "functional", name: "At most one", owl: "owl:FunctionalProperty", more: false },
  { id: "inverseFunctional", name: "Identifies its start", owl: "owl:InverseFunctionalProperty", more: false },
  { id: "symmetric", name: "Works both ways", owl: "owl:SymmetricProperty", more: false },
  { id: "transitive", name: "Chains", owl: "owl:TransitiveProperty", more: false },
  { id: "asymmetric", name: "Never both ways", owl: "owl:AsymmetricProperty", more: true },
  { id: "irreflexive", name: "Never to itself", owl: "owl:IrreflexiveProperty", more: true },
  { id: "reflexive", name: "Always to itself", owl: "owl:ReflexiveProperty", more: true },
];

/** Each characteristic's example, written from the relationship's own
 *  names (5.6). An end not set yet reads as *something* or *thing*. */
export function characteristicExample(
  id: Characteristic,
  name: string,
  from: string | null,
  to: string | null,
): string {
  const said = name.trim() || "…";
  switch (id) {
    case "functional":
      return `${capital(end(from, "something"))} ${said} at most one ${to ?? "thing"}.`;
    case "inverseFunctional":
      return `${capital(end(to, "something"))} is linked by ${said} to at most one ${from ?? "thing"}.`;
    case "symmetric":
      return `If A ${said} B, then B ${said} A.`;
    case "transitive":
      return `If A ${said} B and B ${said} C, then A ${said} C.`;
    case "asymmetric":
      return `If A ${said} B, then B never ${said} A.`;
    case "irreflexive":
      return `Nothing ${said} itself.`;
    case "reflexive":
      return `Everything ${said} itself.`;
  }
}

/** *works for is a more specific kind of member of* (5.6). */
export function parentSentence(child: string, parent: string): string {
  return `${child} is a more specific kind of ${parent}`;
}

/** Why one start and one end, with the relationship's own names (5.6):
 *  *To use "works for" from Robot too, make Person and Robot kinds of a
 *  common class ...* -- the other class is the learner's to think of. */
export function oneStartOneEnd(name: string, from: string | null): string {
  const start = from ? `${from} and that class` : "both classes";
  return (
    `A relationship here has one start and one end. To use "${name.trim() || "it"}" from another class too, ` +
    `make ${start} kinds of a common class, such as Agent, and start the relationship there, ` +
    "or create a second relationship."
  );
}

/** A type of value after *as*: *a date*, *a whole number*, but *text* and
 *  *yes or no*, which take none; a type without a word is its name. */
export function asType(datatype: string): string {
  const word = typeWord(datatype);
  if (!(datatype in TYPE_WORDS) || word === "text" || word === "yes or no") return word;
  return a(word);
}

/** The attribute's sentence (5.7): *A Person has a name, as text.*, *A
 *  Person has a birth date, as a date.* */
export function attributeSentence(domain: string | null, name: string, datatype: string | null): string {
  const has = `${capital(end(domain, "something"))} has ${end(name.trim() || "…", "a value")}`;
  return datatype ? `${has}, as ${asType(datatype)}.` : `${has}.`;
}

/** *One value only* read with the attribute's names: *A Person has at most
 *  one name.* */
export function oneValueExample(domain: string | null, name: string): string {
  return `${capital(end(domain, "something"))} has at most one ${name.trim() || "value"}.`;
}

/** The five mapping kinds (5.8), each explained in one sentence. */
export const MAPPINGS: { id: string; name: string; means: string }[] = [
  { id: "exactMatch", name: "Exact match", means: "The same concept, and it can be used in place of this one." },
  { id: "closeMatch", name: "Close match", means: "Close enough to use in place of this one in some settings, not all." },
  { id: "broadMatch", name: "Broader match", means: "A broader concept in the other vocabulary." },
  { id: "narrowMatch", name: "Narrower match", means: "A narrower concept in the other vocabulary." },
  { id: "relatedMatch", name: "Related match", means: "An associated concept in the other vocabulary, neither broader nor narrower." },
];

/** *Top concept of Fruits* (5.8). */
export function topConceptSentence(scheme: string): string {
  return `Top concept of ${scheme}`;
}

// ---------------------------------------------------------------------------
// Reuse (attribute-reuse 5.1, 5.2, 5.4)
// ---------------------------------------------------------------------------

export type PropertyWord = "attribute" | "relationship";

/** *Employee*, *Employee and Contractor*, *Employee, Contractor and Intern*. */
export function namesList(names: string[], joiner: "and" | "or" = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
}

/** A domain's classes in words (attribute-reuse 5.3): *Employee or
 *  Contractor* for a union, *Employee and Manager* for two domain lines,
 *  which mean both; the one rule the form, the tree's words and the
 *  suggestions share. */
export function domainWords(form: "union" | "separate", names: string[]): string {
  return namesList(names, form === "union" ? "or" : "and");
}

/** *an Employee or a Contractor*: each name with its article. */
function either(names: string[]): string {
  return namesList(names.map(a), "or");
}

/** A suggestion under the name field (5.1): *hasName, an attribute of
 *  Employee (text).*, *reportsTo, from Employee to Manager.* The domain is
 *  the server's reading: *Employee or Contractor* when shared, *no class
 *  yet* when it has none. */
export function suggestionLine(
  kind: PropertyWord,
  name: string,
  domain: string | null,
  end: string | null,
): string {
  const of = domain ?? "no class yet";
  if (kind === "attribute") return `${name}, an attribute of ${of}${end ? ` (${typeWord(end)})` : ""}.`;
  return `${name}, from ${of} to ${end ?? "no class yet"}.`;
}

/** The suggestions' heading and each one's button. */
export const ALREADY_HERE = "Already in this project";
export function useOn(cls: string): string {
  return `Use it on ${cls}`;
}

/** What the live region says once typing pauses: the count, never the list. */
export function matchesSaid(count: number, kind: PropertyWord): string {
  return count === 1 ? `1 existing ${kind} matches` : `${count} existing ${kind}s match`;
}

/** Who has a property, for *It means: whatever has a name ...*. */
function whoever(kind: PropertyWord, name: string): string {
  return kind === "relationship" ? `whatever ${verb(name)} something` : `whatever has ${name}`;
}

/** Case A (5.2): no class yet. */
export function planNoClass(name: string, cls: string): string {
  return `${name} belongs to no class yet. Make it ${cls}'s?`;
}

/** Case B: the class has it already, through the class named in `via`. */
export function planAlready(name: string, cls: string, via: string): string {
  return via === cls ? `${cls} already has ${name}.` : `${cls} already has ${name}, because ${a(cls)} is ${a(via)}.`;
}

/** Case C: the domain is a kind of the class, so the property moves up. */
export function planMoveUp(name: string, cls: string, domain: string[]): string {
  const kept = domain.map((d) => `Every ${d} keeps it, because ${a(d)} is ${a(cls)}.`).join(" ");
  return `${name} moves up to ${cls}. ${kept}`;
}

/** Case D, the first choice: the plain question, then what it does. */
export function planSubclass(name: string, cls: string, domain: string): string {
  return `Is every ${cls} ${a(domain)}? Then make ${cls} a kind of ${domain}, and it gets ${name} through ${domain}.`;
}
export function makeKindOf(cls: string, domain: string): string {
  return `Make ${cls} a kind of ${domain}`;
}

/** Case D, the union, for OWL classes: what it means in one sentence. */
export function planUnion(kind: PropertyWord, name: string, classes: string[]): string {
  return `Share ${name} between ${namesList(classes)}. It means: ${whoever(kind, name)} is ${either(classes)}.`;
}
export const SHARE_IT = "Share it";
export const OR_PARENT = "Or give them a shared parent, which the reasoner can use";

/** Case D with an RDFS class: a shared parent is the only way. */
export function planRdfsParent(name: string, classes: string[]): string {
  return `RDFS has no way to say "either". Give ${namesList(classes)} a shared parent, and ${name} belongs to it:`;
}

/** The shared parent's name field and its button. */
export function parentQuestion(classes: string[]): string {
  return `What is every ${namesList(classes)}? For example, Worker`;
}
export function giveParent(classes: string[]): string {
  return `Give ${namesList(classes)} this parent`;
}

/** Why no shared parent is offered: a class is another ontology's. */
export function importedParentNote(cls: string, from: string | null): string {
  return `${cls} comes from ${from ?? "an imported ontology"}, so it cannot be given a new parent here.`;
}

/** A parent the classes already share: the button, and who else gains. */
export function moveUpTo(name: string, parent: string): string {
  return `Move ${name} up to ${parent}`;
}
export function gainsSentence(name: string, parent: string, gains: string[], total: number): string {
  if (total === 0) return `Nothing else gets ${name}: only these classes are kinds of ${parent}.`;
  if (total === 1) return `Every ${gains[0]} gets ${name} too, because ${a(gains[0])} is ${a(parent)}.`;
  const shown = total > gains.length ? [...gains, `${total - gains.length} more`] : gains;
  return `${namesList(shown)} get ${name} too, because each is ${a(parent)}.`;
}

/** The live region once a choice is made. */
export function sharedAnnouncement(name: string, classes: string[]): string {
  return `${name} is now shared by ${namesList(classes)}.`;
}
export function givenAnnouncement(name: string, cls: string): string {
  return `${name} now belongs to ${cls}.`;
}
export function removedAnnouncement(name: string, cls: string): string {
  return `${cls} no longer has ${name}.`;
}

/** *Belongs to* for a shared domain: what the list means. */
export function domainListNote(form: "union" | "separate"): string {
  return form === "union" ? "Any one of these classes:" : "All of these classes at once (see the warning):";
}

/** Said where a shared domain is shown (Section 7, 5.0 row 6). */
export const REASONER_NOTE =
  "The reasoner here follows OWL 2 RL, which draws no conclusion from a shared class list.";

/** The canvas relate menu's entry (5.1): share an existing relationship. */
export function shareEntry(name: string, from: string, to: string): string {
  return `Share ${name}: ${a(from)} ${verb(name)} ${a(to)} too.`;
}

/** Delete on one line of a shared relationship (5.3). */
export function memberDeleteQuestion(member: string, name: string): string {
  return `Remove ${member} from ${name}, or delete ${name}?`;
}
