import type { LinkOption } from "../sparql/useQueryBuilder";
import type { Modifier, StepLink } from "../sparql/types";

const MODIFIERS: { value: Modifier; label: string; hint: string }[] = [
  { value: "", label: "none (exact)", hint: "Exactly one hop" },
  { value: "*", label: "* (zero or more)", hint: "Matches 0 or more hops" },
  { value: "+", label: "+ (one or more)", hint: "Matches 1 or more hops" },
  { value: "?", label: "? (zero or one)", hint: "Matches 0 or 1 hop" },
];

interface Props {
  link: StepLink;
  anchorLabel: string;
  targetLabel: string;
  options: LinkOption[];
  onChange: (patch: Partial<StepLink>) => void;
  onClose: () => void;
}

export default function PredicateMenu({
  link,
  anchorLabel,
  targetLabel,
  options,
  onChange,
  onClose,
}: Props) {
  const isChecked = (option: LinkOption) =>
    link.predicates.some((p) => p.iri === option.predicate && p.inverse === option.inverse);

  const toggle = (option: LinkOption) => {
    const checked = isChecked(option);
    if (checked && link.predicates.length === 1) return; // keep at least one
    const predicates = checked
      ? link.predicates.filter(
          (p) => !(p.iri === option.predicate && p.inverse === option.inverse),
        )
      : [...link.predicates, { iri: option.predicate, inverse: option.inverse }];
    onChange({ predicates });
  };

  return (
    <div className="menu-card" onClick={(e) => e.stopPropagation()}>
      <div className="menu-header">
        <strong>
          {anchorLabel} → {targetLabel}
        </strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <button
        className={link.optional ? "menu-toggle active" : "menu-toggle"}
        onClick={() => onChange({ optional: !link.optional })}
      >
        <span>{link.optional ? "☑" : "☐"} Make OPTIONAL</span>
        <span className="hint">Results may or may not match this hop</span>
      </button>

      <div className="menu-section">Path modifier</div>
      {MODIFIERS.map((modifier) => (
        <label className="menu-row" key={modifier.value || "none"}>
          <input
            type="radio"
            name="path-modifier"
            checked={link.modifier === modifier.value}
            onChange={() => onChange({ modifier: modifier.value })}
          />
          <span className="menu-row-main">
            {modifier.label}
            <span className="hint">{modifier.hint}</span>
          </span>
        </label>
      ))}

      <div className="menu-section">Relationships — check several for “|”</div>
      {options.length === 0 && <p className="detail-note">No relationships found.</p>}
      {options.map((option, index) => (
        <label className="menu-row" key={`${option.predicate}|${option.inverse}`}>
          <input
            type="checkbox"
            checked={isChecked(option)}
            onChange={() => toggle(option)}
          />
          <span className="menu-row-main">
            <span>
              {option.inverse && <span className="dir-badge">^</span>}
              {option.label}
              {index === 0 && <span className="primary-badge">primary</span>}
            </span>
            <span className="hint">
              {option.inverse ? "inverse" : "forward"} · {option.prefixed}
              {option.declared ? " · declared" : ""}
              {option.count > 0 ? ` · ${option.count.toLocaleString()} in data` : ""}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
