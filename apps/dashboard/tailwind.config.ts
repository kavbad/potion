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
        paper: '#faf9f6', // warm off-white page background
        ink: '#292524', // stone-800 — primary text
        soft: '#57534e', // stone-600 — secondary text
        faint: '#a8a29e', // stone-400 — captions/ticks
        line: '#e7e2da', // warm hairline borders / grid
        panel: '#ffffff',
        accent: {
          DEFAULT: '#0f766e', // teal-700 — the one accent
          soft: '#ccfbf1', // teal-100 — accent wash
        },
        warn: '#b45309', // amber-700 — alerts
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
