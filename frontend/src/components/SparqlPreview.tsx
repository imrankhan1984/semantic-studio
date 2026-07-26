import { highlightSparql } from "../sparql/highlight";

interface Props {
  sparql: string;
}

export default function SparqlPreview({ sparql }: Props) {
  if (!sparql) {
    return (
      <div className="sparql-preview empty">
        <p className="detail-note">
          Click a highlighted node in the graph to start building a query.
        </p>
      </div>
    );
  }
  const lines = sparql.split("\n");
  return (
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
  );
}
