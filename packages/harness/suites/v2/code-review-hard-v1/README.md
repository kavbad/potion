# code-review-hard-v1

code-review-hard-v1 — fixes two faults in the suite it replaces.
(1) INSTRUMENT: 16 of 28 items are localisation items scored by exact
match (name the defective line, or NONE), so most of this cluster no
longer depends on a judge whose trust bar G8 left indeterminate.
(2) NO-BUG CONTROLS: the old suite had none, and its rubric read
"0 = declares the code correct" — it rewarded inventing defects.
Nine items here are correct code, several baited to resemble a
famous bug, and every judge rubric penalises asserted defects that
are not present.
