# Rules the reasoner does not use (V-9)

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| v1.0 | 2026-11-07 | Ready for build | Approved for implementation by Imran. No change to the content of v0.2. |
| v0.2 | 2026-11-07 | Draft | Imran: Q1 as recommended, the reasoner's measured behavior decides. Q1 closed; 5.1 states it as decided. |
| v0.1 | 2026-11-07 | Draft | Initial spec-lite, from `field-feedback-2026-11.md` point 5 and backlog order 14. Grounded in `main` at `aab0b41`, with the reasoner's behavior measured case by case (Section 1). One open question. |

Spec-lite (CLAUDE.md Section 8): no new network path, no new kind of input file. Package A, order 14 in `backlog.md`. **Nothing is refused**: every rule people can write today they can still write.

## 1. Problem

Semantic Studio reasons with OWL 2 RL (Web Ontology Language 2, Rule Language profile) through OWL-RL (D-102 to D-104). That profile covers only part of OWL, and the Rules form writes rules outside it without a word. A learner writes *Every Order has at least one line*, runs reasoning, and reasonably believes the reasoner used the rule. It did not.

Measured at `aab0b41`, each case a small graph through `owlrl.DeductiveClosure(OWLRL_Semantics)`, the engine the worker runs:

| # | What the model says | How it is written | Used by the reasoner |
| --- | --- | --- | --- |
| 1 | Every X has at least one P (that is a Y) | `rdfs:subClassOf` a `owl:someValuesFrom` restriction | **No** |
| 2 | Every X has at least n P | `owl:minCardinality` or its qualified form | **No** |
| 3 | Every X has exactly n P | `owl:cardinality` or its qualified form | **No**, not even its *at most* half: two values of P for an X are not merged when n is 1 |
| 4 | Every X has at most 0 or 1 P | `owl:maxCardinality` 0 or 1, qualified or not | Yes (0 gives a problem, 1 merges two values) |
| 5 | Every X has at most n P, n of 2 or more | `owl:maxCardinality` n | **No** |
| 6 | Every X has only P that are Y | `owl:allValuesFrom` | Yes |
| 7 | Every X has P with the value v | `owl:hasValue` | Yes |
| 8 | X is defined as things with at least one P (that is a Y), only P that are Y, or P with the value v | `owl:equivalentClass` and that restriction | Yes: a thing that fits is placed in X |
| 9 | X is defined by a count | `owl:equivalentClass` and a cardinality | **No** for *at least* and *exactly*; Yes for *at most 0 or 1* |
| 10 | P's subject (domain) or value (range) is one of several classes | `rdfs:domain` or `rdfs:range` a `owl:unionOf` | **No**: a value that belongs to a class disjoint from all of them is not reported |
| 11 | X is exactly one of B or C | `owl:disjointUnionOf` | **No** |
| 12 | Everything is P-related to itself | `owl:ReflexiveProperty` | **No** |

Rows 1 to 9 are what the Rules form writes. Row 10 is what a shared domain (attribute-reuse 5.3) or range writes. Rows 11 and 12 arrive only by Turtle or from an added vocabulary. Of the 12 bundled vocabularies (E-14), QUDT holds 97 rules of rows 2 and 3, OWL-Time 19 and 11 of row 10, BFO 12 of row 10, PROV-O 6; FOAF, Dublin Core and SHACL hold none.

Two things already exist and are kept. Under each rule, the open-world note says the rule does not check the data, and *Check it in data too* writes the SHACL (Shapes Constraint Language) version (`RulesBlock.tsx`, `CheckInData`). A shared domain already says *The reasoner here follows OWL 2 RL, which draws no conclusion from a shared class list* (`modeling/sentences.ts`). What is missing is the same honesty for rows 1, 2, 3, 5 and 9, a mark on the canvas, one place that lists them, and a reasoning result that says what it left out.

**Primary stakeholder:** the learner. What changes: whenever a rule is one the reasoner does not use, Semantic Studio says so where the rule is written, drawn, checked and reasoned over.

## 5. Behavior

### 5.1 The one rule

