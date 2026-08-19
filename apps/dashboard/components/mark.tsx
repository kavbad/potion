/**
 * The Potion mark: a vessel with a measured fill line.
 *
 * The name gets ONE gesture and no more. The design language here is warm
 * paper, a single muted teal and no gradients, so a bubbling-cauldron
 * treatment would fight the thing the product is actually selling — sober,
 * measured evidence. What the glyph says instead is the product's own idea:
 * a level you can read off, drawn as a graduation mark rather than decoration.
 */
export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none">
      {/* vessel */}
      <path
        d="M9.5 3v5.2L4.9 17.4A2.6 2.6 0 0 0 7.2 21h9.6a2.6 2.6 0 0 0 2.3-3.6L14.5 8.2V3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* neck */}
      <path d="M8.6 3h6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* the measured level — filled, because the number is the point */}
      <path
        d="M6.6 14h10.8l1.7 3.4A2.6 2.6 0 0 1 16.8 21H7.2a2.6 2.6 0 0 1-2.3-3.6L6.6 14Z"
        fill="currentColor"
        opacity="0.16"
      />
      <path d="M6.6 14h10.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
