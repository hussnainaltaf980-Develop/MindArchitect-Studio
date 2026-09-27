#!/usr/bin/env bash
# ── MindArchitect Studio · end-to-end gateway verification ───────────────────
#
# Proves the reply plane's behaviour through the REAL HTTP surface:
#
#   Phase A  no key configured   → x-ma-engine: local   (fallback, no network)
#   Phase B  mock key configured → x-ma-engine: gateway (real streamed deltas)
#   Phase C  each failure mode   → honest reason + the correct fallback decision
#
# The upstream in phases B/C is tools/mock-gateway.mjs — A MOCK. It is not a
# provider and has no model weights. What is REAL in every phase: the app's own
# /v1/chat/completions endpoint, its SSE framing, its `x-ma-engine` header, and
# its fallback decision — all exercised over HTTP against a live dev server.
#
# TWO HAZARDS THIS SCRIPT DELIBERATELY GUARDS AGAINST
#   1. A leftover server on the app port. An earlier revision of this script
#      "verified" phase B against a stale process that had no key set, and every
#      gateway assertion failed for a reason that had nothing to do with the
#      code. So each phase hard-kills whatever holds the port, waits for it to
#      free, starts its OWN server, and then waits until that server's health
#      output proves the expected env actually took effect.
#   2. Writing evidence into the watched app tree. The dev server runs
#      `tsx watch`, so creating files under /workspace/app restarts it mid-run.
#      Evidence therefore lives OUTSIDE the app directory.
#
# Usage: bash tools/verify-gateway-live.sh
set -uo pipefail

APP_PORT="${APP_PORT:-3000}"
# The dev API binds API_PORT (3001 by default); Vite owns APP_PORT (3000) and
# proxies /v1 + /trpc to it. Both ports must be freed between phases: killing
# only Vite leaves the OLD API holding 3001, and the next phase's API dies with
# EADDRINUSE — silently leaving the stale (wrong-env) server answering. That is
# exactly the bug that made every gateway assertion fail in an earlier revision.
API_PORT="${API_PORT:-3001}"
MOCK_PORT="${MOCK_PORT:-4599}"
SCENARIO_FILE="/tmp/mock-scenario.txt"
OUT_DIR="/workspace/evidence/gateway"
APP_LOG="/tmp/app-phase.log"
MOCK_LOG="/tmp/mock-gateway.log"
KEY_VALUE="sk-mock-0000000000000000"

mkdir -p "$OUT_DIR"
echo "ok" > "$SCENARIO_FILE"

pass=0
fail=0
declare -a RESULTS

note()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }

check() { # check <label> <expected-substring> <actual>
  # A here-string, NOT `printf … | grep`. grep -q exits on the first match,
  # which SIGPIPEs the writer; under `set -o pipefail` that surfaces as a
  # nonzero pipeline status and the check reports FAIL even though the needle
  # was present. It only bit on inputs larger than the pipe buffer (18 KB
  # bodies passed, one-line headers failed), which is what made it look like a
  # logic bug. `<<<` writes through a temp file, so there is no reader to race.
  if grep -qF -- "$2" <<<"$3"; then
    RESULTS+=("PASS | $1 | found: $2"); pass=$((pass + 1))
  else
    RESULTS+=("FAIL | $1 | expected: $2"); fail=$((fail + 1))
  fi
}

check_absent() { # check_absent <label> <forbidden-substring> <actual>
  # FAILS when the needle IS present — the opposite branch order from `check`,
  # which is what makes it a real leak test. (`grep` with no match reads to EOF,
  # so the SIGPIPE hazard above does not apply here; `<<<` is used anyway for
  # consistency.)
  if grep -qF -- "$2" <<<"$3"; then
    RESULTS+=("FAIL | $1 | LEAKED: $2"); fail=$((fail + 1))
  else
    RESULTS+=("PASS | $1 | absent: $2"); pass=$((pass + 1))
  fi
}

