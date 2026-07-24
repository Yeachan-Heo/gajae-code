/**
 * Stream local GJC session JSONL files and mine compaction behavior.
 *
 * Usage: bun scripts/mine-compaction-history.ts [--json] [--since YYYY-MM-DD]
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SESSIONS_ROOT = join(homedir(), ".gjc", "agent", "sessions");

function opaqueSessionId(sessionFile: string): string {
  return `session:${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}`;
}
const JULY_START = "2026-07-01";
const JULY_END = "2026-07-17";
const OVERFLOW_PATTERN =
  /context_too_large|exceeds the context window|exceeds the available context size|prompt is too long|context (?:window|length|size).*(?:exceeded|overflow)|(?:input|request|payload).*too large/i;

/** User ~/.gjc/agent/models.yml, verified 2026-07-16. Exact keys take precedence. */
const EXACT_MODEL_WINDOWS: Record<string, number> = {
  // layofflabs (openai-responses proxy): 400k except kimi family (256k)
  "layofflabs/gpt-5.2": 400_000,
  "layofflabs/gpt-5.3": 400_000,
  "layofflabs/gpt-5.3-codex-spark": 400_000,
  "layofflabs/gpt-5.4": 400_000,
  "layofflabs/gpt-5.4-mini": 400_000,
  "layofflabs/gpt-5.5": 400_000,
  "layofflabs/gpt-5.6": 400_000,
  "layofflabs/gpt-5.6-sol": 400_000,
  "layofflabs/gpt-5.6-terra": 400_000,
  "layofflabs/gpt-5.6-luna": 400_000,
  "layofflabs/gpt-oss-120b-medium": 400_000,
  "layofflabs/claude-3-5-haiku-20241022": 400_000,
  "layofflabs/claude-3-7-sonnet-20250219": 400_000,
  "layofflabs/claude-fable-5": 400_000,
  "layofflabs/claude-haiku-4-5-20251001": 400_000,
  "layofflabs/claude-opus-4-1-20250805": 400_000,
  "layofflabs/claude-opus-4-20250514": 400_000,
  "layofflabs/claude-opus-4-5-20251101": 400_000,
  "layofflabs/claude-opus-4-6": 400_000,
  "layofflabs/claude-opus-4-7": 400_000,
  "layofflabs/claude-opus-4-8": 400_000,
  "layofflabs/claude-sonnet-4-20250514": 400_000,
  "layofflabs/claude-sonnet-4-5-20250929": 400_000,
  "layofflabs/claude-sonnet-4-6": 400_000,
  "layofflabs/codex-auto-review": 400_000,
  "layofflabs/deepseek-v4-flash": 400_000,
  "layofflabs/deepseek-v4-pro": 400_000,
  "layofflabs/gemini-3-flash-agent": 400_000,
  "layofflabs/gemini-3-flash-preview": 400_000,
  "layofflabs/gemini-3.1-flash-image": 400_000,
  "layofflabs/gemini-3.1-flash-lite": 400_000,
  "layofflabs/gemini-3.1-pro-low": 400_000,
  "layofflabs/gemini-3.5-flash-extra-low": 400_000,
  "layofflabs/gemini-3.5-flash-low": 400_000,
  "layofflabs/gemini-claude-opus-4-6-thinking": 400_000,
  "layofflabs/gemini-pro-agent": 400_000,
  "layofflabs/glm-4.5": 400_000,
  "layofflabs/glm-4.5-air": 400_000,
  "layofflabs/glm-4.6": 400_000,
  "layofflabs/glm-4.7": 400_000,
  "layofflabs/glm-5": 400_000,
  "layofflabs/glm-5-turbo": 400_000,
  "layofflabs/glm-5.1": 400_000,
  "layofflabs/glm-5.2": 400_000,
  "layofflabs/grok-3-mini": 400_000,
  "layofflabs/grok-3-mini-fast": 400_000,
  "layofflabs/grok-4.20-0309-non-reasoning": 400_000,
  "layofflabs/grok-4.20-0309-reasoning": 400_000,
  "layofflabs/grok-4.20-multi-agent-0309": 400_000,
  "layofflabs/grok-4.3": 400_000,
  "layofflabs/grok-build-0.1": 400_000,
  "layofflabs/grok-composer-2.5-fast": 400_000,
  "layofflabs/MiniMax-M2.1": 400_000,
  "layofflabs/MiniMax-M2.5": 400_000,
  "layofflabs/MiniMax-M2.5-highspeed": 400_000,
  "layofflabs/MiniMax-M2.7": 400_000,
  "layofflabs/MiniMax-M2.7-highspeed": 400_000,
  "layofflabs/MiniMax-M3": 400_000,
  "layofflabs/mimo-v2-omni": 400_000,
  "layofflabs/mimo-v2-pro": 400_000,
  "layofflabs/mimo-v2.5": 400_000,
  "layofflabs/mimo-v2.5-pro": 400_000,
  "layofflabs/qwen3.7-max": 400_000,
  "layofflabs/kimi-for-coding": 256_000,
  "layofflabs/kimi-k2": 256_000,
  "layofflabs/kimi-k2-thinking": 256_000,
  "layofflabs/kimi-k2.5": 256_000,
  "layofflabs/kimi-k2.6": 256_000,
  "layofflabs/kimi-k2.7": 256_000,
  "layofflabs/kimi-k2.7-code": 256_000,
  "layofflabs/kimi-k2.7-code-highspeed": 256_000,
  "layofflabs/kimi-k2.7-highspeed": 256_000,
  // layofflabs-anthropic (anthropic-messages): 1M
  "layofflabs-anthropic/claude-opus-4-5": 200_000,
  "layofflabs-anthropic/claude-sonnet-4-5": 200_000,
  "layofflabs-anthropic/claude-haiku-4-5": 200_000,
  "layofflabs-anthropic/claude-opus-4-6": 1_000_000,
  "layofflabs-anthropic/claude-opus-4-7": 1_000_000,
  "layofflabs-anthropic/claude-opus-4-8": 1_000_000,
  "layofflabs-anthropic/claude-fable-5": 1_000_000,
  "layofflabs-anthropic/claude-sonnet-5": 1_000_000,
  // local providers
  "localproxy/qwen3.6-35b-a3b-uncensored": 262_144,
  "localproxy/gemma-4-26B-A4B-it-uncensored": 262_144,
  "qwen3-6-local/qwen3.6-35b-a3b-uncensored": 262_144,
  "gemma-4-uncensored/gemma-4-26B-A4B-it-uncensored": 262_144,
};

