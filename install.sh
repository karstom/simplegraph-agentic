#!/usr/bin/env bash
# simplegraph-agentic one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/karstom/simplegraph-agentic/main/install.sh | bash
#
# Installs into the current directory. To pass options through a pipe, use
# `bash -s --`:
#
#   curl -fsSL .../install.sh | bash -s -- --tool cursor --yes
#
# Options:
#   --dir PATH      project to install into            (default: current directory)
#   --tool NAME     antigravity|cursor|claude-code|copilot|zed|codex|generic|skip
#                   (default: auto-detected from the project)
#   --home PATH     where simplegraph itself lives     (default: ~/.simplegraph)
#   --ref REF       branch or tag to install           (default: main)
#   --no-mcp        skip building/wiring the MCP server
#   --multi-repo    also install the shared/ org-level scaffold
#   -y, --yes       accept defaults for every prompt
#   -h, --help      show this message
#
# Supported on Linux, WSL, and macOS. Requires bash 3.2+ and either git or
# curl/wget. Node 18+ is optional — without it the markdown graph installs and
# the MCP server is skipped.

set -euo pipefail

# Overridable so a fork can be installed with the same one-liner, and so the
# download path can be exercised against a local clone in tests.
REPO_URL="${SIMPLEGRAPH_REPO_URL:-https://github.com/karstom/simplegraph-agentic.git}"
TARBALL_URL="${SIMPLEGRAPH_TARBALL_URL:-https://codeload.github.com/karstom/simplegraph-agentic/tar.gz}"

SG_HOME="${SIMPLEGRAPH_HOME:-$HOME/.simplegraph}"
REF="main"
TARGET_DIR=""
WANT_MCP=true
PASS_THROUGH=()

# ── output helpers ────────────────────────────────────────────────────────────
# tput fails when TERM is unset (common in CI and some WSL shells); the guard
# keeps output plain rather than emitting escape garbage.
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && tput setaf 1 >/dev/null 2>&1; then
  bold=$(tput bold); reset=$(tput sgr0)
  green=$(tput setaf 2); yellow=$(tput setaf 3); cyan=$(tput setaf 6); red=$(tput setaf 1)
else
  bold=""; reset=""; green=""; yellow=""; cyan=""; red=""
fi
say()  { echo "${cyan}▶ $*${reset}"; }
ok()   { echo "${green}✓ $*${reset}"; }
warn() { echo "${yellow}! $*${reset}"; }
die()  { echo "${red}✗ $*${reset}" >&2; exit 1; }

usage() { sed -n '2,26p' "$0" | sed -e 's/^# //' -e 's/^#$//'; exit "${1:-0}"; }

# ── arguments ─────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        [ $# -ge 2 ] || die "--dir needs a path";  TARGET_DIR="$2"; shift 2 ;;
    --home)       [ $# -ge 2 ] || die "--home needs a path"; SG_HOME="$2";    shift 2 ;;
    --ref)        [ $# -ge 2 ] || die "--ref needs a value"; REF="$2";        shift 2 ;;
    --tool)       [ $# -ge 2 ] || die "--tool needs a value"
                  PASS_THROUGH=("${PASS_THROUGH[@]:-}" --tool "$2"); shift 2 ;;
    --no-mcp)     WANT_MCP=false; PASS_THROUGH=("${PASS_THROUGH[@]:-}" --no-mcp); shift ;;
    --multi-repo) PASS_THROUGH=("${PASS_THROUGH[@]:-}" --multi-repo); shift ;;
    -y|--yes)     PASS_THROUGH=("${PASS_THROUGH[@]:-}" --yes); shift ;;
    -h|--help)    usage 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

