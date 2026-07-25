import { useMemo, useState } from "react";

export interface NextStepOption {
  anchor: number;
  anchorLabel: string;
  predicate: string;
  predicateLabel: string;
  inverse: boolean;
  targetClass: string;
  targetLabel: string;
  count: number;
  declared: boolean;
}

interface Props {
  options: NextStepOption[];
  stepCount: number;
  onAdd: (option: NextStepOption) => void;
}

const COLLAPSED_COUNT = 8;

/**
 * Every way the path can continue, listed as chips. Hunting for the right
 * node in a large graph is impractical, so the panel offers the same moves
 * the graph does — the two routes build exactly the same query.
 */
export default function NextSteps({ options, stepCount, onAdd }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) =>
        o.targetLabel.toLowerCase().includes(needle) ||
        o.predicateLabel.toLowerCase().includes(needle),
    );
  }, [options, filter]);

  if (options.length === 0) return null;

  const shown = expanded ? matching : matching.slice(0, COLLAPSED_COUNT);

  return (
    <section className="next-steps">
      <div className="next-steps-head">
        <h3>Add a step</h3>
        {options.length > COLLAPSED_COUNT && (
          <input
            type="search"
            className="next-filter"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      <div className="chip-cloud">
        {shown.map((option) => (
          <button
            key={`${option.anchor}|${option.predicate}|${option.inverse}|${option.targetClass}`}
            className="chip next-chip"
            onClick={() => onAdd(option)}
            title={
              `From step ${option.anchor + 1} (${option.anchorLabel}) via ` +
              `${option.inverse ? "reversed " : ""}${option.predicateLabel}` +
              (option.count > 0 ? ` · ${option.count.toLocaleString()} in the data` : "")
            }
          >
            {stepCount > 1 && <span className="next-anchor">{option.anchor + 1}</span>}
            <span className="next-pred">
              {option.inverse && <span className="dir-badge">^</span>}
              {option.predicateLabel}
            </span>
            <span className="next-arrow">→</span>
            <span className="next-target">{option.targetLabel}</span>
          </button>
        ))}
      </div>
      {matching.length > COLLAPSED_COUNT && (
        <button className="link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${matching.length}`}
        </button>
      )}
      {matching.length === 0 && <p className="detail-note">Nothing matches “{filter}”.</p>}
    </section>
  );
}
