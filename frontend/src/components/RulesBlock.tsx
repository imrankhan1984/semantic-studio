/*
================================================================================
FILE: frontend/src/components/RulesBlock.tsx
================================================================================

SUMMARY
    The Rules block of a class's form (axioms-and-reasoning 5.9): *What is
    true of every Order*, between its kinds and its relationships. It lists
    the class's restrictions, disjoint classes and equivalent classes as
    sentences, each with Edit and Remove; under each restriction, the
    open-world note and *Check it in data too*; a rule outside the form's
    sentences as its Turtle, read-only, with Edit in Turtle; the 5.10
    warnings under the rule they concern; and *Add a rule*, which opens the
    sentence builder.

BASIC IDEA
    The rules come with the panel's /node details, read by the server
    (axioms.py), and refetch with it on every revision, so the block shows
    what the server holds; the sentences are modeling/ruleSentences.ts's.
    Every change is one command through the form's runner, so one undo step
    in model.ttl; *Check it in data too* is one command on shapes.ttl
    (CheckInData), with a runner of its own on that document.

    Focus never falls to the page (Section 6; the PR #55 review found three
    controls that dropped it). After an add it goes back to *Add a rule*;
    after a remove, to the next rule, or to *Add a rule* when none is left,
    once the refetch has taken the old one away; Cancel and Escape give it
    back to what opened the builder. Controls are aria-disabled, never
    disabled. A refusal stands under the builder or the rule and is said
    in the live region too; a warning a change brings is said once.

    A rule begun on the canvas (the relate menu's *a rule* entry) waits in
    the project store; the block of that class opens the builder on it,
    with its class at the other end, and spends it.

INPUTS / INPUT SOURCES (props)
    - iri, name: the class.
    - rules: its rules, warnings and the builder's choices, from /node.
    - runner: the form's command runner (model.ttl).
    - onSelect: select another entity (a class named in a rule).

EXPECTED OUTPUT
    - Commands through the runners; the block's markup.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import {
  EMPTY_BUILDER,
  itemKey,
  itemSentence,
  openWorldNote,
  partsOf,
  removeCommand,
  stateOf,
  type BuilderState,
} from "../modeling/ruleSentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ClassRules, RuleItem, RuleKey, RuleRestriction } from "../types";
import { useRunner, type Runner } from "./EditParts";
import { useWarningAnnouncer } from "./RelationshipForm";
import RuleBuilder from "./RuleBuilder";

interface Props {
  iri: string;
  name: string;
  rules: ClassRules;
  runner: Runner;
  onSelect: (iri: string) => void;
}

/** The builder's place: closed, adding, or changing one rule. */
type Open = null | { initial: BuilderState | null; replacing: RuleKey | null; from: string };

