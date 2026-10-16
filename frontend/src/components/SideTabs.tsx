/*
================================================================================
FILE: frontend/src/components/SideTabs.tsx
================================================================================

SUMMARY
    A labelled region with tabs and the panel of the one chosen. The Edit
    page's side panel (edit-page-rework 5.4) has **Details** and
    **Reasoning**, the default; Shapes gives its own, **Shape** and
    **Results** (load-and-shapes 5.3). What goes in each panel is the
    caller's: the detail panel stays in App.tsx (a load-bearing rule), so
    this draws only the frame.

BASIC IDEA
    The WAI-ARIA tabs pattern with automatic activation: one tab stop, the
    arrow keys (and Home, End) move between the tabs and choose as they go.
    A tab can carry a badge, *Reasoning · 3* or *Results · 3 problems*, when
    a run ended while another tab was showing; the badge is in the tab's
    accessible name too (*Reasoning, 3 new*, *Results, 3 problems*), so it
    is never only seen. The panel is rendered for the chosen tab only, so a
    hidden panel holds no focusable control.

INPUTS / INPUT SOURCES (props)
    - tab, onTab: the chosen tab, the caller's to keep.
    - tabs: each tab's id, name and badge; the Edit page's two by default.
    - badge: the Edit page's Reasoning count, or null, when `tabs` is not
      given.
    - label, className: the region's name and class; *Side panel* and
      `side-panel` by default.
    - wide: the canvas is hidden, so the panel fills the centre (5.10).
    - children: the chosen tab's content.

EXPECTED OUTPUT
    - The region, its tablist and one tabpanel.
================================================================================
*/

import { useId, useRef, type ReactNode } from "react";

export type SideTab = "details" | "reasoning";

/** One tab: what it is called, and what it carries after a run, if anything. */
export interface TabSpec<T extends string> {
  id: T;
  name: string;
  badge?: { shown: string; spoken: string } | null;
}

interface Props<T extends string> {
  tab: T;
  onTab: (tab: T) => void;
  tabs?: readonly TabSpec<T>[];
  badge?: number | null;
  label?: string;
  className?: string;
  children: ReactNode;
  wide?: boolean;
}

/** The Edit page's two tabs, Reasoning's count as *3* and *3 new*. */
function editTabs(badge: number | null): TabSpec<SideTab>[] {
  return [
    { id: "details", name: "Details" },
    {
      id: "reasoning",
      name: "Reasoning",
      badge: badge ? { shown: badge.toLocaleString("en-US"), spoken: `${badge} new` } : null,
    },
  ];
}

export default function SideTabs<T extends string = SideTab>({
  tab,
  onTab,
  tabs,
  badge = null,
  label = "Side panel",
  className = "side-panel",
  children,
  wide = false,
}: Props<T>) {
  const id = useId();
  const list = tabs ?? (editTabs(badge) as unknown as TabSpec<T>[]);
  const refs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});

  const move = (to: T) => {
    onTab(to);
    refs.current[to]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ids = list.map((t) => t.id);
    const at = ids.indexOf(tab);
    let to: T | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = ids[(at + 1) % ids.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = ids[(at + ids.length - 1) % ids.length];
    else if (e.key === "Home") to = ids[0];
    else if (e.key === "End") to = ids[ids.length - 1];
    if (to) {
      e.preventDefault();
      move(to);
    }
  };

  return (
    <aside className={wide ? `${className} wide` : className} aria-label={label}>
      <div className="side-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {list.map(({ id: name, name: text, badge: note }) => (
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
            aria-label={note ? `${text}, ${note.spoken}` : undefined}
          >
            {text}
            {note ? (
              <span className="side-tab-badge" aria-hidden="true">
                {" · "}
                {note.shown}
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
