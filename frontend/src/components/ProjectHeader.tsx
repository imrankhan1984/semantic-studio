/*
================================================================================
FILE: frontend/src/components/ProjectHeader.tsx
================================================================================

SUMMARY
    The header's context row while a project is open (authoring-foundations
    5.2, 5.4.2): the project's name, a document switcher, the save status in
    words, Undo, Redo and Save, the language menu with the display-language
    switch and the missing-translation counts, Save a copy, and Close.

BASIC IDEA
    Reads the project store and calls its actions; App is told only about what
    it has to arbitrate -- switching document and closing, which may first need
    "Apply, discard, or stay?" or "Save, discard, or stay?" -- and about
    failures, which go to its error bar.

    Status is text ("Saved", "Unsaved changes", "Saving…"), never a coloured
    dot alone. Undo and Redo carry what they would undo in their accessible
    names and titles. Unavailable controls are aria-disabled rather than
    disabled: pressing Undo until nothing is left would otherwise disable the
    button holding focus, and a disabled button drops it.

    Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z) and Ctrl+S work anywhere in the page
    except inside a text field, where the field's own undo wins (Section 6).
    The listener is on the document, so it works wherever focus is.

    The live region is here, polite, and rendered while empty, because a
    region added at the same moment as its text is unreliably announced (the
    HomeScreen lesson). It says each applied change and the status after it:
    "Created class Invoice. Unsaved changes."

INPUTS / INPUT SOURCES (props)
    - onSwitchDocument, onClose, onError: what App arbitrates.
    - onSaveCopy: download the current document as Turtle.
    Plus the project store.

EXPECTED OUTPUT
    - The row; store actions and the callbacks above.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { addShapesDocument, getLanguageReport } from "../api";
import { validLanguageTag } from "../projects/form";
import {
  STATUS_WORDS,
  activeDocument,
  projectStore,
  saveStatus,
  useProjectStore,
} from "../state/projectStore";
import type { LanguageReport, ProjectDocName } from "../types";

interface Props {
  /** Runs `then` once any unapplied Turtle has been applied or discarded:
   *  Undo, Redo and Save change the document under the editor, so they ask
   *  first, as every other exit does. */
  guard?: (then: () => void) => void;
  onSwitchDocument: (doc: ProjectDocName) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onSaveCopy: () => void;
}

/** A text field owns its own undo (Section 6). */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
}

const DOC_FILES: Record<ProjectDocName, string> = { model: "model.ttl", shapes: "shapes.ttl" };

const NO_GUARD = (then: () => void) => then();

