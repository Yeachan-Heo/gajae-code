import * as crypto from "node:crypto";
import { canonicalJson } from "./contract";

/**
 * `full` is the gated mock workload, `preflight` the shortened Worker feasibility
 * script, `sanity` the non-gating real-provider check (plain text turns only,
 * because a real model's tool choices are not deterministic).
 */
export type WorkloadVariant = "full" | "preflight" | "sanity";

export type WorkloadAction =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: "bash" | "read" | "search" | "task"; arguments: Record<string, unknown> }
	| { kind: "compaction"; text: string };

export interface WorkloadTurn {
	key: string;
	phase: string;
	prompt: string;
	action: WorkloadAction;
	/** Model response latency for this turn (mock provider `delayMs`); keeps a turn in flight. */
	delayMs?: number;
}

const COMPACTION_PAYLOAD = `BENCH_COMPACTION_PAYLOAD ${"The deterministic compaction turn retains this payload. ".repeat(2_000)}`;

const FULL_SCRIPT: readonly WorkloadTurn[] = [
	{
		key: "stream-1",
		phase: "streaming-text",
		prompt: "BENCH_TEXT:1",
		action: { kind: "text", text: "bench streamed response one" },
	},
	{
		key: "stream-2",
		phase: "streaming-text",
		prompt: "BENCH_TEXT:2",
		action: { kind: "text", text: "bench streamed response two" },
	},
	{
		key: "stream-3",
		phase: "streaming-text",
		prompt: "BENCH_TEXT:3",
		action: { kind: "text", text: "bench streamed response three" },
	},
	{
		key: "bash",
		phase: "tools",
		prompt: "BENCH_TOOL:bash",
		action: { kind: "tool", name: "bash", arguments: { command: "printf 'bench-bash-ok\\n'" } },
	},
	{
		key: "read",
		phase: "tools",
		prompt: "BENCH_TOOL:read",
		action: { kind: "tool", name: "read", arguments: { path: "workload.txt" } },
	},
	{
		key: "grep",
		phase: "tools",
		prompt: "BENCH_TOOL:grep",
		action: { kind: "tool", name: "search", arguments: { pattern: "bench-grep-marker", paths: ["workload.txt"] } },
	},
	{
		key: "task",
		phase: "task",
		prompt: "BENCH_TOOL:task",
		action: {
			kind: "tool",
			name: "task",
			arguments: {
				agent: "executor",
				tasks: [
					{
						id: "bench-child-task",
						description: "deterministic child task",
						assignment: "Return exactly: bench child task complete",
					},
				],
			},
		},
	},
	{
		key: "post-task",
		phase: "post-task",
		prompt: "BENCH_TEXT:after-task",
		action: { kind: "text", text: "bench task phase complete" },
	},
	{
		key: "compaction",
		phase: "compaction",
		prompt: COMPACTION_PAYLOAD,
		action: { kind: "compaction", text: "bench compaction turn completed" },
	},
	{
		key: "post-compaction",
		phase: "post-compaction",
		prompt: "BENCH_TEXT:after-compaction",
		action: { kind: "text", text: "bench post-compaction response" },
	},
];

/** Duration of the preflight's in-flight turn; see preflight.ts for the timing budget. */
export const PREFLIGHT_IN_FLIGHT_MS = 4_000;

const PREFLIGHT_SCRIPT: readonly WorkloadTurn[] = [
	{
		key: "preflight-bash",
		phase: "preflight-tools",
		prompt: "BENCH_PREFLIGHT_TOOL:bash",
		action: { kind: "tool", name: "bash", arguments: { command: "printf 'bench-preflight-bash-ok\\n'" } },
	},
	{
		key: "preflight-grep",
		phase: "preflight-tools",
		prompt: "BENCH_PREFLIGHT_TOOL:grep",
		action: { kind: "tool", name: "search", arguments: { pattern: "bench-grep-marker", paths: ["workload.txt"] } },
	},
	{
		// A long in-flight model response: the sibling session is mid-turn while the
		// first session disposes (preflight close barrier).
		key: "preflight-stream",
		phase: "preflight-tools",
		prompt: "BENCH_PREFLIGHT_TEXT:in-flight",
		action: { kind: "text", text: "bench preflight in-flight response" },
		delayMs: PREFLIGHT_IN_FLIGHT_MS,
	},
];

const SANITY_SCRIPT: readonly WorkloadTurn[] = [1, 2, 3].map(index => ({
	key: `sanity-${index}`,
	phase: "sanity-text",
	prompt: `Benchmark sanity turn ${index}. Reply with one short sentence and do not use any tools.`,
	action: { kind: "text", text: "" },
}));

/** Build the root-session prompt sequence. The full variant has ten turns. */
export function buildWorkloadScript(variant: WorkloadVariant = "full"): readonly WorkloadTurn[] {
	if (variant === "preflight") return PREFLIGHT_SCRIPT;
	if (variant === "sanity") return SANITY_SCRIPT;
	return FULL_SCRIPT;
}

/** SHA-256 digest of the canonical workload script definition. */
export function workloadDigest(): string {
	return crypto.createHash("sha256").update(canonicalJson(FULL_SCRIPT)).digest("hex");
}
