#!/bin/bash
# Usage: OWL_VAULT=/path/to/vault scripts/verify-memory-vault-copy.sh [vault]
# Verifies memory search/recall on a /tmp copy of the vault, following the skill
# verify-owl-retag-without-touching-prod-knowledge. Run `pnpm build` first.
# The vault connection is knowledge_dir in <OWL_DATA_DIR>/app-settings.json; OWL_ROOT alone only
# selects <OWL_ROOT>/knowledge, which is why a bare OWL_DATA_DIR run reported the default storage.dir.
# Production paths are write-denied with sandbox-exec; their sha256 and data/backups are checked afterwards.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
VAULT=${1:-${OWL_VAULT:-}}
if [ -z "$VAULT" ]; then
  echo "Usage: OWL_VAULT=/path/to/vault $0 [vault]" >&2
  exit 2
fi
PROD=${OWL_PROD_ROOT:-}
if [ -z "$PROD" ]; then echo "OWL_PROD_ROOT is required (path of the production Owl root)" >&2; exit 2; fi
PORT=${VERIFY_PORT:-3991}
T=$(mktemp -d /tmp/owl-vault-verify.XXXXXX)
START=$(date +%Y-%m-%dT%H:%M:%S); FAIL=0; PID=
sums() { for d in "$PROD/knowledge" "$VAULT"; do find "$d" -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256; done; }
ok() { echo "PASS $1"; }
ng() { echo "FAIL $1"; FAIL=1; }
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT  # symlinks are removed with rm -rf (links only, not targets)
sums > "$T.before"
mkdir -p "$T/root/data" && cp -R "$VAULT" "$T/vault" && cp -R "$PROD/knowledge" "$T/root/knowledge" || { echo "copy failed"; exit 2; }
for e in "$REPO"/* "$REPO"/.[!.]*; do case "${e##*/}" in knowledge|data|.env*|.git) ;; *) ln -s "$e" "$T/root/";; esac; done  # server needs apps/web/out, contracts etc. under OWL_ROOT
printf '{"knowledge_dir":"%s"}\n' "$T/vault" > "$T/root/data/app-settings.json"
cat > "$T/deny.sb" <<SB
(version 1)
(allow default)
(deny file-write* (subpath "$PROD/data") (subpath "$PROD/knowledge") (subpath "$VAULT"))
SB
(cd "$T/root" && OWL_ROOT="$T/root" OWL_DATA_DIR="$T/root/data" OWL_BIND=127.0.0.1 OWL_PORT=$PORT \
  exec sandbox-exec -f "$T/deny.sb" node "$REPO/apps/server/dist/server.js" --bind 127.0.0.1 --port $PORT >"$T/server.log" 2>&1) &
PID=$!
for _ in $(seq 90); do curl -sf "http://127.0.0.1:$PORT/api/v1/memory/health" >/dev/null && break; sleep 1; done
export OWL_GUARD_API_BASE="http://127.0.0.1:$PORT"; unset OWL_API_BASE OWL_API_TOKEN OWL_GUARD_TOKEN_FILE  # never talk to the production server
cli() { node "$REPO/scripts/memory-cli.mjs" "$@"; }
cli health > "$T/health.json"
DIR=$(cat "$T/health.json" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));(j.data??j).storage?.dir??""')
[ "$DIR" = "$T/vault" ] || [ "$DIR" = "$(realpath "$T/vault")" ] && ok "health storage.dir=$DIR" || ng "storage.dir=$DIR (want $T/vault)"
HITS=0; TRIED=0; LEGACY=0; TITLE=
while IFS= read -r f; do
  [ $TRIED -ge 6 ] && break
  t=$(basename "$f" .md | cut -c1-20)  # note filenames are their titles
  [ ${#t} -ge 3 ] || continue
  TITLE=$t; TRIED=$((TRIED+1)); grep -q '^type:' "$f" || LEGACY=$((LEGACY+1))
  if cli search "$t" --limit 5 | grep -qF "$(basename "$f" .md)"; then HITS=$((HITS+1)); echo "  hit:  ${f#"$T/vault/"}"; else echo "  miss: ${f#"$T/vault/"} ($t)"; fi
done < <(find "$T/vault/notes" -name '*.md' 2>/dev/null | sort)
[ $HITS -ge 3 ] && ok "search top5 hits=$HITS/$TRIED (without type front matter: $LEGACY)" || ng "search top5 hits=$HITS/$TRIED (need >=3)"
[ -n "$TITLE" ] && [ "$(cli recall "$TITLE" | grep -c '"id"')" -gt 0 ] && ok "recall returned items" || ng "recall empty"
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=
sums > "$T.after"; cmp -s "$T.before" "$T.after" && ok "prod knowledge and vault sha256 unchanged" || ng "sha256 changed"
[ -z "$(find "$PROD/data/backups" -type f -newermt "$START" 2>/dev/null)" ] && ok "no new data/backups files" || ng "new data/backups files"
rm -f "$T.before" "$T.after"
exit $FAIL