kill_port() { # kill_port <port> [port...] — hard-kill whatever holds them
  local p
  for p in "$@"; do
    pkill -f "vite dev --port ${p}" 2>/dev/null
    if command -v fuser >/dev/null 2>&1; then fuser -k "${p}/tcp" 2>/dev/null; fi
  done
  pkill -f "concurrently -k -n api,web" 2>/dev/null
  pkill -f "tsx watch" 2>/dev/null
  pkill -f "server/_core/index.ts" 2>/dev/null
  pkill -f "pnpm dev" 2>/dev/null
  local i=0
  for p in "$@"; do
    i=0
    while (( i < 20 )); do
      if ! curl -sS -o /dev/null -m 1 "http://127.0.0.1:${p}/" 2>/dev/null; then break; fi
      sleep 1; i=$((i + 1))
    done
  done
  sleep 1
  return 0
}

health_now() { curl -sS -m 15 "http://127.0.0.1:${APP_PORT}/v1/health?force=1" 2>/dev/null; }

start_app() { # start_app <env-assignments...>
  kill_port "$APP_PORT" "$API_PORT"
  : > "$APP_LOG"
  ( cd /workspace/app && exec env API_PORT="$API_PORT" "$@" pnpm dev ) >>"$APP_LOG" 2>&1 &
  APP_PID=$!
  local i=0
  while (( i < 120 )); do
    if curl -sS -o /dev/null -m 2 "http://127.0.0.1:${APP_PORT}/v1/health" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  echo "!! app not up in 120s — tail of log:"; tail -25 "$APP_LOG"; return 1
}

# Wait until health matches a pattern. This is what proves the PHASE'S OWN
# server answered: if a stale process were somehow still serving, the expected
# env fingerprint would never appear and the phase would fail loudly instead of
# silently testing the wrong thing.
await_health() { # await_health <grep-pattern> <label>
  local pattern="$1" label="$2" i=0 body=""
  while (( i < 45 )); do
    body=$(health_now)
    if printf '%s' "$body" | grep -qF -- "$pattern"; then
      printf '%s' "$body"; return 0
    fi
    sleep 2; i=$((i + 1))
  done
  echo "!! health never showed: $pattern (phase: $label)" >&2
  printf '%s' "$body"
  return 1
}

stop_app() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null
  kill_port "$APP_PORT" "$API_PORT"
  APP_PID=""
  sleep 1
}

cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null
  kill_port "$APP_PORT" "$API_PORT"
  sleep 1
}
trap cleanup EXIT

chat() { # chat <file-prefix>
  local prefix="$1" tmp
  tmp="$(mktemp)"
  # Write to a temp file and move it into place only after curl has exited, so a
  # reader can never observe a half-written body. (An earlier revision had body
  # assertions fail intermittently against a file curl had not finished
  # flushing.)
  curl -sS -N -m 60 -D "${prefix}.hdr.tmp" -o "$tmp" \
    -X POST "http://127.0.0.1:${APP_PORT}/v1/chat/completions" \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
    -d '{"model":"mindarchitect-synapse-v5.0","stream":true,"messages":[{"role":"user","content":"How does GQA repeat work in Forge?"}]}' \
    || true
  mv -f "$tmp" "${prefix}.body"
  mv -f "${prefix}.hdr.tmp" "${prefix}.hdr"
  sync 2>/dev/null || true
}

hdr_engine() { grep -i '^x-ma-engine:' "$1" 2>/dev/null | tr -d '\r' | awk '{print $2}'; }
hdr_reason() { grep -i '^x-ma-engine-reason:' "$1" 2>/dev/null | tr -d '\r' | awk '{print $2}'; }
cat_file()   { cat "$1" 2>/dev/null; }
streamed_text() { grep -o '"content":"[^"]*"' "$1" 2>/dev/null | sed 's/^"content":"//; s/"$//' | tr -d '\n'; }
count_deltas() { grep -c '"content"' "$1" 2>/dev/null || echo 0; }
hstatus() { printf '%s' "$1" | grep -o '"status":"[a-z-]*"' | head -1 | cut -d'"' -f4; }

echo "════════════════════════════════════════════════════════════════════"
echo " MindArchitect Studio — gateway verification (real HTTP, mock upstream)"
echo "════════════════════════════════════════════════════════════════════"

