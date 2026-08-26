import type { Config } from 'tailwindcss';

/**
 * Design language (SPEC §9 "money shot" brief): warm paper neutrals, ONE
 * accent (muted teal), no gradients, generous whitespace. A non-technical
 * buyer should read the frontier chart in 5 seconds.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // exa re-skin: the ground goes clean white; warmth now lives in the
        // artifacts (receipt, band, ticks), not the page itself.
        paper: '#ffffff',
        ink: '#292524', // stone-800 — primary text
        soft: '#57534e', // stone-600 — secondary text
        faint: '#a8a29e', // stone-400 — captions/ticks
        line: '#e7e5e4', // cool hairline borders / grid
        panel: '#ffffff',
        accent: {
          DEFAULT: '#0f766e', // teal-700 — the one accent
          soft: '#ccfbf1', // teal-100 — accent wash
        },
        warn: '#b45309', // amber-700 — alerts
        kept: {
          DEFAULT: '#0E5B43', // ledger green — ONLY for kept money and held bars
          soft: '#DFEDE4',
        },
        refuse: {
          DEFAULT: '#A03B25', // the refusal stamp — worn, never hidden
          soft: '#F5E3DC',
        },
      },
      boxShadow: {
        /* The glaze's single elevation: every raised artefact wears exactly
           this — a tight contact shadow plus a soft long one, both drawn
           from ink, never grey. One shadow = one light source = one object. */
        paper: '0 1px 2px rgba(41,37,36,0.05), 0 12px 32px -16px rgba(41,37,36,0.14)',
        /* the hover tier of the same light source — used only by .lift */
        'paper-lift': '0 2px 4px rgba(41,37,36,0.06), 0 20px 44px -18px rgba(41,37,36,0.20)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
