#!/usr/bin/env python3
"""Label feedback lines through Potion and show where each request was routed.

Usage:  POTION_API_KEY=... python triage.py feedback.txt
        cat feedback.txt | POTION_API_KEY=... python triage.py
"""
import os
import sys

from openai import APIError, OpenAI

BASE_URL = "https://api.withpotion.com/v1"
MODEL = "potion-auto"  # a label, not a model choice: the rule bound to the key decides
LABELS = ("positive", "negative", "neutral")
RECEIPT_FIELDS = ("cluster", "strategy", "policy", "provenance")

SYSTEM = (
    "You triage product feedback. Reply with exactly one line in the form\n"
    "<label> | <reason>\n"
    "where <label> is one of positive, negative, neutral and <reason> is one "
    "short sentence. No other text."
)


def parse_trace(header):
    """'cluster=a;strategy=b;...' -> {'cluster': 'a', 'strategy': 'b', ...}"""
    out = {}
    for part in (header or "").split(";"):
        key, sep, value = part.partition("=")
        if sep:
            out[key.strip()] = value.strip()
    return out


def parse_verdict(text):
    """'negative | checkout crashed' -> ('negative', 'checkout crashed')"""
    label, _, reason = text.strip().partition("|")
    label = label.strip().lower().rstrip(".")
    if label not in LABELS:
        return "unparsed", " ".join(text.split())
    return label, reason.strip()


def triage(ai, line):
    """Return (label, reason, receipt). receipt is None if the header is missing."""
    raw = ai.chat.completions.with_raw_response.create(
        model=MODEL,
        messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": line}],
    )
    header = raw.headers.get("x-frontier-trace")
    completion = raw.parse()
    label, reason = parse_verdict(completion.choices[0].message.content or "")
    return label, reason, parse_trace(header) if header else None


def receipt_text(receipt):
    if receipt is None:
        return "NO RECEIPT: request did not go through Potion"
    return " ".join(f"{k}={receipt.get(k, '?')}" for k in RECEIPT_FIELDS)


def print_table(rows, width=44):
    """Clip the free-text columns; never clip the receipt, it is the point."""
    head = ("text", "label", "reason", "routed to")
    clip = lambda s: s if len(s) <= width else s[: width - 1] + "…"
    rows = [(clip(t), lab, clip(why), rt) for t, lab, why, rt in rows]
    cols = [max(len(r[i]) for r in (head, *rows)) for i in range(len(head))]
    fmt = "  ".join(f"{{:<{c}}}" for c in cols)
    print(fmt.format(*head))
    print("  ".join("-" * c for c in cols))
    for r in rows:
        print(fmt.format(*r))


def main(argv):
    if not os.environ.get("POTION_API_KEY"):
        sys.exit("POTION_API_KEY is not set")
    source = open(argv[1], encoding="utf-8") if len(argv) > 1 else sys.stdin
    lines = [l.strip() for l in source if l.strip()]
    ai = OpenAI(base_url=BASE_URL, api_key=os.environ["POTION_API_KEY"])
    rows = []
    for line in lines:
        try:
            label, reason, receipt = triage(ai, line)
            rows.append((line, label, reason, receipt_text(receipt)))
        except APIError as e:  # budget_exceeded, auth, upstream 5xx: keep going
            rows.append((line, "error", str(e), "-"))
    print_table(rows)


if __name__ == "__main__":
    main(sys.argv)
