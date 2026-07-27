---
name: rdf-fixture
description: Conventions for creating RDF test data for Semantic Studio's pytest and vitest suites. Use whenever a test needs an ontology, a taxonomy, or a malformed file.
---

# RDF fixtures

## Choose the smallest fixture that proves the point

| Need | Use |
| --- | --- |
| A realistic mixed OWL and SKOS ontology | `examples/space-exploration.ttl` — 142 triples, 10 classes, 6 object properties, 2 datatype properties, 10 individuals, 4 SKOS concepts. Already used by six test files |
| One specific behavior | An inline Turtle string in the test, three to five triples, no more |
| Scale | Generate N-Triples in a loop inside the test. Never commit a large file |
| A parse failure | Inline, and make the defect obvious: a missing final full stop |

## Rules

- Use `http://example.org/` namespaces. Never a real vocabulary IRI in a
  synthetic fixture: it makes the test look like it depends on the web.
- Give every entity an `rdfs:label` or `skos:prefLabel` unless the test is
  specifically about missing labels.
- Set `SEMANTIC_STUDIO_DATA_DIR` to a temporary directory in any test that
  stores an ontology, or the test writes into the developer's real library.
- For scale tests, assert on the response shape and timing, not on exact node
  counts, which change as `graph_builder.py` evolves.
- SKOS fixtures should exercise the normalization in `graph_builder.py`:
  `skos:narrower` and `skos:hasTopConcept` are converted to their inverses, so a
  fixture that only uses `skos:broader` never tests that path.

## Reference points

Measured on 2026-07-26 against the graph endpoint, useful when writing scale
tests: 1,000 nodes returns 0.15 MB, 10,000 returns 1.58 MB, 40,000 returns 6.45
MB, all built server-side in under 0.1 seconds.
