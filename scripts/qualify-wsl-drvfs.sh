#!/usr/bin/env bash
set -euo pipefail

[[ $# == 6 ]] || { printf 'Expected bundle, head, tree, evidence, Windows-drive root, drive\n' >&2; exit 1; }
bundle=$1
head=$2
tree=$3
evidence=$4
drvfs_root=$5
drive=$6
[[ $head =~ ^[0-9a-f]{40}$ && $tree =~ ^[0-9a-f]{40}$ && $drive =~ ^[A-Za-z]:$ ]]
[[ -d $evidence && -d $drvfs_root && $drvfs_root == /mnt/* ]]
exec > >(tee "$evidence/linux-stdout.txt") 2> >(tee "$evidence/linux-stderr.txt" >&2)
trap 'status=$?; printf "%s\n" "$status" > "$evidence/linux-exit-code.txt"' EXIT

uname -a
cat /proc/version
cat /etc/os-release
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
grep -qi microsoft /proc/version
findmnt -T "$drvfs_root" -o TARGET,SOURCE,FSTYPE,OPTIONS > "$evidence/mount-before.txt"
mount_type=$(findmnt -T "$drvfs_root" -n -o FSTYPE)
[[ $mount_type == drvfs || $mount_type == 9p ]] || { printf 'Not a real Windows-drive mount: %s\n' "$mount_type" >&2; exit 1; }
# Use a new mount in this disposable distro rather than remounting the drive
# holding the evidence streams. Metadata modes are part of the lock contract.
mount_target=$(findmnt -T "$drvfs_root" -n -o TARGET)
[[ $drvfs_root == "$mount_target/"* ]]
relative_root=${drvfs_root#"$mount_target/"}
private_mount=/mnt/gjc-qualification-drvfs
mkdir "$private_mount"
printf 'mount -t drvfs %q %q -o metadata\n' "$drive" "$private_mount" > "$evidence/mount-configuration.txt"
mount -t drvfs "$drive" "$private_mount" -o metadata
drvfs_root="$private_mount/$relative_root"
[[ -d $drvfs_root ]]
findmnt -T "$drvfs_root" -o TARGET,SOURCE,FSTYPE,OPTIONS > "$evidence/mount-after.txt"
mount_type=$(findmnt -T "$drvfs_root" -n -o FSTYPE)
mount_options=$(findmnt -T "$drvfs_root" -n -o OPTIONS)
[[ $mount_type == drvfs || $mount_type == 9p ]]
[[ ,$mount_options, == *,metadata,* || $mount_options == *';metadata'* ]]
printf 'GJC_TEST_DRVFS_ROOT=%s\n' "$drvfs_root" > "$evidence/test-root.txt"

export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    ca-certificates curl unzip xz-utils git jq python3 procps build-essential \
    cmake clang libclang-dev pkg-config libssl-dev libcairo2-dev libpango1.0-dev \
    libjpeg-dev libgif-dev librsvg2-dev
# Clone committed objects into the Linux filesystem, avoiding Windows checkout
# line endings, symlinks, node_modules, and all contributor worktree state.
git clone --no-checkout "$bundle" /root/source
cd /root/source
git checkout --detach "$head"
[[ $(git rev-parse HEAD) == "$head" && $(git rev-parse 'HEAD^{tree}') == "$tree" ]]
[[ -z $(git status --porcelain) ]]
findmnt -T "$PWD" -o TARGET,SOURCE,FSTYPE,OPTIONS > "$evidence/build-mount.txt"
source_type=$(findmnt -T "$PWD" -n -o FSTYPE)
[[ $source_type != drvfs && $source_type != 9p ]]
printf 'head=%s\ntree=%s\nsource=%s\n' "$head" "$tree" "$PWD" > "$evidence/linux-source.txt"
sha256sum "$bundle" package.json bun.lock rust-toolchain.toml > "$evidence/source-sha256.txt"

fetch() {
    curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 \
        --connect-timeout 30 --max-time 600 --output "$2" "$1"
}
mkdir /root/bootstrap
bun_version=$(jq -er '.packageManager | capture("^bun@(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$").version' package.json)
release_url="https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v$bun_version"
fetch "$release_url" "$evidence/bun-release.json"
bun_asset=bun-linux-x64-baseline.zip
jq -e --arg tag "bun-v$bun_version" '.tag_name == $tag and .draft == false and .prerelease == false' "$evidence/bun-release.json"
asset_url=$(jq -er --arg name "$bun_asset" '[.assets[] | select(.name == $name)] | if length == 1 then .[0].browser_download_url else error("missing/duplicate Bun asset") end' "$evidence/bun-release.json")
asset_digest=$(jq -er --arg name "$bun_asset" '.assets[] | select(.name == $name) | .digest' "$evidence/bun-release.json")
[[ $asset_url == "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/$bun_asset" ]]
[[ $asset_digest =~ ^sha256:[0-9a-f]{64}$ ]]
fetch "$asset_url" /root/bootstrap/bun.zip
printf '%s  %s\n' "${asset_digest#sha256:}" /root/bootstrap/bun.zip | sha256sum --check
unzip -q /root/bootstrap/bun.zip -d /root/bootstrap
install -m 755 /root/bootstrap/bun-linux-x64-baseline/bun /usr/local/bin/bun
[[ $(bun --version) == "$bun_version" ]]
bun --revision
sha256sum /root/bootstrap/bun.zip /usr/local/bin/bun > "$evidence/bun-sha256.txt"

# Pinned official rustup binary, checked against both official SHA256 and the
# reviewed digest before execution. rust-toolchain.toml selects the compiler.
rustup_url=https://static.rust-lang.org/rustup/archive/1.29.1/x86_64-unknown-linux-gnu/rustup-init
rustup_hash=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
fetch "$rustup_url.sha256" "$evidence/rustup-init.sha256"
read -r official_hash _ < "$evidence/rustup-init.sha256"
[[ $official_hash == "$rustup_hash" ]]
fetch "$rustup_url" /root/bootstrap/rustup-init
printf '%s  %s\n' "$rustup_hash" /root/bootstrap/rustup-init | sha256sum --check
chmod 755 /root/bootstrap/rustup-init
/root/bootstrap/rustup-init -y --no-modify-path --default-toolchain none --profile minimal
export PATH="/root/.cargo/bin:$PATH"
rustup show > "$evidence/rust-toolchain.txt"
rustc --version --verbose >> "$evidence/rust-toolchain.txt"
cargo --version >> "$evidence/rust-toolchain.txt"
sha256sum "$(rustup which rustc)" >> "$evidence/rust-toolchain.txt"
dpkg-query -W > "$evidence/linux-packages.txt"

publication=packages/coding-agent/test/file-lock-publication-recovery.test.ts
gc=packages/coding-agent/test/file-lock-gc-toctou.test.ts
[[ -f $publication && -f $gc ]]
sha256sum "$publication" "$gc" >> "$evidence/source-sha256.txt"
bun install --frozen-lockfile
TARGET_PLATFORM=linux TARGET_ARCH=x64 TARGET_VARIANTS='baseline modern' bun run ci:build:native
sha256sum packages/natives/native/pi_natives.linux-x64-baseline.node \
    packages/natives/native/pi_natives.linux-x64-modern.node > "$evidence/native-sha256.txt"
export GJC_TEST_DRVFS_ROOT="$drvfs_root"
printf 'GJC_TEST_DRVFS_ROOT=%q timeout --signal=TERM --kill-after=30s 15m bun test %q %q --reporter=junit --reporter-outfile=%q\n' "$drvfs_root" "./$publication" "./$gc" "$evidence/tests.xml" > "$evidence/test-command.txt"
status=0
timeout --signal=TERM --kill-after=30s 15m bun test "./$publication" "./$gc" \
    --reporter=junit --reporter-outfile="$evidence/tests.xml" \
    > "$evidence/tests-stdout.txt" 2> "$evidence/tests-stderr.txt" || status=$?
printf '%s\n' "$status" > "$evidence/test-exit-code.txt"
cat "$evidence/tests-stdout.txt"
cat "$evidence/tests-stderr.txt" >&2
[[ $status == 0 ]] || exit "$status"
# Synthetic cases alone cannot qualify this run. Require the exact existing
# real-filesystem testcase to have executed and passed, not merely suite exit 0.
python3 - "$evidence/tests.xml" "$evidence/real-drvfs-result.txt" <<'PY'
import sys
import xml.etree.ElementTree as ET

name = "real DrvFS filesystem acquires, writes, releases, and reacquires without lock remnants"
root = ET.parse(sys.argv[1]).getroot()
cases = [case for case in root.iter("testcase") if case.get("name") == name]
if len(cases) != 1 or any(cases[0].find(tag) is not None for tag in ("skipped", "failure", "error")):
    raise SystemExit("Required real DrvFS testcase absent, duplicated, skipped, or failed")
if cases[0].get("file") != "packages/coding-agent/test/file-lock-publication-recovery.test.ts":
    raise SystemExit("Real DrvFS testcase is not from the expected source file")
if int(cases[0].get("assertions", "0")) <= 0:
    raise SystemExit("Real DrvFS testcase recorded no assertions")
with open(sys.argv[2], "w", encoding="utf-8") as receipt:
    receipt.write("Executed and passed: " + name + "\n")
PY
