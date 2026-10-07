#!/bin/bash
# Usage: scripts/verify-memory-pages-integrate.sh [vault]   (default $OWL_VAULT)
# Runs the real PageLibrarian (real Haiku, one page) through POST /memory/pages/integrate on a /tmp copy of the vault
# with a temp OWL_DATA_DIR, following the skill verify-owl-retag-without-touching-prod-knowledge: production paths
# are write-denied with sandbox-exec, the denial log and a data/ churn baseline (t0,t1) are taken before the run.
# Run `pnpm build` first. Evidence is kept in EVIDENCE_DIR. Exit 1: a check failed. Exit 3: proof incomplete.
#
# 5(e) judgement for differences under production data/ (t0/t1 = churn baseline taken before the run):
#  - in the churn baseline            -> explained (the production server changed it with no run involved)
#  - not in it, but on SERVER_STATE   -> allowed by path (owl.sqlite*, logs, guard-tokens, connectors/), the files the production server writes itself
#  - on neither                       -> FAIL (exit 1)
# The path allowance is valid only if (a) the sandbox profile denies file-write* with no allow for production paths and
# (b) the denial log over the whole run shows no write attempt against them, or every attempt was denied; if either fails, 5(e) fails too.
# Why not PID: connectors/*.json is rewritten in-process by the production server's connector manager each time a cursor
# advances; those writes are short and a sudo-free observer (lsof sampling) cannot reliably catch their writer, so the
# writer is not proven by PID. The verification process is excluded by the kernel instead: it runs inside sandbox-exec with
# file-write* denied on production data/, knowledge, the vault and ~/.owl/workspaces ((a) the profile, (b) no attempt, or only denied attempts, in the
# denial log, with a positive control showing the log captures denials). A process that cannot write there cannot be the
# writer, so a difference on the allowance list is the production server's own. Cursor values are NOT compared.
# The PID sampler (server-open.log) is evidence only and is not used for pass/fail; the production server pid must be the same before and after.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
VAULT=${1:-${OWL_VAULT:-}}
PROD=${OWL_PROD_ROOT:-}
if [ -z "$PROD" ]; then echo "OWL_PROD_ROOT is required (path of the production Owl root)" >&2; exit 2; fi
PORT=${VERIFY_PORT:-3993}
PAGE_REL="projects/verify/page-under-test.md"
T=$(mktemp -d /tmp/owl-pages-verify.XXXXXX)
EV=${EVIDENCE_DIR:-/tmp/owl-pages-evidence-$(date +%Y%m%dT%H%M%S)}
mkdir -p "$EV" || exit 2
FAIL=0; UNPROVEN=0; A_OK=0; B_OK=0; SPID=; LOGPID=; SAMPLERPID=
ok() { echo "PASS $1"; }
ng() { echo "FAIL $1"; FAIL=1; }
unproven() { echo "NOT PROVEN $1"; UNPROVEN=1; }
sums() { for d in "$VAULT" "$PROD/knowledge" "$PROD/data"; do find "$d" -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256; done; }
state() { for d in "$HOME"/.owl/workspaces/*/*; do [ -d "$d/.git" ] || [ -f "$d/.git" ] && { echo "== $d"; git -C "$d" status --porcelain 2>/dev/null; }; done; git -C "$PROD" worktree list 2>/dev/null; }
cleanup() { [ -n "$SPID" ] && kill "$SPID" 2>/dev/null; [ -n "$LOGPID" ] && kill "$LOGPID" 2>/dev/null; [ -n "$SAMPLERPID" ] && kill "$SAMPLERPID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

PROD_PID=$(lsof -t "$PROD/data/owl.sqlite" 2>/dev/null | sort -u | head -1)
echo "server_pid_before=${PROD_PID:-none}" > "$EV/server-pid.txt"
state > "$EV/workspaces.before"
# outside-sandbox sampler (no sudo): every 0.2s, which files under production data/ the production server pid and its children hold open
if [ -n "${PROD_PID:-}" ]; then
  ( while :; do
      PIDS=$PROD_PID$(for c in $(pgrep -P "$PROD_PID"); do printf ',%s' "$c"; done)
      lsof -nP -w -p "$PIDS" -F pn 2>/dev/null | awk -v t="$(date +%s)" '/^p/{p=substr($0,2)} /^n\//{n=substr($0,2); print t, p, n}'
      sleep 0.2
    done | grep -F " $PROD/data/" > "$EV/server-open.log" ) &
  SAMPLERPID=$!
fi
cat > "$T/deny.sb" <<SB
(version 1)
(allow default)
(deny file-write* (subpath "$PROD/data") (subpath "$PROD/knowledge") (subpath "$VAULT") (subpath "$HOME/.owl/workspaces"))
SB
cp "$T/deny.sb" "$EV/deny.sb"
# (a) machine check of the profile that is actually used: it denies file-write* and allows no write to a production path
if grep -q 'deny file-write\*' "$EV/deny.sb" && ! grep -E '^\(allow file-write' "$EV/deny.sb" | grep -E "$PROD/data|$PROD/knowledge|$VAULT|\.owl/workspaces" > "$EV/profile-allow.txt"; then
  A_OK=1; ok "sandbox profile denies file-write* and has no allow for production paths (profile: $EV/deny.sb)"
else
  ng "sandbox profile check failed: see $EV/profile-allow.txt"
fi
/usr/bin/log stream --style compact --predicate 'sender == "Sandbox" AND eventMessage CONTAINS "deny"' > "$EV/denials.log" 2> "$EV/denials.err" &
LOGPID=$!
sleep 3
PROBE=$PROD/data/.owl-pages-probe-$$
sandbox-exec -f "$T/deny.sb" /usr/bin/touch "$PROBE" 2>/dev/null
sleep 2
[ -e "$PROBE" ] && { rm -f "$PROBE"; echo "sandbox did not deny the probe" >&2; exit 2; }
grep -q "owl-pages-probe-$$" "$EV/denials.log" && ok "denial log captures sandbox denials (positive control)" || unproven "sandbox denial log could not be captured"

sums > "$EV/sha.t0"
sleep "${CHURN_WAIT:-90}"
sums > "$EV/sha.t1"

# temp root: vault copy plus one seeded theme page that has an appended, not yet integrated line
mkdir -p "$T/root/data" "$T/vault" && cp -R "$VAULT"/. "$T/vault"/ && mkdir -p "$T/root/knowledge" "$T/root/rules" "$T/root/skills" || exit 2
for e in "$REPO"/* "$REPO"/.[!.]*; do case "${e##*/}" in knowledge|data|rules|skills|.env*|.git) ;; *) ln -s "$e" "$T/root/";; esac; done
mkdir -p "$T/vault/projects/verify"
cp "$REPO/scripts/fixtures/pages-verify-page.md" "$T/vault/$PAGE_REL" || exit 2
printf '{"knowledge_dir":"%s"}\n' "$T/vault" > "$T/root/data/app-settings.json"
# the pages-v1 marker tells the first-open archive that this vault is already in the pages layout
printf '{"format":1,"layout":"pages-v1"}\n' > "$T/vault/.owl-knowledge"
sums > "$EV/sha.before"
START=$(date +%s)
# macOS find has no -newermt "@epoch"; compare against a reference file made at the start
touch "$EV/start.ref" || exit 2
(cd "$T/root" && OWL_ROOT="$T/root" OWL_DATA_DIR="$T/root/data" OWL_BIND=127.0.0.1 OWL_PORT=$PORT \
  exec sandbox-exec -f "$T/deny.sb" node "$REPO/apps/server/dist/server.js" --bind 127.0.0.1 --port $PORT >"$T/server.log" 2>&1) &
