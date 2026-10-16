/*
================================================================================
FILE: frontend/src/components/ExplainBlock.tsx
================================================================================

SUMMARY
    The detail panel's In plain words block (explain-panel 5.1, 5.2, D-114):
    what kind of thing is selected, the facts its file states about it, and
    its authors' own description, as sentences, above the statements.

BASIC IDEA
    The server sends the structure (`explain`) and explain/explainSentences.ts
    writes it; this component only draws the sentences. Each name in them is
    the panel's term button, so it selects that entity as every term in the
    panel does. The heading is an h3 in the panel's order, before Rules and
    Statements, and the sentences are plain text: nothing is shown only on
    hover or only by colour.

    DetailPanel draws it only where there is no Edit section: that section
    already says the same things in its forms (5.1).

INPUTS / INPUT SOURCES (props)
    - label: the entity's name, as the panel's heading shows it.
    - explain: the node response's `explain`.
    - onNavigate: select an entity named in a sentence.

EXPECTED OUTPUT
    - A <section> with the heading and one paragraph per sentence.
================================================================================
*/

import { explainSentences, type Sentence } from "../explain/explainSentences";
import type { Explain } from "../types";

interface Props {
  label: string;
  explain: Explain;
  onNavigate: (iri: string) => void;
}

function SentenceLine({ sentence, onNavigate }: { sentence: Sentence; onNavigate: (iri: string) => void }) {
  return (
    <p className="explain-sentence">
      {sentence.map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          // The panel's term button, with the IRI in its title as there.
          <button key={i} className="term-link" title={part.iri} onClick={() => onNavigate(part.iri)}>
            {part.label}
          </button>
        ),
      )}
    </p>
  );
}

export default function ExplainBlock({ label, explain, onNavigate }: Props) {
  const sentences = explainSentences(label, explain);
  return (
    <section className="explain-block">
      <h3>In plain words</h3>
      {sentences.map((sentence, i) => (
        <SentenceLine key={i} sentence={sentence} onNavigate={onNavigate} />
      ))}
    </section>
  );
}