# Empty-array expansion under `set -u` is an error in bash 3.2/4.3, so the
# array is seeded with "${PASS_THROUGH[@]:-}" above and the empty first element
# is stripped here rather than expanded into setup.sh as a bare "".
CLEAN_ARGS=()
for a in ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}; do
  [ -n "$a" ] && CLEAN_ARGS[${#CLEAN_ARGS[@]}]="$a"
done

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
[ -d "${TARGET_DIR}" ] || die "target directory does not exist: ${TARGET_DIR}"
TARGET_DIR="$(cd "${TARGET_DIR}" && pwd)"

# ── platform ──────────────────────────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macOS" ;;
    Linux)
      # WSL reports Linux; the marker is in /proc/version. Worth naming because
      # its most common failure — CRLF line endings from a Windows-side clone —
      # is specific to it.
      if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then echo "WSL"; else echo "Linux"; fi ;;
    *) echo "$(uname -s)" ;;
  esac
}
PLATFORM="$(detect_platform)"

echo ""
echo "${bold}simplegraph-agentic installer${reset}"
echo "────────────────────────────────────"
echo "Platform: ${PLATFORM}    Project: ${TARGET_DIR}"
echo ""

# ── preflight ─────────────────────────────────────────────────────────────────
# bash 3.2 is what macOS ships as /bin/bash; everything here stays inside it.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 3 ]; then
  die "bash 3.2 or newer is required."
fi

if [ "${PLATFORM}" = "WSL" ] && [ -n "${TARGET_DIR##/mnt/*}" ]; then
  : # project lives on the Linux filesystem — the fast, well-behaved case
elif [ "${PLATFORM}" = "WSL" ]; then
  warn "Project is on a Windows drive (${TARGET_DIR})."
  warn "Git there may write CRLF line endings, which break shell scripts under WSL."
  warn "If scripts fail with '\\r: command not found', run: git config core.autocrlf input"
fi

HAVE_GIT=false;  command -v git  >/dev/null 2>&1 && HAVE_GIT=true
HAVE_CURL=false; command -v curl >/dev/null 2>&1 && HAVE_CURL=true
HAVE_WGET=false; command -v wget >/dev/null 2>&1 && HAVE_WGET=true

if [ "${HAVE_GIT}" = false ] && [ "${HAVE_CURL}" = false ] && [ "${HAVE_WGET}" = false ]; then
  die "need git, curl, or wget to download simplegraph."
fi

NODE_OK=false
NODE_VERSION=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || echo "")"
  NODE_MAJOR="$(echo "${NODE_VERSION}" | sed -e 's/^v//' -e 's/\..*$//')"
  case "${NODE_MAJOR}" in
    ''|*[!0-9]*) NODE_OK=false ;;
    *) [ "${NODE_MAJOR}" -ge 18 ] && NODE_OK=true ;;
  esac
fi

# ── fetch simplegraph into its own home ───────────────────────────────────────
# Deliberately NOT a temp directory: setup.sh writes an .mcp.json that points at
# ${SG_HOME}/mcp/dist/index.js, so the checkout has to outlive the install. It
# doubles as the upgrade path — re-running this script pulls and rebuilds.
install_source() {
  if [ -f "$(dirname "$0")/setup.sh" ] && [ -d "$(dirname "$0")/core" ]; then
    # Running from an existing clone (not piped from curl) — use it as-is.
    SG_HOME="$(cd "$(dirname "$0")" && pwd)"
    say "Using this checkout: ${SG_HOME}"
    return
  fi

  if [ -d "${SG_HOME}/.git" ] && [ "${HAVE_GIT}" = true ]; then
    say "Updating ${SG_HOME} ..."
    git -C "${SG_HOME}" fetch --quiet --depth 1 origin "${REF}" \
      && git -C "${SG_HOME}" checkout --quiet FETCH_HEAD \
      || die "could not update ${SG_HOME}. Delete it and re-run to reinstall."
    ok "Updated to latest ${REF}"
    return
  fi

  if [ -e "${SG_HOME}" ] && [ ! -d "${SG_HOME}/.git" ]; then
    die "${SG_HOME} exists but is not a simplegraph checkout. Move it, or pass --home PATH."
  fi

  say "Downloading simplegraph (${REF}) → ${SG_HOME}"
  mkdir -p "$(dirname "${SG_HOME}")"

  if [ "${HAVE_GIT}" = true ]; then
    git clone --quiet --depth 1 --branch "${REF}" "${REPO_URL}" "${SG_HOME}" \
      || die "git clone failed."
  else
    # Tarball fallback for machines without git. `mktemp -d` with no template
    # works on GNU coreutils but not every BSD mktemp, hence the fallback form.
    tmp="$(mktemp -d 2>/dev/null || mktemp -d -t simplegraph)" || die "could not create temp dir."
    trap 'rm -rf "${tmp}"' EXIT
    if [ "${HAVE_CURL}" = true ]; then
      curl -fsSL "${TARBALL_URL}/${REF}" -o "${tmp}/sg.tar.gz" || die "download failed."
    else
      wget -qO "${tmp}/sg.tar.gz" "${TARBALL_URL}/${REF}" || die "download failed."
    fi
    mkdir -p "${SG_HOME}"
    # --strip-components drops the "repo-ref/" wrapper GitHub adds.
    tar -xzf "${tmp}/sg.tar.gz" -C "${SG_HOME}" --strip-components=1 || die "extract failed."
  fi
  ok "Installed to ${SG_HOME}"
}

