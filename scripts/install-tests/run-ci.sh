#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
	echo ""
	echo "=== $1 ==="
}

smoke_cli() {
	local gjc_bin="$1"
	local runtime_dir
	runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$gjc_bin" --version
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$gjc_bin" --help >/dev/null
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$gjc_bin" stats --help >/dev/null
	# Spawns the stats sync worker via `new Worker(...)` and waits for a pong.
	# Regression probe for #1011 (browser tab worker) and #1027 (stats sync
	# worker) — both broke silently in compiled binaries because the `with
	# { type: "file" }` import pattern only copies the worker as a raw asset
	# without bundling its imports. `stats --summary` doesn't catch this on a
	# fresh install (no session files = no Worker spawn).
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$gjc_bin" --smoke-test
}

find_tarball() {
	local pattern="$1"
	local matches=()
	shopt -s nullglob
	matches=("$pattern")
	shopt -u nullglob

	if [ "${#matches[@]}" -ne 1 ]; then
		echo "Expected exactly one tarball matching: $pattern"
		exit 1
	fi

	echo "${matches[0]}"
}

section "Binary install smoke"
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/gjc "$BINARY_DIR/gjc"
smoke_cli "$BINARY_DIR/gjc"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
	export BUN_INSTALL="$SOURCE_BUN_HOME"
	export PATH="$BUN_INSTALL/bin:$PATH"
	bun --cwd="$ROOT_DIR/packages/coding-agent" link
	smoke_cli "$BUN_INSTALL/bin/gjc"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
for pkg in utils natives ai agent tui stats coding-agent gajae-code; do
	(
		cd "$ROOT_DIR/packages/$pkg"
		bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
	)
done

utils_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-utils-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-natives-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-ai-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-stats-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-coding-agent-*.tgz)"
wrapper_tgz="$(find_tarball "$TARBALL_DIR"/gajae-code-[0-9]*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
	cd "$TARBALL_APP_DIR"
	bun init -y >/dev/null

	# Write overrides so bun resolves inter-package deps from tarballs, not the registry
	# (version 12.x.y hasn't been published yet when CI runs pre-release)
	node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@gajae-code/utils': '$utils_tgz',
			'@gajae-code/natives': '$natives_tgz',
			'@gajae-code/ai': '$ai_tgz',
			'@gajae-code/agent-core': '$agent_tgz',
			'@gajae-code/tui': '$tui_tgz',
			'@gajae-code/stats': '$stats_tgz',
			'@gajae-code/coding-agent': '$coding_agent_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

	bun add "$utils_tgz" "$natives_tgz" "$ai_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$wrapper_tgz"
	smoke_cli ./node_modules/.bin/gjc
)

echo ""
echo "All install method smoke tests passed"
