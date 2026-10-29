/*
================================================================================
FILE: frontend/src/components/SettingsDialog.tsx
================================================================================

SUMMARY
    Settings (home-and-settings 5.4, D-120): the one dialog for choices about
    the application itself, opened from the header's Settings button. Three
    tabs: Network (today's panel, NetworkPanel), Library (the catalogue,
    *Add the examples back* and where the work is kept, LibrarySettings) and
    Limits (the three limits a person can change, LimitsSettings).

BASIC IDEA
    A modal like About and the Load dialog: role="dialog", aria-modal,
    labelled by its heading, which takes focus on open. Escape, the ✕ and a
    click on the backdrop close it, and the caller gives focus back to the
    Settings button (App holds it, as it holds About's).

    The tabs are the ARIA tablist pattern (5.7): one tab stop, the selected
    tab; Left and Right move between tabs and select as they go, Home and End
    go to the ends; Tab leaves the tablist for the panel. Selection follows
    focus because no panel costs anything to show.

    Every panel stays mounted and the hidden ones are `hidden`, rather than
    unmounting: a catalogue load running in Library is cancelled by
    unmounting (useLoadRun), and a look at Network must not do that; nor
    must it lose a limit typed but not yet saved.
    Network reads its two lists again each time its tab is chosen (it is
    keyed on the visit), so a site allowed or a download made while Library
    showed is there to see and to revoke.

    GET /api/settings is read once, when the dialog opens (never on the app's
    mount, whose two requests are a load-bearing rule): Library shows its
    data folder and Limits its three limits. A Save's answer replaces it.

    Closing with a limit typed but not saved asks once, in the dialog, as the
    Load dialog asks over a mapping: *Close* closes and discards, *Keep
    editing* (or Escape again) goes back to Limits. Every way out asks: the
    ✕, Escape and the backdrop. A catalogue entry that finished loading
    closes without asking; the person chose that.

    The key handler is on `document` (a load-bearing rule for every dialog
    here): a click on the panel's own prose blurs focus to <body>, where a
    panel-scoped handler would see nothing. A key pressed while another
    modal is open over this one is that dialog's: the network approval can
    open over any screen, since any request may meet a site not yet decided
    about, and its Escape must not close Settings under it. (A catalogue
    entry's own download asks nothing: pressing it is the consent.)

INPUTS / INPUT SOURCES (props)
    - initialTab: the tab to open on; Network unless a caller names another
      (the Load dialog's refusal for a limit names Limits).
    - onClose: every way of closing.
    - onLoaded / onLibraryChanged / examplesMissing / onExamplesRestored:
      passed to the Library tab.

EXPECTED OUTPUT
    - The dialog and its backdrop; GET /api/settings once per opening.
================================================================================
*/

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getSettings, type AppSettings, type ExamplesRestored } from "../api";
import { LEAVE_QUESTION } from "../limitWords";
import type { OntologySummary } from "../types";
import LibrarySettings from "./LibrarySettings";
import LimitsSettings from "./LimitsSettings";
import NetworkPanel from "./NetworkPanel";
import { wrapTab } from "./useDialogTrap";

export type SettingsTab = "network" | "library" | "limits";

/** The tabs in their order (home-and-settings 5.4). */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "network", label: "Network" },
  { id: "library", label: "Library" },
  { id: "limits", label: "Limits" },
];

interface Props {
  initialTab?: SettingsTab;
  onClose: () => void;
  onLoaded: (summary: OntologySummary) => void;
  onLibraryChanged?: () => void;
  examplesMissing: number;
  onExamplesRestored?: (result: ExamplesRestored) => void;
}

export default function SettingsDialog({
  initialTab = "network",
  onClose,
  onLoaded,
  onLibraryChanged,
  examplesMissing,
  onExamplesRestored,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // The limits and the data folder, read once per opening.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsFailed, setSettingsFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getSettings().then(
      (answer) => {
        if (live) setSettings(answer);
      },
      (e: unknown) => {
        if (live) setSettingsFailed(`Could not read the settings: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // Each visit to Network mounts its panel afresh, which reads the policy
  // and the activity again; the first visit is the opening one.
  const [networkVisit, setNetworkVisit] = useState(0);
  const select = (next: SettingsTab) => {
    if (next === "network" && tab !== "network") setNetworkVisit((n) => n + 1);
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  // A limit typed but not saved; and, once a close was asked for, the
  // question standing in the dialog.
  const [limitsDirty, setLimitsDirty] = useState(false);
  const onDirtyChange = useCallback((dirty: boolean) => setLimitsDirty(dirty), []);
  const [asking, setAsking] = useState(false);
  const askOrClose = () => {
    if (limitsDirty) setAsking(true);
    else onClose();
  };
  const keepEditing = () => {
    setAsking(false);
    select("limits");
  };

  const escape = useRef(askOrClose);
  escape.current = () => (asking ? keepEditing() : askOrClose());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || e.defaultPrevented) return;
      const over = [...document.querySelectorAll('[aria-modal="true"]')].some((d) => d !== panel);
      if (over) return;
      if (e.key === "Escape") {
        e.preventDefault();
        escape.current();
        return;
      }
      wrapTab(panel, e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (at - 1 + TABS.length) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    select(TABS[to].id);
  };

  return (
    <>
      {/* The backdrop is the dialog's sibling, as About's is: aria-hidden on
          an ancestor would take the dialog out of the accessibility tree. */}
      <div className="modal-backdrop" aria-hidden="true" onClick={askOrClose} />
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
      >
        <button className="icon-btn about-close" onClick={askOrClose} aria-label="Close Settings">
          ✕
        </button>
        <h2 id="settings-heading" ref={headingRef} tabIndex={-1} className="settings-heading">
          Settings
        </h2>

        {asking && (
          <div className="wizard-actions wizard-leave" role="group" aria-label="Close without saving?">
            <span>{LEAVE_QUESTION}</span>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button type="button" className="primary" autoFocus onClick={keepEditing}>
              Keep editing
            </button>
          </div>
        )}

        <div className="tabs settings-tabs" role="tablist" aria-label="Settings">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={`settings-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => select(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          id="settings-panel-network"
          role="tabpanel"
          aria-labelledby="settings-tab-network"
          hidden={tab !== "network"}
        >
          <NetworkPanel key={networkVisit} />
        </div>
        <div
          id="settings-panel-library"
          role="tabpanel"
          aria-labelledby="settings-tab-library"
          hidden={tab !== "library"}
        >
          <LibrarySettings
            onLoaded={onLoaded}
            onLibraryChanged={onLibraryChanged}
            examplesMissing={examplesMissing}
            onExamplesRestored={onExamplesRestored}
            focusTab={() => tabRefs.current.library?.focus()}
            dataDir={settings ? settings.dataDir : null}
            onOpenLimits={() => select("limits")}
          />
        </div>
        <div
          id="settings-panel-limits"
          role="tabpanel"
          aria-labelledby="settings-tab-limits"
          hidden={tab !== "limits"}
        >
          <LimitsSettings
            settings={settings}
            failed={settingsFailed}
            onSaved={setSettings}
            onDirtyChange={onDirtyChange}
          />
        </div>
      </div>
    </>
  );
}
