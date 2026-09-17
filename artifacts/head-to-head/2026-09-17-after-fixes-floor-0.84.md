# Head-to-head — 2026-09-17

Potion (`potion-auto`, policy `h2h-floor-0.84`) vs `openrouter/auto` vs `anthropic/claude-sonnet-4.5`, 182 scored items across 10 kinds of work (20/cluster max), max_tokens 1600, judge judge-class, prices 2026-08-04-or2+tranche-2026-08-19+or-hy4-preview… (+6513 chars). Spent $1.45 of a $30 cap.

| | Potion | auto | incumbent |
|---|---|---|---|
| quality (mean) | 0.916 | 0.917 | 0.842 |
| cost (total) | $0.0953 | $0.0554 | $0.5031 |
| answered | 182/182 | 182/182 | 182/182 |

**Cost ratio, Potion ÷ auto: 1.72x [1.23–2.29]. Potion ÷ incumbent: 0.19x [0.13–0.25].** Potion fallback rate 3.3%; resolved off the suite's label on 41 item(s).

## Per kind of work

| kind of work | n | Potion q | auto q | incumbent q | Potion $ | auto $ | incumbent $ | Potion÷auto | Potion÷incumbent |
|---|---|---|---|---|---|---|---|---|---|
| code-gen | 20 | 0.860 | 0.950 | 0.900 | $0.0022 | $0.0142 | $0.1071 | 0.15x [0.12–0.19] | 0.02x [0.02–0.02] |
| extraction | 20 | 0.919 | 0.988 | 0.981 | $0.0014 | $0.0053 | $0.0562 | 0.27x [0.20–0.36] | 0.03x [0.03–0.03] |
| classification | 20 | 1.000 | 1.000 | 0.950 | $0.0004 | $0.0006 | $0.0091 | 0.57x [0.45–0.68] | 0.04x [0.03–0.05] |
| multi-step-reasoning | 20 | 0.950 | 1.000 | 0.250 | $0.0004 | $0.0005 | $0.0381 | 0.73x [0.29–1.36] | 0.01x [0.00–0.02] |
| rag-answer | 20 | 0.900 | 0.800 | 0.750 | $0.0007 | $0.0006 | $0.0103 | 1.16x [0.23–3.20] | 0.06x [0.01–0.17] |
| agentic-tool-use | 14 | 0.950 | 0.893 | 0.921 | $0.0114 | $0.0112 | $0.1548 | 1.02x [0.24–2.40] | 0.07x [0.02–0.16] |
| code-review | 20 | 0.875 | 0.895 | 0.990 | $0.0177 | $0.0067 | $0.0237 | 2.64x [1.25–4.80] | 0.75x [0.53–1.03] |
| creative | 14 | 0.879 | 0.829 | 0.886 | $0.0340 | $0.0081 | $0.0354 | 4.19x [2.67–7.47] | 0.96x [0.87–1.02] |
| rewrite-edit | 20 | 0.915 | 0.855 | 0.925 | $0.0268 | $0.0058 | $0.0390 | 4.62x [2.09–8.77] | 0.69x [0.46–0.88] |
| summarization | 14 | 0.914 | 0.936 | 0.936 | $0.0004 | $0.0024 | $0.0294 | 0.16x [0.10–0.31] | 0.01x [0.01–0.02] |

## What decided the headline (Potion's five costliest items)

| item | label | resolved | Potion $ | auto $ | served |
|---|---|---|---|---|---|
| agentic-tool-use-002 | agentic-tool-use | code-review | $0.0053 | $0.0006 | combination:cascade |
| crh-p03 | code-review | code-review | $0.0050 | $0.0005 | combination:cascade |
| creative-011 | creative | creative | $0.0048 | $0.0019 | or-sonnet |
| creative-009 | creative | creative | $0.0043 | $0.0004 | or-sonnet |
| creative-005 | creative | creative | $0.0038 | $0.0003 | or-sonnet |

## What the auto-router picked

- openai/gpt-5.6-luna: 85
- deepseek/deepseek-v4-flash-0731: 67
- z-ai/glm-5.3-flash: 25
- google/gemini-2.5-flash: 5
