#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

case "${OWL_LANG:-}" in
  ja|en) SETUP_LANG="$OWL_LANG" ;;
  *)
    case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
      [Jj][Aa]*) SETUP_LANG=ja ;;
      *) SETUP_LANG=en ;;
    esac
    ;;
esac

msg() { if [ "$SETUP_LANG" = ja ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

info()  { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
fail()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

echo "$(msg '=== Owl-Agent セットアップ ===' '=== Owl-Agent Setup ===')"
echo ""

# --- OS detection ---
OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) : ;;
  *) fail "$(msg "未対応OS: $OS。公開v1はmacOS/Linuxのみです（Windowsはunsupported/experimental）。" "Unsupported OS: $OS. Public v1 supports macOS and Linux only (Windows is experimental).")" ;;
esac

# --- Node.js ---
if ! command -v node &>/dev/null; then
  fail "$(msg 'Node.js が見つかりません。v22.17.0以上、v23未満をインストールしてください。' 'Node.js was not found. Install v22.17.0 or later, but below v23.')\n  https://nodejs.org/"
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 17 ? 0 : 1)'; then
  fail "$(msg "Node.js v22.17.0以上、v23未満が必要です (現在: $(node -v))" "Node.js v22.17.0 or later, but below v23, is required (found: $(node -v))")\n  https://nodejs.org/"
fi
info "Node.js $(node -v)"

# --- git ---
if ! command -v git &>/dev/null; then
  echo "$(msg 'git をインストール中...' 'Installing git...')"
  case "$OS" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install git
      else
        xcode-select --install 2>/dev/null || true
        fail "$(msg 'git のインストールにはXcode CLTが必要です。ダイアログ完了後に再度 ./setup.sh を実行してください。' 'Installing git requires Xcode Command Line Tools. Complete the dialog and rerun ./setup.sh.')"
      fi
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq git
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y git
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm git
      else
        fail "$(msg 'git を自動インストールできません。手動でインストールしてください。' 'Could not install git automatically. Install it manually.')"
      fi
      ;;
    *) fail "$(msg "未対応OS: $OS" "Unsupported OS: $OS")" ;;
  esac
fi
info "git $(git --version | awk '{print $3}')"

# --- C/C++ toolchain (native modules: better-sqlite3, sharp) ---
case "$OS" in
  Darwin)
    if ! xcode-select -p &>/dev/null; then
      echo "$(msg 'Xcode Command Line Tools をインストール中...' 'Installing Xcode Command Line Tools...')"
      xcode-select --install 2>/dev/null || true
      fail "$(msg 'インストールダイアログが表示されます。完了後に再度 ./setup.sh を実行してください。' 'Complete the installation dialog, then rerun ./setup.sh.')"
    fi
    info "Xcode CLT"
    ;;
  Linux)
    NEED_BUILD=false
    command -v gcc &>/dev/null || command -v cc &>/dev/null || NEED_BUILD=true
    command -v make &>/dev/null || NEED_BUILD=true

    if [ "$NEED_BUILD" = true ]; then
      echo "$(msg 'ビルドツールをインストール中...' 'Installing build tools...')"
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq build-essential
      elif command -v dnf &>/dev/null; then
        sudo dnf groupinstall -y "Development Tools"
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm base-devel
      else
        fail "$(msg 'ビルドツールを自動インストールできません。gcc と make を手動でインストールしてください。' 'Could not install build tools automatically. Install gcc and make manually.')"
      fi
    fi
    info "C/C++ toolchain"
    ;;
esac

# --- python3 (node-gyp) ---
if ! command -v python3 &>/dev/null; then
  echo "$(msg 'python3 をインストール中...' 'Installing python3...')"
  case "$OS" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install python3
      else
        fail "$(msg 'python3 が見つかりません。Homebrew経由でインストールしてください:' 'python3 was not found. Install it with Homebrew:')\n  brew install python3"
      fi
      ;;
    Linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq python3
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y python3
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm python
      else
        fail "$(msg 'python3 を自動インストールできません。手動でインストールしてください。' 'Could not install python3 automatically. Install it manually.')"
      fi
      ;;
  esac
fi
info "python3 $(python3 --version 2>&1 | awk '{print $2}')"

# --- pnpm via corepack ---
PNPM_VERSION="10.15.0"
if ! command -v corepack &>/dev/null; then
  fail "$(msg 'corepack が見つかりません。Node.js 22+ に同梱されているはずです。' 'corepack was not found. It should be included with Node.js 22 or later.')"
fi

