/*
================================================================================
FILE: frontend/src/components/AddVocabularyDialog.tsx
================================================================================

SUMMARY
    Add a vocabulary… (vocabularies-and-ontologies 5.3): four tabs --
    Bundled, Your library, File, Web address -- a choice in one of them,
    then one sentence saying what Add will write and one button that writes
    it. The learner never chooses between owl:imports and a prefix: the
    server reads the source and decides (D-128), and the sentence says
    which.

BASIC IDEA
    Choosing sends the source to inspect, which writes nothing to the
    document; the dialog then shows the sentence, the prefix in an editable
    field, and **Add <title>**. Add runs AddVocabulary through the project
    store, one undo step, and the live region reads the sentence again with
    *Added.* in front (5.3). A source already added offers *Show in the
    list* instead.

    A web address goes through `send`, so a host not yet allowed meets the
    existing approval dialog on top of this one; every key is then that
    dialog's (LoadDialog's rule). Offline, the Web address tab says so and
    reads nothing (5.9).

    The tabs are the ARIA tabs pattern: one tab stop, arrow keys, Home and
    End. The dialog traps Tab with wrapTab; Escape closes it while nothing
    is being read and asks while a read is on its way. Focus goes to the
    heading on open and back to the control that opened it on close --
    unless Add worked, when the section focuses the new row. Controls that
    cannot act are aria-disabled, never disabled.

INPUTS / INPUT SOURCES (props)
    - projectId, bundled: the open project and the twelve bundled ones.
    - initialTab, preset: the tab to open on and a source to read at once
      (a row's Add…).
    - readOnly: the document cannot change (Section 6, Disabled).
    - onAdded(iri): Add worked; onShowRow(iri): Show in the list; onClose.

EXPECTED OUTPUT
    - inspect requests, an AddVocabulary command, and the callbacks.
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getNetworkPolicy, inspectVocabulary, listOntologies } from "../api";
import { editDocId, projectStore } from "../state/projectStore";
import type { BundledVocabulary, OntologySummary, VocabularyChoice, VocabularyInspection } from "../types";
import { wrapTab } from "./useDialogTrap";
import {
  OFFLINE,
  READ_ONLY,
  TABS,
  addedWords,
  readingWord,
  validAddress,
  validPrefix,
  type SourceTab,
} from "../vocabularies/words";

interface Props {
  projectId: string;
  bundled: BundledVocabulary[];
  initialTab?: SourceTab;
  /** Read at once: a row's Add… on a bundled or library vocabulary. */
  preset?: VocabularyChoice | null;
  readOnly?: boolean;
  onAdded: (iri: string) => void;
  onShowRow: (iri: string) => void;
  onClose: () => void;
}

type Phase = "choosing" | "reading" | "summary" | "refused";