const PREFIX_MODEL_WINDOWS: Array<[string, number]> = [
  ["layofflabs/gpt-5.", 400_000],
  ["layofflabs-anthropic/claude-opus-4-6", 1_000_000],
  ["layofflabs-anthropic/claude-opus-4-7", 1_000_000],
  ["layofflabs-anthropic/claude-opus-4-8", 1_000_000],
  ["layofflabs-anthropic/claude-fable-5", 1_000_000],
  ["layofflabs-anthropic/claude-opus-4-5", 200_000],
  ["layofflabs-anthropic/claude-sonnet-4-5", 200_000],
  ["layofflabs-anthropic/claude-haiku-4-5", 200_000],
];

interface Integrity {
  filesScanned: number;
  filesFailed: number;
  linesParsed: number;
  linesRejected: number;
  eventsInvalidTimestamp: number;
}

interface AssistantPredecessor {
  stopReason?: string;
  errorMessage?: string;
  providerTokens: number;
}

interface CompactionEvidence {
  timestamp: string;
  sessionFile: string;
  tokensBefore: number;
  model: string | null;
  provider: string | null;
  contextWindow: number | null;
  effectiveThresholdPre1021: number | null;
  effectiveThresholdPost1021: number | null;
  applicableEffectiveThreshold: number | null;
  thresholdRegime: "pre-1021" | "post-1021";
  classification: "reactive" | "proactive";
  triggerFullnessClassification: "expected" | "premature" | "between" | "unknown-usage" | "unknown-window";
  rawWindowPercent: number | null;
  predecessorStopReasons: string[];
  predecessorErrorSnippets: string[];
  lastValidProviderTokens: number;
}

interface Aggregate {
  key: string;
  sessions: Set<string>;
  assistantTurns: number;
  compactions: number;
  reactive: number;
  proactive: number;
  expected: number;
  premature: number;
  between: number;
  unknownUsage: number;
  unknownWindow: number;
  tokensBefore: number[];
  rawWindowPercent: number[];
}