if ! command -v pnpm &>/dev/null || [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  corepack enable 2>/dev/null || warn "$(msg 'corepack enable に失敗 (sudo が必要な場合があります)' 'corepack enable failed (sudo may be required)')"
  if ! corepack prepare "pnpm@$PNPM_VERSION" --activate 2>/dev/null; then
    fail "$(msg "pnpm@$PNPM_VERSION の有効化に失敗しました。ネットワークとCorepackの設定を確認してください。" "Could not activate pnpm@$PNPM_VERSION. Check the network and Corepack configuration.")"
  fi
fi

if ! command -v pnpm &>/dev/null; then
  fail "$(msg 'pnpm のインストールに失敗しました。手動でインストールしてください:' 'Could not install pnpm. Install it manually:')\n  corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate"
fi
PNPM_ACTUAL="$(pnpm --version)"
if [ "$PNPM_ACTUAL" != "$PNPM_VERSION" ]; then
  fail "$(msg "pnpm@$PNPM_VERSION が必要です (現在: $PNPM_ACTUAL)" "pnpm@$PNPM_VERSION is required (found: $PNPM_ACTUAL)")"
fi
info "pnpm $PNPM_ACTUAL"

# --- .env ---
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  chmod 600 .env
  info "$(msg '.env を .env.example からコピーしました (必要に応じて編集してください)' 'Copied .env from .env.example (edit it as needed)')"
elif [ -f .env ]; then
  chmod 600 .env
  info "$(msg '.env (既存)' 'Using existing .env')"
fi

# --- Install dependencies + build ---
echo ""
echo "$(msg '全workspaceの依存関係をインストール中...' 'Installing dependencies for all workspaces...')"
# --recursive + --include-workspace-root makes the scope explicit: every
# workspace package and the root devDependencies are installed. Frozen lockfile
# prevents setup from silently resolving a different dependency graph. Lifecycle
# scripts are run explicitly below so the setup path is deterministic.
# CI=1 makes repeated setup runs non-interactive when pnpm needs to recreate
# node_modules; it does not change the frozen dependency graph.
CI=1 pnpm install --recursive --include-workspace-root --frozen-lockfile --ignore-scripts

echo "$(msg 'native依存を再ビルド中...' 'Rebuilding native dependencies...')"
# These are the only native build scripts allowed by the root pnpm policy. The
# package filters avoid rerunning the root postinstall build here.
pnpm --filter @owl/db rebuild better-sqlite3 --pending
pnpm --filter web rebuild sharp --pending

echo "$(msg '全workspaceをビルド中...' 'Building all workspaces...')"
pnpm run build

# Provider CLIs are external executables, not npm dependencies. Do not install
# them implicitly because they require separate accounts/authentication. The
# built doctor loads .env and reports the selected provider without printing
# secret values.
echo "$(msg 'provider / configuration doctorを実行中...' 'Running provider and configuration checks...')"
if ./bin/owl doctor --json; then
  info "$(msg 'providerと基本設定のdoctorを完了しました' 'Provider and basic configuration checks completed')"
else
  warn "$(msg 'doctorが要対応項目を報告しました。`./bin/owl doctor`でremediationを確認してください。provider CLIは自動インストールされません。' 'Doctor reported items requiring attention. Run ./bin/owl doctor for guidance. Provider CLIs are not installed automatically.')"
fi

# --- owl command on PATH ---
# Put bin/ on PATH in the login shell's rc file so `owl` works from anywhere.
# Idempotent: any existing line mentioning this bin directory is left alone.
BIN_DIR="$(pwd)/bin"
case "$(basename "${SHELL:-sh}")" in
  zsh) RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$OS" = Darwin ]; then RC_FILE="$HOME/.bash_profile"; else RC_FILE="$HOME/.bashrc"; fi
    ;;
  fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
  *) RC_FILE="$HOME/.profile" ;;
esac
if [ -f "$RC_FILE" ] && grep -qF "$BIN_DIR" "$RC_FILE"; then
  info "$(msg "owlコマンドは設定済みです ($RC_FILE)" "owl command already on PATH ($RC_FILE)")"
else
  mkdir -p "$(dirname "$RC_FILE")"
  if [ "$(basename "$RC_FILE")" = config.fish ]; then
    PATH_LINE="fish_add_path \"$BIN_DIR\"  # owl-agent"
  else
    PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\"  # owl-agent"
  fi
  printf '\n%s\n' "$PATH_LINE" >> "$RC_FILE"
  info "$(msg "owlコマンドをPATHに追加しました ($RC_FILE)" "Added the owl command to PATH ($RC_FILE)")"
fi

echo ""
echo -e "${GREEN}$(msg '=== セットアップ完了 ===' '=== Setup Complete ===')${NC}"
echo ""
echo "$(msg '新しいターミナルで起動してWeb UIを開く:' 'In a new terminal, start Owl and open the Web UI:')"
echo "  owl open"
echo "$(msg "今のターミナルで使う場合: source $RC_FILE" "To use it in this terminal: source $RC_FILE")"
echo ""
echo "$(msg 'デフォルト: http://127.0.0.1:3787/owl/' 'Default: http://127.0.0.1:3787/owl/')"
