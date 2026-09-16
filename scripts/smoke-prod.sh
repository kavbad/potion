#!/usr/bin/env bash
# smoke-prod.sh — production smoke checks for Potion's OpenAI-compatible API.
#
# Usage:  POTION_API_KEY=... [POTION_API_URL=https://api.withpotion.com] bash scripts/smoke-prod.sh
# Needs:  bash, curl, python3. Makes 5 requests (4 chat, 1 models).
# Prints one PASS/FAIL line per check plus a SUMMARY line; exits 1 if any check fails.
# The key is only ever placed in a request header. Do not run with `bash -x`.
set -u

API_URL="${POTION_API_URL:-https://api.withpotion.com}"
if [ -z "${POTION_API_KEY:-}" ]; then echo "FAIL setup: POTION_API_KEY is not set"; exit 2; fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AUTH="Authorization: Bearer $POTION_API_KEY"
BODY='{"model":"potion-auto","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":12}'
pass=0; fail=0
ok()  { echo "PASS $1: $2"; pass=$((pass + 1)); }
bad() { echo "FAIL $1: $2"; fail=$((fail + 1)); }

# post NAME [curl args...] -> prints HTTP status; response headers/body land in $TMP/NAME.hdr|.body
post() {
  local name=$1; shift
  local code
  : > "$TMP/$name.hdr"; : > "$TMP/$name.body"   # exist even if curl never connects
  code=$(curl -sS -m 90 -o "$TMP/$name.body" -D "$TMP/$name.hdr" -w '%{http_code}' \
    -H "$AUTH" -H 'Content-Type: application/json' "$@" "$API_URL/v1/chat/completions" 2>/dev/null)
  echo "${code:-000}"
}
# hdr NAME HEADER -> value of a response header (case-insensitive), empty if absent
hdr() { tr -d '\r' < "$TMP/$1.hdr" | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }
# jget FILE EXPR -> evaluate a python expression against the parsed JSON body as `d`
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$1" "$2" 2>/dev/null; }

# 1. chat completion: 200 + x-frontier-trace with the expected fields
code=$(post c1 -d "$BODY")
trace=$(hdr c1 x-frontier-trace)
missing=""
# fallback=0 is REQUIRED (2026-09-16). This check passed 6/6 on a day every
# request was served by the platform default: the key's policy floor
# (0.978543771043771, an August row) admitted no measured point, so the
# server — correctly — declined to claim a measured pick and said so with
# fallback=1. A smoke test that is green while nothing is routed proves
# only that the fallback works. `traceWasRouted` in routes/chat.ts is the
# server's own definition: frontier=v<n>, n>0, AND fallback=0.
for field in cluster= strategy= policy= provenance=live 'fallback=0'; do
  case "$trace" in *"$field"*) ;; *) missing="$missing $field" ;; esac
done
if [ "$code" != 200 ]; then bad "chat completion" "HTTP $code (expected 200)"
elif [ -z "$trace" ]; then bad "chat completion" "200 but no x-frontier-trace header"
elif [[ "$trace" == *"fallback=1"* ]]; then bad "chat completion" "NOT ROUTED — fallback=1: this key's policy admitted no measured point, so the platform default served it. Bind the key to a feasible floor (Settings → your bar → apply to all keys). trace: $trace"
elif [ -n "$missing" ]; then bad "chat completion" "trace missing:$missing (got: $trace)"
else ok "chat completion" "200, x-frontier-trace: $trace"; fi

# 2. max_tokens honored (same response as check 1)
ct=$(jget "$TMP/c1.body" 'd["usage"]["completion_tokens"]')
if [ -n "$ct" ] && [ "$ct" -le 12 ] 2>/dev/null; then ok "max_tokens honored" "completion_tokens=$ct (limit 12)"
else bad "max_tokens honored" "completion_tokens=${ct:-unreadable} (limit 12)"; fi

# 3. streaming: text/event-stream, last line is data: [DONE]
code=$(post c3 -d '{"model":"potion-auto","messages":[{"role":"user","content":"Say hi"}],"max_tokens":8,"stream":true}')
ctype=$(hdr c3 content-type)
last=$(tr -d '\r' < "$TMP/c3.body" | grep -v '^$' | tail -1 | cut -c1-120)
if [ "$code" != 200 ]; then bad "streaming" "HTTP $code (expected 200)"
elif [[ "$ctype" != text/event-stream* ]]; then bad "streaming" "content-type '$ctype' (expected text/event-stream)"
elif [ "$last" != "data: [DONE]" ]; then bad "streaming" "last line '$last' (expected 'data: [DONE]')"
else ok "streaming" "text/event-stream, ended with data: [DONE]"; fi

# 4. cluster hint header is reflected in the trace
code=$(post c4 -H 'x-potion-cluster: classification' -d "$BODY")
trace=$(hdr c4 x-frontier-trace)
if [ "$code" != 200 ]; then bad "cluster hint" "HTTP $code (expected 200)"
elif [[ "$trace" != *cluster=classification* ]]; then bad "cluster hint" "trace did not say cluster=classification (got: ${trace:-none})"
else ok "cluster hint" "x-potion-cluster: classification -> trace cluster=classification"; fi

# 5. unknown cluster hint -> 400 cluster_not_found
code=$(post c5 -H 'x-potion-cluster: no-such-cluster-smoke' -d "$BODY")
ecode=$(jget "$TMP/c5.body" 'd["error"]["code"]')
if [ "$code" = 400 ] && [ "$ecode" = cluster_not_found ]; then ok "unknown cluster" "400 with code=cluster_not_found"
else bad "unknown cluster" "HTTP $code, code=${ecode:-none} (expected 400 cluster_not_found)"; fi

# 6. /v1/models lists potion-auto
code=$(curl -sS -m 30 -o "$TMP/c6.body" -w '%{http_code}' -H "$AUTH" "$API_URL/v1/models" 2>/dev/null)
listed=$(jget "$TMP/c6.body" 'any(m.get("id") == "potion-auto" for m in d.get("data", []))')
if [ "${code:-000}" != 200 ]; then bad "models" "HTTP ${code:-000} (expected 200)"
elif [ "$listed" != True ]; then bad "models" "potion-auto not in /v1/models data"
else ok "models" "/v1/models lists potion-auto"; fi

echo "SUMMARY: $pass passed, $fail failed against $API_URL"
[ "$fail" -eq 0 ] || exit 1
exit 0