A new function in `axioms.py`, `unused_by_reasoner(g, node) -> Optional[str]`, takes the node of one rule (a restriction under `rdfs:subClassOf` or `owl:equivalentClass`, a domain or range, a `owl:disjointUnionOf` or `owl:ReflexiveProperty` statement) and returns `None` when the reasoner uses it, or a reason key (`some`, `atLeast`, `exactly`, `atMostMany`, `definedByCount`, `classList`, `exactlyOneOf`, `reflexive`). The table in Section 1 is the function, row for row, and its test (Section 11) is that table. It is the only code that decides; the form, canvas, check and reasoning result all read it, and `/node` carries its key on each rule as `reasoner: "unused"` with `reason`.

The table follows what this reasoner does, measured, not the W3C grammar of the profile (Q1, decided by Imran 2026-11-07). If the engine changes, the test changes with it.

### 5.2 The Rules form

In the sentence builder, as soon as the chosen kind and count make a rule of rows 1, 2, 3, 5 or 9, one note appears under the sentence preview, before Save. It is `role="status"`, so it is read once, and Save stays available:

- Row 1: *Reasoning won't use this rule: the reasoner here follows OWL 2 RL, which draws no conclusion from "at least one". To find an Order with no line, use Check it in data too.*
- Row 2: *… from "at least 3". To find an Order with fewer than 3 lines, use Check it in data too.*
- Row 3: *… from "exactly 2", not even its "at most" part. To find an Order with another number of lines, use Check it in data too.* When n is 1, one more sentence: *For reasoning to use "at most one", add it as a rule of its own.*
- Row 5: *… from "at most 3". It uses "at most" only for 0 or 1.*
- Row 9: *Reasoning won't use this definition: the reasoner here follows OWL 2 RL, which draws no conclusion from a count in a definition.*

The names, counts and nouns are filled the way `openWorldNote` fills them today. Once saved, the same note stands under the rule in the Rules block, after the open-world note and before *Check it in data too*. A rule outside the form's sentences (read-only, shown as Turtle) carries the note when the server's key says so.

### 5.3 The canvas

A rule line the reasoner does not use keeps its dotted style and gains the symbol **⊘** at the start of its label (*⊘ at least 1 · has line*), in the warning color token, in both themes. The symbol comes first so it survives a cut-off label (the open E-14 follow-up). The line's accessible name ends *, not used by reasoning*. The canvas legend in `CanvasAids.tsx` gains one line: *⊘ marks a rule the reasoner does not use.* Nothing is shown by color alone.

### 5.4 Shared domains and ranges

The existing shared-domain sentence stays as it is. The server's domain warning now comes from the 5.1 rule, and the same sentence is shown for a range that is a class list. No other change.

### 5.5 The check

A new check, **DC-30**, *Rules reasoning does not use*, level **Worth a look**, because the model is not wrong. A pinned SELECT lists candidate nodes (the 5.1 shapes); Python rereads each through the 5.1 rule (`_REREAD`), so the rule stays the only reader. Sentence: *Reasoning does not use "{rule sentence}".* Fix: *Nothing is wrong with it. To test it against your data, use Check it in data too.* It opens the class's Edit form at its Rules block, or the property's at its domain or range. Like every check, it reads the project's own document only (the existing imports note says so) and follows the D-125 cap.

### 5.6 The reasoning result

The reasoning summary gains `unused`: `{ "total", "sources": [{ "source": "model" | vocabulary id, "name", "count", "items" }] }`, computed in the main process from the same statements the worker is given, own model and added vocabularies alike, never inside the worker. `items` holds each rule's short label (*QuantityKind · at least 1 · applicable unit*), at most 50 per source, paged with the existing `_group` mechanism.

The reasoning panel shows one line under the result sentence when `total` is above 0: *Reasoning did not use 3 rules in your model and 97 in QUDT. Show them.* Show them opens the list, grouped by source; a rule in the model opens its Edit form, a vocabulary's is read-only. A run that timed out or was too large shows no such line.

### 5.7 Keyboard, focus and screen reader

The builder note is `role="status"` and never takes focus. *Show them* is a button with `aria-expanded`; the list is ordinary links and text in tab order. The ⊘ is `aria-hidden`; its meaning is in the line's accessible name and the legend.

## 11. Test plan

