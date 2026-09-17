# Head-to-head — 2026-09-17

Potion (`potion-auto`, policy `h2h-floor-0.95`) vs `openrouter/auto` vs `anthropic/claude-sonnet-4.5`, 182 scored items across 10 kinds of work (20/cluster max), max_tokens 1600, judge judge-class, prices 2026-08-04-or2+tranche-2026-08-19+or-hy4-preview… (+6513 chars). Spent $1.90 of a $30 cap.

| | Potion | auto | incumbent |
|---|---|---|---|
| quality (mean) | 0.916 | 0.924 | 0.841 |
| cost (total) | $0.4810 | $0.0538 | $0.5189 |
| answered | 182/182 | 182/182 | 182/182 |

**Cost ratio, Potion ÷ auto: 8.95x [5.47–13.46]. Potion ÷ incumbent: 0.93x [0.56–1.37].** Potion fallback rate 48.9%; resolved off the suite's label on 38 item(s).

## Per kind of work

| kind of work | n | Potion q | auto q | incumbent q | Potion $ | auto $ | incumbent $ | Potion÷auto | Potion÷incumbent |
|---|---|---|---|---|---|---|---|---|---|
| code-gen | 20 | 0.911 | 0.900 | 0.950 | $0.0232 | $0.0145 | $0.1100 | 1.61x [0.18–3.78] | 0.21x [0.02–0.62] |
| extraction | 20 | 0.931 | 0.988 | 0.981 | $0.0037 | $0.0051 | $0.0560 | 0.73x [0.52–1.04] | 0.07x [0.06–0.07] |
| classification | 20 | 1.000 | 1.000 | 0.950 | $0.0009 | $0.0006 | $0.0091 | 1.36x [1.15–1.58] | 0.09x [0.08–0.11] |
| multi-step-reasoning | 20 | 1.000 | 1.000 | 0.250 | $0.0002 | $0.0005 | $0.0384 | 0.37x [0.23–0.59] | 0.01x [0.00–0.01] |
| rag-answer | 20 | 0.900 | 0.900 | 0.750 | $0.0019 | $0.0005 | $0.0103 | 3.90x [1.17–7.66] | 0.18x [0.06–0.33] |
| agentic-tool-use | 14 | 0.807 | 0.900 | 0.907 | $0.0337 | $0.0130 | $0.1645 | 2.60x [0.43–6.37] | 0.20x [0.03–0.49] |
| code-review | 20 | 0.930 | 0.890 | 0.945 | $0.0115 | $0.0046 | $0.0286 | 2.48x [1.65–3.15] | 0.40x [0.35–0.46] |
| creative | 14 | 0.779 | 0.836 | 0.871 | $0.0343 | $0.0090 | $0.0339 | 3.79x [2.51–5.48] | 1.01x [0.94–1.11] |
| rewrite-edit | 20 | 0.880 | 0.885 | 0.930 | $0.3601 | $0.0042 | $0.0380 | 86.40x [55.08–119.29] | 9.48x [6.26–12.81] |
| summarization | 14 | 0.964 | 0.900 | 0.936 | $0.0116 | $0.0017 | $0.0300 | 6.71x [4.84–10.20] | 0.39x [0.28–0.50] |

## What decided the headline (Potion's five costliest items)

| item | label | resolved | Potion $ | auto $ | served |
|---|---|---|---|---|---|
| rewrite-edit-013 | rewrite-edit | rewrite-edit | $0.0476 | $0.0002 | or-claude-opus-5-fast |
| rewrite-edit-001 | rewrite-edit | rewrite-edit | $0.0408 | $0.0004 | or-claude-opus-5-fast |
| rewrite-edit-003 | rewrite-edit | rewrite-edit | $0.0350 | $0.0004 | or-claude-opus-5-fast |
| rwh-02 | rewrite-edit | rewrite-edit | $0.0350 | $0.0003 | or-claude-opus-5-fast |
| rwh-06 | rewrite-edit | rewrite-edit | $0.0301 | $0.0001 | or-claude-opus-5-fast |

## What the auto-router picked

- openai/gpt-5.6-luna: 86
- deepseek/deepseek-v4-flash-0731: 68
- z-ai/glm-5.3-flash: 23
- google/gemini-2.5-flash: 5
