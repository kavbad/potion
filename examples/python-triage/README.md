# python-triage

Labels feedback lines (positive / negative / neutral, plus a one-line reason) by sending each
line through Potion with the stock `openai` package, then prints the `x-frontier-trace` receipt
that says where the request was routed (cluster, strategy, policy, provenance).

    python3 -m venv .venv && .venv/bin/pip install openai
    POTION_API_KEY=<your key> .venv/bin/python triage.py feedback.txt
    cat feedback.txt | POTION_API_KEY=<your key> .venv/bin/python triage.py

A row reading `NO RECEIPT` means the response lacked the header, i.e. it did not go through Potion.
