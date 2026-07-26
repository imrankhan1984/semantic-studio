/**
 * Abstract brand mark: three open arcs turning around a faceted core — an
 * aperture for "studio", and relations converging on a concept for the
 * semantics. Colours come from CSS variables so it follows the theme.
 */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable={false}
    >
      <g strokeWidth="3.4" strokeLinecap="round">
        <path className="logo-arc-1" d="M18.92 6.44 A10 10 0 0 1 25.74 18.25" />
        <path className="logo-arc-2" d="M22.82 23.31 A10 10 0 0 1 9.18 23.31" />
        <path className="logo-arc-3" d="M6.26 18.25 A10 10 0 0 1 13.08 6.44" />
      </g>
      <rect
        className="logo-core"
        x="12.4"
        y="12.4"
        width="7.2"
        height="7.2"
        rx="1.5"
        transform="rotate(45 16 16)"
      />
    </svg>
  );
}

export default function Logo() {
  return (
    <div className="brand" title="Semantic Studio">
      <LogoMark />
      <div className="brand-text">
        <div className="brand-name">
          <span className="brand-name-1">SEMANTIC</span>
          <span className="brand-name-2">STUDIO</span>
        </div>
        <div className="brand-tagline">ONTOLOGY WORKSPACE</div>
      </div>
    </div>
  );
}
