# Potion design guide — the lab look

Shareable page: https://claude.ai/code/artifact/de32f40d-f968-4883-a63c-f8cce5f6370f
(private by default; share from the page's menu). Every value below is the one
in the code (`apps/dashboard/tailwind.config.ts`, `app/globals.css`,
`app/layout.tsx`, `components/landing.tsx`), read 2026-08-23.

## Colour — two neutrals, one hairline, one accent; the accent only touches data

| name | hex | use |
|---|---|---|
| paper | `#f4f2ec` | the ground, everywhere (5% fractal-noise grain, multiply, behind everything) |
| panel | `#fbfaf7` | figures, receipts, tables, forms — never white |
| ink | `#292524` | primary text, flat buttons |
| charcoal band | `#1c1a17` | full-bleed evidence sections; foreground `#efece4`, hairline `#3f3b35`, captions `#a8a29e` |
| soft | `#57534e` | secondary text, ledes |
| faint | `#a8a29e` | captions, eyebrows, margin labels, ticks, table heads |
| hairline | `#d9d5cb` | every border and divider, 1px — replaces cards, shadows, radii |
| control | `#b8b3a6` | slider tracks, inactive control strokes |
| accent | `#0f766e` | data only: measured quality, savings, the frontier line, the mark |
| accent wash | `#ccfbf1` | a highlighted data cell, the fill under a frontier — sparingly |
| warn | `#b45309` | alerts, refusals, budget stops (semantic, not a second accent) |

Legacy: the Tailwind config still carries `paper: #ffffff` and `line: #e7e5e4`
from an earlier white re-skin; the lab look overrides them inline and is the truth.

## Type — Inter 400/500, IBM Plex Mono 400/500; no serif, ever

| role | face | size / leading / tracking |
|---|---|---|
| display (hero h1) | Inter 500 | 3.2–5.25rem / 1.02 / −0.035em |
| section heading (h2) | Inter 500 | 2–2.5rem / 1.12 / −0.02em |
| lede / body | Inter 400 | 15–16px / 1.6, max 62ch |
| UI text | Inter 400 | 13px / 1.6 |
| mono (receipts, traces, numbers) | IBM Plex Mono 400/500 | 12px / 1.6 |
| caption / margin label | IBM Plex Mono 400 | 11px, uppercase, .18em |
| eyebrow | IBM Plex Mono 400 | 10px, uppercase, .14–.16em |

Headings are medium, never bold. `text-wrap: balance` on headings, `pretty` on
paragraphs; tabular figures wherever digits line up.

## Layout — numbered margin labels, framed figures, hairlines not cards

- Page width 72rem, 1.5rem side padding. Section grid: 10rem label column + 1fr,
  3rem gap (≥1024px); the label stacks above content below that.
- Section padding 5–7rem vertical; a 1px hairline at the top of each section.
- Section numbers are a real sequence — never number a list that isn't one.
- Every artifact sits in a 1px hairline frame on panel with a mono caption
  underneath that states the date and n (intervals 95% CI; filled points on
  the frontier, hollow dominated).
- No radii, no shadows, no gradients, no pastel washes, no console chrome.
- The hero's visualisation is fixed-size and never changes dimensions.
- App shell: paper ground, 15rem sidebar with a right hairline, Mark in accent.

## Components

- Primary button: ink on paper, 12–14px medium, square, hover opacity .9,
  active 1px down, focus = 2px accent outline. Secondary: hairline outline.
- Receipt: mono 12px on panel in a hairline frame; keys faint, values ink,
  measured numbers accent.
- Table: heads 10px mono uppercase faint; numbers mono, tabular, right-aligned;
  quality in accent.
- Mark: the vessel, 24-unit stroke icon, 1.6 stroke, round caps — ink on
  paper or accent beside the wordmark; never filled, never on a gradient.

## Motion — short, eased, once

fade 300–420 ms ease-out · route draw 700–900 ms cubic-bezier(.2,.7,.2,1) ·
travel 700–900 ms cubic-bezier(.3,0,.2,1) · settle ring 1200 ms once · hero
tick every 3400 ms in a fixed box · reduced-motion gets the final frame.
Nothing bobs, loops for decoration, floats, or lifts on hover.

## Voice and standing rules

Always: short bullets; the number, the date, the n; plain words first with the
term in parentheses; structure that encodes order.
Never: a serif (permanent); supplier or vendor names on the public landing
page (the signed-in app may show the model); "learn from site X" as anything
but structure; a claim without the measurement behind it.