| Test | Type | Layer | File | Covers |
| --- | --- | --- | --- | --- |
| Section 1's 12 rows, each as a graph: `unused_by_reasoner` returns the row's key or `None` | unit | pytest | `tests/test_axioms.py` | AC-1 |
| The same 12 graphs through `owlrl`: each "No" row concludes nothing the row would give, each "Yes" row does (the table is true of the engine) | unit | pytest | `tests/test_axioms.py` | AC-1 |
| `/node` carries `reasoner: "unused"` and `reason` on rules of rows 1, 2, 3, 5, 9 and on a class-list domain, and nothing on rows 4, 6, 7, 8 | integration | pytest | `tests/test_modeling_checks.py` | AC-2 |
| DC-30 lists rows 1, 2, 3, 5, 9, 10, 11, 12 of a fixture at Worth a look and none of rows 4, 6, 7, 8; its file is pinned and a moved hash is refused | integration | pytest | `tests/test_checks.py` | AC-5 |
| The reasoning summary's `unused` counts the model's rules and an imported QUDT's 97 by source; caps at 50 items; absent on timeout | integration | pytest | `tests/test_reasoning.py` | AC-6 |
| The 5.1 scan over QUDT takes under 100 ms (measured: 11 ms) | perf | pytest | `tests/test_axioms.py` | AC-7 |
| The builder shows each row's note before Save, Save still sends the command; n of 1 adds the *at most one* sentence | component | vitest | `components/RuleEditor.test.tsx` | AC-3 |
| A saved unused rule shows the note between the open-world note and *Check it in data too* | component | vitest | `components/RulesBlock.test.tsx` | AC-3 |
| An unused rule line's label starts with ⊘, its name ends *not used by reasoning*; a used one has neither; the legend line is present | component | vitest | `canvas/ModelCanvas.test.tsx` | AC-4 |
| The panel line and *Show them* list, grouped by source, with `aria-expanded` | component | vitest | `reasoning/*.test.tsx` | AC-6, AC-8 |
| Removal checks: remove the rule's call in `/node`, the DC-30 reread, the canvas mark and the summary field in turn; the matching test goes red each time | removal | both | as above | all |

## 12. Acceptance criteria

- **AC-1.** One function decides whether the reasoner uses a rule, and it matches Section 1's table, which is itself tested against the engine.
- **AC-2.** Every rule the reasoner does not use is marked as such in what the server returns for a class or property; no used rule is.
- **AC-3.** Given the Rules form, when a person picks *at least one*, *at least n*, *exactly n*, *at most n* (n of 2 or more) or a count in a definition, then one sentence says before Save that reasoning won't use it and what to use instead, and Save still works. The sentence stays under the saved rule.
- **AC-4.** On the canvas, such a rule's line carries ⊘ and says *not used by reasoning* to a screen reader; the legend explains the symbol.
- **AC-5.** View → Checks lists every rule of the project's own model that reasoning does not use, at Worth a look, and opens its Edit form.
- **AC-6.** After a run, the reasoning panel says how many rules it did not use, per source (the model and each added vocabulary), and can list them.
- **AC-7.** The scan adds no noticeable time: under 100 ms on QUDT.
- **AC-8.** Nothing is refused, and nothing is said by color alone.

## 13. Skills to use

`build-spec`, `rdf-fixture` (Section 1's 12 rows as one fixture), `a11y-check` (the note, the ⊘ and *Show them*), `run-semantic-viewer` (the form, the canvas and the panel in the running app, both themes).

## 14. Architecture impact

- `axioms.py` gains `unused_by_reasoner`; `modeling_checks.py`, `checks.py` and `reasoning.py` read it. No new module, dependency, endpoint or network path.
- `/node` rules gain `reasoner` and `reason`; the reasoning summary gains `unused`. State both in the PR description.
- A 30th pinned check, DC-30. The repository `CLAUDE.md`'s layout line *The 29 pinned SELECT files* becomes 30, and a load-bearing line is added: *Whether the reasoner uses a rule is decided only by `axioms.unused_by_reasoner`, measured against the engine; nothing is refused for it (D-129).*
- **D-129**, to append to `decisions.md`: *Rules outside what the reasoner uses are written as asked and said plainly in four places: the form, the canvas, a check and the reasoning result (V-9).* Considered: refusing them; rewriting them into the profile; a warning in the form only. Chosen because each is legitimate OWL that another reasoner or a reader uses, and because the learner's mistake is believing reasoning used it, which only a sentence at each place fixes.

## 15. Open questions

None. **Q1 (closed 2026-11-07):** which list decides, the reasoner's measured behavior or the W3C grammar of OWL 2 RL. Imran chose measured behavior, as recommended: the note promises *reasoning won't use this*, so it must be true of this reasoner. Row 8 (a definition with *at least one* or *only*) is therefore not flagged.
