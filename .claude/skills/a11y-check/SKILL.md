---
name: a11y-check
description: Accessibility check for any new or changed interactive element in Semantic Studio. Use when adding a control, a panel, a menu, or anything clickable.
---

# Accessibility check

Measured on 2026-07-26: the application exposes **thirteen** interactive
elements to assistive technology for the entire interface. The graph, the legend
rows, and the search results are all absent, so a screen reader user can pick an
ontology and then do nothing with it. Do not add to that debt.

## For every interactive element you touch

1. **Is it a real button or link?** A `div` or `li` with an `onClick` is not
   reachable by keyboard. Use a `button`, or add a role, `tabIndex`, and key
   handlers for Enter and Space. Known offenders today: legend rows in
   `Legend.tsx`, search results in `SearchBox.tsx`.
2. **Can you see focus?** `index.css` sets `outline: none` on focused inputs and
   selects, leaving only a border color change. Anything you add needs a visible
   focus indicator that does not rely on color alone.
3. **What does a screen reader say?** Icon-only controls need an `aria-label`.
   State changes need to be announced.
4. **Is anything conveyed only by color?** Node kind and edge kind are colored
   today with no second channel, which is backlog G-2. Anything new needs shape,
   text, or pattern as well.
5. **Does it animate?** There is no `prefers-reduced-motion` rule anywhere in
   the stylesheet, while the default view is a continuously running physics
   simulation. Add one for any motion you introduce.

## Verify, do not assume

Read the page as assistive technology sees it and confirm your element appears
with a sensible accessible name. Then tab through the interface and confirm you
can reach it and see where you are. If the element does not appear in the
accessibility tree, it does not exist for a screen reader user, whatever it
looks like on screen.

## What to write in the spec

`CLAUDE.md` requires three statements for every new interactive element: how it
is reached from the keyboard, what shows focus, and what a screen reader
announces. Write those three before building, not after.
