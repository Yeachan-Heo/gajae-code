# @gajae-code/stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.gjc/agent/sessions/`
- **SQLite aggregation**: Efficient stats storage and querying using `bun:sqlite`
- **Web dashboard**: Real-time metrics visualization with Chart.js
- **Incremental sync**: Only processes new/modified log entries
- **Role usage breakdown**: `gjc stats --summary` and JSON report usage by default, executor, planner, architect, and critic; custom roles and legacy sessions without identity metadata are grouped as `other` or `unknown`

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| Total Cost | Sum of `usage.cost.total` |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
gjc stats

# Custom port
gjc stats --port 8080

# Print summary to console
gjc stats --summary

# Output as JSON (for scripting)
gjc stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@gajae-code/stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
console.log(stats.byAgent.find(agent => agent.agent === "executor")?.totalCost);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `POST /api/sync` | Trigger sync and return counts |

## Local server security

The dashboard binds only to `127.0.0.1`; the CLI opens its default browser URL through `localhost`. API requests must use HTTP, the server's actual port, and exactly `localhost` or `127.0.0.1`. Browser requests must remain same-origin, and session sync requires a same-origin `POST` request. The server does not enable cross-origin access or trust forwarded host headers.

Reverse-proxy and non-loopback deployments are unsupported. They require a separate authenticated deployment boundary rather than relaxing these local-only checks.

## Data Storage

- **Session logs**: `~/.gjc/agent/sessions/` (JSONL files)
- **Stats database**: `~/.gjc/stats.db` (SQLite)

## Dashboard

The web dashboard provides:

- Overall metrics cards (requests, cost, cache rate, error rate, duration, tokens/s)
- Time series chart showing requests and errors over time
- Per-model breakdown table
- Per-folder breakdown table
- Auto-refresh every 30 seconds

## Tips & Common Patterns

### Sync and print a summary

Every `gjc stats` invocation syncs session files before it does anything else, so there is no separate sync flag.

```bash
gjc stats --summary
```

### JSON output for scripting

`gjc stats --json` prints a `Synced N new entries ...` status line and a blank line on stdout before the JSON object (sync progress goes to stderr). Skip to the first line that opens the object before piping into `jq`:

```bash
gjc stats --json | sed -n '/^{/,$p' | jq '.overall.totalCost'
```

### Dashboard on a custom port

```bash
gjc stats --port 3000
```

`--summary` and `--json` print and exit without starting the server, so `--port` has no effect when combined with them.

### Programmatic: highest-cost folder

```typescript
import { getDashboardStats, syncAllSessions } from "@gajae-code/stats";

await syncAllSessions();
const stats = await getDashboardStats();

const [first, ...rest] = stats.byFolder;
if (first) {
  const topFolder = rest.reduce((a, b) => (b.totalCost > a.totalCost ? b : a), first);
  console.log(`Highest cost folder: ${topFolder.folder} ($${topFolder.totalCost.toFixed(2)})`);
} else {
  console.log("No folder data available");
}
```

### Programmatic: most-requested model

```typescript
import { getDashboardStats, syncAllSessions } from "@gajae-code/stats";

await syncAllSessions();
const stats = await getDashboardStats();

// byModel is ordered by request count, highest first.
const topModel = stats.byModel[0];
if (topModel) {
  console.log(`Most requested model: ${topModel.model} (${topModel.totalRequests} requests)`);
}
```

### Troubleshooting

- **No data shown?** Check that session logs exist under `~/.gjc/agent/sessions/`.
- **Dashboard not starting?** Check that port 3847 (or the port passed to `--port`) is free.

## License

MIT