note "starting the mock upstream on :${MOCK_PORT}"
: > "$MOCK_LOG"
( cd /workspace/app && exec node tools/mock-gateway.mjs "$MOCK_PORT" ) >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
sleep 2
head -2 "$MOCK_LOG" | sed 's/^/  /'

# ═════════════════════════════════════════════════════════════════════════════
note "PHASE A — no gateway key configured (expect the local fallback)"
# ═════════════════════════════════════════════════════════════════════════════
if ! start_app \
  MINDARCHITECT_LLM_API_KEY= \
  XAI_API_KEY= \
  OPENAI_API_KEY= \
  LLM_API_KEY= \
  MINDARCHITECT_LLM_BASE_URL=; then
  echo "cannot continue"; exit 1
fi
HEALTH_A=$(await_health '"keySource":null' "A") || true
echo "$HEALTH_A" > "$OUT_DIR/phaseA-health.json"
echo "  keySource: $(printf '%s' "$HEALTH_A" | grep -o '"keySource":[^,]*' | head -1)"

MODELS_A=$(curl -sS -m 15 "http://127.0.0.1:${APP_PORT}/v1/models"); echo "$MODELS_A" > "$OUT_DIR/phaseA-models.json"
chat "$OUT_DIR/phaseA-chat"
HDR_A="$OUT_DIR/phaseA-chat.hdr"; BODY_A="$OUT_DIR/phaseA-chat.body"
TEXT_A=$(streamed_text "$BODY_A")
echo "  engine=$(hdr_engine "$HDR_A") reason=$(hdr_reason "$HDR_A") deltas=$(count_deltas "$BODY_A") chars=${#TEXT_A}"

check "A health gateway_live false"           '"gateway_live":false' "$HEALTH_A"
check "A health probe status not-configured"  '"status":"not-configured"' "$HEALTH_A"
check "A chat header x-ma-engine: local"      'x-ma-engine: local' "$(cat_file "$HDR_A")"
check "A chat header reason not_configured"   'x-ma-engine-reason: not_configured' "$(cat_file "$HDR_A")"
check "A body streams local replies"          '"ma_engine":"local"' "$(cat_file "$BODY_A")"
check "A stream terminates with [DONE]"       '[DONE]' "$(cat_file "$BODY_A")"
check "A reply came from the expert plane"    'GQA repeat' "$TEXT_A"
check "A models show local-expert status"     '"status":"local-expert"' "$MODELS_A"
check "A probe reports not reachable"         '"reachable":false' "$HEALTH_A"

stop_app

# ═════════════════════════════════════════════════════════════════════════════
note "PHASE B — mock key configured (expect the real gateway path)"
# ═════════════════════════════════════════════════════════════════════════════
if ! start_app \
  MINDARCHITECT_LLM_API_KEY="$KEY_VALUE" \
  MINDARCHITECT_LLM_BASE_URL="http://127.0.0.1:${MOCK_PORT}/switch" \
  MINDARCHITECT_LLM_MODEL=grok-4.5 \
  MINDARCHITECT_LLM_TIMEOUT_MS=15000 \
  MINDARCHITECT_LLM_FIRST_CHUNK_TIMEOUT_MS=3000; then
  echo "cannot continue"; exit 1
