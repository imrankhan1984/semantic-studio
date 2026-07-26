/*
================================================================================
FILE: frontend/src/components/icons.tsx
================================================================================

SUMMARY
    A set of small inline SVG icons used in the header nav and toolbar (Load,
    View, Explore, Query, sun/moon theme toggle, trash).

BASIC IDEA
    Inlining a handful of stroked icons avoids an icon-font/library dependency.
    They inherit the surrounding text colour (stroke: currentColor) and share
    one `base` set of SVG attributes so they look consistent.

INPUTS / INPUT SOURCES
    - None; each is a stateless presentational component.

EXPECTED OUTPUT
    - <svg> icon elements coloured by their CSS context.
================================================================================
*/

// Shared SVG attributes: 20px, 24-unit viewBox, stroked in the current colour.
const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function IconLoad() {
  return (
    <svg {...base}>
      <path d="M12 3v11" />
      <path d="M8 10l4 4 4-4" />
      <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
    </svg>
  );
}

export function IconExplore() {
  return (
    <svg {...base}>
      <circle cx="6" cy="17" r="2.6" />
      <circle cx="17.5" cy="18.5" r="2.2" />
      <circle cx="12" cy="6" r="2.8" />
      <path d="M7.8 15.1L10.8 8.6" />
      <path d="M13.7 8.2l3 8.2" />
      <path d="M8.6 17.4l6.3.9" />
    </svg>
  );
}

export function IconView() {
  return (
    <svg {...base}>
      <path d="M5 4h9l5 5v11a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
      <path d="M14 4v5h5" />
      <path d="M8 13h7M8 17h5" />
    </svg>
  );
}

export function IconQuery() {
  return (
    <svg {...base}>
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </svg>
  );
}

export function IconSun() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function IconMoon() {
  return (
    <svg {...base}>
      <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" />
      <path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
    </svg>
  );
}
