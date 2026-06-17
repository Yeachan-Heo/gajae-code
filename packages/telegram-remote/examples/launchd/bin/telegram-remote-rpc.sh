#!/bin/sh
# Example launchd wrapper. Copy outside the repo, edit absolute paths, and chmod 700.
set -eu
ENV_FILE="${GJC_TELEGRAM_REMOTE_ENV_FILE:-$HOME/Library/Application Support/gjc/telegram-remote.env}"
CHECKOUT="${GJC_TELEGRAM_REMOTE_CHECKOUT:-$HOME/src/gajae-code}"
BUN="${GJC_BUN:-$HOME/.bun/bin/bun}"
TIMEOUT="${GJC_TELEGRAM_REMOTE_SOCKET_WAIT_SEC:-30}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Telegram Remote env file is missing" >&2
  exit 1
fi
perm=$(stat -f "%Lp" "$ENV_FILE" 2>/dev/null || echo "")
if [ "$perm" != "600" ]; then
  echo "Telegram Remote env file must be mode 600" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
socket="${GJC_TELEGRAM_REMOTE_RPC_SOCKET:-}"
if [ -z "$socket" ]; then
  echo "RPC socket path is not configured" >&2
  exit 1
fi
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if [ -S "$socket" ]; then
    cd "$CHECKOUT/packages/telegram-remote"
    exec "$BUN" run src/cli.ts
  fi
  i=$((i + 1))
  sleep 1
done
echo "RPC socket not ready after timeout" >&2
exit 1
