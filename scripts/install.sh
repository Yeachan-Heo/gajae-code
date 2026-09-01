#!/bin/sh
set -e

# GJC Coding Agent Installer (standalone binary, no Bun required)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --channel nightly
#   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --ref v0.15.0
#   sh scripts/install.sh --dev
#
# Options:
#   --channel <stable|nightly>  Release channel (default: stable)
#   --ref <tag> / -r <tag>      Exact GitHub release tag (binary assets required)
#   --binary                    Explicit binary install (default; no-op alias)
#   --source                    Development/source install via an existing Bun
#   --dev                      Build and install the current checkout via Bun (local only)
#   -h, --help                  Show this help
#
# Bun is never detected, installed, or invoked on the default path.
# --source requires a preinstalled Bun and never downloads one.
# --dev requires an on-disk GJC checkout and a preinstalled Bun.

REPO="Yeachan-Heo/gajae-code"
PACKAGE="@gajae-code/coding-agent"
INSTALL_DIR="${GJC_INSTALL_DIR:-$HOME/.local/bin}"
GITHUB_API="${GJC_GITHUB_API:-https://api.github.com}"
GITHUB_RELEASES="${GJC_GITHUB_RELEASES:-https://github.com/${REPO}/releases/download}"
MIN_BUN_VERSION="1.3.14"
BINARY_SHA256_ASSET="gajae-release-binaries.sha256"
BINARY_MANIFEST_ASSET="gajae-release-binaries-v1.json"

MODE="binary"
CHANNEL="stable"
REF=""
TMP_FILES=""
LOCK_FILE=""
LOCK_NONCE=""
AUTH_HDR=""
BACKUP_PATH=""
DEST_PATH=""
SOURCE_CLONE_DIR=""
DEV_REPO_ROOT=""
DEV_REQUESTED=0
SOURCE_REQUESTED=0
BINARY_REQUESTED=0
OFFER_RUNTIME_DIR=""

usage() {
    cat <<'EOF'
GJC installer — standalone binary (Bun is not required)

Usage:
  curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh
  sh install.sh [--channel stable|nightly] [--ref <tag>]
  sh install.sh --source [--ref <tag>]
  sh scripts/install.sh --dev

Options:
  --channel <stable|nightly>  GitHub release channel (default: stable)
  --ref <tag>, -r <tag>       Exact GitHub release tag
  --binary                    Install the prebuilt binary (default)
  --source                    Source/development install; requires existing Bun
  --dev                      Build and install the current checkout via Bun (local only)
  -h, --help                  Show this help

Environment:
  GJC_INSTALL_DIR             Install directory (default: ~/.local/bin)
  GITHUB_TOKEN / GH_TOKEN     Optional GitHub API token (rate limits)
EOF
}

die() {
    echo "$*" >&2
    exit 1
}

cleanup() {
    old_status=$?
    if [ -n "$TMP_FILES" ]; then
        printf '%s\n' "$TMP_FILES" | while IFS= read -r tmp_file; do
            [ -n "$tmp_file" ] || continue
            rm -f "$tmp_file"
        done || true
    fi
    if [ -n "$LOCK_FILE" ] && [ -f "$LOCK_FILE" ]; then
        owner=""
        nonce=""
        read owner nonce < "$LOCK_FILE" || true
        if [ "$owner" = "$$" ] && [ -n "$LOCK_NONCE" ] && [ "$nonce" = "$LOCK_NONCE" ]; then
            rm -f "$LOCK_FILE"
        fi
    fi
    if [ -n "$SOURCE_CLONE_DIR" ] && [ -d "$SOURCE_CLONE_DIR" ]; then
        rm -rf "$SOURCE_CLONE_DIR"
    fi
    if [ -n "$OFFER_RUNTIME_DIR" ] && [ -d "$OFFER_RUNTIME_DIR" ]; then
        rm -rf "$OFFER_RUNTIME_DIR"
    fi
    return 0
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

remember_tmp() {
    TMP_FILES="${TMP_FILES}$1
"
}
exclusive_tmp() {
    prefix="$1"
    dir="${2:-$INSTALL_DIR}"
    mkdir -p "$dir"
    LAST_EXCLUSIVE_TMP=$(mktemp "${dir}/${prefix}.XXXXXX")
    if [ -h "$LAST_EXCLUSIVE_TMP" ]; then
        rm -f "$LAST_EXCLUSIVE_TMP"
        die "Refusing to write through a symlink at $LAST_EXCLUSIVE_TMP"
    fi
    remember_tmp "$LAST_EXCLUSIVE_TMP"
}


is_safe_tag() {
    case "$1" in
        v[A-Za-z0-9]*)
            rest="${1#v}"
            stripped=$(printf '%s' "$rest" | tr -d 'A-Za-z0-9._-')
            [ -z "$stripped" ]
            return $?
            ;;
        *)
            return 1
            ;;
    esac
}

