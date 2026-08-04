---
name: a11y-check
description: Accessibility check for any new or changed interactive element in Semantic Studio. Use when adding a control, a panel, a menu, or anything clickable.
---

# Accessibility check

Measured on 2026-07-26, the application exposed **thirteen** interactive
elements to assistive technology for the entire interface. The graph, the legend
rows and the search results were all absent, so a screen reader user could pick
an ontology and then do nothing with it.

Measured again on 2026-07-31 after `keyboard-and-motion` (backlog X-1), on the
built application with the space ontology open: **33 interactive elements, every
one of them carrying an accessible name**, plus the graph canvas exposed as a
named image. Do not spend that.

## For every interactive element you touch

1. **Is it a real button or link?** A `div` or `li` with an `onClick` is not
   reachable by keyboard. Use a `button`, or add a role, `tabIndex`, and key
   handlers for Enter and Space. The two long-standing offenders — legend rows
   in `Legend.tsx` and search results in `SearchBox.tsx` — were fixed on
   2026-07-31 and both have tests that fail if they come back.
2. **Can you see focus?** `index.css` carries one global `:focus-visible` rule
   and `focus-visible.test.ts` fails if anything suppresses it. Do not add a
   per-component focus rule: there is exactly one documented exception, D-022 on
   the start screen, and it is not a precedent.
3. **What does a screen reader say?** Icon-only controls need an `aria-label`,
   and so does anything whose only contents are a glyph — a button reading "＋"
   is announced as "＋". Do not assume name-from-contents survives every
   consumer: `next-steps-dropdown` measured one reporting a `title` instead, and
   the house habit since is to state the name explicitly and assert in a test
   that it agrees with the visible text. State changes need announcing too, with
   `aria-pressed`, `aria-expanded`, or a polite live region.
4. **Is anything conveyed only by color?** Node kind and edge kind are colored
   today with no second channel, which is backlog G-2. Anything new needs shape,
   text, or pattern as well.
5. **Does it animate?** `index.css` carries a global
   `@media (prefers-reduced-motion: reduce)` rule, so CSS transitions and
   animations are covered wherever they are declared. **A stylesheet cannot
   reach motion driven from JavaScript**: `GraphView.tsx` reads the media query
   to apply the force layout in one pass rather than animating it and to give
   every camera move a zero duration, and `SourceView.tsx` reads it for a scroll
   option. Anything you add that moves from JavaScript has to read it too.

## Verify, do not assume

Read the page as assistive technology sees it and confirm your element appears
with a sensible accessible name. Then tab through the interface and confirm you
can reach it and see where you are. If the element does not appear in the
accessibility tree, it does not exist for a screen reader user, whatever it
looks like on screen.

**jsdom cannot do this for you.** It implements neither layout nor sequential
focus navigation, so a `userEvent.tab()` loop tests the polyfill rather than the
tab order. The house pattern is to assert document order and the absence of
`tabindex` in the suite, and to measure the real order in a browser. Chrome's
`Accessibility.getFullAXTree` over the DevTools Protocol is how the counts above
were taken and is the fastest way to see what is actually exposed;
`Input.dispatchKeyEvent` drives real Tab, Space, arrow and Enter presses. Note
that Enter needs a full `keyDown` carrying `text`, not a `rawKeyDown`, or Chrome
never activates the button.

## What is still missing

The graph canvas has an accessible **equivalent**, not keyboard navigation:
`role="img"`, a label stating how much of the ontology is drawn, and a skip link
to the entity list. That is D-025, taken deliberately, and it means a keyboard
user gets a path through the ontology and not the spatial view. Do not re-open
it, and do not describe the application as WCAG conformant — nothing here is an
audit.

## What to write in the spec

`CLAUDE.md` requires three statements for every new interactive element: how it
is reached from the keyboard, what shows focus, and what a screen reader
announces. Write those three before building, not after.
