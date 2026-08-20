#!/usr/bin/env bash
#
# Install (or verify) the system dependencies needed by CI smoke/test jobs.
#
# Shared by ci.yml (`test`, `install_methods`) and dev-ci.yml (`affected`).
# When every required tool and library is already present the script exits
# without touching apt, so warm self-hosted runners skip the install entirely.
# When anything is missing it performs exactly the historical install
# behavior, including the sudo-unavailable warning fallback.
#
# `-eo pipefail` mirrors the default shell GitHub Actions uses for `run:`
# steps, so the extracted script keeps the inline blocks' failure semantics.
set -eo pipefail
# Guard against stalled apt mirrors (observed: azure.archive.ubuntu.com stopped
# responding mid-fetch and apt blocked until the job's hard timeout). apt has no
# default per-request deadline, so bound each update/install pass and retry with
# the fallback mirror before giving up.
apt_with_timeout() {
   local attempt rc
   for attempt in 1 2 3; do
      timeout --foreground 8m "$@" && return 0
      rc=$?
      echo "system-deps: apt attempt ${attempt} failed or stalled (exit ${rc}); retrying with a fallback mirror." >&2
      # Force the canonical archive.ubuntu.com mirror: azure.archive.ubuntu.com is
      # the runner default and is what stalls on cold runners.
      printf 'deb https://archive.ubuntu.com/ubuntu jammy main universe\ndeb https://archive.ubuntu.com/ubuntu jammy-updates main universe\ndeb https://archive.ubuntu.com/ubuntu jammy-security main universe\n' \
         | sudo tee /etc/apt/sources.list.d/gjc-fallback.list >/dev/null
   done
   echo "system-deps: apt remained stalled after retries; failing closed." >&2
   return 1
}

# Tools expected on PATH (imagemagick is satisfied by `convert` or `magick`).
required_path_tools=(fd rg tmux gh)
# Development libraries verified via dpkg.
required_dpkg_libs=(libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev)

missing=0

for tool in "${required_path_tools[@]}"; do
   if ! command -v "$tool" >/dev/null 2>&1; then
      echo "system-deps: missing tool on PATH: $tool"
      missing=1
   fi
done

if ! command -v convert >/dev/null 2>&1 && ! command -v magick >/dev/null 2>&1; then
   echo "system-deps: missing imagemagick (convert/magick) on PATH"
   missing=1
fi

for lib in "${required_dpkg_libs[@]}"; do
   if ! dpkg -s "$lib" >/dev/null 2>&1; then
      echo "system-deps: missing dpkg package: $lib"
      missing=1
   fi
done

if [ "$missing" -eq 0 ]; then
   echo "system-deps: all required tools and libraries already present; skipping apt."
   exit 0
fi

echo "system-deps: missing dependencies detected; installing."
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
   apt_with_timeout sudo apt-get update
   apt_with_timeout sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep imagemagick tmux gh
   sudo ln -sf $(which fdfind) /usr/local/bin/fd
   sudo ln -sf /usr/bin/convert /usr/local/bin/magick
else
   echo "sudo unavailable on this runner; skipping apt-based system dependency install."
   echo "The self-hosted runner image is expected to provide optional smoke-test helpers when needed."
   for tool in fd rg convert tmux gh; do
      if ! command -v "$tool" >/dev/null 2>&1; then
         echo "warning: optional helper not on PATH: $tool"
      fi
   done
fi
