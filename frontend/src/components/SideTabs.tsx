/*
================================================================================
FILE: frontend/src/components/SideTabs.tsx
================================================================================

SUMMARY
    The Edit page's side panel frame (edit-page-rework 5.4): a labelled
    region with two tabs, **Details** and **Reasoning**, and the panel of
    the one chosen. What goes in each panel is App's: the detail panel
    stays in App.tsx (a load-bearing rule), so this draws only the frame.

BASIC IDEA
    The WAI-ARIA tabs pattern with automatic activation: one tab stop, the
    arrow keys (and Home, End) move between the tabs and choose as they go.
    The Reasoning tab can carry a badge, *Reasoning · 3*, when a run ended
    while Details was showing; the count is in its accessible name too.
    The panel is rendered for the chosen tab only, so a hidden panel holds
    no focusable control.

INPUTS / INPUT SOURCES (props)
    - tab, onTab: the chosen tab, App's to keep.
    - badge: the Reasoning tab's count, or null.
    - wide: the canvas is hidden, so the panel fills the centre (5.10).
    - children: the chosen tab's content.

EXPECTED OUTPUT
    - The region, its tablist and one tabpanel.
================================================================================
*/

import { useId, useRef, type ReactNode } from "react";

export type SideTab = "details" | "reasoning";

interface Props {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  badge?: number | null;
  children: ReactNode;
  wide?: boolean;
}

const TABS: SideTab[] = ["details", "reasoning"];

export default function SideTabs({ tab, onTab, badge = null, children, wide = false }: Props) {
  const id = useId();
  const refs = useRef<Record<SideTab, HTMLButtonElement | null>>({ details: null, reasoning: null });

  const move = (to: SideTab) => {
    onTab(to);
    refs.current[to]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = TABS.indexOf(tab);
    let to: SideTab | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = TABS[(at + 1) % TABS.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = TABS[(at + TABS.length - 1) % TABS.length];
    else if (e.key === "Home") to = TABS[0];
    else if (e.key === "End") to = TABS[TABS.length - 1];
    if (to) {
      e.preventDefault();
      move(to);
    }
  };

  return (
    <aside className={wide ? "side-panel wide" : "side-panel"} aria-label="Side panel">
      <div className="side-tabs" role="tablist" aria-label="Side panel" onKeyDown={onKeyDown}>
        {TABS.map((name) => (
          <button
            key={name}
            ref={(el) => {
              refs.current[name] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            tabIndex={tab === name ? 0 : -1}
            className={tab === name ? "side-tab active" : "side-tab"}
            onClick={() => onTab(name)}
            aria-label={name === "reasoning" && badge ? `Reasoning, ${badge} new` : undefined}
          >
            {name === "details" ? "Details" : "Reasoning"}
            {name === "reasoning" && badge ? (
              <span className="side-tab-badge" aria-hidden="true">
                {" · "}
                {badge.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="side-tabpanel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {children}
      </div>
    </aside>
  );
}