export default function ProjectHeader({
  guard = NO_GUARD,
  onSwitchDocument,
  onClose,
  onError,
  onSaveCopy,
}: Props) {
  const state = useProjectStore();
  const project = state.project!;
  const current = activeDocument(state);
  const status = saveStatus(state);
  const [langOpen, setLangOpen] = useState(false);
  const [report, setReport] = useState<LanguageReport | null>(null);
  const [newLang, setNewLang] = useState("");
  const [langError, setLangError] = useState<string | null>(null);
  const langPanelId = useId();
  const langButton = useRef<HTMLButtonElement>(null);
  const langPanel = useRef<HTMLDivElement>(null);

  const run = (action: () => Promise<unknown>) => {
    action().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  };

  const canUndo = current?.canUndo ?? false;
  const canRedo = current?.canRedo ?? false;
  const undo = () => canUndo && guard(() => run(() => projectStore.undo()));
  const redo = () => canRedo && guard(() => run(() => projectStore.redo()));
  const save = () => !state.saving && guard(() => run(() => projectStore.save()));

  // The shortcuts, rebound when what they would do changes.
  const keys = useRef({ undo, redo, save });
  keys.current = { undo, redo, save };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || inTextField(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        keys.current.save();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        keys.current.redo();
      } else if (key === "z") {
        e.preventDefault();
        keys.current.undo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The counts are asked for when the menu opens, and again after a change,
  // so a translation just added is reflected without closing the menu.
  useEffect(() => {
    if (!langOpen || !current) return;
    let live = true;
    getLanguageReport(project.id, current.doc)
      .then((r) => live && setReport(r))
      .catch(() => live && setReport(null));
    return () => {
      live = false;
    };
  }, [langOpen, project.id, current?.doc, current?.revision, project.languages.join(",")]);

  useEffect(() => {
    if (langOpen) langPanel.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [langOpen]);

  const closeLang = () => {
    setLangOpen(false);
    langButton.current?.focus();
  };

  const languages = [project.primaryLanguage, ...project.languages];
  const display = state.displayLanguage ?? project.primaryLanguage;

  const addLanguage = () => {
    const tag = newLang.trim();
    if (!validLanguageTag(tag)) {
      setLangError("Use a language tag such as fr, es or pt-BR.");
      return;
    }
    setLangError(null);
    setNewLang("");
    run(() => projectStore.setLanguages([...project.languages, tag]));
  };

  const hasShapes = state.documents.some((d) => d.doc === "shapes");

  return (
    <div className="project-header">
      <span className="context-label">PROJECT</span>
      <span className="project-name" title={project.name}>
        {project.name}
      </span>

      <label className="visually-hidden" htmlFor="project-doc-select">
        Document
      </label>
      <select
        id="project-doc-select"
        value={state.activeDoc}
        onChange={(e) => onSwitchDocument(e.target.value as ProjectDocName)}
        title="The document open for editing"
      >
        {state.documents.map((d) => (
          <option key={d.doc} value={d.doc}>
            {DOC_FILES[d.doc]}
            {d.dirty ? " (unsaved)" : ""}
          </option>
        ))}
      </select>
      {!hasShapes && (
        <button
          className="ghost"
          onClick={() =>
            run(async () => {
              await addShapesDocument(project.id);
              await projectStore.reload();
            })
          }
          title="Add an empty shapes.ttl for SHACL shapes"
        >
          Add shapes.ttl
        </button>
      )}

      <span className={`project-status project-status-${status}`}>{STATUS_WORDS[status]}</span>

      <button
        className="ghost"
        aria-disabled={!canUndo}
        aria-label={canUndo ? `Undo: ${current?.undoLabel}` : "Undo"}
        title={canUndo ? `Undo: ${current?.undoLabel} (Ctrl+Z)` : "Nothing to undo"}
        onClick={undo}
      >
        Undo
      </button>
      <button
        className="ghost"
        aria-disabled={!canRedo}
        aria-label={canRedo ? `Redo: ${current?.redoLabel}` : "Redo"}
        title={canRedo ? `Redo: ${current?.redoLabel} (Ctrl+Y)` : "Nothing to redo"}
        onClick={redo}
      >
        Redo
      </button>
      <button
        className={status === "unsaved" ? "primary" : "ghost"}
        aria-disabled={state.saving}
        title="Save to the project's file (Ctrl+S)"
        onClick={save}
      >
        Save
      </button>

      <div className="onto-menu-wrap project-lang-wrap">
        <button
          ref={langButton}
          className="ghost"
          aria-expanded={langOpen}
          aria-controls={langPanelId}
          onClick={() => (langOpen ? closeLang() : setLangOpen(true))}
          title="Which language names are shown in, and which languages this project has"
        >
          Language: {display}
        </button>
        <div
          className="onto-menu project-lang-menu"
          id={langPanelId}
          ref={langPanel}
          hidden={!langOpen}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closeLang();
            }
          }}
        >
          {langOpen && (
            <>
              <fieldset className="project-lang-display">
                <legend>Show names in</legend>
                {languages.map((lang) => (
                  <label key={lang}>
                    <input
                      type="radio"
                      name="project-display-language"
                      checked={display === lang}
                      onChange={() => projectStore.setDisplayLanguage(lang)}
                    />
                    {lang}
                    {lang === project.primaryLanguage ? " (primary)" : ""}
                    {report && report.missing[lang] > 0 && (
                      <span className="project-lang-missing">
                        {" "}
                        — {report.missing[lang].toLocaleString()} of{" "}
                        {report.entities.toLocaleString()} entities have no name in {lang}
                      </span>
                    )}
                  </label>
                ))}
              </fieldset>
              {project.languages.length > 0 && (
                <ul className="project-lang-list" aria-label="Additional languages">
                  {project.languages.map((lang) => (
                    <li key={lang}>
                      {lang}{" "}
                      <button
                        className="ghost"
                        aria-label={`Remove ${lang} from this project's languages`}
                        onClick={() =>
                          run(() =>
                            projectStore.setLanguages(project.languages.filter((l) => l !== lang)),
                          )
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="project-lang-add">
                <label htmlFor="project-new-language">Add a language</label>
                <input
                  id="project-new-language"
                  value={newLang}
                  placeholder="fr"
                  onChange={(e) => setNewLang(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addLanguage();
                  }}
                  aria-invalid={langError ? true : undefined}
                  aria-describedby={langError ? "project-new-language-error" : undefined}
                />
                <button className="ghost" onClick={addLanguage}>
                  Add
                </button>
                {langError && (
                  <p id="project-new-language-error" className="form-error">
                    {langError}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <button className="ghost" onClick={onSaveCopy} title="Download this document as Turtle">
        Save a copy
      </button>
      <button className="ghost" onClick={onClose} title="Close the project and return home">
        Close project
      </button>

      <div className="visually-hidden" role="status" aria-live="polite">
        {/* Keyed on the counter, so "Undid: … " said twice is heard twice. */}
        <span key={state.announcement.id}>{state.announcement.text}</span>
      </div>
    </div>
  );
}