export default function AddVocabularyDialog({
  projectId,
  bundled,
  initialTab = "bundled",
  preset = null,
  readOnly = false,
  onAdded,
  onShowRow,
  onClose,
}: Props) {
  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [phase, setPhase] = useState<Phase>("choosing");
  const [reading, setReading] = useState("");
  const [found, setFound] = useState<VocabularyInspection | null>(null);
  const [refusal, setRefusal] = useState<{ message: string; technical: string | null } | null>(null);
  const [prefix, setPrefix] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [asking, setAsking] = useState(false);
  const [offline, setOffline] = useState(false);
  const [library, setLibrary] = useState<OntologySummary[] | null>(null);
  const [address, setAddress] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<SourceTab, HTMLButtonElement | null>>>({});
  const abort = useRef<AbortController | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Taken at the first render, before the heading takes focus (LoadDialog's rule).
  if (opener.current === null) opener.current = document.activeElement as HTMLElement | null;
  const closedByAdd = useRef(false);

  useEffect(() => {
    headingRef.current?.focus();
    let cancelled = false;
    getNetworkPolicy()
      .then((policy) => !cancelled && setOffline(Boolean(policy.offline)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      abort.current?.abort();
      const back = opener.current;
      if (!closedByAdd.current && back && back !== document.body && back.isConnected) back.focus();
    };
  }, []);

  // The library, only once its tab is shown: Home already lists it, and
  // the dialog's first look is the bundled one.
  useEffect(() => {
    if (tab !== "library" || library !== null) return;
    listOntologies()
      .then((all) => setLibrary(all))
      .catch(() => setLibrary([]));
  }, [tab, library]);

  const read = useCallback(
    async (choice: VocabularyChoice, name: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setPhase("reading");
      setReading(name);
      setFound(null);
      setRefusal(null);
      setAddError("");
      try {
        const result = await inspectVocabulary(projectId, choice, controller.signal);
        if (controller.signal.aborted) return;
        setFound(result);
        setPrefix(result.prefix);
        setPhase("summary");
      } catch (e) {
        if (controller.signal.aborted) return;
        // A file that does not parse: parse_errors.py's sentence, the raw
        // text kept under Technical details (D-112).
        const detail = e instanceof ApiError ? (e.detail as { message?: string; technical?: string } | undefined) : undefined;
        const message = typeof detail?.message === "string" ? detail.message : e instanceof Error ? e.message : String(e);
        setRefusal({ message, technical: typeof detail?.technical === "string" ? detail.technical : null });
        setPhase("refused");
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (preset) {
      const name =
        "bundled" in preset ? (bundled.find((b) => b.id === preset.bundled)?.title ?? preset.bundled) : "the vocabulary";
      void read(preset, name);
    }
    // The preset is read once, when the dialog opens.
  }, []);

  const stopReading = () => {
    abort.current?.abort();
    abort.current = null;
    setAsking(false);
    setPhase("choosing");
  };

  const escape = useRef<() => void>(() => {});
  escape.current = () => {
    if (asking) setAsking(false);
    else if (phase === "reading") setAsking(true);
    else onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || e.defaultPrevented) return;
      const target = e.target as Node | null;
      if (target && target !== document.body && !panel.contains(target)) return;
      // An approval over this dialog has every key (LoadDialog's rule).
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((d) => d !== panel)) return;
      if (e.key !== "Escape") {
        wrapTab(panel, e);
        return;
      }
      e.preventDefault();
      escape.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const chooseTab = (next: SourceTab, focus = false) => {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    const at = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    chooseTab(TABS[next].id, true);
  };

  const prefixOk = validPrefix(prefix.trim());
  const add = async () => {
    if (!found || adding || readOnly || !prefixOk) return;
    setAdding(true);
    setAddError("");
    try {
      await projectStore.command("AddVocabulary", { iri: found.iri, prefix: prefix.trim() }, () => addedWords(found.sentence), editDocId());
      closedByAdd.current = true;
      onAdded(found.iri);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const libraryEntries = useMemo(
    () => (library ?? []).filter((o) => !o.id.startsWith(`${projectId}-`)),
    [library, projectId],
  );

  const busy = phase === "reading";
  const panelId = (id: SourceTab) => `add-vocabulary-panel-${id}`;
  const tabId = (id: SourceTab) => `add-vocabulary-tab-${id}`;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        ref={panelRef}
        className="modal add-vocabulary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-vocabulary-title"
        aria-busy={busy}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="add-vocabulary-title" ref={headingRef} tabIndex={-1}>
            Add a vocabulary
          </h2>
          <button className="icon-btn" onClick={() => (busy ? setAsking(true) : onClose())} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs" role="tablist" aria-label="Where it comes from" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={tabId(t.id)}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={panelId(t.id)}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => chooseTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} className="add-vocabulary-panel">
          {tab === "bundled" && (
            <ul className="add-vocabulary-list">
              {bundled.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className="add-vocabulary-choice"
                    aria-disabled={busy}
                    aria-describedby={`bundled-${b.id}`}
                    onClick={() => !busy && void read({ bundled: b.id }, b.title)}
                  >
                    {b.title} <code>{b.prefix}:</code>
                  </button>
                  <span className="detail-note" id={`bundled-${b.id}`}>
                    {b.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {tab === "library" &&
            (library === null ? (
              <p className="detail-note" role="status">
                Reading your library…
              </p>
            ) : libraryEntries.length === 0 ? (
              <p className="detail-note">Your library has no ontology yet. Load one from Home.</p>
            ) : (
              <ul className="add-vocabulary-list">
                {libraryEntries.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      className="add-vocabulary-choice"
                      aria-disabled={busy}
                      onClick={() => !busy && void read({ ontologyId: o.id }, o.name)}
                    >
                      {o.name}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          {tab === "file" && (
            <label className="add-vocabulary-field">
              <span className="edit-field-label">One RDF file: Turtle, RDF/XML, JSON-LD, N-Triples or N3</span>
              <input
                type="file"
                aria-disabled={busy}
                accept=".ttl,.rdf,.owl,.xml,.jsonld,.json,.nt,.n3,.trig,.nq"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file && !busy) void read({ file }, file.name);
                }}
              />
            </label>
          )}
          {tab === "web" &&
            (offline ? (
              <p className="detail-note">{OFFLINE}</p>
            ) : (
              <form
                className="add-vocabulary-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy && validAddress(address)) void read({ url: address.trim() }, address.trim());
                }}
              >
                <label className="edit-field-label" htmlFor="add-vocabulary-url">
                  Web address
                </label>
                <input
                  id="add-vocabulary-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.org/vocabulary.ttl"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
                <button type="submit" className="ghost" aria-disabled={busy || !validAddress(address)}>
                  Read
                </button>
              </form>
            ))}
        </div>

        {/* The summary area (Section 6): one sentence and one button. The
            sentence is in a polite live region, read as it changes. */}
        <div className="add-vocabulary-summary">
          <p className="add-vocabulary-sentence" role="status" aria-live="polite">
            {phase === "reading" ? readingWord(reading) : phase === "summary" && found ? found.sentence : ""}
          </p>
          {phase === "reading" && (
            <button type="button" className="ghost" onClick={stopReading}>
              Cancel
            </button>
          )}
          {asking && (
            <div className="wizard-actions" role="group" aria-label="Stop reading?">
              <span>Stop reading {reading}?</span>
              <button type="button" onClick={stopReading}>
                Stop
              </button>
              <button type="button" className="ghost" onClick={() => setAsking(false)}>
                Keep reading
              </button>
            </div>
          )}
          {phase === "refused" && refusal && (
            <div className="edit-error" role="alert">
              <p>{refusal.message}</p>
              {refusal.technical && (
                <details>
                  <summary>Technical details</summary>
                  <pre>{refusal.technical}</pre>
                </details>
              )}
            </div>
          )}
          {phase === "summary" && found && (
            found.alreadyAdded ? (
              <p className="detail-note">
                Already added.{" "}
                <button type="button" onClick={() => onShowRow(found.iri)}>
                  Show in the list
                </button>
              </p>
            ) : (
              <div className="add-vocabulary-add">
                <label className="edit-field-label" htmlFor="add-vocabulary-prefix">
                  Prefix
                </label>
                <input
                  id="add-vocabulary-prefix"
                  value={prefix}
                  aria-invalid={!prefixOk}
                  aria-describedby={!prefixOk ? "add-vocabulary-prefix-rule" : undefined}
                  onChange={(e) => setPrefix(e.target.value)}
                />
                {!prefixOk && (
                  <span className="detail-note" id="add-vocabulary-prefix-rule">
                    A prefix starts with a letter and uses only letters, digits, hyphens and underscores.
                  </span>
                )}
                <button
                  type="button"
                  className="primary"
                  aria-disabled={adding || readOnly || !prefixOk}
                  aria-describedby={readOnly ? "add-vocabulary-read-only" : undefined}
                  onClick={() => void add()}
                >
                  {adding ? "Adding…" : `Add ${found.title}`}
                </button>
                {readOnly && (
                  <span className="detail-note" id="add-vocabulary-read-only">
                    {READ_ONLY}
                  </span>
                )}
                {addError && (
                  <p className="edit-error" role="alert">
                    {addError}
                  </p>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
