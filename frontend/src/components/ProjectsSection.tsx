/*
================================================================================
FILE: frontend/src/components/ProjectsSection.tsx
================================================================================

SUMMARY
    "My projects", the first section of the Home screen (authoring-foundations
    5.1): the user's own work, above the read-only library. Each project card
    shows its name, when it last changed, its documents and its counts, an
    Open button, and a menu with Rename, Duplicate, Export as zip and Delete.

BASIC IDEA
    Everything on a card comes from the project list App fetched on mount,
    which the server builds from manifests alone, so this section, like the
    rest of the Home screen, costs no request of its own and parses nothing.

    The menu is a disclosure of plain buttons, OntologyCard's pattern and for
    its reason: role="menu" would promise arrow keys and typeahead. Rename
    happens in place, in a labelled field that Enter saves and Escape
    abandons, rather than in a browser prompt. Delete is App's, because the
    confirmation and the sentence saying where the folder went belong with the
    live region App owns.

INPUTS / INPUT SOURCES (props)
    - projects, loading, error: the list and its state.
    - busyId: the project an action is running on, which then says so.
    - onNew, onOpen, onRename, onDuplicate, onExport, onDelete.

EXPECTED OUTPUT
    - The section, and one callback per action.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import type { ProjectSummary } from "../types";

interface Props {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  onNew: () => void;
  onOpen: (pid: string) => void;
  onRename: (pid: string, name: string) => Promise<void>;
  onDuplicate: (pid: string) => void;
  onExport: (pid: string) => void;
  onDelete: (pid: string) => void;
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

function ProjectCard({
  project,
  busy,
  disabled,
  onOpen,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
}: {
  project: ProjectSummary;
  busy: boolean;
  disabled: boolean;
} & Pick<Props, "onOpen" | "onRename" | "onDuplicate" | "onExport" | "onDelete">) {
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
      className="onto-card project-card"
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
        <p className="onto-summary">
          {plural(project.counts.classes, "class", "classes")},{" "}
          {plural(project.counts.properties, "property", "properties")},{" "}
          {plural(project.counts.concepts, "concept", "concepts")}
        </p>
        <p className="project-meta">
          <span>{changedOn(project.updatedAt)}</span>
          <span>{project.documents.map((d) => d.file).join(", ")}</span>
        </p>
        <div className="onto-verbs">
          <button
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

export default function ProjectsSection({
  projects,
  loading,
  error,
  busyId,
  onNew,
  onOpen,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
}: Props) {
  return (
    <section className="start-section" aria-labelledby="home-projects-heading">
      <div className="home-library-head">
        <h2 id="home-projects-heading">My projects</h2>
        <div className="home-controls">
          <button className="primary" onClick={onNew} disabled={busyId !== null}>
            New project
          </button>
        </div>
      </div>
      {loading ? (
        <p className="start-empty">Loading your projects…</p>
      ) : error ? (
        <p className="detail-error">{error}</p>
      ) : projects.length === 0 ? (
        <p className="start-empty">
          No projects yet. Start one from a template or from any ontology in your library.
        </p>
      ) : (
        <div className="onto-grid">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              busy={busyId === project.id}
              disabled={busyId !== null}
              onOpen={onOpen}
              onRename={onRename}
              onDuplicate={onDuplicate}
              onExport={onExport}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}