is_stable_release_tag() {
    printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'
}

is_nightly_release_tag() {
    printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+\.g[0-9a-f]+$'
}

is_release_tag() {
    is_stable_release_tag "$1" || is_nightly_release_tag "$1"
}

is_safe_channel() {
    [ "$1" = "stable" ] || [ "$1" = "nightly" ]
}

has_bun() {
    command -v bun >/dev/null 2>&1
}

require_dev_checkout() {
    case "$0" in
        */scripts/install.sh | scripts/install.sh)
            ;;
        *)
            die "--dev requires running the on-disk scripts/install.sh from a GJC checkout; piped installers cannot use --dev."
            ;;
    esac

    script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) ||
        die "--dev could not resolve the on-disk installer path."
    DEV_REPO_ROOT=$(CDPATH= cd -- "$script_dir/.." 2>/dev/null && pwd) ||
        die "--dev could not resolve the GJC checkout root."

    if [ ! -f "$script_dir/install.sh" ] || \
        [ ! -f "$DEV_REPO_ROOT/package.json" ] || \
        [ ! -f "$DEV_REPO_ROOT/bun.lock" ] || \
        [ ! -f "$DEV_REPO_ROOT/packages/coding-agent/package.json" ]; then
        die "--dev requires a GJC checkout containing scripts/install.sh, package.json, bun.lock, and packages/coding-agent/package.json."
    fi
}

has_git() {
    command -v git >/dev/null 2>&1
}

has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}


trusted_github_url() {
    case "$1" in
        https://api.github.com/* | https://github.com/*) return 0 ;;
        *) return 1 ;;
    esac
}

require_official_github_origins() {
    api=$(printf '%s' "$GITHUB_API" | sed 's:/*$::')
    releases=$(printf '%s' "$GITHUB_RELEASES" | sed 's:/*$::')
    expected_releases="https://github.com/${REPO}/releases/download"
    if [ "$api" != "https://api.github.com" ]; then
        die "GJC_GITHUB_API must be https://api.github.com (got ${GITHUB_API})."
    fi
    if [ "$releases" != "$expected_releases" ]; then
        die "GJC_GITHUB_RELEASES must be ${expected_releases} (got ${GITHUB_RELEASES})."
    fi
}

prepare_github_auth_header() {
    token="$1"
    exclusive_tmp "gjc.curlhdr" "${TMPDIR:-/tmp}"
    AUTH_HDR="$LAST_EXCLUSIVE_TMP"
    old_umask=$(umask)
    umask 077
    printf 'Authorization: Bearer %s\n' "$token" > "$AUTH_HDR"
    umask "$old_umask"
}

curl_github() {
    url="$1"
    out="$2"
    token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    if [ -n "$token" ] && trusted_github_url "$url"; then
        prepare_github_auth_header "$token"
        curl -fsSL --retry 3 --retry-delay 1 \
            -A "gjc-install" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            -H "@${AUTH_HDR}" \
            -o "$out" "$url"
    else
        curl -fsSL --retry 3 --retry-delay 1 \
            -A "gjc-install" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            -o "$out" "$url"
    fi
}

curl_github_optional() {
    url="$1"
    out="$2"
    token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    if [ -n "$token" ] && trusted_github_url "$url"; then
        prepare_github_auth_header "$token"
        curl -sSL --retry 2 --retry-delay 1 \
            -A "gjc-install" \
            -H "Accept: application/octet-stream" \
            -H "@${AUTH_HDR}" \
            -o "$out" -w "%{http_code}" "$url"
    else
        curl -sSL --retry 2 --retry-delay 1 \
            -A "gjc-install" \
            -H "Accept: application/octet-stream" \
            -o "$out" -w "%{http_code}" "$url"
    fi
}

