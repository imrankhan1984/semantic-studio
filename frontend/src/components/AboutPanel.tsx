/*
================================================================================
FILE: frontend/src/components/AboutPanel.tsx
================================================================================

SUMMARY
    The About dialog: what this application is, who made it, where its source
    lives, under what licence, and the promise that ontologies loaded into it
    never leave the machine. Four blocks of static text separated by hairlines,
    over a dimmed backdrop.

BASIC IDEA
    Everything shown here is a constant in this file. The panel makes no
    request, reads no ontology and renders nothing derived from one, which is
    why it opens identically on the chooser screen with nothing loaded — the
    moment a newcomer most wants to know what they are looking at.

    The copy is exported as ABOUT rather than written inline, for two reasons:
    a test asserts the copyright holder and licence match the repository's
    LICENSE file, so a change to one that is not mirrored here fails the suite
    instead of leaving the interface making a false statement; and the line
    lengths are a stated design property (45 to 70 characters at the panel's
    width) that can only be measured against the strings, jsdom having no
    layout.

    The dialog behaviour is the substance of the component. Focus moves to the
    heading on open, is trapped inside the panel while it is open, and is
    returned to the About control by the caller on close. The key handler is on
    `document` rather than on the panel: clicking the panel's own text moves
    focus to <body> in a real browser, and a panel-scoped handler would then
    never see the Escape that follows.

INPUTS / INPUT SOURCES (props)
    - onClose: called for the close control, for Escape, and for a click on the
      backdrop. The caller is what restores focus to the control that opened
      the panel, because only it holds that element.

EXPECTED OUTPUT
    - The rendered dialog and its backdrop, and onClose on each of the three
      dismissal routes.
================================================================================
*/

import { useEffect, useRef } from "react";

/**
 * Everything the panel says.
 *
 * `licence` and `repository` are facts about the project, not decoration:
 * `AboutPanel.test.tsx` reads the repository's LICENSE file and asserts the
 * holder and year here agree with it.
 *
 * The privacy pair is the one line in this file that is a promise rather than a
 * description. It is true of the application by construction and is enforced by
 * the four network and resource specifications and their tests. If any future
 * feature ever sends ontology content anywhere, these two sentences must change
 * in the same commit — see about-panel.md Section 15, which names the two
 * backlog items that would engage it.
 */
export const ABOUT = {
  name: "Semantic Studio",
  purpose: "An ontology workspace for RDF, RDFS, OWL and SKOS.",
  description: "Explore vocabularies as a graph. Build SPARQL by clicking.",
  author: "Created by Imran Khan",
  repository: "https://github.com/imrankhan1984/semantic-studio",
  repositoryLabel: "View source and report issues →",
  licence: "MIT licensed · © 2026 Imran Khan",
  warranty: 'Provided "as is", without warranty of any kind.',
  privacy: "Your ontologies stay on this machine.",
  privacyDetail: "Semantic Studio does not upload them.",
} as const;

/** What Tab may land on inside the panel. The heading carries tabindex="-1" so
 *  it can be focused by script on open without joining the tab order, which is
 *  why the selector excludes that value rather than accepting any [tabindex]. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  onClose: () => void;
}

export default function AboutPanel({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus the heading on open. A dialog that leaves focus behind it is
  // unusable without a pointer: Tab would continue through the header behind
  // the backdrop, and a screen reader user would be told nothing had happened.
  //
  // No scoped focus rule accompanies this, deliberately. Script-driven focus
  // matches :focus-visible after a keyboard activation and not after a pointer
  // one (D-022), so a mouse user sees no ring on the heading — which is the
  // right outcome here, because the whole panel has just appeared over the
  // application and the heading is its first line. D-022's exception exists for
  // focus landing somewhere that shows nothing, which is not this.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape closes; Tab wraps at both ends. Bound to the document rather than to
  // the panel because focus does not necessarily stay on a focusable element:
  // pressing on the panel's own prose blurs to <body> in a browser, and from
  // there a panel-scoped handler sees neither key. Tab from outside the panel
  // is pulled back to its first control, which is what makes this a trap rather
  // than a pair of wrapping edges.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* The backdrop is a sibling of the dialog rather than its parent, which
          is the one structural difference from LoadDialog. aria-hidden on an
          ancestor removes the dialog from the accessibility tree entirely, so
          the decorative layer has to sit beside what it dims. It reuses
          .modal-backdrop for the dimming and the stacking; only the click
          target is its own. */}
      <div className="modal-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="about-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-panel-heading"
      >
        <button className="icon-btn about-close" onClick={onClose} aria-label="Close About">
          ✕
        </button>

        <div className="about-block">
          {/* tabIndex -1: focusable by the effect above, not by Tab. */}
          <h2 id="about-panel-heading" className="about-name" ref={headingRef} tabIndex={-1}>
            {ABOUT.name}
          </h2>
          <p className="about-purpose">{ABOUT.purpose}</p>
          <p className="about-description">{ABOUT.description}</p>
        </div>

        <hr className="about-rule" />

        <div className="about-block">
          <p className="about-author">{ABOUT.author}</p>
          {/* rel="noreferrer" implies noopener, which is what stops the opened
              page reaching back through window.opener. Same pattern as the IRI
              link in DetailPanel. */}
          <a
            className="about-link"
            href={ABOUT.repository}
            target="_blank"
            rel="noreferrer"
          >
            {ABOUT.repositoryLabel}
          </a>
        </div>

        <hr className="about-rule" />

        <div className="about-block about-licence">
          <p>{ABOUT.licence}</p>
          <p>{ABOUT.warranty}</p>
        </div>

        <hr className="about-rule" />

        <div className="about-block about-privacy">
          <p>{ABOUT.privacy}</p>
          <p>{ABOUT.privacyDetail}</p>
        </div>
      </div>
    </>
  );
}
