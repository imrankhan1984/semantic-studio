/*
================================================================================
FILE: frontend/src/components/ShapeForm.tsx
================================================================================

SUMMARY
    The form of the one selected shape (shacl-authoring 5.3, 5.4, 5.5): its
    sentence, what it applies to, its name, its rules -- each a sentence with
    Edit and Remove, and one rule editor at a time -- the rules the model
    suggests, how serious a failure is and its message, and Delete. A shape
    written in Turtle with parts the form cannot edit is shown read-only:
    its sentence where the parts are known, what it uses that the form does
    not, and Edit in Turtle.

BASIC IDEA
    Every control is one command on shapes.ttl through the shared runner
    (EditParts.useRunner, pointed at the shapes document), so every change
    is one undo step and a refusal shows under the field that caused it.
    The shape itself is the server's reading, fetched again by ShapesView on
    every revision of either document; the form keeps nothing of its own
    but which editor is open.

    Suggestions come from the server, worked out from the same graph the
    form shows (5.4): fetched when the shape or either document changes,
    each with Add, none added by itself, and none offered once a rule says
    it. Add merges into the rule already on that path, as one step.

    Delete counts the rules first, in a confirmation, before DeleteShape.

INPUTS / INPUT SOURCES (props)
    - projectId, shape, modelOntologyId (the class picker searches the
      model), languages, revisions (to refetch suggestions).
    - onDeleted, onEditInTurtle.

EXPECTED OUTPUT
    - The form; shape commands through the project store.
================================================================================
*/

import { useEffect, useMemo, useRef, useState } from "react";
import { getShapeSuggestions } from "../api";
import { pathWords, ruleSentence, shapeSentence } from "../modeling/shapeSentences";
import type { ShapeForm as Shape, ShapePath, ShapeRule, ShapeSuggestions } from "../types";
import ConfirmDialog from "./ConfirmDialog";
import { Block, InlineText, useRunner, useReturnFocus } from "./EditParts";
import EntityPicker from "./EntityPicker";
import RuleEditor from "./RuleEditor";

interface Props {
  projectId: string;
  shape: Shape;
  modelOntologyId: string;
  languages: string[];
  revisions: string;
  onDeleted: () => void;
  onEditInTurtle: (shape: Shape) => void;
}

const key = (path: string[]) => path.join(" ");

