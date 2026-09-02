#!/usr/bin/env bash
# Research-only harness for mission ai-harness-trends-gjc-improvements.
# Wraps the deterministic mock orchestration-token benchmark (no live network,
# fixed workload) and emits METRIC/ASI lines. Exit 0 on success.
# NOTE: this file is a mission research artifact, NOT product code.
set -euo pipefail
cd "$(dirname "$0")" || exit 1
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
bun --cwd=packages/orchestration-token-benchmark run start >"$TMP/out.json" 2>"$TMP/err.txt"
python3 - "$TMP/out.json" <<'PYEOF'
import json,sys
d=json.load(open(sys.argv[1]))
tm=d["tokenMetrics"]
print(f"METRIC cache_hit_rate_high={tm['highCache']['cacheHitRate']:.4f}")
print(f"METRIC cache_hit_rate_low={tm['lowCache']['cacheHitRate']:.4f}")
print(f"METRIC token_overhead_ratio={tm['highCache']['totalTokens']/max(1,tm['lowCache']['totalTokens']):.4f}")
ps=d["prefixStability"]["stable"]
print(f"METRIC prefix_stability_stable={1 if ps['stable'] else 0}")
print(f"ASI prefix_violations_total={sum(len(x['violations']) for x in d['prefixStability'].values())}")
sg=d["spawnGate"]
print(f"ASI spawn_gate_rejects_incomplete_plan={1 if sg['fanout5Reject']['outcome']=='rejected' else 0}")
print(f"ASI spawn_gate_passes_complete_plan={1 if sg['fanout5PlanOk']['outcome']=='allowed' else 0}")
PYEOF
