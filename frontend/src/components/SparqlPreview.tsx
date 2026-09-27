/*
================================================================================
FILE: frontend/src/components/SparqlPreview.tsx
================================================================================

SUMMARY
    A small read-only pane that renders the generated SPARQL with line numbers
    and syntax highlighting (or a hint when the query is empty), with the two
    ways into the text editor above it: Edit as text and New text query.

BASIC IDEA
    Splits the query into lines and highlights each with highlightSparql,
    rendering tokens as coloured spans. highlightSparql returns tokens, never
    markup, so query text reaches the page as text.

    The two buttons are the only change Query mode shows a learner who never
    presses them (spec sparql-text-and-query-files, AC-1). Edit as text is
    disabled while there is no query, since there is nothing to edit; New text
    query is always offered, because writing from nothing needs no path.

INPUTS / INPUT SOURCES (props)
    - sparql: the query text to display.
    - onEditAsText / onNewTextQuery: open the editor.
    - editButtonRef: where focus returns when the editor closes (AC-15).

EXPECTED OUTPUT
    - The rendered, highlighted, line-numbered query (or an empty-state hint),
      and the two buttons.
================================================================================
*/

import type { Ref } from "react";
import { highlightSparql } from "../sparql/highlight";

interface Props {
  sparql: string;
  onEditAsText?: () => void;
  onNewTextQuery?: () => void;
  editButtonRef?: Ref<HTMLButtonElement>;
  newButtonRef?: Ref<HTMLButtonElement>;
}

export default function SparqlPreview({
  sparql,
  onEditAsText,
  onNewTextQuery,
  editButtonRef,
  newButtonRef,
}: Props) {
  const actions = (onEditAsText || onNewTextQuery) && (
    <div className="sparql-preview-actions">
      {onEditAsText && (
        <button
          ref={editButtonRef}
          className="ghost"
          disabled={!sparql}
          onClick={onEditAsText}
          title="Open this query in a text editor"
        >
          Edit as text
        </button>
      )}
      {onNewTextQuery && (
        <button
          ref={newButtonRef}
          className="ghost"
          onClick={onNewTextQuery}
          title="Write a SPARQL query from nothing"
        >
          New text query
        </button>
      )}
    </div>
  );

  if (!sparql) {
    return (
      <>
        {actions}
        <div className="sparql-preview empty">
          <p className="detail-note">
            Click a highlighted node in the graph to start building a query.
          </p>
        </div>
      </>
    );
  }
  const lines = sparql.split("\n");
  return (
    <>
      {actions}
      <div className="sparql-preview">
        <pre>
          <code>
            {lines.map((line, index) => (
              <span className="sparql-line" key={index}>
                <span className="sparql-gutter">{index + 1}</span>
                <span className="sparql-code">
                  {highlightSparql(line).map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.cls}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </>
  );
}
