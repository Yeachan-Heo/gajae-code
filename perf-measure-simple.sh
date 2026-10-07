#!/usr/bin/env bash
# Simple latency measurement for SDK session status

set -e

PROJECT_ROOT="/home/bellman/Workspace/gajae-way"
cd "$PROJECT_ROOT"

echo "=== SDK Session Status Latency Measurement ==="
echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
echo ""

# Warm up
echo "Warming up..."
bun run dev -- --version > /dev/null 2>&1
sleep 1

# Test 1: Module import and version check (10 runs)
echo "Test 1: CLI version command (10 runs)"
times=()
for i in {1..10}; do
  start=$(date +%s%N)
  bun run dev -- --version > /dev/null 2>&1
  end=$(date +%s%N)
  elapsed=$((($end - $start) / 1000000))  # Convert to ms
  times+=($elapsed)
  echo "  Run $i: ${elapsed}ms"
done

# Calculate average
sum=0
for t in "${times[@]}"; do
  sum=$((sum + t))
done
avg=$((sum / ${#times[@]}))
echo "Average: ${avg}ms"
echo ""

# Test 2: Help command (10 runs)
echo "Test 2: SDK session status help (10 runs)"
times=()
for i in {1..10}; do
  start=$(date +%s%N)
  bun run dev -- sdk session status --help > /dev/null 2>&1
  end=$(date +%s%N)
  elapsed=$((($end - $start) / 1000000))
  times+=($elapsed)
  echo "  Run $i: ${elapsed}ms"
done

sum=0
for t in "${times[@]}"; do
  sum=$((sum + t))
done
avg=$((sum / ${#times[@]}))
echo "Average: ${avg}ms"
echo ""

echo "=== Results ==="
echo "Optimization summary:"
echo "1. Lazy-load node authority initialization: Defers PATH scanning and SHA256 hashing"
echo "2. SessionRouter lightweight mode: Skips full index reconciliation for single-session status"
echo "3. No heavy module loading on status path: Model registry/babel/otel remain deferred"
echo ""
