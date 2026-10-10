/*
================================================================================
FILE: frontend/src/components/RuleBuilder.tsx
================================================================================

SUMMARY
    The sentence builder (axioms-and-reasoning 5.9): one rule on a class,
    written by filling the blanks of its sentence -- which rule, the
    relationship or attribute, what is true of it, how many, and the class,
    type or value at the other end, or the other class of a disjoint or
    same-meaning rule. The sentence reads as the blanks fill, and Add
    writes one command.

BASIC IDEA
    A group named by its sentence (Section 6, Accessibility), so a screen
    reader hears the rule so far whenever focus enters it, and the same
    sentence is shown under the blanks. Each blank is a labelled select, or
    a number or text field; only the blanks the rule needs are drawn, and
    the kinds offered follow the property (an attribute takes a count or a
    value). The words, the problem that stops Add and the command come from
    modeling/ruleSentences.ts; this only draws them.

    Add is aria-disabled while a blank stops it, with the sentence that says
    why beside it, never `disabled`, so a keyboard user standing on it is
    never dropped to the page (PR #55 review). Escape and Cancel close it;
    the caller gives focus back to what opened it. The server's refusal
    stands under the builder; the caller also says it in the live region.

    A select offers at most the first 1,000 choices of each kind, and says
    so with the true total when there are more (CLAUDE.md rule 6).

INPUTS / INPUT SOURCES (props)
    - cls, name: the class and its name.
    - choices: what the selects offer, from /node.
    - initial: the state to open on (an edit, or a rule begun on the canvas).
    - editing: an existing rule is being changed (Save, not Add).
    - busy, error: the command in flight and the server's refusal.
    - onSubmit(command, sentence), onCancel.

EXPECTED OUTPUT
    - The builder; onSubmit with one command.
================================================================================
*/

import { useId, useMemo, useState } from "react";
import {
  EMPTY_BUILDER,
  RULE_TYPES,
  VALUE_TYPES,
  builderCommand,
  builderProblem,
  builderSentence,
  isCount,
  kindsFor,
  propertyKind,
  type BuilderState,
  type RuleType,
} from "../modeling/ruleSentences";
import type { RuleChoices, RuleKey, RuleKind, RuleRef } from "../types";

interface Props {
  cls: string;
  name: string;
  choices: RuleChoices | null;
  initial?: BuilderState | null;
  /** The key of the rule being changed: Save sends ReplaceRestriction. */
  replacing?: RuleKey | null;
  busy: boolean;
  error?: string | null;
  onSubmit: (command: { name: string; args: Record<string, unknown> }, sentence: string) => void;
  onCancel: () => void;
}

function Options({ list }: { list: RuleRef[] }) {
  return (
    <>
      {list.map((r) => (
        <option key={r.iri} value={r.iri}>
          {r.label}
        </option>
      ))}
    </>
  );
}

/** The true total beside a capped list (rule 6). */
function Capped({ shown, total, what }: { shown: number; total: number; what: string }) {
  if (total <= shown) return null;
  return (
    <p className="detail-note">
      Showing the first {shown.toLocaleString()} of {total.toLocaleString()} {what}; write a rule on another in Turtle.
    </p>
  );
}