function* walkJsonl(root: string): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) stack.push(path);
        else if (name.endsWith(".jsonl")) yield path;
      } catch {
        // A concurrently removed entry is not a scanned session file.
      }
    }
  }
}

function calculateContextTokens(usage: any): number {
  return usage?.totalTokens || (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

function modelWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  if (EXACT_MODEL_WINDOWS[model]) return EXACT_MODEL_WINDOWS[model];
  return PREFIX_MODEL_WINDOWS.find(([prefix]) => model.startsWith(prefix))?.[1];
}

function timestampKey(timestamp: unknown, integrity: Integrity): { week: string; day: string } | undefined {
  if (typeof timestamp !== "string") {
    integrity.eventsInvalidTimestamp++;
    return undefined;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    integrity.eventsInvalidTimestamp++;
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() || 7) - 1));
  return { week: monday.toISOString().slice(0, 10), day };
}

function getAggregate(aggregates: Map<string, Aggregate>, key: string): Aggregate {
  let aggregate = aggregates.get(key);
  if (!aggregate) {
    aggregate = {
      key,
      sessions: new Set(),
      assistantTurns: 0,
      compactions: 0,
      reactive: 0,
      proactive: 0,
      expected: 0,
      premature: 0,
      between: 0,
      unknownUsage: 0,
      unknownWindow: 0,
      tokensBefore: [],
      rawWindowPercent: [],
    };
    aggregates.set(key, aggregate);
  }
  return aggregate;
}

function medianNearestRank(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function serializeAggregate(aggregate: Aggregate) {
  return {
    week: aggregate.key,
    distinctSessions: aggregate.sessions.size,
    assistantTurns: aggregate.assistantTurns,
    compactions: aggregate.compactions,
    compactionsPer100Turns:
      aggregate.assistantTurns === 0 ? null : Number(((aggregate.compactions / aggregate.assistantTurns) * 100).toFixed(2)),
    reactive: aggregate.reactive,
    proactive: aggregate.proactive,
    triggerFullness: {
      expected: aggregate.expected,
      premature: aggregate.premature,
      between: aggregate.between,
      unknownUsage: aggregate.unknownUsage,
      unknownWindow: aggregate.unknownWindow,
    },
    tokensBeforeMedian: medianNearestRank(aggregate.tokensBefore),
    rawWindowPercentMedian: medianNearestRank(aggregate.rawWindowPercent),
  };
}

function shortError(errorMessage: unknown): string | undefined {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) return undefined;
  return errorMessage.replace(/\s+/g, " ").slice(0, 120);
}

function applyCompaction(aggregate: Aggregate, evidence: CompactionEvidence): void {
  aggregate.compactions++;
  aggregate.sessions.add(evidence.sessionFile);
  if (evidence.classification === "reactive") aggregate.reactive++;
  else aggregate.proactive++;
  switch (evidence.triggerFullnessClassification) {
    case "expected": aggregate.expected++; break;
    case "premature": aggregate.premature++; break;
    case "between": aggregate.between++; break;
    case "unknown-usage": aggregate.unknownUsage++; break;
    case "unknown-window": aggregate.unknownWindow++; break;
  }
  if (evidence.tokensBefore > 0) aggregate.tokensBefore.push(evidence.tokensBefore);
  if (typeof evidence.rawWindowPercent === "number") aggregate.rawWindowPercent.push(evidence.rawWindowPercent);
}