extract_json_string() {
    json_file="$1"
    key="$2"
    # Constrained extractor: first "key": "value" whose value matches the
    # allowed charset. Rejects path traversal and shell metacharacters.
    tr -d '\r' < "$json_file" | awk -v key="$key" '
        BEGIN { pat = "\"" key "\"[[:space:]]*:[[:space:]]*\"" }
        {
            line = $0
            while (match(line, "\"" key "\"[ \t]*:[ \t]*\"[^\"]*\"")) {
                s = substr(line, RSTART, RLENGTH)
                sub(/^[^"]*\"[^\"]*\"[ \t]*:[ \t]*\"/, "", s)
                sub(/\"$/, "", s)
                print s
                exit
            }
        }
    '
}


pick_nightly_tag() {
    json_file="$1"
    # Split compact GitHub arrays so each field can be inspected independently.
    tr -d '\r' < "$json_file" | sed 's/[{,]/&\n/g' | awk '
        BEGIN { tag=""; draft=""; pre="" }
        {
            if ($0 ~ /\{/) { tag=""; draft=""; pre="" }
            if (match($0, /"tag_name"[ \t]*:[ \t]*"[^"]+"/)) {
                s = substr($0, RSTART, RLENGTH)
                sub(/^"tag_name"[ \t]*:[ \t]*"/, "", s)
                sub(/"$/, "", s)
                tag = s
            }
            if ($0 ~ /"draft"[ \t]*:[ \t]*true/) draft = "1"
            if ($0 ~ /"draft"[ \t]*:[ \t]*false/) draft = "0"
            if ($0 ~ /"prerelease"[ \t]*:[ \t]*true/) pre = "1"
            if ($0 ~ /"prerelease"[ \t]*:[ \t]*false/) pre = "0"
            if ($0 ~ /\}/) {
                if (pre == "1" && draft != "1" && tag ~ /-nightly\.[0-9]+\.[0-9]+\.g[0-9a-f]+$/) {
                    print tag
                    exit
                }
                tag=""; draft=""; pre=""
            }
        }
    '
}

file_sha256() {
    f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$f" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$f" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$f" | awk '{print $NF}'
    else
        die "Need sha256sum, shasum, or openssl to verify the downloaded binary"
    fi
}

lookup_checksum() {
    sums_file="$1"
    asset_name="$2"
    awk -v name="$asset_name" '
        $2 == name || $2 == ("*" name) || $2 == ("./" name) {
            print $1
            exit
        }
    ' "$sums_file"
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        die "Failed to read bun version"
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        die "Bun ${MIN_BUN_VERSION} or newer is required for --source. Current version: ${version_clean}
Install or upgrade Bun yourself: https://bun.sh/docs/installation
This installer never downloads Bun."
    fi
}

detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)
            PLATFORM="linux"
            ldd_out=$(ldd /bin/sh 2>/dev/null || true)
            if printf '%s' "$ldd_out" | grep -q musl; then
                die "Unsupported libc: musl. Prebuilt Linux binaries are glibc-only. See docs/install.md."
            fi
            if [ -z "$ldd_out" ] || ! printf '%s' "$ldd_out" | grep -q 'libc.so.6'; then
                die "Unsupported libc: could not identify glibc. Prebuilt Linux binaries are glibc-only. See docs/install.md."
            fi
            ;;
        Darwin) PLATFORM="darwin" ;;
        *)      die "Unsupported OS: $OS. Prebuilt binaries exist for Linux and macOS. See docs/install.md." ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             die "Unsupported architecture: $ARCH. Prebuilt binaries exist for x64 and arm64." ;;
    esac

    BINARY="gjc-${PLATFORM}-${ARCH}"
}

try_publish_lock_file() {
    lock="$1"
    ( set -C; umask 077; printf '%s %s\n' "$$" "$LOCK_NONCE" > "$lock" )
}

acquire_lock() {
    lock="${INSTALL_DIR}/.gjc-install.lock"
    mkdir -p "$INSTALL_DIR"
    LOCK_NONCE=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
    [ -n "$LOCK_NONCE" ] || LOCK_NONCE="$$.$RANDOM"
    if try_publish_lock_file "$lock" 2>/dev/null; then
        LOCK_FILE="$lock"
        return 0
    fi
    die "Another GJC installer is already running in ${INSTALL_DIR} (lock: ${lock}). Remove a leftover lock file only after confirming no installer is running."
}

resolve_release_tag() {
    exclusive_tmp "gjc-release"
    json_tmp="$LAST_EXCLUSIVE_TMP"

    if [ -n "$REF" ]; then
        is_release_tag "$REF" || die "Invalid --ref '$REF'. Expected a GitHub release tag like v0.15.0 or v0.15.0-nightly.1.1.gabc."
        echo "Fetching release $REF..."
        if ! curl_github "${GITHUB_API}/repos/${REPO}/releases/tags/${REF}" "$json_tmp"; then
            die "Release tag not found: $REF
For branch/commit source installs, re-run with --source --ref <git-ref> and an existing Bun."
        fi
        LATEST=$(extract_json_string "$json_tmp" "tag_name")
    elif [ "$CHANNEL" = "nightly" ]; then
        echo "Fetching latest nightly GitHub prerelease..."
        if ! curl_github "${GITHUB_API}/repos/${REPO}/releases?per_page=40" "$json_tmp"; then
            die "Failed to list GitHub releases for the nightly channel"
        fi
        LATEST=$(pick_nightly_tag "$json_tmp")
        if [ -z "$LATEST" ]; then
            die "The nightly channel has no published GitHub prerelease yet; it is populated by the scheduled nightly workflow."
        fi
    else
        echo "Fetching latest stable GitHub release..."
        if ! curl_github "${GITHUB_API}/repos/${REPO}/releases/latest" "$json_tmp"; then
            die "Failed to fetch the latest GitHub release"
        fi
        LATEST=$(extract_json_string "$json_tmp" "tag_name")
    fi

    if [ -n "$REF" ]; then
        is_release_tag "$LATEST" || die "Refusing unsafe release tag: ${LATEST:-<empty>}"
    elif [ "$CHANNEL" = "nightly" ]; then
        is_nightly_release_tag "$LATEST" || die "Refusing non-nightly release tag: ${LATEST:-<empty>}"
    else
        is_stable_release_tag "$LATEST" || die "Refusing non-stable release tag: ${LATEST:-<empty>}"
    fi
    EXPECTED_VERSION="${LATEST#v}"
    echo "Using version: $LATEST"
}

verify_checksum() {
    asset_name="$1"
    downloaded="$2"
    VERIFY_CHECKSUM_OPTIONAL="${3:-}"
    exclusive_tmp "gjc.sha256"
    sums_tmp="$LAST_EXCLUSIVE_TMP"
    exclusive_tmp "gjc.manifest"
    manifest_tmp="$LAST_EXCLUSIVE_TMP"
    sums_url="${GITHUB_RELEASES}/${LATEST}/${BINARY_SHA256_ASSET}"
    http_code=$(curl_github_optional "$sums_url" "$sums_tmp") || {
        if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
        die "Failed to fetch integrity asset $sums_url. Existing install was not changed."
    }
    if [ "$http_code" = "200" ]; then
        expected=$(lookup_checksum "$sums_tmp" "$asset_name")
        if [ ${#expected} -ne 64 ]; then
            if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
            die "Release checksum file ${BINARY_SHA256_ASSET} did not list ${asset_name}"
        fi
        actual=$(file_sha256 "$downloaded")
        if [ "$actual" != "$expected" ]; then
            if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
            die "Checksum mismatch for ${asset_name}: expected ${expected}, got ${actual}. Existing install was not changed."
        fi
        echo "Verified SHA-256 for ${asset_name}"
        return 0
    fi
    if [ "$http_code" != "404" ]; then
        if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
        die "Integrity asset ${BINARY_SHA256_ASSET} returned HTTP ${http_code}. Existing install was not changed."
    fi

    manifest_url="${GITHUB_RELEASES}/${LATEST}/${BINARY_MANIFEST_ASSET}"
    http_code=$(curl_github_optional "$manifest_url" "$manifest_tmp") || {
        if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
        die "Failed to fetch integrity asset $manifest_url. Existing install was not changed."
    }
    if [ "$http_code" = "200" ]; then
        expected=$(awk -v name="$asset_name" '
            $0 ~ "\"name\"" && $0 ~ name { saw=1 }
            saw && /"sha256"/ {
                if (match($0, /"sha256"[ \t]*:[ \t]*"[0-9a-f]{64}"/)) {
                    s = substr($0, RSTART, RLENGTH)
                    sub(/^.*"sha256"[ \t]*:[ \t]*"/, "", s)
                    sub(/"$/, "", s)
                    print s
                    exit
                }
            }
        ' "$manifest_tmp")
        if [ ${#expected} -ne 64 ]; then
            if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
            die "Release manifest ${BINARY_MANIFEST_ASSET} did not list a SHA-256 for ${asset_name}"
        fi
        actual=$(file_sha256 "$downloaded")
        if [ "$actual" != "$expected" ]; then
            if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
            die "Checksum mismatch for ${asset_name}: expected ${expected}, got ${actual}. Existing install was not changed."
        fi
        echo "Verified SHA-256 for ${asset_name} from ${BINARY_MANIFEST_ASSET}"
        return 0
    fi
    if [ "$http_code" != "404" ]; then
        if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
        die "Integrity asset ${BINARY_MANIFEST_ASSET} returned HTTP ${http_code}. Existing install was not changed."
    fi

    if [ "$VERIFY_CHECKSUM_OPTIONAL" = "optional" ]; then return 1; fi
    die "Release ${LATEST} has no checksum assets. Existing install was not changed."
}

restore_backup() {
    if [ -n "$BACKUP_PATH" ] && [ -f "$BACKUP_PATH" ] && [ -n "$DEST_PATH" ]; then
        mv -f "$BACKUP_PATH" "$DEST_PATH"
        echo "Restored previous gjc binary at ${DEST_PATH}"
    elif [ -n "$DEST_PATH" ] && [ ! -f "$BACKUP_PATH" ]; then
        rm -f "$DEST_PATH"
    fi
}

verify_installed_binary() {
    dest="$1"
    expected="$2"
    if [ ! -x "$dest" ]; then
        echo "Installed file is not executable: $dest" >&2
        return 1
    fi
    reported=$("$dest" --version 2>/dev/null || true)
    actual=$(printf '%s\n' "$reported" | sed -n 's|^gjc/\([^[:space:]]*\).*|\1|p')
    if [ "$actual" != "$expected" ]; then
        echo "Installed binary --version mismatch (expected gjc/${expected}, got: ${reported:-<empty>})" >&2
        return 1
    fi
    if ! "$dest" --smoke-test >/dev/null 2>&1; then
        echo "Installed binary --smoke-test failed" >&2
        return 1
    fi
    return 0
}

install_dev() {
    echo "Building and installing GJC from the current checkout..."
    cd "$DEV_REPO_ROOT" || die "--dev could not enter the GJC checkout at ${DEV_REPO_ROOT}."
    bun run build || die "--dev build failed."
    bun run install:dev:bin || die "--dev install failed."
    echo ""
    echo "Installed gjc development build from checkout"
    echo "Run 'gjc' to get started!"
}

install_via_bun() {
    echo "Installing from source via existing bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            die "git is required for --source --ref"
        fi

        TMP_DIR="$(mktemp -d)"
        SOURCE_CLONE_DIR="$TMP_DIR"
        SOURCE_TMP="$TMP_DIR"

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            rm -rf "$TMP_DIR"
            die "Expected package at ${TMP_DIR}/packages/coding-agent"
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            rm -rf "$TMP_DIR"
            die "Failed to install from source"
        }
        rm -rf "$TMP_DIR"
    else
        bun install -g "$PACKAGE" || die "Failed to install $PACKAGE"
    fi
    echo ""
    echo "Installed gjc via bun (development/source mode)"
    echo "Run 'gjc' to get started!"
}

install_binary() {
    detect_platform
    require_official_github_origins
    acquire_lock
    resolve_release_tag

    DEST_PATH="${INSTALL_DIR}/gjc"
    exclusive_tmp "gjc.download"
    DOWNLOAD_TMP="$LAST_EXCLUSIVE_TMP"
    BACKUP_PATH=""

    BINARY_URL="${GITHUB_RELEASES}/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    if ! curl_github "$BINARY_URL" "$DOWNLOAD_TMP"; then
        rm -f "$DOWNLOAD_TMP"
        echo ""
        echo "No prebuilt GJC binary was found for ${PLATFORM}-${ARCH} in ${LATEST}."
        echo "Fallback options:"
        echo "  - Choose a release that publishes ${BINARY}"
        echo "  - Re-run this installer with --source if you are developing GJC and already have Bun"
        echo "Expected asset URL: $BINARY_URL"
        exit 1
    fi

    if [ ! -s "$DOWNLOAD_TMP" ]; then
        rm -f "$DOWNLOAD_TMP"
        die "Downloaded file was empty: $BINARY_URL. Existing install was not changed."
    fi

    verify_checksum "$BINARY" "$DOWNLOAD_TMP"
    chmod +x "$DOWNLOAD_TMP"

    if [ -h "$DEST_PATH" ]; then
        die "Refusing to replace symlink ${DEST_PATH} with a regular binary. Remove the symlink or set GJC_INSTALL_DIR."
    fi

    if [ -e "$DEST_PATH" ]; then
        exclusive_tmp "gjc.bak"
        BACKUP_PATH="$LAST_EXCLUSIVE_TMP"
        rm -f "$BACKUP_PATH"
        cp -p "$DEST_PATH" "$BACKUP_PATH"
    fi

    if ! mv -f "$DOWNLOAD_TMP" "$DEST_PATH"; then
        restore_backup
        die "Failed to publish the downloaded binary. Existing install was preserved if one existed."
    fi

    if ! verify_installed_binary "$DEST_PATH" "$EXPECTED_VERSION"; then
        restore_backup
        die "Verification failed; existing install was preserved if one existed."
    fi

    rm -f "$BACKUP_PATH"
    BACKUP_PATH=""

    echo ""
    echo "Installed gjc ${EXPECTED_VERSION} to ${DEST_PATH}"

    # The verified runtime owns the optional macOS community-app flow so fresh
    # installs and `gjc update` share the same supply-chain checks. The offer is
    # strictly best-effort and must never change a successful GJC install.
    if [ "$PLATFORM" = "darwin" ]; then
        OFFER_RUNTIME_DIR=$(mktemp -d "${INSTALL_DIR}/.gjc-community-app.XXXXXX" 2>/dev/null || true)
        OFFER_RUNTIME="${OFFER_RUNTIME_DIR}/gjc"
        if [ -n "$OFFER_RUNTIME_DIR" ] && [ ! -L "$DEST_PATH" ] && [ -f "$DEST_PATH" ] && ln "$DEST_PATH" "$OFFER_RUNTIME" 2>/dev/null; then
            if [ -f "$OFFER_RUNTIME" ] && [ "$OFFER_RUNTIME" -ef "$DEST_PATH" ] && verify_checksum "$BINARY" "$OFFER_RUNTIME" optional; then
                "$OFFER_RUNTIME" macos-community-app-offer || true
            fi
            rm -rf "$OFFER_RUNTIME_DIR" || true
            OFFER_RUNTIME_DIR=""
        elif [ -n "$OFFER_RUNTIME_DIR" ]; then
            rm -rf "$OFFER_RUNTIME_DIR" || true
            OFFER_RUNTIME_DIR=""
        fi
    fi

    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'gjc' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'gjc'" ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            SOURCE_REQUESTED=1
            MODE="source"
            shift
            ;;
        --dev)
            DEV_REQUESTED=1
            MODE="dev"
            shift
            ;;
        --binary)
            BINARY_REQUESTED=1
            MODE="binary"
            shift
            ;;
        --channel)
            shift
            [ -n "$1" ] || die "Missing value for --channel"
            CHANNEL="$1"
            is_safe_channel "$CHANNEL" || die "Invalid --channel '$CHANNEL'. Expected stable or nightly."
            shift
            ;;
        --channel=*)
            CHANNEL="${1#*=}"
            is_safe_channel "$CHANNEL" || die "Invalid --channel '$CHANNEL'. Expected stable or nightly."
            shift
            ;;
        --ref)
            shift
            [ -n "$1" ] || die "Missing value for --ref"
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            [ -n "$REF" ] || die "Missing value for --ref"
            shift
            ;;
        -r)
            shift
            [ -n "$1" ] || die "Missing value for -r"
            REF="$1"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "Unknown option: $1"
            ;;
    esac
done

if [ "$DEV_REQUESTED" -eq 1 ]; then
    if [ "$SOURCE_REQUESTED" -eq 1 ] || [ "$BINARY_REQUESTED" -eq 1 ]; then
        die "--dev cannot be combined with --source or --binary."
    fi
    [ -z "$REF" ] || die "--dev cannot be combined with --ref; it uses the current checkout."
    [ "$CHANNEL" = "stable" ] || die "--dev cannot be combined with --channel $CHANNEL; it uses the current checkout."
fi

case "$MODE" in
    source)
        if ! has_bun; then
            die " --source requires an existing Bun ${MIN_BUN_VERSION}+ on PATH.
This installer never downloads Bun. Install it from https://bun.sh/docs/installation
Ordinary installs should omit --source and use the prebuilt binary."
        fi
        require_bun_version
        install_via_bun
        ;;
    dev)
        require_dev_checkout
        if ! has_bun; then
            die "--dev requires an existing Bun on PATH.
This installer never downloads Bun. Install it from https://bun.sh/docs/installation"
        fi
        install_dev
        ;;
    binary)
        install_binary
        ;;
    *)
        die "Internal error: unknown mode $MODE"
        ;;
esac
