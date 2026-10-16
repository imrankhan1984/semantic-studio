/*
================================================================================
FILE: frontend/src/components/ProjectsSection.tsx
================================================================================

SUMMARY
    A project's card in Home's one library (home-and-examples 5.5; it was
    the "My projects" section of authoring-foundations 5.1 until the
    person's projects and files joined one grid). Each project card shows
    its name, its kind (*Ontology* or *Taxonomy*, relationships 5.1), when
    it last changed, its documents and its counts, a line for each of its
    data snapshots with its label (csv-data-import 5.7: *from people.csv,
    imported 2 October 2026*, a sample's words included, and *off* when
    switched off), an Open button, and a menu with Rename, Change to
    taxonomy… (or ontology…), Duplicate, Export as zip and Delete.

BASIC IDEA
    Everything on a card comes from the project list App fetched on mount,
    which the server builds from manifests alone, so a project card, like
    the rest of the Home screen, costs no request of its own and parses
    nothing. HomeScreen places the cards among the library's; the heading,
    New project and the empty sentence are its.

    The menu is a disclosure of plain buttons, OntologyCard's pattern and for
    its reason: role="menu" would promise arrow keys and typeahead. Rename
    happens in place, in a labelled field that Enter saves and Escape
    abandons, rather than in a browser prompt. Delete is App's, because the
    confirmation and the sentence saying where the folder went belong with the
    live region App owns. So is Change to…, which asks first with one
    sentence of what changes: the tools, never the model (D-089).

INPUTS / INPUT SOURCES (props)
    - project: the project's summary.
    - busy: an action is running on this project, which then says so;
      disabled: one is running on some project.
    - layout: "card" or "row", as the library around it is laid out.
    - openRef: set on the library's first entry, for Home's start focus.
    - onOpen, onRename, onChangeKind, onDuplicate, onExport, onDelete.

EXPECTED OUTPUT
    - The card, and one callback per action.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { dataLabel } from "../modeling/dataSentences";
import type { ProjectSummary } from "../types";

/** What a project card's controls do; App owns every one of them. */
export interface ProjectActions {
  onOpen: (pid: string) => void;
  onRename: (pid: string, name: string) => Promise<void>;
  onChangeKind: (pid: string) => void;
  onDuplicate: (pid: string) => void;
  onExport: (pid: string) => void;
  onDelete: (pid: string) => void;
}

interface Props extends ProjectActions {
  project: ProjectSummary;
  busy: boolean;
  disabled: boolean;
  layout?: "card" | "row";
  openRef?: React.RefObject<HTMLButtonElement>;
}

/** "Changed 28 Sep 2026", in the reader's locale. */
function changedOn(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Changed ${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

function plural(n: number | undefined, one: string, many: string): string {
  const count = n ?? 0;
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export default function ProjectCard({
  project,
  busy,
  disabled,
  layout = "card",
  openRef,
  onOpen,
  onRename,
  onChangeKind,
  onDuplicate,
  onExport,
  onDelete,
}: Props) {
  const headingId = useId();
  const menuId = useId();
  const renameId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  const finishRename = async (save: boolean) => {
    if (save && draft.trim() && draft.trim() !== project.name) {
      try {
        await onRename(project.id, draft.trim());
      } catch (e: unknown) {
        setRenameError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setRenameError(null);
    setRenaming(false);
    setDraft(project.name);
    // The field is going; the menu button is the stable thing to return to.
    requestAnimationFrame(() => menuButton.current?.focus());
  };

  const act = (action: (pid: string) => void) => () => {
    closeMenu();
    action(project.id);
  };

  return (
    <article
      className={layout === "row" ? "onto-card onto-row project-card" : "onto-card project-card"}
      aria-labelledby={headingId}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <div className="onto-body">
        <div className="onto-head">
          {renaming ? (
            <div className="project-rename">
              <label htmlFor={renameId} className="visually-hidden">
                New name for {project.name}
              </label>
              <input
                id={renameId}
                ref={renameInput}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={renameError ? true : undefined}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void finishRename(true);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    void finishRename(false);
                  }
                }}
              />
              <button className="ghost" onClick={() => void finishRename(true)}>
                Save name
              </button>
              <button className="ghost" onClick={() => void finishRename(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <h3 id={headingId} className="onto-name" title={project.name}>
              {project.name}
            </h3>
          )}
          <div className="onto-menu-wrap">
            <button
              ref={menuButton}
              className="ghost icon-btn onto-menu-btn"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-haspopup="true"
              aria-label={`More actions for ${project.name}`}
              // aria-disabled, not disabled: the action this card starts puts
              // focus here, and a disabled button would drop it.
              aria-disabled={disabled}
              onClick={() => !disabled && setMenuOpen((was) => !was)}
            >
              <span aria-hidden="true">⋮</span>
            </button>
            <div className="onto-menu" id={menuId} ref={menuRef} hidden={!menuOpen}>
              {menuOpen && (
                <>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </button>
                  {/* A project from before kinds gets its kind when it is
                      first opened; until then there is nothing to change. */}
                  {project.kind && (
                    <button onClick={act(onChangeKind)}>
                      {project.kind === "ontology" ? "Change to taxonomy…" : "Change to ontology…"}
                    </button>
                  )}
                  <button onClick={act(onDuplicate)}>Duplicate</button>
                  <button onClick={act(onExport)}>Export as zip</button>
                  <button className="danger" onClick={act(onDelete)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {renameError && <p className="form-error">{renameError}</p>}
        {project.kind && <p className="project-kind">{project.kind === "ontology" ? "Ontology" : "Taxonomy"}</p>}
        <p className="onto-summary">
          {plural(project.counts.classes, "class", "classes")},{" "}
          {plural(project.counts.properties, "property", "properties")},{" "}
          {plural(project.counts.concepts, "concept", "concepts")}
        </p>
        {(project.data ?? []).map((source) => (
          <p key={source.id} className="project-data data-label">
            Data {dataLabel(source)}
            {source.enabled ? "" : " (off)"}
          </p>
        ))}
        <p className="project-meta">
          <span>{changedOn(project.updatedAt)}</span>
          <span>{project.documents.map((d) => d.file).join(", ")}</span>
        </p>
        <div className="onto-verbs">
          <button
            ref={openRef}
            className="primary"
            aria-disabled={disabled}
            aria-label={`Open ${project.name}`}
            onClick={() => !disabled && onOpen(project.id)}
          >
            {busy ? "Working…" : "Open"}
          </button>
        </div>
      </div>
    </article>
  );
}
