#!/bin/bash
# Measure startup timing by running multiple times and recording wall clock time

ITERATIONS=${1:-15}
CMD="${2:-bun run dev -- sdk --version}"

echo "Measuring: $CMD"
echo "Iterations: $ITERATIONS"
echo ""

TIMES=()
for i in $(seq 1 $ITERATIONS); do
  START=$(date +%s%N)
  eval "$CMD" > /dev/null 2>&1
  END=$(date +%s%N)
  
  # Calculate elapsed time in milliseconds
  ELAPSED=$(( (END - START) / 1000000 ))
  TIMES+=($ELAPSED)
  
  echo "Run $i: ${ELAPSED}ms"
done

echo ""
echo "=== Statistics ==="

# Calculate min, max, mean
MIN=${TIMES[0]}
MAX=${TIMES[0]}
SUM=0

for t in "${TIMES[@]}"; do
  if (( t < MIN )); then MIN=$t; fi
  if (( t > MAX )); then MAX=$t; fi
  SUM=$((SUM + t))
done

MEAN=$((SUM / ITERATIONS))

echo "Min:  ${MIN}ms"
echo "Max:  ${MAX}ms"
echo "Mean: ${MEAN}ms"
echo "Total iterations: $ITERATIONS"
