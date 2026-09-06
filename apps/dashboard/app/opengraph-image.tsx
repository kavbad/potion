// THE SHARE CARD. Until now a link to withpotion.com rendered in Slack, X or
// LinkedIn as whatever the platform had last scraped — through the entire
// compiler rename that meant "Potion — your router, built from evidence",
// with no image at all.
//
// It is the landing page's own composition, reduced to what survives at
// thumbnail size: the eyebrow, the headline, the mark under the last word.
// Same paper, same ink, same single teal. No gradient, no glow, no logo lockup
// — the house rules do not stop at the edge of the site.
//
// ImageResponse renders with a flexbox subset only: every element with more
// than one child needs an explicit display:flex, and grid does not exist here.
import { ImageResponse } from 'next/og';

export const alt = 'Potion — The Compiler for Inference';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const PAPER = '#f4f2ec';
const INK = '#1c1a17';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: PAPER,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 96px',
        }}
      >
        <div style={{ fontSize: 26, letterSpacing: 6, color: FAINT, display: 'flex' }}>
          MEASURED, NOT PREDICTED
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
          <div style={{ fontSize: 96, color: INK, letterSpacing: -3, display: 'flex' }}>
            The Compiler for
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
            <div style={{ fontSize: 96, color: INK, letterSpacing: -3, display: 'flex' }}>
              Inference
            </div>
            {/* the graduation mark, as on the page: beneath the word, never
                through it — a strike reads as negation */}
            <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 4 }}>
              <div style={{ width: 396, height: 6, background: ACCENT }} />
              <div style={{ width: 6, height: 26, background: ACCENT }} />
            </div>
          </div>
        </div>
        <div style={{ fontSize: 30, color: FAINT, marginTop: 54, display: 'flex', maxWidth: 940 }}>
          Every model measured on your work. Every request compiled to the lowest price your
          quality bar allows.
        </div>
      </div>
    ),
    size,
  );
}
