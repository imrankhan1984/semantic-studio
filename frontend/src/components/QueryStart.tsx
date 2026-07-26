/*
================================================================================
FILE: frontend/src/components/QueryStart.tsx
================================================================================

SUMMARY
    What the query panel shows before the first step: a "Try one of these" list
    of ready-made starter queries plus an "Or start from" cloud of entry-point
    classes — both derived from the loaded ontology's schema.

BASIC IDEA
    An empty builder tells a newcomer nothing. This turns the schema into
    concrete first moves: clicking a starter loads a ready QueryState (via
    onUseStarter), clicking a class begins the path (via onPickClass). The lists
    themselves come from the pure starters module.

INPUTS / INPUT SOURCES (props)
    - schema: the ontology's query schema (null -> renders nothing).
    - theme: for the class swatches.
    - onUseStarter: load a starter's ready state.
    - onPickClass: begin the path from a class.

EXPECTED OUTPUT
    - The rendered guided-start section; the two callbacks on interaction.
================================================================================
*/

import { useMemo } from "react";
import { buildStarters, entryPoints } from "../sparql/starters";
import type { QueryState } from "../sparql/types";
import type { QuerySchema, Theme } from "../types";
import { kindColor } from "../types";

interface Props {
  schema: QuerySchema | null;
  theme: Theme;
  onUseStarter: (state: QueryState, title: string) => void;
  onPickClass: (iri: string, label: string) => void;
}

/**
 * What the user sees before the first click. An empty builder tells a
 * newcomer nothing, so this offers ready-made queries drawn from the
 * ontology itself plus the classes worth starting from.
 */
export default function QueryStart({ schema, theme, onUseStarter, onPickClass }: Props) {
  const starters = useMemo(() => buildStarters(schema), [schema]);
  const classes = useMemo(() => entryPoints(schema), [schema]);

  if (!schema) return null;

  return (
    <div className="query-start">
      {starters.length > 0 && (
        <section>
          <h3>Try one of these</h3>
          <p className="hint">
            Ready-made queries for this ontology — run them, then edit anything.
          </p>
          <div className="starter-list">
            {starters.map((starter) => (
              <button
                key={starter.id}
                className="starter"
                onClick={() => onUseStarter(starter.state, starter.title)}
              >
                <span className="starter-title">{starter.title}</span>
                <span className="starter-detail">{starter.detail}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {classes.length > 0 && (
        <section>
          <h3>Or start from</h3>
          <p className="hint">
            Pick what the query should be about. You can also click any highlighted node
            in the graph, or search for it by name.
          </p>
          <div className="chip-cloud">
            {classes.map((cls) => (
              <button
                key={cls.iri}
                className="chip chip-class start-chip"
                style={{ borderColor: kindColor(cls.kind, theme) }}
                onClick={() => onPickClass(cls.iri, cls.label)}
                title={cls.prefixed}
              >
                <span className="dot" style={{ background: kindColor(cls.kind, theme) }} />
                {cls.label}
                {cls.instances > 0 && (
                  <span className="chip-count">{cls.instances.toLocaleString()}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