install_source

[ -f "${SG_HOME}/setup.sh" ] || die "setup.sh missing from ${SG_HOME} — the download looks incomplete."

# ── build the MCP server ──────────────────────────────────────────────────────
# The MCP server is what makes the agent actively call the graph mid-task rather
# than hoping it read a file at session start, so it is on by default — but only
# when Node can actually run it. A missing toolchain downgrades to the markdown
# graph instead of failing the install.
if [ "${WANT_MCP}" = true ] && [ "${NODE_OK}" = true ]; then
  if command -v npm >/dev/null 2>&1; then
    say "Building the MCP server (Node ${NODE_VERSION}) ..."
    if ( cd "${SG_HOME}/mcp" && npm install --silent --no-fund --no-audit >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ); then
      ok "MCP server built"
    else
      warn "MCP build failed — continuing with the markdown graph only."
      warn "Retry later with: cd ${SG_HOME}/mcp && npm install && npm run build"
      WANT_MCP=false
    fi
  else
    warn "npm not found — skipping the MCP server."
    WANT_MCP=false
  fi
elif [ "${WANT_MCP}" = true ]; then
  if [ -n "${NODE_VERSION}" ]; then
    warn "Node ${NODE_VERSION} is older than v18 — skipping the MCP server."
  else
    warn "Node not found — skipping the MCP server (the markdown graph works without it)."
  fi
  WANT_MCP=false
fi

if [ "${WANT_MCP}" = false ]; then
  case " ${CLEAN_ARGS[*]:-} " in
    *" --no-mcp "*) : ;;
    *) CLEAN_ARGS[${#CLEAN_ARGS[@]}]="--no-mcp" ;;
  esac
fi

# ── hand off to setup.sh ──────────────────────────────────────────────────────
echo ""
bash "${SG_HOME}/setup.sh" "${TARGET_DIR}" ${CLEAN_ARGS[@]+"${CLEAN_ARGS[@]}"}

echo ""
echo "${bold}simplegraph is installed.${reset}"
echo ""
echo "  Graph:      ${TARGET_DIR}/core/"
echo "  simplegraph: ${SG_HOME}   (re-run this installer to upgrade)"
echo ""
echo "${bold}Next: give the graph something to remember.${reset}"
if [ "${NODE_OK}" = true ]; then
  echo "  cd ${TARGET_DIR}"
  echo "  node ${SG_HOME}/mcp/dist/seed/cli.js seed . --dry-run"
  echo ""
  echo "  That mines your git history for regressions, decisions, and invariants"
  echo "  offline, with no API key, and shows you the draft before writing anything."
else
  echo "  Open ${SG_HOME}/scripts/seed_prompt.md and paste it into your AI tool."
fi
echo ""
