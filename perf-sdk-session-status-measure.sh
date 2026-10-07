#!/usr/bin/env bash
# Performance measurement for SDK session status latency optimization
# This script measures the baseline latency and tests various code paths

set -e

PROJECT_ROOT="/home/bellman/Workspace/gajae-way"
cd "$PROJECT_ROOT"

echo "=== SDK Session Status Latency Measurement ==="
echo "Date: $(date)"
echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
echo ""

# Build the CLI
echo "Building CLI..."
bun run dev -- --version > /dev/null 2>&1
echo "CLI ready."
echo ""

# Test 1: Measure import-time lazy initialization improvement
# This measures just loading the module with runtime-adapters
echo "Test 1: Module import time (with lazy node authority initialization)"
echo "Running 10 iterations..."
hyperfine --min-runs 10 \
  "bun run dev -- --version" \
  --show-output 2>&1 | grep -E "(Time|Benchmark)"

echo ""

# Test 2: CLI help command (checks if modules load quickly)
echo "Test 2: SDK session status help command (module loading + command parsing)"
echo "Running 10 iterations..."
hyperfine --min-runs 10 \
  "bun run dev -- sdk session status --help > /dev/null 2>&1" \
  --show-output 2>&1 | grep -E "(Time|Benchmark)"

echo ""
echo "=== Measurement Notes ==="
echo "1. The lazy-initialization optimization defers expensive import-time operations"
echo "2. Node authority hashing is now only computed when actually needed (for plugin validation)"
echo "3. SessionRouter lightweight mode skips full index reconciliation for single-session queries"
echo ""
echo "Expected improvements:"
echo "- Module import time: ~50-100ms reduction (fewer path scans and SHA256 computations)"
echo "- SDK status command: ~200-400ms reduction (skipped full index reconciliation)"
echo ""