SPID=$!
for _ in $(seq 90); do curl -sf "http://127.0.0.1:$PORT/api/v1/memory/health" >/dev/null && break; sleep 1; done
# memory_mode defaults to legacy and the integrate API needs pages: set it in the temp data dir's own DB (read at every call, no restart needed)
(cd "$REPO/packages/db" && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.prepare("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES (?, (SELECT id FROM owners LIMIT 1), ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run("memory_mode","1.0.0",JSON.stringify("pages"),new Date().toISOString())' "$T/root/data/owl.sqlite") || ng "could not set memory_mode to pages in the temp DB"
curl -s -X POST "http://127.0.0.1:$PORT/api/v1/memory/pages/integrate" -H 'content-type: application/json' -d '{}' -m 280 > "$EV/integrate.json"
cp "$T/server.log" "$EV/server.log"
cp "$T/vault/$PAGE_REL" "$EV/page.after.md"
node -pe 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data??{};JSON.stringify({status:r.status,run:r.id,pages:r.report?.pages})' "$EV/integrate.json" > "$EV/summary.json"; cat "$EV/summary.json"
grep -q '"status":"succeeded"' "$EV/summary.json" && ok "real Haiku run recorded as succeeded" || ng "run not succeeded"
# the run record must remain in curation_runs as succeeded, fetched by run_id (not by list order)
RUN_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).run||""' "$EV/summary.json")
curl -s "http://127.0.0.1:$PORT/api/v1/curation-runs/$RUN_ID" > "$EV/curation-run.json"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=r.data??r;process.exit(d.id===process.argv[2]&&d.status==="succeeded"?0:1)' "$EV/curation-run.json" "$RUN_ID" && ok "curation_runs holds run $RUN_ID as succeeded (get by run_id)" || ng "curation_runs record for run $RUN_ID is not succeeded"
sleep 2
kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; SPID=
sums > "$EV/sha.after"
state > "$EV/workspaces.after"
changed() { diff "$1" "$2" | grep -E '^[<>]' | awk '{print $3}' | sort -u; }
changed "$EV/sha.t0" "$EV/sha.t1" > "$EV/churn.files"
changed "$EV/sha.before" "$EV/sha.after" > "$EV/diff.files"
diff "$EV/sha.before" "$EV/sha.after" > "$EV/sha.diff"
echo "run_seconds=$(( $(date +%s) - START )) churn_wait=${CHURN_WAIT:-90}" > "$EV/timing.txt"
echo "server_pid_after=$(lsof -t "$PROD/data/owl.sqlite" 2>/dev/null | sort -u | head -1)" >> "$EV/server-pid.txt"
grep -E "$PROD/knowledge/|^$VAULT/" "$EV/diff.files" > "$EV/diff.vault.files" && ng "production knowledge or vault changed: $(tr '\n' ' ' < "$EV/diff.vault.files")" || ok "production knowledge and vault sha256 unchanged"
# files the production server writes itself (owl.sqlite*, logs, guard-tokens, connectors/): allowed by path when not in the churn baseline, valid only if (a) and (b) pass
SERVER_STATE=${SERVER_STATE_RE:-"^$PROD/data/(owl\.sqlite[^/]*|[^/]*\.log|guard-tokens/[^/]+|connectors/.+)$"}
grep -vxFf "$EV/churn.files" "$EV/diff.files" > "$EV/nonchurn.files" || true
grep -vE "$SERVER_STATE" "$EV/nonchurn.files" > "$EV/unexplained.files" || true
grep -E "$SERVER_STATE" "$EV/nonchurn.files" > "$EV/allowed-by-path.files" || true
ok "data/ differences listed: $(tr '\n' ' ' < "$EV/diff.files")"
sleep 2
grep -E "node\(" "$EV/denials.log" | grep -E "$PROD/(data|knowledge)|$VAULT|\.owl/workspaces" > "$EV/denials.node.log" || true
# attempts are evidence; only an attempt that was not denied fails (b)
grep -vE ' deny[( ]' "$EV/denials.node.log" > "$EV/denials.notdenied.log" || true
if [ -s "$EV/denials.notdenied.log" ]; then
  ng "a write attempt against production paths was not denied: see $EV/denials.notdenied.log"
elif [ "$UNPROVEN" != 0 ]; then unproven "no denial log"
else
  B_OK=1; ok "denial log over the whole run: $(wc -l < "$EV/denials.node.log" | tr -d ' ') write attempt(s) against production paths, all denied (0 allowed; evidence: $EV/denials.node.log)"
fi
# PID sampler result: evidence only, not used for pass/fail
{ echo "sampler lines: $(wc -l < "$EV/server-open.log" 2>/dev/null || echo 0)"; } > "$EV/pid-evidence.txt"
# (e) judgement
if [ -s "$EV/unexplained.files" ]; then
  ng "(e) data/ change on neither the churn baseline nor the server-state allowance: $(tr '\n' ' ' < "$EV/unexplained.files")"
elif [ "$A_OK" = 1 ] && [ "$B_OK" = 1 ]; then
  ok "(e) every data/ difference is in the churn baseline or the server-state allowance, and (a)(b) prove the run cannot write there (allowed by path: $(tr '\n' ' ' < "$EV/allowed-by-path.files"))"
else
  ng "(e) the path allowance does not hold because (a) or (b) did not pass (a=$A_OK b=$B_OK)"
fi
# (d) the find must exit 0 and print nothing; its stderr is kept, and any non-zero exit is a FAIL (FIND_REF can be set to a broken path to see that)
NEW_BACKUPS=$(find "$PROD/data/backups" -type f -newer "${FIND_REF:-$EV/start.ref}" 2> "$EV/backups-find.err"); FIND_RC=$?
if [ $FIND_RC -ne 0 ]; then ng "find under production data/backups failed (exit $FIND_RC): $(cat "$EV/backups-find.err")"
elif [ -n "$NEW_BACKUPS" ]; then ng "new file under production data/backups: $NEW_BACKUPS"
else ok "no new file under production data/backups (find exit 0)"; fi
[ "$(grep server_pid "$EV/server-pid.txt" | sed 's/.*=//' | sort -u | wc -l | tr -d ' ')" = 1 ] && ok "production server pid unchanged" || ng "production server pid changed"
diff "$EV/workspaces.before" "$EV/workspaces.after" > "$EV/workspaces.diff" && echo "workspaces unchanged" || echo "workspaces changed by live Works (see $EV/workspaces.diff)"
echo "evidence: $EV"
[ $FAIL -ne 0 ] && exit 1
[ $UNPROVEN -ne 0 ] && exit 3
exit 0