fi
echo "ok" > "$SCENARIO_FILE"
HEALTH_B=$(await_health '"keySource":"MINDARCHITECT_LLM_API_KEY"' "B") || true
echo "$HEALTH_B" > "$OUT_DIR/phaseB-health.json"
echo "  keySource: $(printf '%s' "$HEALTH_B" | grep -o '"keySource":"[^"]*"')  probe=$(hstatus "$HEALTH_B")"

MODELS_B=$(curl -sS -m 15 "http://127.0.0.1:${APP_PORT}/v1/models"); echo "$MODELS_B" > "$OUT_DIR/phaseB-models.json"
chat "$OUT_DIR/phaseB-chat"
HDR_B="$OUT_DIR/phaseB-chat.hdr"; BODY_B="$OUT_DIR/phaseB-chat.body"
TEXT_B=$(streamed_text "$BODY_B")
echo "  engine=$(hdr_engine "$HDR_B") reason=$(hdr_reason "$HDR_B") deltas=$(count_deltas "$BODY_B")"
echo "  streamed: ${TEXT_B}"

check "B health gateway_live true"            '"gateway_live":true' "$HEALTH_B"
check "B health probe status reachable"       '"status":"reachable"' "$HEALTH_B"
check "B health reachable true"               '"reachable":true' "$HEALTH_B"
check "B health names the key variable"       'MINDARCHITECT_LLM_API_KEY' "$HEALTH_B"
check_absent "B health never leaks the key"   "$KEY_VALUE" "$HEALTH_B"
check "B chat header x-ma-engine: gateway"    'x-ma-engine: gateway' "$(cat_file "$HDR_B")"
check "B chat header reason ok"               'x-ma-engine-reason: ok' "$(cat_file "$HDR_B")"
check "B body frames labelled gateway"        '"ma_engine":"gateway"' "$(cat_file "$BODY_B")"
check "B streamed the MOCK's first token"     'MindArchitect gateway stream' "$TEXT_B"
check "B streamed the MOCK's last token"      'Token 5 of 5.' "$TEXT_B"
check "B stream terminates with [DONE]"       '[DONE]' "$(cat_file "$BODY_B")"
check_absent "B body never contains the key"  "$KEY_VALUE" "$(cat_file "$BODY_B")"
check_absent "B no error frame on success"    '"error"' "$(cat_file "$BODY_B")"
check_absent "B did NOT use the local plane"  '"ma_engine":"local"' "$(cat_file "$BODY_B")"
check "B models report live-gateway"          '"status":"live-gateway"' "$MODELS_B"
check "B models expose the gateway block"     '"reachable":true' "$MODELS_B"

# ═════════════════════════════════════════════════════════════════════════════
note "PHASE C — failure modes (expect honest reason + correct fallback)"
# ═════════════════════════════════════════════════════════════════════════════

# Pre-commit failures: nothing has been written yet, so the plane MUST fall back
# to the local expert answer, labelled `local`, with the reason attached.
run_failure() { # run_failure <scenario> <reason> <probe-status>
  local scenario="$1" reason="$2" probe="$3" health hdr body text
  echo "$scenario" > "$SCENARIO_FILE"
  health=$(health_now); echo "$health" > "$OUT_DIR/phaseC-${scenario}-health.json"
  chat "$OUT_DIR/phaseC-${scenario}-chat"
  hdr="$OUT_DIR/phaseC-${scenario}-chat.hdr"; body="$OUT_DIR/phaseC-${scenario}-chat.body"
  text=$(streamed_text "$body")
  printf '  %-12s engine=%-8s reason=%-16s probe=%-14s fallback_chars=%d\n' \
    "$scenario" "$(hdr_engine "$hdr")" "$(hdr_reason "$hdr")" "$(hstatus "$health")" "${#text}"

  check "C $scenario engine=local"           'x-ma-engine: local' "$(cat_file "$hdr")"
  check "C $scenario reason=$reason"         "x-ma-engine-reason: $reason" "$(cat_file "$hdr")"
  check "C $scenario body labelled local"    '"ma_engine":"local"' "$(cat_file "$body")"
  check "C $scenario stream completes"       '[DONE]' "$(cat_file "$body")"
  check "C $scenario probe status=$probe"    "\"status\":\"$probe\"" "$health"
  check "C $scenario local plane answered"   'Engine notice' "$text"
  check_absent "C $scenario leaks no key"    "$KEY_VALUE" "$(cat_file "$body")"
}

run_failure auth        unauthorized   unauthorized
run_failure ratelimit   rate_limited   rate-limited
run_failure servererror upstream_error reachable
run_failure stall       timeout        reachable
run_failure nocontent   empty_response reachable

# ═════════════════════════════════════════════════════════════════════════════
note "PHASE C2 — mid-stream failure (MUST NOT fall back)"
# ═════════════════════════════════════════════════════════════════════════════
# The socket dies after real tokens have already been delivered. Falling back
# here would splice the local answer onto a partial hosted reply, producing text
# that claims one engine while being two — so the contract is: keep the partial
# text, label it `gateway`, and report the truncation in-band.
echo "die" > "$SCENARIO_FILE"
health_now > "$OUT_DIR/phaseC-die-health.json"
chat "$OUT_DIR/phaseC-die-chat"
HDR_D="$OUT_DIR/phaseC-die-chat.hdr"; BODY_D="$OUT_DIR/phaseC-die-chat.body"
TEXT_D=$(streamed_text "$BODY_D")
echo "  die          engine=$(hdr_engine "$HDR_D") reason=$(hdr_reason "$HDR_D") partial_chars=${#TEXT_D}"

check "C2 die engine=gateway (not local)"      'x-ma-engine: gateway' "$(cat_file "$HDR_D")"
check "C2 die keeps the partial tokens"        'partial before the' "$TEXT_D"
check "C2 die reports an in-band error"        '"error"' "$(cat_file "$BODY_D")"
check "C2 die error code is network"           '"code":"network"' "$(cat_file "$BODY_D")"
check "C2 die marks the reply partial"         '"partial":true' "$(cat_file "$BODY_D")"
check "C2 die finish_reason is error"          '"finish_reason":"error"' "$(cat_file "$BODY_D")"
check_absent "C2 die does NOT emit local text" 'GQA repeat' "$TEXT_D"
check "C2 die still closes the stream"         '[DONE]' "$(cat_file "$BODY_D")"

# ── recovery: the happy path must return after every failure ─────────────────
echo "ok" > "$SCENARIO_FILE"
chat "$OUT_DIR/phaseC-recovered-chat"
HDR_R="$OUT_DIR/phaseC-recovered-chat.hdr"
echo "  recovered    engine=$(hdr_engine "$HDR_R")"
check "C3 recovered engine back to gateway"    'x-ma-engine: gateway' "$(cat_file "$HDR_R")"

# ── operator surface: the kill switch ────────────────────────────────────────
note "PHASE D — kill switch (MINDARCHITECT_LLM_DISABLED)"
stop_app
if ! start_app \
  MINDARCHITECT_LLM_API_KEY="$KEY_VALUE" \
  MINDARCHITECT_LLM_BASE_URL="http://127.0.0.1:${MOCK_PORT}/switch" \
  MINDARCHITECT_LLM_DISABLED=1; then
  echo "cannot continue"; exit 1
fi
HEALTH_D=$(await_health '"status":"disabled"' "D") || true
echo "$HEALTH_D" > "$OUT_DIR/phaseD-health.json"
echo "  probe=$(hstatus "$HEALTH_D") disabledBy=$(printf '%s' "$HEALTH_D" | grep -o '"disabledBy":"[^"]*"')"
chat "$OUT_DIR/phaseD-chat"
check "D kill switch reports disabled"         '"status":"disabled"' "$HEALTH_D"
check "D kill switch names the variable"       '"disabledBy":"MINDARCHITECT_LLM_DISABLED"' "$HEALTH_D"
check "D disabled → local plane answers"       'x-ma-engine: local' "$(cat_file "$OUT_DIR/phaseD-chat.hdr")"

# ── summary ──────────────────────────────────────────────────────────────────
note "SUMMARY"
for line in "${RESULTS[@]}"; do
  if [[ "$line" == PASS* ]]; then printf '  \033[32m%s\033[0m\n' "$line"; else printf '  \033[31m%s\033[0m\n' "$line"; fi
done
printf '\n  %d passed, %d failed\n' "$pass" "$fail"
{
  echo "MindArchitect Studio gateway verification — $(date -u +%FT%TZ)"
  echo "$pass passed, $fail failed"
  printf '%s\n' "${RESULTS[@]}"
  echo
  echo "Upstream: tools/mock-gateway.mjs — A MOCK, not a provider."
} > "$OUT_DIR/VERIFY-RESULT.txt"

[[ "$fail" -eq 0 ]]
