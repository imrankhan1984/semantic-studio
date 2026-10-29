/*
================================================================================
FILE: frontend/src/components/ProjectHeader.tsx
================================================================================

SUMMARY
    The header's context row while a project is open (authoring-foundations
    5.2, 5.4.2; edit-page-rework 5.2): one row, never wrapped -- the
    project's name, a document switcher, the save status as a dot and a
    word, Undo, Redo and Save; then **Turtle**, which opens the document in
    View's Turtle editor, and a ⋯ menu holding Language (the display-language
    switch and the missing-translation counts), Description… (reference-
    ontologies 5.5), Add shapes.ttl while there is none, Save a copy, Show
    canvas and Close project.

BASIC IDEA
    Reads the project store and calls its actions; App is told only about what
    it has to arbitrate -- switching document and closing, which may first need
    "Apply, discard, or stay?" or "Save, discard, or stay?" -- and about
    failures, which go to its error bar.

    Status is text ("Saved", "Unsaved changes", "Saving…"), never a coloured
    dot alone. Undo and Redo carry what they would undo in their accessible
    names and titles, so where the row is narrow and they shrink to icons
    nothing is lost. Unavailable controls are aria-disabled rather than
    disabled: pressing Undo until nothing is left would otherwise disable the
    button holding focus, and a disabled button drops it.

    The ⋯ menu is the WAI-ARIA menu button: arrow keys, Home and End move
    through it, Escape closes it and gives focus back to ⋯, and a press
    outside closes it. *Language…* opens the language panel beside it,
    whose Escape gives focus back to ⋯ too. *Show canvas* is a checkbox
    item: its state is aria-checked and a tick, never colour. *Description…*
    gives focus to ⋯ before its dialog opens, so the dialog gives it back
    there; unapplied Turtle is asked about first, as Undo asks, since a
    save changes the document under the editor.

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
    - onTurtle: open the current document in the Turtle editor (View).
    - canvas: the Show canvas switch, on the Edit page only.
    Plus the project store.

EXPECTED OUTPUT
    - The row; store actions and the callbacks above.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { addShapesDocument, getLanguageReport } from "../api";
import DescriptionDialog from "./DescriptionDialog";
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
  onTurtle?: () => void;
  canvas?: { on: boolean; onToggle: () => void } | null;
}

type MenuAction = "language" | "description" | "shapes" | "copy" | "canvas" | "close";

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
  onTurtle,
  canvas = null,
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
  const menuId = useId();
  // The ⋯ button: the menu's and the language panel's way back.
  const langButton = useRef<HTMLButtonElement>(null);
  const langPanel = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [describing, setDescribing] = useState(false);
  const model = state.documents.find((d) => d.doc === "model");

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

  // The menu: focus to its first item as it opens; a press outside closes.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus();
    const outside = (e: MouseEvent) => {
      const wrap = langButton.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    langButton.current?.focus();
  };

  const moveInMenu = (step: number | "first" | "last") => {
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = step === "first" ? 0 : step === "last" ? all.length - 1 : (at + step + all.length) % all.length;
    all[next]?.focus();
  };

  const chooseMenu = (action: MenuAction) => {
    setMenuOpen(false);
    if (action === "language") {
      setLangOpen(true);
      return;
    }
    // Every other item leaves the menu for a control that is still there.
    langButton.current?.focus();
    if (action === "description") {
      if (!model?.header) {
        onError("This model has no ontology header (owl:Ontology) to describe. Add one in Turtle first.");
        return;
      }
      guard(() => setDescribing(true));
    } else if (action === "shapes") {
      run(async () => {
        await addShapesDocument(project.id);
        await projectStore.reload();
      });
    } else if (action === "copy") onSaveCopy();
    else if (action === "canvas") canvas?.onToggle();
    else onClose();
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
      <span className={`project-status project-status-${status}`}>
        <span className="project-status-dot" aria-hidden="true" />
        {STATUS_WORDS[status]}
      </span>

      <button
        className="ghost"
        aria-disabled={!canUndo}
        aria-label={canUndo ? `Undo: ${current?.undoLabel}` : "Undo"}
        title={canUndo ? `Undo: ${current?.undoLabel} (Ctrl+Z)` : "Nothing to undo"}
        onClick={undo}
      >
        {/* The word, or an icon where the row is narrow (5.2); the name is
            the aria-label either way. */}
        <span className="ph-icon" aria-hidden="true">↶</span>
        <span className="ph-word">Undo</span>
      </button>
      <button
        className="ghost"
        aria-disabled={!canRedo}
        aria-label={canRedo ? `Redo: ${current?.redoLabel}` : "Redo"}
        title={canRedo ? `Redo: ${current?.redoLabel} (Ctrl+Y)` : "Nothing to redo"}
        onClick={redo}
      >
        <span className="ph-icon" aria-hidden="true">↷</span>
        <span className="ph-word">Redo</span>
      </button>
      <button
        className={status === "unsaved" ? "primary" : "ghost"}
        aria-disabled={state.saving}
        title="Save to the project's file (Ctrl+S)"
        onClick={save}
      >
        Save
      </button>

      <span className="spacer" />
      {onTurtle && (
        <button className="ghost" onClick={onTurtle} title="Edit this document as Turtle, in View">
          Turtle
        </button>
      )}
      <div className="onto-menu-wrap project-lang-wrap">
        <button
          ref={langButton}
          className="ghost project-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label="More project actions"
          title="Language, Description, Save a copy, Show canvas, Close project"
          onClick={() => {
            setLangOpen(false);
            setMenuOpen((open) => !open);
          }}
        >
          ⋯
        </button>
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More project actions"
          className="onto-menu project-menu"
          hidden={!menuOpen}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") moveInMenu(1);
            else if (e.key === "ArrowUp") moveInMenu(-1);
            else if (e.key === "Home") moveInMenu("first");
            else if (e.key === "End") moveInMenu("last");
            else if (e.key === "Escape") closeMenu();
            else if (e.key === "Tab") {
              setMenuOpen(false);
              return;
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <li role="none">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => chooseMenu("language")}>
              Language: {display}…
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => chooseMenu("description")}>
              Description…
            </button>
          </li>
          {!hasShapes && (
            <li role="none">
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => chooseMenu("shapes")}>
                Add shapes.ttl
              </button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => chooseMenu("copy")}>
              Save a copy
            </button>
          </li>
          {canvas && (
            <li role="none">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={canvas.on}
                tabIndex={-1}
                onClick={() => chooseMenu("canvas")}
              >
                <span className="project-menu-check" aria-hidden="true">
                  {canvas.on ? "✓" : ""}
                </span>
                Show canvas
              </button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => chooseMenu("close")}>
              Close project
            </button>
          </li>
        </ul>
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

      {describing && model?.header && (
        <DescriptionDialog
          ontologyId={model.ontologyId}
          header={model.header}
          primaryLanguage={project.primaryLanguage}
          onClose={() => setDescribing(false)}
        />
      )}

      <div className="visually-hidden" role="status" aria-live="polite">
        {/* Keyed on the counter, so "Undid: … " said twice is heard twice. */}
        <span key={state.announcement.id}>{state.announcement.text}</span>
      </div>
    </div>
  );
}
