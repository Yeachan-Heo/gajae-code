#!/bin/bash
# Measure 'gjc sdk session status' startup latency
# Usage: ./measure_sdk_startup.sh [iterations]

ITERATIONS=${1:-15}
CMD="bun run dev -- sdk --version"

echo "Measuring SDK startup latency (${ITERATIONS} iterations)..."
echo "Command: $CMD"
echo ""

hyperfine --runs $ITERATIONS --prepare "bun run dev -- --version > /dev/null 2>&1" "$CMD"