export default function RulesBlock({ iri, name, rules, runner, onSelect }: Props) {
  const { busy, errors, run, clear } = runner;
  const shapes = useRunner("shapes");
  const [open, setOpen] = useState<Open>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // After a remove: the key of the rule to focus once the removed one has
  // gone from the list, or "add" for *Add a rule*.
  const pending = useRef<{ gone: string; next: string } | null>(null);
  const items = rules.items;
  useWarningAnnouncer(iri, rules.warnings);

  // A rule begun on the canvas for this class: open the builder on it once.
  const draft = useProjectSelector((s) => s.ruleDraft);
  useEffect(() => {
    if (!draft || draft.cls !== iri || !rules.choices) return;
    projectStore.ruleDraftTaken();
    setOpen({
      initial: { ...EMPTY_BUILDER, kind: "some", filler: draft.filler || null, property: draft.property ?? null },
      replacing: null,
      from: "add",
    });
  }, [draft, iri, rules.choices]);

  const focusAdd = () => window.setTimeout(() => addRef.current?.focus(), 0);
  const focusItem = (key: string) =>
    window.setTimeout(() => {
      const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-rule]") ?? []).find(
        (el) => el.dataset.rule === key,
      );
      if (row) row.focus();
      else addRef.current?.focus();
    }, 0);

  useEffect(() => {
    const wait = pending.current;
    if (!wait || items.some((i) => itemKey(i) === wait.gone)) return;
    pending.current = null;
    if (wait.next === "add") focusAdd();
    else focusItem(wait.next);
  }, [items]);

  const close = (back: string) => {
    clear("rule");
    setOpen(null);
    if (back === "add") focusAdd();
    else focusItem(back);
  };

  const remove = async (item: RuleItem, index: number) => {
    const command = removeCommand(iri, item);
    if (!command || busy) return;
    const key = itemKey(item);
    const next = items.slice(index + 1).find((i) => itemKey(i) !== key) ?? items.slice(0, index).reverse()[0];
    pending.current = { gone: key, next: next ? itemKey(next) : "add" };
    const sentence = itemSentence(name, item) ?? "the rule";
    const done = await run(`rule:${key}`, command.name, command.args, (r) => `Removed: ${sentence}. ${r.label}.`, say);
    if (!done) pending.current = null;
  };

  const checkInData = async (item: RuleRestriction) => {
    const key = itemKey(item);
    // A refusal stands under the rule and is said too (Section 6).
    await shapes.run(
      `check:${key}`,
      "CheckInData",
      { class: iri, restriction: item.key },
      (r) => `${r.label}. Validate checks it in your data.`,
      say,
    );
  };

  const warningsFor = (item: RuleItem) =>
    item.type === "disjoint" ? rules.warnings.filter((w) => w.disjoint === item.other.iri) : [];
  const general = rules.warnings.filter(
    (w) => !w.disjoint || !items.some((i) => i.type === "disjoint" && i.other.iri === w.disjoint),
  );
  const canEdit = rules.choices !== null;

  return (
    <section className="rules-block" aria-labelledby={`rules-${cssId(iri)}`}>
      <h5 id={`rules-${cssId(iri)}`}>What is true of every {name}</h5>
      {general.length > 0 && (
        <ul className="form-warnings" aria-label="Warnings">
          {general.map((w) => (
            <li key={w.text} className="form-warning">
              {w.text}
            </li>
          ))}
        </ul>
      )}
      {items.length === 0 ? (
        <p className="detail-note">No rules yet.</p>
      ) : (
        <ul className="edit-list rules-list" ref={listRef}>
          {items.map((item, index) => {
            const key = itemKey(item);
            const sentence = itemSentence(name, item);
            const mine = warningsFor(item);
            return (
              <li key={key} className="rule-item" data-rule={key} tabIndex={-1}>
                {item.type === "turtle" ? (
                  <>
                    <p className="detail-note">Written in Turtle, outside the sentences this form writes:</p>
                    <pre className="rule-turtle">{item.turtle}</pre>
                    <button
                      type="button"
                      className="ghost edit-btn"
                      onClick={() => projectStore.showInEditor([`<${iri}>`, ...prefixedFind(iri)])}
                    >
                      Edit in Turtle
                    </button>
                  </>
                ) : (
                  <>
                    <span className="rule-sentence">{sentence}</span>
                    {item.type !== "restriction" && (
                      <>
                        {" "}
                        <button type="button" className="term-link" onClick={() => onSelect(item.other.iri)}>
                          {item.other.label}
                        </button>
                      </>
                    )}
                    {item.editable && canEdit ? (
                      <span className="rule-actions">
                        {item.type === "restriction" && (
                          <button
                            type="button"
                            className="ghost edit-btn"
                            aria-label={`Edit: ${sentence}`}
                            onClick={() => setOpen({ initial: stateOf(item), replacing: item.key, from: key })}
                          >
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="ghost edit-btn"
                          aria-label={`Remove: ${sentence}`}
                          aria-disabled={busy}
                          onClick={() => void remove(item, index)}
                        >
                          Remove
                        </button>
                      </span>
                    ) : (
                      !item.editable && <span className="detail-note"> (read-only)</span>
                    )}
                    {mine.length > 0 && (
                      <ul className="form-warnings" aria-label="Warnings">
                        {mine.map((w) => (
                          <li key={w.text} className="form-warning">
                            {w.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.type === "restriction" && (
                      <div className="rule-note">
                        <p className="detail-note">{openWorldNote(name, partsOf(item))}</p>
                        {item.editable && canEdit && (
                          <button
                            type="button"
                            className="link-btn"
                            aria-disabled={shapes.busy}
                            aria-label={`Check it in data too: ${sentence}`}
                            onClick={() => !shapes.busy && void checkInData(item)}
                          >
                            Check it in data too
                          </button>
                        )}
                        {shapes.errors[`check:${key}`] && (
                          <p className="edit-error">
                            {shapes.errors[`check:${key}`]}
                          </p>
                        )}
                      </div>
                    )}
                    {errors[`rule:${key}`] && <p className="edit-error">{errors[`rule:${key}`]}</p>}
                  </>
                )}
                {open && open.replacing && open.from === key && (
                  <RuleBuilder
                    cls={iri}
                    name={name}
                    choices={rules.choices}
                    initial={open.initial}
                    replacing={open.replacing}
                    busy={busy}
                    error={errors.rule || null}
                    onCancel={() => close(key)}
                    onSubmit={async (command, said) => {
                      const result = await run("rule", command.name, command.args, (r) => `Changed: ${said}. ${r.label}.`, say);
                      if (result) close("add");
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && !open.replacing ? (
        <RuleBuilder
          cls={iri}
          name={name}
          choices={rules.choices}
          initial={open.initial}
          busy={busy}
          error={errors.rule || null}
          onCancel={() => close("add")}
          onSubmit={async (command, said) => {
            const result = await run("rule", command.name, command.args, (r) => `Added: ${said}. ${r.label}.`, say);
            if (result) close("add");
          }}
        />
      ) : (
        canEdit && (
          <button ref={addRef} type="button" className="ghost" onClick={() => setOpen({ initial: null, replacing: null, from: "add" })}>
            Add a rule
          </button>
        )
      )}
    </section>
  );
}

/** A refusal stands under the builder or the rule, and is said in the live
 *  region too (Section 6). */
function say(message: string): void {
  projectStore.say(message);
}

/** An id-safe form of a key: IRIs carry characters ids should not. */
function cssId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `r${(hash >>> 0).toString(36)}`;
}

/** Where *Edit in Turtle* puts the caret: the class, as the file writes it. */
function prefixedFind(iri: string): string[] {
  const project = projectStore.getSnapshot().project;
  if (!project || !iri.startsWith(project.baseIri)) return [];
  return [`${project.prefix}:${iri.slice(project.baseIri.length)}`];
}