export default function ShapeForm({
  projectId,
  shape,
  modelOntologyId,
  languages,
  revisions,
  onDeleted,
  onEditInTurtle,
}: Props) {
  const runner = useRunner("shapes");
  const { busy, errors, run } = runner;
  const [suggestions, setSuggestions] = useState<ShapeSuggestions | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // One editor at a time: "new", a rule's path key, or nothing.
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addRef, restoreAdd] = useReturnFocus();
  const [targetRef, restoreTarget] = useReturnFocus();
  const deleteRef = useRef<HTMLButtonElement>(null);
  // Each rule's Edit button, by path: where focus goes back to after Cancel,
  // and the next rule's after a Remove took the button that had it
  // (Stage A follow-up 6, row S19).
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusLater = (target: () => HTMLElement | null | undefined) =>
    window.setTimeout(() => target()?.focus(), 0);

  // A different shape opens with nothing open.
  useEffect(() => {
    setEditing(null);
    setPicking(false);
    setConfirmDelete(false);
  }, [shape.id]);

  const target = shape.target?.iri ?? null;
  useEffect(() => {
    if (!target || !shape.editable) {
      setSuggestions(null);
      return;
    }
    let live = true;
    getShapeSuggestions(projectId, target, shape.id)
      .then((s) => {
        if (!live) return;
        setSuggestions(s);
        setSuggestError(null);
      })
      .catch((e: unknown) => live && setSuggestError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [projectId, target, shape.id, shape.editable, revisions]);

  // The paths the rule editor offers, with any a rule already uses (a rule
  // written in Turtle may be on a path the model does not suggest).
  const paths: ShapePath[] = useMemo(() => {
    const out = [...(suggestions?.paths ?? [])];
    for (const rule of shape.rules) {
      if (!out.some((p) => key(p.path) === key(rule.path))) {
        out.push({ path: rule.path, label: pathWords(rule), kind: rule.pathKind ?? "other" });
      }
    }
    return out;
  }, [suggestions, shape.rules]);

  const sentence = shapeSentence(shape);

  if (!shape.editable) {
    return (
      <section className="shape-form read-only" aria-labelledby="shape-form-heading">
        <h3 id="shape-form-heading" tabIndex={-1}>
          {shape.name}
        </h3>
        <p className="shape-sentence">{sentence}</p>
        <p className="detail-note">
          Written in Turtle with parts this form cannot edit. It is still validated with every other shape.
        </p>
        <ul className="shape-unsupported">
          {shape.unsupported.map((part) => (
            <li key={part}>{part}</li>
          ))}
        </ul>
        <button type="button" className="primary" onClick={() => onEditInTurtle(shape)}>
          Edit in Turtle
        </button>
      </section>
    );
  }

  const submitRule = async (rule: ShapeRule, replacing: ShapeRule | null) => {
    const result = replacing
      ? await run("rule", "ReplaceRule", { shape: shape.id, path: replacing.path, rule })
      : await run("rule", "AddRule", { shape: shape.id, rule });
    if (result) {
      setEditing(null);
      // A changed rule keeps its place: focus its Edit, once the list holds
      // it under its (possibly new) path.
      if (replacing) focusLater(() => editButtons.current.get(key(rule.path)) ?? addRef.current);
      else restoreAdd();
    }
  };

  const removeRule = async (rule: ShapeRule) => {
    if (busy) return;
    const keys = shape.rules.map((r) => key(r.path));
    const at = keys.indexOf(key(rule.path));
    // The rule after it, else the one before, else + Add a rule.
    const next = keys[at + 1] ?? keys[at - 1] ?? null;
    if (await run("rule", "RemoveRule", { shape: shape.id, path: rule.path })) {
      focusLater(() => (next ? editButtons.current.get(next) : null) ?? addRef.current);
    }
  };

  const ruleCount = shape.rules.length;
  return (
    <section className="shape-form" aria-labelledby="shape-form-heading">
      <h3 id="shape-form-heading" tabIndex={-1}>
        {shape.name}
      </h3>
      <p className="shape-sentence">{sentence}</p>

      <Block title="Applies to">
        {picking ? (
          <EntityPicker
            ontologyId={modelOntologyId}
            kind="class"
            label="Class the shape applies to"
            busy={busy}
            error={errors.target}
            onPick={async (iri) => {
              if (await run("target", "SetShapeTarget", { shape: shape.id, target: iri })) {
                setPicking(false);
                restoreTarget();
              }
            }}
            onCancel={() => {
              setPicking(false);
              restoreTarget();
            }}
          />
        ) : (
          <div className="edit-value">
            <span>{shape.target ? shape.target.every ?? shape.target.label : "nothing yet"}</span>
            <button ref={targetRef} type="button" className="ghost edit-btn" onClick={() => setPicking(true)}>
              Change
            </button>
          </div>
        )}
      </Block>

      <Block title="Name">
        <InlineText
          label="shape name"
          value={shape.named ? shape.name : null}
          busy={busy}
          error={errors.name}
          onSave={async (value) => (await run("name", "SetShapeName", { shape: shape.id, value })) !== null}
        />
      </Block>

      <Block title="Rules">
        {ruleCount === 0 && <p className="detail-note">No rules yet. Add one, or take a suggestion below.</p>}
        <ul className="shape-rules">
          {shape.rules.map((rule) =>
            editing === key(rule.path) ? (
              <li key={key(rule.path)}>
                <RuleEditor
                  modelOntologyId={modelOntologyId}
                  paths={paths}
                  initial={rule}
                  languages={languages}
                  busy={busy}
                  error={errors.rule}
                  onSubmit={(next) => void submitRule(next, rule)}
                  onCancel={() => {
                    setEditing(null);
                    focusLater(() => editButtons.current.get(key(rule.path)));
                  }}
                />
              </li>
            ) : (
              <li key={key(rule.path)} className="shape-rule">
                <span>{ruleSentence(rule)}</span>
                <span className="shape-rule-actions">
                  <button
                    ref={(el) => {
                      if (el) editButtons.current.set(key(rule.path), el);
                      else editButtons.current.delete(key(rule.path));
                    }}
                    type="button"
                    className="ghost edit-btn"
                    aria-label={`Edit the rule on ${pathWords(rule)}`}
                    onClick={() => setEditing(key(rule.path))}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost edit-btn"
                    aria-label={`Remove the rule on ${pathWords(rule)}`}
                    aria-disabled={busy}
                    onClick={() => void removeRule(rule)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
        {editing === "new" ? (
          <RuleEditor
            modelOntologyId={modelOntologyId}
            paths={paths}
            initial={null}
            languages={languages}
            busy={busy}
            error={errors.rule}
            onSubmit={(next) => void submitRule(next, null)}
            onCancel={() => {
              setEditing(null);
              restoreAdd();
            }}
          />
        ) : (
          <button ref={addRef} type="button" className="ghost" onClick={() => setEditing("new")}>
            + Add a rule
          </button>
        )}
        {editing !== "new" && editing === null && errors.rule && <p className="edit-error">{errors.rule}</p>}
      </Block>

      <Block title="Suggested from the model">
        {suggestError && <p className="edit-error">{suggestError}</p>}
        {!target ? (
          // A shape written in Turtle with no target class (found in review):
          // there is nothing to suggest from until it has one.
          <p className="detail-note">Choose what the shape applies to, and the model suggests rules for it.</p>
        ) : !suggestions ? (
          !suggestError && <p className="detail-note">Reading the model…</p>
        ) : suggestions.suggestions.length === 0 ? (
          <p className="detail-note">Every rule the model suggests is already here.</p>
        ) : (
          <ul className="shape-suggestions">
            {suggestions.suggestions.map((s) => (
              <li key={s.id} className="shape-rule">
                <span>{ruleSentence(s.rule)}</span>
                <button
                  type="button"
                  className="ghost edit-btn"
                  aria-label={`Add: ${ruleSentence(s.rule)}`}
                  aria-disabled={busy}
                  onClick={() => !busy && void run("suggestion", "AddRule", { shape: shape.id, rule: s.rule, merge: true })}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        )}
        {errors.suggestion && <p className="edit-error">{errors.suggestion}</p>}
      </Block>

      <Block title="More">
        <fieldset className="shape-severity">
          <legend>When a rule is broken, it is</legend>
          {(["violation", "warning"] as const).map((severity) => (
            <label key={severity} className="rule-check">
              <input
                type="radio"
                name={`severity-${shape.id}`}
                checked={shape.severity === severity}
                aria-disabled={busy}
                onChange={() => !busy && void run("severity", "SetShapeSeverity", { shape: shape.id, severity })}
              />
              {severity === "violation" ? "A problem" : "A warning"}
            </label>
          ))}
        </fieldset>
        {errors.severity && <p className="edit-error">{errors.severity}</p>}
        <h5>Message shown with every failure</h5>
        <InlineText
          label="message"
          value={shape.message}
          multiline
          busy={busy}
          error={errors.message}
          onSave={async (value) => (await run("message", "SetShapeMessage", { shape: shape.id, value })) !== null}
        />
      </Block>

      <Block title="Delete">
        <button ref={deleteRef} type="button" className="ghost danger" onClick={() => setConfirmDelete(true)}>
          Delete this shape
        </button>
        {errors.delete && <p className="edit-error">{errors.delete}</p>}
      </Block>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${shape.name}?`}
          escape="cancel"
          busy={busy}
          actions={[
            { id: "delete", label: "Delete", danger: true, primary: true },
            { id: "cancel", label: "Cancel" },
          ]}
          onAnswer={async (answer) => {
            if (answer !== "delete") {
              setConfirmDelete(false);
              window.setTimeout(() => deleteRef.current?.focus(), 0);
              return;
            }
            if (await run("delete", "DeleteShape", { shape: shape.id })) {
              setConfirmDelete(false);
              onDeleted();
            } else {
              setConfirmDelete(false);
            }
          }}
        >
          <p>
            {ruleCount === 0
              ? "It has no rules."
              : `Its ${ruleCount === 1 ? "rule goes" : `${ruleCount} rules go`} with it.`}{" "}
            Undo brings it back.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