async function mineFile(
  path: string,
  since: Date | undefined,
  integrity: Integrity,
  weekly: Map<string, Aggregate>,
  daily: Map<string, Aggregate>,
  compactionEvidence: CompactionEvidence[],
  unknownModels: Map<string, number>,
): Promise<void> {
  let currentModel: string | undefined;
  let lastValidProviderTokens = 0;
  const assistantPredecessors: AssistantPredecessor[] = [];
  const input = createReadStream(path);
  const rl = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
        integrity.linesParsed++;
      } catch {
        integrity.linesRejected++;
        continue;
      }

      if (entry.type === "model_change") {
        currentModel = entry.model;
        continue;
      }
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const message = entry.message;
        if (message.model) currentModel = `${message.provider ?? ""}/${message.model}`;
        const providerTokens = calculateContextTokens(message.usage);
        const stopReason = message.stopReason;
        const isInvalidTurn = stopReason === "error" || stopReason === "aborted";
        assistantPredecessors.push({ stopReason, errorMessage: message.errorMessage, providerTokens });
        if (!isInvalidTurn && providerTokens > 0) lastValidProviderTokens = providerTokens;

        const eventTime = timestampKey(entry.timestamp, integrity);
        if (eventTime && (!since || new Date(entry.timestamp) >= since)) {
          const week = getAggregate(weekly, eventTime.week);
          week.assistantTurns++;
          week.sessions.add(path);
          if (eventTime.day >= JULY_START && eventTime.day <= JULY_END) {
            const day = getAggregate(daily, eventTime.day);
            day.assistantTurns++;
            day.sessions.add(path);
          }
        }
        continue;
      }
      if (entry.type !== "compaction") continue;

      const eventTime = timestampKey(entry.timestamp, integrity);
      const consecutiveErrors: AssistantPredecessor[] = [];
      for (let i = assistantPredecessors.length - 1; i >= 0; i--) {
        const predecessor = assistantPredecessors[i];
        if (predecessor.stopReason !== "error" && predecessor.stopReason !== "aborted") break;
        consecutiveErrors.push(predecessor);
      }
      const errorSnippets = consecutiveErrors.map((item) => shortError(item.errorMessage)).filter((item): item is string => item !== undefined);
      const reactive = errorSnippets.some((message) => OVERFLOW_PATTERN.test(message));
      const tokensBefore = typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0;
      const window = modelWindow(currentModel);
      if (!window && currentModel) unknownModels.set(currentModel, (unknownModels.get(currentModel) ?? 0) + 1);
      const knownMaxOutput = window === undefined ? 0 : 128_000;
      // Mirror production effectiveReserveTokens: Math.floor on the 15% reserve component.
      const effectiveThresholdPre1021 = window === undefined ? undefined : window - Math.max(Math.floor(window * 0.15), 16_384, knownMaxOutput);
      const effectiveThresholdPost1021 = window === undefined ? undefined : window - Math.max(Math.floor(window * 0.15), 16_384);
      const rawWindowPercent = window && tokensBefore > 0 ? Number(((tokensBefore / window) * 100).toFixed(2)) : undefined;
      const thresholdRegime = typeof entry.timestamp === "string" && entry.timestamp.slice(0, 10) < "2026-06-23" ? "pre-1021" : "post-1021";
      const applicableEffectiveThreshold = thresholdRegime === "pre-1021" ? effectiveThresholdPre1021 : effectiveThresholdPost1021;
      let triggerFullnessClassification: CompactionEvidence["triggerFullnessClassification"];
      if (tokensBefore === 0) triggerFullnessClassification = "unknown-usage";
      else if (applicableEffectiveThreshold === undefined) triggerFullnessClassification = "unknown-window";
      // Production shouldCompact triggers strictly above the threshold (contextTokens > thresholdTokens).
      else if (tokensBefore > applicableEffectiveThreshold) triggerFullnessClassification = "expected";
      else if (tokensBefore < applicableEffectiveThreshold * 0.9) triggerFullnessClassification = "premature";
      else triggerFullnessClassification = "between";

      const [provider] = currentModel?.split("/") ?? [];
      const evidence: CompactionEvidence = {
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
        sessionFile: opaqueSessionId(path),
        tokensBefore,
        model: currentModel ?? null,
        provider: provider ?? null,
        contextWindow: window ?? null,
        effectiveThresholdPre1021: effectiveThresholdPre1021 ?? null,
        effectiveThresholdPost1021: effectiveThresholdPost1021 ?? null,
        applicableEffectiveThreshold: applicableEffectiveThreshold ?? null,
        thresholdRegime,
        classification: reactive ? "reactive" : "proactive",
        triggerFullnessClassification,
        rawWindowPercent: rawWindowPercent ?? null,
        predecessorStopReasons: consecutiveErrors.map((item) => item.stopReason ?? "unknown"),
        predecessorErrorSnippets: errorSnippets,
        lastValidProviderTokens,
      };
      if (eventTime && (!since || new Date(entry.timestamp) >= since)) {
        applyCompaction(getAggregate(weekly, eventTime.week), evidence);
        if (eventTime.day >= JULY_START && eventTime.day <= JULY_END) applyCompaction(getAggregate(daily, eventTime.day), evidence);
        compactionEvidence.push(evidence);
      }
      lastValidProviderTokens = 0;
      assistantPredecessors.length = 0;
    }
  } catch {
    integrity.filesFailed++;
  } finally {
    rl.close();
    input.destroy();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const sinceIndex = args.indexOf("--since");
  const sinceValue = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
  const since = sinceValue ? new Date(`${sinceValue}T00:00:00.000Z`) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error(`Invalid --since date: ${sinceValue}`);

  const integrity: Integrity = { filesScanned: 0, filesFailed: 0, linesParsed: 0, linesRejected: 0, eventsInvalidTimestamp: 0 };
  const weekly = new Map<string, Aggregate>();
  const daily = new Map<string, Aggregate>();
  const compactionEvidence: CompactionEvidence[] = [];
  const unknownModels = new Map<string, number>();

  for (const path of walkJsonl(SESSIONS_ROOT)) {
    integrity.filesScanned++;
    await mineFile(path, since, integrity, weekly, daily, compactionEvidence, unknownModels);
  }

  const weeklyAggregates = [...weekly.values()].sort((a, b) => a.key.localeCompare(b.key)).map(serializeAggregate);
  const dailyAggregates = [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)).map((aggregate) => ({ ...serializeAggregate(aggregate), day: aggregate.key, week: undefined }));
  const output = {
    provenance: {
      sessionStore: "Local GJC session store (path redacted)",
      modelWindowMap: "User ~/.gjc/agent/models.yml, verified 2026-07-16; exact provider/model keys precede documented provider/model prefixes.",
      thresholdSemantics: "Pre-#1021 uses maxOutputTokens=128000 for known mapped models; post-#1021 uses maxOutputTokens=0.",
    },
    methodology: {
      eventBucketing: "Each assistant turn and compaction is bucketed by its own timestamp; --since is applied to each event. distinctSessions is the distinct session-file count for events in that bucket.",
      reactiveClassifier: "Reactive means consecutive error/aborted assistant predecessors immediately before compaction contain a context-overflow pattern; all other compactions are proactive.",
      triggerFullness: "Expected is tokensBefore > the effective threshold active at the event timestamp (strict, matching production shouldCompact; pre-#1021 before 2026-06-23; post-#1021 on/after); premature is <90% of it; between is the remaining range up to and including the threshold. tokensBefore=0 is unknown-usage. Reserve mirrors production: max(floor(0.15*window), 16384, maxOutput).",
      median: "Nearest-rank lower-of-two convention: sorted[Math.floor((n - 1) / 2)].",
    },
    integrity,
    weeklyAggregates,
    dailyAggregates,
    compactionEvidence,
    unknownModels: [...unknownModels.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, count]) => ({ model, count })),
    modelConcentration: [...compactionEvidence.reduce((counts, item) => counts.set(item.model ?? "unknown", (counts.get(item.model ?? "unknown") ?? 0) + 1), new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model, count]) => ({ model, count })),
  };

  if (jsonOut) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Scanned ${integrity.filesScanned} JSONL files; failed ${integrity.filesFailed}; parsed ${integrity.linesParsed} lines; rejected ${integrity.linesRejected}.`);
  console.log("week        sessions  turns  compacts  per100  reactive  proactive  expected  premature  unknown-use  unknown-window");
  for (const week of weeklyAggregates) {
    console.log(`${week.week}  ${String(week.distinctSessions).padStart(8)}  ${String(week.assistantTurns).padStart(5)}  ${String(week.compactions).padStart(8)}  ${String(week.compactionsPer100Turns ?? "n/a").padStart(6)}  ${String(week.reactive).padStart(8)}  ${String(week.proactive).padStart(9)}  ${String(week.triggerFullness.expected).padStart(8)}  ${String(week.triggerFullness.premature).padStart(9)}  ${String(week.triggerFullness.unknownUsage).padStart(11)}  ${String(week.triggerFullness.unknownWindow).padStart(14)}`);
  }
  console.log("\nJuly daily onset (day, turns, compactions, reactive, proactive):");
  for (const day of dailyAggregates) console.log(`${day.day}  ${day.assistantTurns}  ${day.compactions}  ${day.reactive}  ${day.proactive}`);
}

await main();
