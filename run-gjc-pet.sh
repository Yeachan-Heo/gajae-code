#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR="$SCRIPT_DIR"
ORIGINAL_PATH=${PATH-}

if [ ! -f "$SOURCE_DIR/packages/coding-agent/src/cli.ts" ]; then
  printf '%s\n' "ERROR: Gajae-Code checkout not found: $SOURCE_DIR" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' 'ERROR: bun is not available on PATH.' >&2
  exit 1
fi

RUST_BIN=''
if command -v rustup >/dev/null 2>&1; then
  RUSTC_PATH=$(rustup which rustc 2>/dev/null || true)
  if [ -n "$RUSTC_PATH" ]; then
    RUST_BIN=$(dirname -- "$RUSTC_PATH")
  fi
fi

RUN_PATH=$ORIGINAL_PATH
if [ -n "$RUST_BIN" ]; then
  RUN_PATH="$RUST_BIN:$RUN_PATH"
fi

# This launcher is for iTerm2. GJC normally disables image overlays inside a
# multiplexer because raw graphics escapes are not portable there; the explicit
# protocol tells GJC that this launcher's output is intended for iTerm2.
IMAGE_PROTOCOL=${GJC_FORCE_IMAGE_PROTOCOL:-iterm2}

if [ ! -f "$SOURCE_DIR/packages/natives/native/pi_natives.darwin-arm64.node" ]; then
  printf '%s\n' 'Native addon is missing; building it once...'
  (
    cd "$SOURCE_DIR"
    PATH="$RUN_PATH" GJC_FORCE_IMAGE_PROTOCOL="$IMAGE_PROTOCOL" bun --cwd=packages/natives run build
  )
fi

printf '%s\n' "Starting local Gajae-Code from: $SOURCE_DIR"
(
  cd "$SOURCE_DIR"
  PATH="$RUN_PATH" GJC_FORCE_IMAGE_PROTOCOL="$IMAGE_PROTOCOL" bun packages/coding-agent/src/cli.ts "$@"
)

# PATH is deliberately scoped to the subshell above and remains unchanged here.
PATH=$ORIGINAL_PATH
export PATH
