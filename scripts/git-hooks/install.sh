#!/bin/sh
set -u

error() {
  printf 'owl-hooks: error: %s\n' "$1" >&2
}

usage_error() {
  error 'usage: sh scripts/git-hooks/install.sh [--use-hooks-path] [<repo>]'
  exit 1
}

use_hooks_path=0
repo=
for arg in "$@"; do
  case "$arg" in
    --use-hooks-path)
      [ "$use_hooks_path" -eq 0 ] || usage_error
      use_hooks_path=1
      ;;
    *)
      [ -z "$repo" ] || usage_error
      repo=$arg
      ;;
  esac
done

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || {
  error 'could not locate hook files'
  exit 1
}
guard=$script_dir/pre-push
if [ ! -f "$guard" ]; then
  error 'pre-push guard script is missing'
  exit 1
fi
if [ -z "$repo" ]; then
  repo=$(CDPATH='' cd -- "$script_dir/../.." 2>/dev/null && pwd -P) || {
    error 'not a Git working tree'
    exit 2
  }
fi

top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || {
  error 'not a Git working tree'
  exit 2
}
top=$(CDPATH='' cd -- "$top" 2>/dev/null && pwd -P) || {
  error 'not a Git working tree'
  exit 2
}

canonical_path() {
  path=$1
  case "$path" in
    /*) ;;
    *) path=$top/$path ;;
  esac
  suffix=
  while [ ! -d "$path" ]; do
    [ "$path" != / ] || break
    base=${path##*/}
    parent=${path%/*}
    [ -n "$parent" ] || parent=/
    if [ -n "$suffix" ]; then
      suffix=$base/$suffix
    else
      suffix=$base
    fi
    path=$parent
  done
  physical=$(CDPATH='' cd -- "$path" 2>/dev/null && pwd -P) || return 1
  if [ -n "$suffix" ]; then
    printf '%s/%s\n' "${physical%/}" "$suffix"
  else
    printf '%s\n' "$physical"
  fi
}

hooks_raw=$(git -C "$top" rev-parse --git-path hooks 2>/dev/null) || {
  error 'could not locate Git hooks directory'
  exit 1
}
common_raw=$(git -C "$top" rev-parse --git-common-dir 2>/dev/null) || {
  error 'could not locate common Git directory'
  exit 1
}
hooks=$(canonical_path "$hooks_raw") || {
  error 'could not resolve Git hooks directory'
  exit 1
}
common=$(canonical_path "$common_raw") || {
  error 'could not resolve common Git directory'
  exit 1
}

case "$hooks/" in
  "$common/"*) default_hooks=1 ;;
  *) default_hooks=0 ;;
esac
if [ "$default_hooks" -eq 0 ]; then
  case "$hooks/" in
    "$top/"*)
      error 'core.hooksPath points inside the working tree; add a call to scripts/git-hooks/pre-push from that hook manually'
      exit 4
      ;;
  esac
  if [ "$use_hooks_path" -ne 1 ]; then
    error 'core.hooksPath points outside the repository; rerun with --use-hooks-path to install in that shared directory'
    exit 4
  fi
fi

if [ ! -d "$hooks" ] && ! mkdir -p "$hooks"; then
  error 'could not create Git hooks directory'
  exit 1
fi
pre_push=$hooks/pre-push
quoted_guard=$(printf '%s' "$guard" | sed "s/'/'\\\\''/g") || {
  error 'could not prepare pre-push hook'
  exit 1
}
temporary=$hooks/.pre-push.owl.$$
trap 'rm -f "$temporary"' 0
if ! cat >"$temporary" <<EOF
#!/bin/sh
# owl-managed: pre-push-guard
exec '$quoted_guard' "\$@"
EOF
then
  error 'could not write pre-push hook'
  exit 1
fi
if [ -e "$pre_push" ] || [ -L "$pre_push" ]; then
  if [ -f "$pre_push" ] && cmp -s "$pre_push" "$temporary"; then
    if [ ! -x "$pre_push" ] && ! chmod +x "$pre_push"; then
      error 'could not enable the matching pre-push hook'
      exit 1
    fi
    printf 'owl-hooks: pre-push guard already matches at %s\n' "$pre_push"
    exit 0
  fi
  error 'pre-push already exists and was left unchanged; chain the guard from the existing hook:'
  printf "owl-hooks: example: input=\$(mktemp) || exit 1\n" >&2
  printf "owl-hooks: example: cat >\"\$input\"\n" >&2
  printf "owl-hooks: example: '%s' \"\$@\" <\"\$input\" || { rm -f \"\$input\"; exit 1; }\\n" "$quoted_guard" >&2
  printf "owl-hooks: example: # continue the existing hook using \"\$input\", then remove the temp file\n" >&2
  exit 3
fi
if ! chmod +x "$temporary" || ! mv -f "$temporary" "$pre_push"; then
  error 'could not install pre-push hook'
  exit 1
fi
trap - 0

if [ -f "$top/data/private-words.txt" ] && ! git -C "$top" check-ignore -q data/private-words.txt 2>/dev/null; then
  printf 'owl-hooks: warning: data/private-words.txt is not ignored by Git\n' >&2
fi
printf 'owl-hooks: installed pre-push guard at %s\n' "$pre_push"
exit 0
