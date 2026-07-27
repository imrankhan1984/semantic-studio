---
name: perf-budget
description: Measures and enforces the performance budget for rendering and parsing changes in Semantic Studio. Use for any work on the graph endpoint, graph_builder, GraphView, or file parsing.
---

# Performance budget

## What to measure

| Path | Measure | Budget |
| --- | --- | --- |
| `GET /{id}/graph` | Serialized response size and build time | Stated in the spec. The response must never be unbounded |
| Upload and parse | Wall clock to a 200 response, peak memory | Stated in the spec |
| Browser first paint of the graph | Time from response received to interactive | Stated in the spec |

## How to measure the server side

Drive the app in-process with generated ontologies at 1,000, 10,000 and 40,000
nodes. Record response bytes and build time for each.

Reference points measured on 2026-07-26 at commit `1faef6f`:

| Nodes | Response | Server build time |
| --- | --- | --- |
| 1,000 | 0.15 MB | under 0.1s |
| 10,000 | 1.58 MB | under 0.1s |
| 40,000 | 6.45 MB | 0.1s |

The server is not the bottleneck and never was. Do not spend effort optimizing
it without evidence that it has become one.

## How to measure the browser side

Do not trust a stopwatch. Load the application with the target ontology, then
confirm the page still responds to input afterward. A tab that cannot answer a
script injection for thirty seconds has failed, whatever the timing numbers say.

Known failure, for comparison: with FIBO loaded, 18,717 nodes and 51,446 edges,
clicking a starter query left the tab unresponsive for more than 95 seconds and
it never recovered. Switching ontologies and resizing the window did the same.

## Rules

- A spec that touches these paths states a number. "Should be fast" is not a
  budget.
- The budget becomes a test that fails when exceeded, not a note in a document.
- Measure before and after, and put both numbers in the pull request.
- If a change cannot meet the budget, say so and raise the budget deliberately
  with a decision log entry in `architecture.md`. Do not silently exceed it.
