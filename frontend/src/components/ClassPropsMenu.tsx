/*
================================================================================
FILE: frontend/src/components/ClassPropsMenu.tsx
================================================================================

SUMMARY
    The popover for a class chip: choose which data (literal) properties to
    return for that step, and optionally add a filter to each (operator + value),
    with the operator set and input type chosen from the property's datatype.
    Also unpins a pinned individual.

BASIC IDEA
    Presentational over one QueryStep and the class's available data properties.
    Toggling a property adds/removes it; a filter forces the property present
    (so its "optional" toggle disables). Datatype drives which operators and
    input control are offered. It calls onChange with a partial QueryStep patch.

INPUTS / INPUT SOURCES (props)
    - step: the step being edited.
    - available: the class's data properties (from the hook, incl. inherited).
    - onChange, onClose: edit and dismiss.

EXPECTED OUTPUT
    - The rendered menu; onChange patches to the step (props / pin).
================================================================================
*/

import { NUMERIC_TYPES, TEMPORAL_TYPES } from "../sparql/generate";
import type { FilterOp, QueryStep, SelectedProp } from "../sparql/types";
import type { SchemaDataProp } from "../types";

const XSD = "http://www.w3.org/2001/XMLSchema#";

/** Datatypes with a native HTML input; other ordered types fall back to text. */
const NATIVE_INPUTS: Record<string, string> = {
  [`${XSD}date`]: "date",
  [`${XSD}dateTime`]: "datetime-local",
  [`${XSD}time`]: "time",
};

const OP_LABELS: Record<FilterOp, string> = {
  "=": "equals",
  "!=": "not equals",
  ">": "greater than",
  ">=": "at least",
  "<": "less than",
  "<=": "at most",
  contains: "contains",
  startsWith: "starts with",
  lang: "language is",
};

function opsFor(datatype?: string): FilterOp[] {
  if (datatype && (NUMERIC_TYPES.has(datatype) || TEMPORAL_TYPES.has(datatype))) {
    return ["=", "!=", ">", ">=", "<", "<="];
  }
  return ["=", "!=", "contains", "startsWith", "lang"];
}

function inputTypeFor(datatype?: string): string {
  if (!datatype) return "text";
  if (NUMERIC_TYPES.has(datatype)) return "number";
  return NATIVE_INPUTS[datatype] ?? "text";
}

interface Props {
  step: QueryStep;
  available: SchemaDataProp[];
  onChange: (patch: Partial<QueryStep>) => void;
  onClose: () => void;
}

export default function ClassPropsMenu({ step, available, onChange, onClose }: Props) {
  const selectedByIri = new Map(step.props.map((p) => [p.predicateIri, p]));

  const setProps = (props: SelectedProp[]) => onChange({ props });

  const toggle = (prop: SchemaDataProp) => {
    if (selectedByIri.has(prop.predicate)) {
      setProps(step.props.filter((p) => p.predicateIri !== prop.predicate));
    } else {
      setProps([
        ...step.props,
        {
          predicateIri: prop.predicate,
          label: prop.label,
          datatype: prop.datatype,
          optional: true,
        },
      ]);
    }
  };

  const patchProp = (iri: string, patch: Partial<SelectedProp>) =>
    setProps(step.props.map((p) => (p.predicateIri === iri ? { ...p, ...patch } : p)));

  return (
    <div className="menu-card" onClick={(e) => e.stopPropagation()}>
      <div className="menu-header">
        <strong>Data properties &amp; filters — {step.label}</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {step.pin && (
        <div className="pin-row">
          <span>
            Pinned to <strong>{step.pin.label}</strong>
          </span>
          <button className="ghost" onClick={() => onChange({ pin: null })}>
            Match any {step.label}
          </button>
        </div>
      )}

      {available.length === 0 && (
        <p className="detail-note">This class has no literal-valued properties.</p>
      )}

      {available.length > 0 && (
        <div className="menu-actions">
          <button
            className="ghost"
            onClick={() =>
              setProps(
                available.map((prop) => ({
                  predicateIri: prop.predicate,
                  label: prop.label,
                  datatype: prop.datatype,
                  optional: selectedByIri.get(prop.predicate)?.optional ?? true,
                  filter: selectedByIri.get(prop.predicate)?.filter,
                })),
              )
            }
          >
            Select all
          </button>
          <button className="ghost" onClick={() => setProps([])}>
            Clear all
          </button>
        </div>
      )}

      {available.map((prop) => {
        const selected = selectedByIri.get(prop.predicate);
        const filterActive = !!selected?.filter && selected.filter.value.trim() !== "";
        return (
          <div className="prop-row" key={prop.predicate}>
            <label className="menu-row">
              <input type="checkbox" checked={!!selected} onChange={() => toggle(prop)} />
              <span className="menu-row-main">
                {prop.label}
                <span className="hint">
                  {prop.datatypePrefixed}
                  {prop.count > 0 ? ` · ${prop.count.toLocaleString()} values` : ""}
                </span>
              </span>
            </label>

            {selected && (
              <div className="filter-row">
                <select
                  value={selected.filter?.op ?? ""}
                  onChange={(e) =>
                    patchProp(prop.predicate, {
                      filter: e.target.value
                        ? {
                            op: e.target.value as FilterOp,
                            value: selected.filter?.value ?? "",
                          }
                        : undefined,
                    })
                  }
                  title="Filter operator"
                >
                  <option value="">no filter</option>
                  {opsFor(prop.datatype).map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </select>
                {selected.filter && (
                  <input
                    type={selected.filter.op === "lang" ? "text" : inputTypeFor(prop.datatype)}
                    value={selected.filter.value}
                    placeholder={selected.filter.op === "lang" ? "en" : "value"}
                    onChange={(e) =>
                      patchProp(prop.predicate, {
                        filter: { op: selected.filter!.op, value: e.target.value },
                      })
                    }
                  />
                )}
                <button
                  className={selected.optional && !filterActive ? "toggle-pill active" : "toggle-pill"}
                  disabled={filterActive}
                  onClick={() => patchProp(prop.predicate, { optional: !selected.optional })}
                  title={
                    filterActive
                      ? "A filtered property must be present, so it cannot be optional"
                      : "Optional: rows without this property still match"
                  }
                >
                  optional
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
