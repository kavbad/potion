# potion-check

Sends one prompt through Potion and prints the answer plus the parsed `x-frontier-trace` receipt
(cluster, strategy, frontier version, policy, fallback, provenance). Exits 2 if the header is missing.

    cd examples/node-receipt-check && npm install
    export POTION_API_KEY=...            # never commit or echo it
    node potion-check.ts "Is this review positive or negative? 'Crashed twice, support never replied.'"
    echo "Summarise: ..." | node potion-check.ts

Needs Node >= 23.6 (runs the `.ts` directly, no build). Set `POTION_BASE_URL` to target a self-hosted Potion.