export default function RuleBuilder({
  cls,
  name,
  choices,
  initial = null,
  replacing = null,
  busy,
  error = null,
  onSubmit,
  onCancel,
}: Props) {
  const id = useId();
  const [state, setState] = useState<BuilderState>(initial ?? EMPTY_BUILDER);
  const set = (part: Partial<BuilderState>) => setState((s) => ({ ...s, ...part }));
  const sentence = useMemo(() => builderSentence(name, state, choices), [name, state, choices]);
  const problem = builderProblem(state, choices);
  const command = builderCommand(cls, state, choices, replacing);
  const pkind = propertyKind(state, choices);
  const kinds = kindsFor(pkind);
  const classes = choices?.classes.items ?? [];
  const properties = choices?.properties.items ?? [];
  const things = choices?.things.items ?? [];
  const restriction = state.type === "every" || state.type === "defines";
  const types = replacing ? RULE_TYPES.filter((t) => t.id === "every" || t.id === "defines") : RULE_TYPES;

  const chooseProperty = (iri: string) => {
    const chosen = properties.find((p) => p.iri === iri);
    const offered = kindsFor(chosen?.kind ?? null).map((k) => k.id);
    // A kind the new property is not offered goes, and so does a filler of
    // the other sort (a class for an attribute, a type for a relationship).
    const keepKind = state.kind && offered.includes(state.kind) ? state.kind : null;
    const sameSort = chosen?.kind === pkind;
    set({ property: iri || null, kind: keepKind, filler: sameSort ? state.filler : null, value: sameSort ? state.value : "" });
  };

  const submit = () => {
    if (busy || !command) return;
    onSubmit(command, sentence);
  };

  return (
    <div
      className="rule-builder"
      role="group"
      aria-label={sentence}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="edit-field-label" htmlFor={`${id}-type`}>
        Rule
      </label>
      <select id={`${id}-type`} autoFocus value={state.type} onChange={(e) => set({ type: e.target.value as RuleType })}>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.words(name)}
          </option>
        ))}
      </select>

      {restriction ? (
        <>
          {state.type === "defines" && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-with`}>
                Exactly a (class)
              </label>
              <select id={`${id}-with`} value={state.with ?? ""} onChange={(e) => set({ with: e.target.value || null })}>
                <option value="">something (no class)</option>
                <Options list={classes.filter((c) => c.iri !== cls)} />
              </select>
            </>
          )}
          <label className="edit-field-label" htmlFor={`${id}-property`}>
            {state.type === "defines" ? "That (relationship or attribute)" : "Relationship or attribute"}
          </label>
          <select id={`${id}-property`} value={state.property ?? ""} onChange={(e) => chooseProperty(e.target.value)}>
            <option value="">Choose…</option>
            {properties.map((p) => (
              <option key={p.iri} value={p.iri}>
                {p.label} ({p.kind})
              </option>
            ))}
          </select>
          {choices && <Capped shown={properties.length} total={choices.properties.total} what="relationships and attributes" />}

          <label className="edit-field-label" htmlFor={`${id}-kind`}>
            What is true of it
          </label>
          <select id={`${id}-kind`} value={state.kind ?? ""} onChange={(e) => set({ kind: (e.target.value || null) as RuleKind | null, filler: null, value: "" })}>
            <option value="">Choose…</option>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.words}
              </option>
            ))}
          </select>

          {isCount(state.kind) && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-n`}>
                How many (0 to 1,000)
              </label>
              <input
                id={`${id}-n`}
                type="number"
                min={0}
                max={1000}
                step={1}
                inputMode="numeric"
                value={state.n}
                onChange={(e) => set({ n: e.target.value })}
              />
            </>
          )}

          {state.kind && state.kind !== "value" && pkind !== "attribute" && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-filler`}>
                {isCount(state.kind) ? "That are (a class, optional)" : "That is a (class)"}
              </label>
              <select id={`${id}-filler`} value={state.filler ?? ""} onChange={(e) => set({ filler: e.target.value || null })}>
                <option value="">{isCount(state.kind) ? "any thing" : "Choose…"}</option>
                <Options list={classes} />
              </select>
              {choices && <Capped shown={classes.length} total={choices.classes.total} what="classes" />}
            </>
          )}

          {isCount(state.kind) && pkind === "attribute" && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-filler`}>
                Type of value (optional)
              </label>
              <select id={`${id}-filler`} value={state.filler ?? ""} onChange={(e) => set({ filler: e.target.value || null })}>
                <option value="">any value</option>
                <Options list={VALUE_TYPES} />
              </select>
            </>
          )}

          {state.kind === "value" && pkind !== "attribute" && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-filler`}>
                The value (a thing)
              </label>
              <select id={`${id}-filler`} value={state.filler ?? ""} onChange={(e) => set({ filler: e.target.value || null })}>
                <option value="">Choose…</option>
                <Options list={things} />
              </select>
              {choices && <Capped shown={things.length} total={choices.things.total} what="things" />}
            </>
          )}

          {state.kind === "value" && pkind === "attribute" && (
            <>
              <label className="edit-field-label" htmlFor={`${id}-value`}>
                The value
              </label>
              <input id={`${id}-value`} type="text" value={state.value} onChange={(e) => set({ value: e.target.value })} />
            </>
          )}
        </>
      ) : (
        <>
          <label className="edit-field-label" htmlFor={`${id}-other`}>
            {state.type === "disjoint" ? "Never a (class)" : "Means the same as (class)"}
          </label>
          <select id={`${id}-other`} value={state.other ?? ""} onChange={(e) => set({ other: e.target.value || null })}>
            <option value="">Choose…</option>
            <Options list={classes.filter((c) => c.iri !== cls)} />
          </select>
          {choices && <Capped shown={classes.length} total={choices.classes.total} what="classes" />}
        </>
      )}

      <p className="rule-preview" aria-hidden="true">
        Reads: {sentence}.
      </p>
      {problem && (
        <p id={`${id}-problem`} className="detail-note">
          {problem}
        </p>
      )}
      <div className="edit-actions">
        <button
          type="button"
          className="primary"
          aria-disabled={busy || Boolean(problem)}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onClick={submit}
        >
          {busy ? "Saving change…" : replacing ? "Save rule" : "Add"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="edit-error">{error}</p>}
    </div>
  );
}
