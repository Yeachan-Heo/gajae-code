#!/usr/bin/env bun

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

type FloorMetric = "rssBytes.stableTree.median";

export interface FloorPolicy {
	milestone: string;
	scenario: ScenarioId;
	metric: FloorMetric;
	minimumImprovementPercent: number;
}

export const FLOOR_POLICIES: Record<string, FloorPolicy> = {
	W1c: { milestone: "W1c", scenario: "S3", metric: "rssBytes.stableTree.median", minimumImprovementPercent: 5 },
	W3b: { milestone: "W3b", scenario: "S3", metric: "rssBytes.stableTree.median", minimumImprovementPercent: 15 },
	W5b: { milestone: "W5b", scenario: "S1", metric: "rssBytes.stableTree.median", minimumImprovementPercent: 20 },
};
type ScenarioStatus = "measured" | "deferred";

interface CliOptions {
	scenarios: ScenarioId[];
	milestone?: string;
	rescopeRef?: string;
	all: boolean;
	compare: boolean;
	allowBaselineDrift: boolean;
	baseline?: string;
	writeBaseline: boolean;
	matrix: string[];
	json: boolean;
}

interface Distribution {
	median: number;
	p95: number;
	min: number;
	max: number;
}

interface MemorySnapshot {
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
}

interface ProcessSample {
	barrierRssBytes: number;
	exitRssBytes: number;
	peakRssBytes: number;
	stableRssBytes: number;
	stableTreeRssBytes: number;
	measuredProcessMaxRssBytes: number;
	barrierChildCount: number;
	exitChildCount: number;
	peakChildCount: number;
	distinctChildCount: number;
	barrierMemory: MemorySnapshot;
	exitMemory: MemorySnapshot;
	exitCode: number;
	timedOut: boolean;
	stderrTail: string;
	cleanupSignal?: string;
	barrierReached: boolean;
}

interface ScenarioReport {
	id: ScenarioId;
	status: ScenarioStatus;
	barrier?: string;
	reason?: string;
	command: string[];
	warmups: number;
	sampleCount: number;
	workload?: {
		expected: string;
		observedToolCalls: number;
		observedToolNames: string[];
		observedMcpCalls: number;
		advertisedToolNames?: string[];
		successfulToolResults?: number;
		failedToolResults?: number;
	};
	rssBytes?: {
		barrier: Distribution;
		exit: Distribution;
		peak: Distribution;
		stable: Distribution;
		stableTree: Distribution;
		measuredProcessMaxRss: Distribution;
	};
	childCount?: {
		barrier: Distribution;
		exit: Distribution;
		peak: Distribution;
		distinct?: Distribution;
	};
	inProcessMemory?: {
		barrier: Record<keyof MemorySnapshot, Distribution>;
		exit: Record<keyof MemorySnapshot, Distribution>;
	};
	processExitCodes?: Distribution;
	timedOutSamples?: number;
	forcedCleanupSamples?: number;
}

interface RescopeTransferTarget {
	milestone: string;
	minimumImprovementPercent: number;
}

interface RescopeReference {
	path: string;
	schemaVersion: 1;
	milestone: string;
	referenceId: string;
	gitCommit: string;
	baselineStableTreeMedianBytes: number;
	currentStableTreeMedianBytes: number;
	repairedHarnessBinarySha256: string;
	attributionBasis: string;
	transferTarget: RescopeTransferTarget;
	reason: string;
}

interface Metadata {
	os: string;
	arch: string;
	kernel: string;
	bun: string;
	binarySha256: string;
	gitCommit: string;
	timestamp: string;
	matrix: string[];
	milestone?: string;
	floorPolicy?: FloorPolicy;
	rescopeReference?: RescopeReference;
	baselineProvenance?: { gitCommit: string; binarySha256: string; drift: boolean };
	referenceWorkspace: { files: number; bytes: number; depth: number };
}

interface RssReport {
	schemaVersion: 1;
	metadata: Metadata;
	scenarios: ScenarioReport[];
}

export class CheckpointError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = code;
		this.code = code;
		this.details = details;
	}
}

const repoRoot = path.resolve(import.meta.dir, "..");
const checkpointRoot = path.join(repoRoot, ".gjc", "rss-checkpoints");

const REFERENCE_CHUNK_MARKER = "gjc-rss-reference-0123456789abcdef";
const REFERENCE_LARGE_LINE_COUNT = 29_960;
const BASH_OUTPUT_BYTES = 8_388_608;
const BASH_OUTPUT_MARKER = `GJC_RSS_BASH_BYTES=${BASH_OUTPUT_BYTES}`;
const binaryPath = path.join(repoRoot, "packages", "coding-agent", "dist", "gjc");
const buildCommand = "bun --cwd=packages/coding-agent run build";
const deferredS6Reason = "requires W7/W8 authorization and daemon implementation";
const allMeasuredScenarios: ScenarioId[] = ["S1", "S2", "S3", "S4", "S5", "S7"];
const scenarioIds = new Set<ScenarioId>(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);

function usage(): string {
	return [
		"Usage: bun scripts/verify-rss-checkpoints.ts [options]",
		"",
		"  --scenario <S1..S7[,S...]>  Measure selected scenarios",
		"  --all                       Measure S1-S5 and S7; report S6 as deferred",
		"  --compare                   Compare against --baseline, or the current commit checkpoint when omitted",
		"  --baseline <file>           Baseline JSON path (defaults to .gjc/rss-checkpoints/<commit>.json)",
		"  --allow-baseline-drift      Permit comparing across builds (required for milestone floor gates)",
		"  --write-baseline            Write .gjc/rss-checkpoints/<commit>.json",
		"  --milestone <W1c|W3b|W5b>  enforce the declared RSS improvement floor",
		"  --rescope-ref <file>       accepted re-scope record for a missed floor",
		"  --matrix <name[,name...]>   Record a named measurement matrix",
		"  --json                      Emit machine-readable output",
	].join("\n");
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function parseScenario(value: string): ScenarioId {
	const normalized = value.toUpperCase() as ScenarioId;
	if (!scenarioIds.has(normalized)) throw new CheckpointError("InvalidScenario", `Unknown RSS scenario: ${value}`);
	return normalized;
}

export function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		scenarios: [],
		all: false,
		compare: false,
		allowBaselineDrift: false,
		writeBaseline: false,
		matrix: [],
		json: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--all") {
			options.all = true;
			continue;
		}
		if (arg === "--compare") {
			options.compare = true;
			continue;
		}
		if (arg === "--allow-baseline-drift") {
			options.allowBaselineDrift = true;
			continue;
		}
		if (arg === "--write-baseline") {
			options.writeBaseline = true;
			continue;
		}
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--scenario" || arg === "--baseline" || arg === "--matrix" || arg === "--milestone" || arg === "--rescope-ref") {
			const value = argv[++index];
			if (!value) throw new CheckpointError("UsageError", `${arg} requires a value`);
			if (arg === "--scenario") options.scenarios.push(...splitList(value).map(parseScenario));
			else if (arg === "--baseline") options.baseline = value;
			else if (arg === "--matrix") options.matrix.push(...splitList(value));
			else if (arg === "--milestone") {
				if (!FLOOR_POLICIES[value]) throw new CheckpointError("InvalidMilestone", `Unknown RSS milestone: ${value}`);
				options.milestone = value;
			} else options.rescopeRef = value;
			continue;
		}
		if (arg.startsWith("--scenario=")) {
			options.scenarios.push(...splitList(arg.slice("--scenario=".length)).map(parseScenario));
			continue;
		}
		if (arg.startsWith("--baseline=")) {
			options.baseline = arg.slice("--baseline=".length);
			continue;
		}
		if (arg.startsWith("--matrix=")) {
			options.matrix.push(...splitList(arg.slice("--matrix=".length)));
			continue;
		}
		if (arg.startsWith("--milestone=")) {
			const value = arg.slice("--milestone=".length);
			if (!FLOOR_POLICIES[value]) throw new CheckpointError("InvalidMilestone", `Unknown RSS milestone: ${value}`);
			options.milestone = value;
			continue;
		}
		if (arg.startsWith("--rescope-ref=")) {
			options.rescopeRef = arg.slice("--rescope-ref=".length);
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		}
		throw new CheckpointError("UsageError", `Unknown option: ${arg}`);
	}
	if (!options.all && options.scenarios.length === 0) throw new CheckpointError("UsageError", "Use --all or --scenario");
	if (options.milestone && !options.compare) throw new CheckpointError("MilestoneCompareRequired", "--milestone requires --compare; baseline capture is a separate non-milestone mode.");
	if (options.milestone && options.writeBaseline) throw new CheckpointError("MilestoneBaselineWriteRejected", "--milestone cannot be combined with --write-baseline; capture a baseline without a milestone.");
	return options;
}

function runSync(command: string[], cwd = repoRoot): string {
	try {
		const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return "";
		return result.stdout.toString().trim();
	} catch {
		return "";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}


interface ProcessRow {
	pid: number;
	ppid: number;
	rss: number;
}

function processRows(): ProcessRow[] {
	const output = runSync(["ps", "-axo", "pid=,ppid=,rss="]);
	const rows: ProcessRow[] = [];
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 3) continue;
		const pid = Number(fields[0]);
		const ppid = Number(fields[1]);
		const rss = Number(fields[2]);
		if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)) rows.push({ pid, ppid, rss });
	}
	return rows;
}

function treeUsage(rootPid: number): { rssBytes: number; childCount: number; childPids: number[] } {
	if (!Number.isFinite(rootPid) || rootPid <= 0) return { rssBytes: 0, childCount: 0, childPids: [] };
	const rows = processRows();
	const children = new Map<number, number[]>();
	const rssByPid = new Map<number, number>();
	for (const row of rows) {
		rssByPid.set(row.pid, row.rss);
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const visited = new Set<number>();
	const queue = [rootPid];
	let rss = 0;
	let childCount = 0;
	const childPids: number[] = [];
	while (queue.length > 0) {
		const pid = queue.shift()!;
		if (visited.has(pid)) continue;
		visited.add(pid);
		rss += (rssByPid.get(pid) ?? 0) * 1024;
		if (pid !== rootPid) {
			childCount += 1;
			childPids.push(pid);
		}
		for (const child of children.get(pid) ?? []) queue.push(child);
	}
	return { rssBytes: rss, childCount, childPids };
}

async function sha256File(filePath: string): Promise<string> {
	const hash = crypto.createHash("sha256");
	hash.update(await fs.readFile(filePath));
	return hash.digest("hex");
}

function referenceFilePath(root: string, index: number): string {
	const parts: string[] = [];
	let value = index;
	for (let level = 0; level < 8; level += 1) {
		parts.push(`level-${level}-${value % 8}`);
		value = Math.floor(value / 8);
	}
	return path.join(root, ...parts, `file-${index.toString().padStart(4, "0")}.txt`);
}

async function generateReferenceWorkspace(root: string): Promise<{ files: number; bytes: number; depth: number }> {
	const fileCount = 2000;
	const totalTargetBytes = 40 * 1024 * 1024;
	const largeReadBytes = 1 * 1024 * 1024;
	const regularBytes = Math.floor((totalTargetBytes - largeReadBytes) / (fileCount - 1));
	const depth = 8;
	const chunk = `${REFERENCE_CHUNK_MARKER}\n`;
	const makeBody = (size: number) => chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size);
	let bytes = 0;
	for (let index = 0; index < fileCount; index += 1) {
		const filePath = referenceFilePath(root, index);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const body = makeBody(index === 0 ? largeReadBytes : regularBytes);
		await fs.writeFile(filePath, body, "utf8");
		bytes += Buffer.byteLength(body);
	}
	return { files: fileCount, bytes, depth };
}

interface ProviderStats {
	requestCount: number;
	lastBodies: string[];
	lastSummaries: string[];
	toolCallCount: number;
	mcpToolCallCount: number;
	toolNames: string[];
	advertisedToolNames: string[];
	successfulReadResultCount: number;
	successfulBashResultCount: number;
	failedScenarioResultCount: number;
	missingScenarioAdvertisementCount: number;
}

interface ProviderStub {
	url: string;
	s7Url: string;
	stats: ProviderStats;
	setBarrierFile: (filePath?: string) => void;
	close: () => void;
}

function completionStream(response: { id: string; content: string }): string {
	return [
		`data: ${JSON.stringify({ id: response.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: response.content }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ id: response.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join("");
}

function toolCallStream(id: string, name: string, args: Record<string, unknown>): string {
	return [
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join("");
}

function hasToolResultMessage(parsed: Record<string, unknown>): boolean {
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	return messages.some(message => {
		if (!message || typeof message !== "object") return false;
		const value = message as Record<string, unknown>;
		if (value.role === "tool" || value.role === "tool_result") return true;
		const serialized = JSON.stringify(message).toLowerCase();
		return serialized.includes("rss-mcp-echo") || serialized.includes("tool_result");
	});
}
function advertisedToolNames(parsed: Record<string, unknown>): string[] {
	if (!Array.isArray(parsed.tools)) return [];
	return parsed.tools.flatMap(tool => {
		if (!tool || typeof tool !== "object") return [];
		const fn = (tool as Record<string, unknown>).function;
		if (!fn || typeof fn !== "object") return [];
		const name = (fn as Record<string, unknown>).name;
		return typeof name === "string" ? [name] : [];
	});
}

function toolResultText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "");
	return content.map(item => {
		if (typeof item === "string") return item;
		if (!item || typeof item !== "object") return String(item ?? "");
		const value = item as Record<string, unknown>;
		return typeof value.text === "string" ? value.text : JSON.stringify(value);
	}).join("\n");
}

function scenarioToolResults(parsed: Record<string, unknown>): string[] {
	const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
	return messages.filter(message => {
		if (!message || typeof message !== "object") return false;
		const role = (message as Record<string, unknown>).role;
		return role === "tool" || role === "tool_result";
	}).map(toolResultText);
}

function toolResultHasFailure(text: string): boolean {
	// Artifact spill notices ("Bash output artifact unavailable: terminal artifact
	// publisher unavailable", "Artifact storage failed: unavailable") are expected
	// benign footers in --no-session harness children and must not count as a
	// failed tool result; only genuine execution failures may.
	const withoutBenignNotices = text
		.split("\n")
		.filter(line => !/(?:output artifact|artifact storage|artifact publisher)\b.*\b(?:unavailable|failed)\b/i.test(line))
		.join("\n");
	return /(?:\b(?:error|failed|unavailable|not found|traceback|syntaxerror)\b|exit code\s+[1-9]\d*)/i.test(withoutBenignNotices);
}

export function successfulScenarioResult(scenario: "S4" | "S5", text: string): boolean {
	if (toolResultHasFailure(text)) return false;
	if (scenario === "S4") {
		return text.includes(REFERENCE_CHUNK_MARKER) && new RegExp(`of\\s+${REFERENCE_LARGE_LINE_COUNT}\\b`).test(text);
	}
	return text.includes(BASH_OUTPUT_MARKER);
}

export interface ScenarioWorkloadCheckInput {
	scenario: "S4" | "S5";
	observedToolCalls: number;
	missingScenarioAdvertisements: number;
	failedScenarioResults: number;
	successfulToolResults: number;
	expectedSamples: number;
	workload: Record<string, unknown>;
}

/** Enforce the deterministic S4/S5 proof gates without running RSS sampling. */
export function validateScenarioWorkload(input: ScenarioWorkloadCheckInput): void {
	if (input.observedToolCalls < 1) {
		throw new CheckpointError(
			"ScenarioWorkloadMismatch",
			`${input.scenario} provider stub observed no required tool call`,
			input.workload,
		);
	}
	if (input.missingScenarioAdvertisements > 0) {
		throw new CheckpointError(
			"ScenarioWorkloadAdvertisementMissing",
			`${input.scenario} provider did not advertise its required scenario tool.`,
			{ ...input.workload, missing: input.missingScenarioAdvertisements },
		);
	}
	if (input.failedScenarioResults > 0) {
		throw new CheckpointError(
			"ScenarioWorkloadResultFailed",
			`${input.scenario} produced an unsuccessful required tool result.`,
			{ ...input.workload, failures: input.failedScenarioResults },
		);
	}
	if (input.successfulToolResults < input.expectedSamples) {
		throw new CheckpointError(
			"ScenarioWorkloadProofMissing",
			`${input.scenario} did not prove a successful required tool result for every measured sample.`,
			{ ...input.workload, expectedSamples: input.expectedSamples },
		);
	}
}


export function chooseToolCall(body: string, parsed: Record<string, unknown>, forceMcp = false): { name: string; args: Record<string, unknown> } | undefined {
	if (hasToolResultMessage(parsed)) return undefined;
	const toolNames = Array.isArray(parsed.tools)
		? parsed.tools.flatMap(tool => {
			if (!tool || typeof tool !== "object") return [];
			const fn = (tool as Record<string, unknown>).function;
			return fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string"
				? [String((fn as Record<string, unknown>).name)]
				: [];
		})
		: [];
	const lower = body.toLowerCase();
	if (lower.includes("read one mib")) {
		const match = body.match(/[^"'\s]*file-0000\.txt/);
		return { name: "read", args: { path: match?.[0] ?? "file-0000.txt", truncation: "head" } };
	}
	if (lower.includes("8 mib") || lower.includes("8mib")) {
		// The marker line is what successfulScenarioResult("S5", ...) gates on. It is
		// emitted BOTH before and after the 8 MiB payload so it survives either
		// head- or tail-biased tool-output truncation; the payload write runs between
		// the two copies and aborts the command on failure.
		return {
			name: "bash",
			args: {
				command: `echo ${BASH_OUTPUT_MARKER} && python3 -c 'import sys; sys.stdout.write("x"*${BASH_OUTPUT_BYTES}+"\\n")' && echo ${BASH_OUTPUT_MARKER}`,
				timeout: 30,
			},
		};
	}
	const mcpName = toolNames.find(name => /echo/i.test(name)) ?? body.match(/"name"\s*:\s*"([^"]*echo[^"]*)"/i)?.[1];
	if ((forceMcp || mcpName) && lower.includes("echo")) return { name: mcpName ?? "mcp__echo_echo", args: {} };
	return undefined;
}

async function startProviderStub(): Promise<ProviderStub> {
	const stats: ProviderStats = {
		requestCount: 0,
		lastBodies: [],
		lastSummaries: [],
		toolCallCount: 0,
		mcpToolCallCount: 0,
		toolNames: [],
		advertisedToolNames: [],
		successfulReadResultCount: 0,
		successfulBashResultCount: 0,
		failedScenarioResultCount: 0,
		missingScenarioAdvertisementCount: 0,
	};
	const response = { id: "rss-stub-response", content: "RSS harness response" };
	let activeBarrierFile: string | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const isS7 = url.pathname.startsWith("/s7/");
			if (request.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "stub-model", object: "model", owned_by: "gjc-rss" }] });
			if (request.method === "POST" && (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses"))) {
				stats.requestCount += 1;
				const body = await request.text();
				stats.lastBodies.push(body.slice(-20_000));
				if (stats.lastBodies.length > 3) stats.lastBodies.shift();
				let parsed: Record<string, unknown> = {};
				try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {}
				const summary = JSON.stringify({
					messages: Array.isArray(parsed.messages) ? parsed.messages.map(message => message && typeof message === "object" ? { role: (message as Record<string, unknown>).role, content: (message as Record<string, unknown>).content } : message) : parsed.messages,
					tools: parsed.tools,
				});
				const advertised = advertisedToolNames(parsed);
				for (const name of advertised) if (!stats.advertisedToolNames.includes(name)) stats.advertisedToolNames.push(name);
				const lower = body.toLowerCase();
				const expectedScenario = lower.includes("read one mib") ? "S4" : lower.includes("8 mib") || lower.includes("8mib") ? "S5" : undefined;
				const expectedTool = expectedScenario === "S4" ? "read" : expectedScenario === "S5" ? "bash" : undefined;
				if (expectedTool && !advertised.includes(expectedTool)) stats.missingScenarioAdvertisementCount += 1;
				for (const resultText of scenarioToolResults(parsed)) {
					if (!expectedScenario || !successfulScenarioResult(expectedScenario, resultText)) {
						if (expectedScenario) stats.failedScenarioResultCount += 1;
						if (expectedScenario && process.env.GJC_RSS_DEBUG_RESULT) { try { fsSync.writeFileSync(process.env.GJC_RSS_DEBUG_RESULT, resultText); } catch {} }
						continue;
					}
					if (expectedScenario === "S4") stats.successfulReadResultCount += 1;
					else stats.successfulBashResultCount += 1;
				}
				stats.lastSummaries.push(summary.slice(-20_000));
				if (stats.lastSummaries.length > 3) stats.lastSummaries.shift();
				const selected = expectedTool && !advertised.includes(expectedTool) ? undefined : chooseToolCall(body, parsed, isS7);
				const hasToolResult = hasToolResultMessage(parsed);
				if (!selected && hasToolResult && activeBarrierFile) {
					try { fsSync.writeFileSync(activeBarrierFile, "provider:tool-result\n", "utf8"); } catch {}
				}
				if (selected) {
					stats.toolCallCount += 1;
					stats.toolNames.push(selected.name);
					if (/echo/i.test(selected.name)) stats.mcpToolCallCount += 1;
				}
				const stream = selected ? toolCallStream(`rss-tool-call-${stats.toolCallCount}`, selected.name, selected.args) : completionStream(response);
				const streaming = parsed.stream !== false;
				return streaming ? new Response(stream, { headers: { "content-type": "text/event-stream" } }) : Response.json({ id: response.id, object: "chat.completion", created: 1, model: "stub-model", choices: [{ index: 0, message: { role: "assistant", content: response.content }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		s7Url: `http://127.0.0.1:${server.port}/s7/v1`,
		stats,
		setBarrierFile: filePath => { activeBarrierFile = filePath; },
		close: () => server.stop(true),
	};
}

async function writeModelsConfig(agentDir: string, baseUrl: string, s7BaseUrl = `${baseUrl.replace(/\/v1$/, "")}/s7/v1`): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	const content = [
		"providers:",
		"  rss-stub:",
		`    baseUrl: ${baseUrl}`,
		"    api: openai-completions",
		"    apiKeyEnv: RSS_HARNESS_API_KEY",
		"    models:",
		"      - id: stub-model",
		"        name: RSS Harness Stub",
		"        api: openai-completions",
		"        reasoning: false",
		"        input: [text]",
		"        contextWindow: 128000",
		"        maxTokens: 4096",
		"        cost:",
		"          input: 0",
		"          output: 0",
		"          cacheRead: 0",
		"          cacheWrite: 0",
		"",
		"  rss-stub-s7:",
		`    baseUrl: ${s7BaseUrl}`,
		"    api: openai-completions",
		"    apiKeyEnv: RSS_HARNESS_API_KEY",
		"    models:",
		"      - id: stub-model",
		"        name: RSS Harness MCP Stub",
		"        api: openai-completions",
		"        reasoning: false",
		"        input: [text]",
		"        contextWindow: 128000",
		"        maxTokens: 4096",
		"        cost:",
		"          input: 0",
		"          output: 0",
		"          cacheRead: 0",
		"          cacheWrite: 0",
		"",
	].join("\n");
	await fs.writeFile(path.join(agentDir, "models.yml"), content, "utf8");
}

async function writeMcpEchoServer(root: string, callsPath: string): Promise<string> {
	const serverPath = path.join(root, "mcp-echo-server.ts");
	const source = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const callsPath = ${JSON.stringify(callsPath)};
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let request: any;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "rss-echo", version: "1" } } }) + "\\n");
  } else if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "RSS harness echo tool", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }) + "\\n");
  } else if (request.method === "tools/call") {
    try { fs.appendFileSync(callsPath, "tools/call\\n", "utf8"); } catch {}
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "rss-mcp-echo" }], isError: false } }) + "\\n");
  } else if (request.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  }
}
`;
	await fs.writeFile(serverPath, source, "utf8");
	return serverPath;
}
async function writeInteractiveBarrierDriver(root: string): Promise<string> {
	const driverPath = path.join(root, "rss-idle-driver.py");
	const source = `
import os, pty, select, subprocess, sys, time
binary = ${JSON.stringify(binaryPath)}
repo_root = ${JSON.stringify(repoRoot)}
env = os.environ.copy()
agent_dir = env.get("GJC_AGENT_DIR", "")
debug_paths = [os.path.join(agent_dir, "gjc-debug.log"), os.path.join(agent_dir, "state", "gjc-debug.log")]
barrier_file = env.get("GJC_RSS_BARRIER_FILE", "")
master, slave = pty.openpty()
child = subprocess.Popen([binary, "--no-session", "--no-tools"], cwd=repo_root, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
barrier = False
deadline = time.time() + 30.0
try:
    while time.time() < deadline:
        try:
            readable, _, _ = select.select([master], [], [], 0.01)
            if readable:
                data = os.read(master, 65536)
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
        except (OSError, EOFError):
            pass
        for debug_path in debug_paths:
            try:
                if "fullRender: first render" in open(debug_path, encoding="utf-8").read():
                    barrier = True
                    break
            except OSError:
                pass
        if barrier:
            break
    if barrier:
        if barrier_file:
            open(barrier_file, "w", encoding="utf-8").write("interactive:first-render-complete\\n")
        sys.stderr.write("interactive:first-render-complete\\n")
        sys.stderr.flush()
        try:
            os.write(master, b"\\x03")
        except OSError:
            pass
        try:
            child.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    else:
        sys.stderr.write("ScenarioBarrierTimeout: interactive:first-render-complete\\n")
        sys.stderr.flush()
        child.terminate()
        child.wait()
finally:
    try:
        os.close(master)
    except OSError:
        pass
sys.exit(0 if barrier else 1)
`;
	await fs.writeFile(driverPath, source, "utf8");
	return driverPath;
}

function interactiveScenarioCommand(): string[] {
	return [binaryPath, "--no-session", "--no-tools"];
}


function scenarioCommand(id: ScenarioId, mcpConfig?: string, referenceWorkspace?: string): string[] {
	switch (id) {
		case "S1":
			return [binaryPath, "--help"];
		case "S2":
			return [binaryPath, "--version"];
		case "S3":
			return interactiveScenarioCommand();
		case "S4":
			return [binaryPath, "--no-session", "--model", "rss-stub/stub-model", "--print", `Read one MiB from this exact file once: ${referenceFilePath(referenceWorkspace ?? ".", 0)}`];
		case "S5":
			return [binaryPath, "--no-session", "--model", "rss-stub/stub-model", "--print", "Use bash exactly once to produce an 8 MiB output: python3 -c 'import sys; sys.stdout.write(\"x\"*8388608)'"];
		case "S7":
			return mcpConfig
			? [binaryPath, "--no-session", "--mcp-config", mcpConfig, "--model", "rss-stub-s7/stub-model", "--print", "Call the MCP echo tool once."]
			: [binaryPath, "--help"];
		case "S6":
			return [];
	}
}

interface ChildMemoryProbeRecord extends MemorySnapshot {
	phase: "start" | "barrier" | "exit";
}

async function writeProcessProbe(root: string, command: string[], cwd: string): Promise<string> {
	const probePath = path.join(root, "rss-process-probe.ts");
	const source = `
import * as fs from "node:fs";
const target = ${JSON.stringify(command)};
const targetCwd = ${JSON.stringify(cwd)};
const metricsPath = process.env.GJC_RSS_MEMORY_PROBE;
const barrierPath = process.env.GJC_RSS_BARRIER_FILE;
const cleanupPath = process.env.GJC_RSS_CLEANUP_FILE;
if (!metricsPath) throw new Error("GJC_RSS_MEMORY_PROBE is required");
let barrierWritten = !barrierPath;
let childDone = false;
const snapshot = (phase: "start" | "barrier" | "exit") => {
  const memory = process.memoryUsage();
  fs.appendFileSync(metricsPath, JSON.stringify({ phase, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers }) + "\\n", "utf8");
};
fs.writeFileSync(metricsPath, "", "utf8");
snapshot("start");
const barrierTimer = setInterval(() => {
  if (!barrierWritten && barrierPath && fs.existsSync(barrierPath)) {
    barrierWritten = true;
    snapshot("barrier");
    if (process.env.GJC_RSS_SCENARIO === "S7" && !childDone) setTimeout(() => { try { if (cleanupPath) fs.writeFileSync(cleanupPath, "SIGINT\\n", "utf8"); } catch {} child?.kill("SIGINT"); }, 100);
  }
}, 2);
barrierTimer.unref?.();
let child: any;
child = Bun.spawn(target, {
  cwd: targetCwd,
  env: { ...Bun.env, GJC_RSS_PROBE_CHILD: "1" },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const rawExitCode = await child.exited;
childDone = true;
const exitCode = rawExitCode;
if (!barrierWritten && (!barrierPath || fs.existsSync(barrierPath))) {
  barrierWritten = true;
  snapshot("barrier");
}
snapshot("exit");
clearInterval(barrierTimer);
process.exitCode = exitCode;
`;
	await fs.writeFile(probePath, source, "utf8");
	return probePath;
}

function readChildMemoryProbe(probePath: string): Partial<Record<ChildMemoryProbeRecord["phase"], ChildMemoryProbeRecord>> {
	if (!fsSync.existsSync(probePath)) return {};
	const records: Partial<Record<ChildMemoryProbeRecord["phase"], ChildMemoryProbeRecord>> = {};
	for (const line of fsSync.readFileSync(probePath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Partial<ChildMemoryProbeRecord>;
			if ((value.phase === "start" || value.phase === "barrier" || value.phase === "exit") && ["heapUsed", "heapTotal", "external", "arrayBuffers"].every(key => typeof value[key as keyof MemorySnapshot] === "number")) {
				records[value.phase] = value as ChildMemoryProbeRecord;
			}
		} catch {}
	}
	return records;
}
function sampleDistribution(values: number[]): Distribution {
	if (values.length === 0) return { median: 0, p95: 0, min: 0, max: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	const middle = sorted.length / 2;
	const median = middle % 1 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[Math.floor(middle)] ?? 0);
	const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))] ?? 0;
	return { median, p95, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
}

function memoryDistribution(samples: ProcessSample[], phase: "barrierMemory" | "exitMemory"): Record<keyof MemorySnapshot, Distribution> {
	const keys: Array<keyof MemorySnapshot> = ["heapUsed", "heapTotal", "external", "arrayBuffers"];
	return Object.fromEntries(keys.map(key => [key, sampleDistribution(samples.map(sample => sample[phase][key]))])) as Record<keyof MemorySnapshot, Distribution>;
}
function maxRssCommand(command: string[]): string[] {
	if (process.platform === "darwin") return ["/usr/bin/time", "-l", ...command];
	if (process.platform === "linux") return ["/usr/bin/time", "-v", ...command];
	throw new CheckpointError("RssSamplerUnavailable", `Stable RSS sampling is unsupported on ${process.platform}.`);
}

function parseMaxRssBytes(stderr: string): number | undefined {
	for (const line of stderr.split(/\r?\n/)) {
		const darwin = /^(?:\s*)(\d+)\s+maximum resident set size\s*$/.exec(line);
		if (darwin) return Number(darwin[1]);
		const linux = /Maximum resident set size \(kbytes\):\s*(\d+)\s*$/.exec(line);
		if (linux) return Number(linux[1]) * 1024;
	}
	return undefined;
}


interface ProcessMeasureOptions {
	barrierFile?: string;
	memoryProbeFile?: string;
	cleanupFile?: string;
}

async function measureProcess(command: string[], env: Record<string, string>, cwd: string, timeoutMs = 30_000, options: ProcessMeasureOptions = {}): Promise<ProcessSample> {
	const processEnv = options.memoryProbeFile
		? { ...env, GJC_RSS_MEMORY_PROBE: options.memoryProbeFile, ...(options.cleanupFile ? { GJC_RSS_CLEANUP_FILE: options.cleanupFile } : {}) }
		: env;
	const proc = Bun.spawn(maxRssCommand(command), { cwd, env: processEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();

	const startedAt = Date.now();
	let barrierRssBytes = 0;
	let exitRssBytes = 0;
	let peakRssBytes = 0;
	let barrierChildCount = 0;
	let exitChildCount = 0;
	let peakChildCount = 0;
	let barrierMemory: MemorySnapshot | undefined;
	let childExitSnapshot: MemorySnapshot | undefined;
	let barrierReached = !options.barrierFile;
	let measuredProcessMaxRssBytes = 0;
	let timedOut = false;
	let settled = false;
	let lastUsage = treeUsage(proc.pid);
	const exitPromise = proc.exited.then(code => {
		const exitUsage = treeUsage(proc.pid);
		lastUsage = exitUsage.rssBytes > 0 ? exitUsage : lastUsage;
		exitRssBytes = lastUsage.rssBytes;
		exitChildCount = lastUsage.childCount;
		try {
			const resourceUsage = proc.resourceUsage();
			measuredProcessMaxRssBytes = Number(resourceUsage?.maxRSS ?? 0);
		} catch {
			measuredProcessMaxRssBytes = 0;
		}
		settled = true;
		return code;
	});
	const initialUsage = lastUsage;
	if (barrierReached) {
		barrierRssBytes = initialUsage.rssBytes;
		barrierChildCount = initialUsage.childCount;
		peakRssBytes = initialUsage.rssBytes;
		peakChildCount = initialUsage.childCount;
	}
	// Instantaneous polling misses short-lived children (an MCP stdio server for a single
	// tool call can live well under one poll interval), so the union of every child pid
	// observed during the run is the reliable "how many children did this spawn" metric.
	const observedChildPids = new Set<number>(initialUsage.childPids);

	await sleep(10);
	while (!settled && Date.now() - startedAt < timeoutMs) {
		const usage = treeUsage(proc.pid);
		lastUsage = usage;
		for (const pid of usage.childPids) observedChildPids.add(pid);
		if (!barrierReached && options.barrierFile && fsSync.existsSync(options.barrierFile)) {
			barrierReached = true;
			barrierRssBytes = usage.rssBytes;
			barrierChildCount = usage.childCount;
			const probe = options.memoryProbeFile ? readChildMemoryProbe(options.memoryProbeFile) : {};
			barrierMemory = probe.barrier ?? probe.start;
		}
		if (barrierReached && peakRssBytes === 0) {
			peakRssBytes = usage.rssBytes;
			peakChildCount = usage.childCount;
		}
		peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
		peakChildCount = Math.max(peakChildCount, usage.childCount);
		await sleep(5);
	}
	if (!settled) {
		timedOut = true;
		proc.kill("SIGTERM");
		await Promise.race([exitPromise, sleep(1_000)]);
	}
	let exitCode = await exitPromise;
	const finalUsage = treeUsage(proc.pid);
	for (const pid of finalUsage.childPids) observedChildPids.add(pid);
	if (exitRssBytes === 0 && finalUsage.rssBytes > 0) exitRssBytes = finalUsage.rssBytes;
	if (exitChildCount === 0 && finalUsage.childCount > 0) exitChildCount = finalUsage.childCount;
	if (options.memoryProbeFile) {
		let probe = readChildMemoryProbe(options.memoryProbeFile);
		for (let attempt = 0; !probe.exit && attempt < 500; attempt += 1) {
			await sleep(10);
			probe = readChildMemoryProbe(options.memoryProbeFile);
		}
		barrierMemory ??= probe.barrier ?? probe.start;
		childExitSnapshot = Object.entries(probe).find(([phase]) => phase === "exit")?.[1] as ChildMemoryProbeRecord | undefined;
	}
	const cleanupSignal = options.cleanupFile && fsSync.existsSync(options.cleanupFile)
		? fsSync.readFileSync(options.cleanupFile, "utf8").trim() || undefined
		: undefined;
	if (cleanupSignal && barrierReached && exitCode !== 0) exitCode = 0;
	if (options.barrierFile && !barrierReached) {
		throw new CheckpointError("ScenarioBarrierMissing", `Scenario ${command[0]} exited without explicit barrier ${options.barrierFile}.`);
	}
	const [, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	const stableRssBytes = parseMaxRssBytes(stderr) ?? 0;
	const stableTreeRssBytes = Math.max(barrierRssBytes, exitRssBytes);
	if (stableTreeRssBytes <= 0 || !Number.isFinite(stableTreeRssBytes)) {
		throw new CheckpointError("RssSamplerUnavailable", `Whole-process-tree RSS sampling did not report a positive value for ${command[0]}.`, {
			command,
			exitCode,
			timedOut,
			stderr: stderr.slice(-4_000),
		});
	}
	if (!barrierMemory || !childExitSnapshot) {
		const [, probeStderr] = await Promise.all([stdoutPromise, stderrPromise]);
		throw new CheckpointError("ChildMemoryProbeMissing", `Measured child did not emit deterministic memory metrics for ${command[0]}.`, {
			probe: options.memoryProbeFile,
			available: options.memoryProbeFile ? Object.keys(readChildMemoryProbe(options.memoryProbeFile)) : [],
			stderr: probeStderr.slice(0, 4_000),
		});
	}
	peakRssBytes = Math.max(peakRssBytes, exitRssBytes, barrierRssBytes);
	peakChildCount = Math.max(peakChildCount, exitChildCount, barrierChildCount);
	return {
		barrierRssBytes,
		exitRssBytes,
		peakRssBytes,
		stableRssBytes,
		stableTreeRssBytes,
		measuredProcessMaxRssBytes,
		barrierReached,
		barrierChildCount,
		exitChildCount,
		peakChildCount,
		distinctChildCount: observedChildPids.size,
		barrierMemory,
		exitMemory: childExitSnapshot,
		exitCode,
		cleanupSignal,
		timedOut,
		stderrTail: stderr.slice(-2_000),
	};
}

function baselineOutputPath(commit: string): string {
	return path.join(checkpointRoot, `${commit}.json`);
}

function validateDefaultBaseline(filePath: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
	} catch (error) {
		throw new CheckpointError("BaselineReadFailed", `Unable to read default RSS baseline ${filePath}: ${String(error)}; regenerate it with --write-baseline.`);
	}
	parseBaselineReport(parsed, filePath);
}

export function resolveDefaultBaseline(commit: string, root = checkpointRoot): string {
	const expectedPath = path.join(root, `${commit}.json`);
	if (!fsSync.existsSync(expectedPath)) {
		throw new CheckpointError(
			"BaselineDefaultMissing",
			`No default RSS baseline found for commit ${commit}. Expected ${expectedPath}; run bun scripts/verify-rss-checkpoints.ts --all --write-baseline to create it.`,
			{ commit, expectedPath },
		);
	}
	validateDefaultBaseline(expectedPath);
	return expectedPath;
}


async function measureScenario(
	id: ScenarioId,
	tempRoot: string,
	baseEnv: Record<string, string>,
	referenceWorkspace: string,
	provider: ProviderStub,
): Promise<ScenarioReport> {
	const warmups = 3;
	const totalSamples = 10;
	const scenarioRoot = path.join(tempRoot, id);
	await fs.mkdir(scenarioRoot, { recursive: true });
	let mcpConfig: string | undefined;
	let measuredToolCalls = 0;
	let measuredMcpCalls = 0;
	const measuredToolNames: string[] = [];
	let measuredSuccessfulReadResults = 0;
	let measuredSuccessfulBashResults = 0;
	let measuredFailedScenarioResults = 0;
	let measuredMissingScenarioAdvertisements = 0;
	const mcpCallsPath = id === "S7" ? path.join(scenarioRoot, "mcp-tools-call.log") : undefined;
	if (id === "S7") {
		const serverPath = await writeMcpEchoServer(scenarioRoot, mcpCallsPath!);
		mcpConfig = path.join(scenarioRoot, "mcp.json");
		await fs.writeFile(
			mcpConfig,
			JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [serverPath], cwd: referenceWorkspace, noInheritEnv: true } } }, null, 2),
			"utf8",
		);
	}
	let barrierFile: string | undefined;
	let command: string[];
	if (id === "S3") {
		barrierFile = path.join(scenarioRoot, "interactive-first-render.complete");
		command = ["python3", await writeInteractiveBarrierDriver(scenarioRoot)];
	} else {
		command = scenarioCommand(id, mcpConfig, referenceWorkspace);
		if (id === "S4" || id === "S5" || id === "S7") barrierFile = path.join(scenarioRoot, "workload-complete");
	}
	const reportedCommand = id === "S3" ? [binaryPath, "--no-session", "--no-tools"] : command;
	const probePath = await writeProcessProbe(scenarioRoot, command, referenceWorkspace);
	const measuredCommand = [process.execPath, "--no-env-file", probePath];
	const cleanupFile = path.join(scenarioRoot, "cleanup.signal");
	const samples: ProcessSample[] = [];
	for (let index = 0; index < warmups + totalSamples; index += 1) {
		const toolCallsBefore = provider.stats.toolCallCount;
		const toolNamesBefore = provider.stats.toolNames.length;
		const mcpCallsBefore = mcpCallsPath && fsSync.existsSync(mcpCallsPath)
			? fsSync.readFileSync(mcpCallsPath, "utf8").split(/\r?\n/).filter(Boolean).length
			: 0;
		const successfulReadBefore = provider.stats.successfulReadResultCount;
		const successfulBashBefore = provider.stats.successfulBashResultCount;
		const failedScenarioBefore = provider.stats.failedScenarioResultCount;
		const missingAdvertisementBefore = provider.stats.missingScenarioAdvertisementCount;
		const env: Record<string, string> = {
			...baseEnv,
			...(id === "S3" ? { GJC_DEBUG_REDRAW: "1" } : {}),
			...(barrierFile ? { GJC_RSS_BARRIER_FILE: barrierFile } : {}),
			GJC_RSS_SCENARIO: id,
			GJC_RSS_REFERENCE_WORKSPACE: referenceWorkspace,
			GJC_RSS_PROVIDER_STUB: provider.url,
			RSS_HARNESS_API_KEY: "rss-harness",
		};
		if (barrierFile) await fs.rm(barrierFile, { force: true });
		await fs.rm(cleanupFile, { force: true });
		if (id === "S4" || id === "S5" || id === "S7") provider.setBarrierFile(barrierFile);
		const sample = await measureProcess(measuredCommand, env, referenceWorkspace, id === "S5" ? 120_000 : 30_000, { barrierFile, memoryProbeFile: path.join(scenarioRoot, "memory.ndjson"), cleanupFile });
		if (index >= warmups) {
			measuredToolCalls += provider.stats.toolCallCount - toolCallsBefore;
			measuredToolNames.push(...provider.stats.toolNames.slice(toolNamesBefore));
			measuredSuccessfulReadResults += provider.stats.successfulReadResultCount - successfulReadBefore;
			measuredSuccessfulBashResults += provider.stats.successfulBashResultCount - successfulBashBefore;
			measuredFailedScenarioResults += provider.stats.failedScenarioResultCount - failedScenarioBefore;
			measuredMissingScenarioAdvertisements += provider.stats.missingScenarioAdvertisementCount - missingAdvertisementBefore;
			const mcpCallsAfter = mcpCallsPath && fsSync.existsSync(mcpCallsPath)
				? fsSync.readFileSync(mcpCallsPath, "utf8").split(/\r?\n/).filter(Boolean).length
				: 0;
			measuredMcpCalls += mcpCallsAfter - mcpCallsBefore;
		}
		if (id === "S4" || id === "S5" || id === "S7") provider.setBarrierFile(undefined);
		if (index >= warmups) samples.push(sample);
	}
	if (mcpCallsPath) {
		await sleep(250);
		const totalMcpCalls = fsSync.existsSync(mcpCallsPath)
			? fsSync.readFileSync(mcpCallsPath, "utf8").split(/\r?\n/).filter(Boolean).length
			: 0;
		const warmupMcpCalls = Math.max(0, provider.stats.mcpToolCallCount - measuredToolCalls);
		measuredMcpCalls = Math.max(measuredMcpCalls, totalMcpCalls - warmupMcpCalls);
	}
	const failures = samples.filter(sample => sample.exitCode !== 0 || sample.timedOut);
	if (failures.length > 0) {
		throw new CheckpointError("ScenarioProcessFailed", `${id} had ${failures.length}/${samples.length} failed or timed-out samples`, {
			id,
			failedExitCodes: failures.map(sample => sample.exitCode),
			timedOut: failures.filter(sample => sample.timedOut).length,
			firstFailureStderr: failures[0]?.stderrTail ?? "",
		});
	}
	const observedToolCalls = measuredToolCalls;
	const observedMcpCalls = measuredMcpCalls;
	const observedToolNames = measuredToolNames;
	const successfulToolResults = id === "S4" ? measuredSuccessfulReadResults : id === "S5" ? measuredSuccessfulBashResults : id === "S7" ? measuredMcpCalls : 0;
	const workload = {
		expected: id === "S4" ? "one advertised read result containing the 1 MiB marker/line count per sample" : id === "S5" ? "one advertised bash result containing GJC_RSS_BASH_BYTES=8388608 per sample" : id === "S7" ? "one MCP echo tool call and child process" : "no tool call",
		observedToolCalls,
		observedToolNames,
		observedMcpCalls,
		advertisedToolNames: provider.stats.advertisedToolNames,
		successfulToolResults,
		failedToolResults: measuredFailedScenarioResults,
		lastProviderSummaries: provider.stats.lastSummaries,
	};
	if (id === "S4" || id === "S5") {
		validateScenarioWorkload({
			scenario: id,
			observedToolCalls,
			missingScenarioAdvertisements: measuredMissingScenarioAdvertisements,
			failedScenarioResults: measuredFailedScenarioResults,
			successfulToolResults,
			expectedSamples: samples.length,
			workload,
		});
	}
	if (id === "S7" && (observedMcpCalls < 1 || sampleDistribution(samples.map(sample => sample.distinctChildCount)).median < 1)) {
		throw new CheckpointError("ScenarioWorkloadMismatch", "S7 did not observe an MCP echo call and child process", {
			...workload,
			childCount: sampleDistribution(samples.map(sample => sample.distinctChildCount)),
			lastProviderBodies: provider.stats.lastBodies,
			lastProviderSummaries: provider.stats.lastSummaries,
		});
	}
	const report: ScenarioReport = {
		id,
		status: "measured",
		command: reportedCommand,
		barrier: id === "S3" ? "interactive:first-render-complete" : barrierFile ? "workload-complete" : "process-exit",
		warmups,
		sampleCount: samples.length,
		workload,
		rssBytes: {
			barrier: sampleDistribution(samples.map(sample => sample.barrierRssBytes)),
			exit: sampleDistribution(samples.map(sample => sample.exitRssBytes)),
			peak: sampleDistribution(samples.map(sample => sample.peakRssBytes)),
			stable: sampleDistribution(samples.map(sample => sample.stableRssBytes)),
			stableTree: sampleDistribution(samples.map(sample => sample.stableTreeRssBytes)),
			measuredProcessMaxRss: sampleDistribution(samples.map(sample => sample.measuredProcessMaxRssBytes)),
		},
		childCount: {
			barrier: sampleDistribution(samples.map(sample => sample.barrierChildCount)),
			exit: sampleDistribution(samples.map(sample => sample.exitChildCount)),
			peak: sampleDistribution(samples.map(sample => sample.peakChildCount)),
			// Union of distinct child pids seen across the whole run; unlike `peak` this does
			// not depend on catching a short-lived child in a poll window.
			distinct: sampleDistribution(samples.map(sample => sample.distinctChildCount)),
		},
		inProcessMemory: {
			barrier: memoryDistribution(samples, "barrierMemory"),
			exit: memoryDistribution(samples, "exitMemory"),
		},
		processExitCodes: sampleDistribution(samples.map(sample => sample.exitCode)),
		timedOutSamples: samples.filter(sample => sample.timedOut).length,
		forcedCleanupSamples: samples.filter(sample => sample.cleanupSignal).length,
	};
	return report;
}

export function deferredScenario(): ScenarioReport {
	return {
		id: "S6",
		status: "deferred",
		reason: deferredS6Reason,
		command: [],
		warmups: 0,
		sampleCount: 0,
	};
}

async function metadata(binarySha256: string, referenceWorkspace: Metadata["referenceWorkspace"], matrix: string[], milestone?: string, floorPolicy?: FloorPolicy, rescopeReference?: Metadata["rescopeReference"]): Promise<Metadata> {
	return {
		os: process.platform,
		arch: process.arch,
		kernel: runSync(["uname", "-r"]) || "unknown",
		bun: Bun.version,
		binarySha256,
		gitCommit: runSync(["git", "rev-parse", "HEAD"]) || "unknown",
		timestamp: new Date().toISOString(),
		matrix,
		...(milestone ? { milestone, floorPolicy, ...(rescopeReference ? { rescopeReference } : {}) } : {}),
		referenceWorkspace,
	};
}

function medianRegression(current: number, baseline: number): boolean {
	// Whole-tree RSS includes short-lived helper/MCP children and allocator page retention;
	// use a noise envelope wide enough for repeatability while still rejecting material regressions.
	return current > baseline + Math.max(baseline * 0.12, 16 * 1024 * 1024);
}

function p95Regression(current: number, baseline: number): boolean {
	return current > baseline * 1.1;
}

interface Regression {
	id: string;
	metric: string;
	baseline: number;
	current: number;
	allowed: number;
}

export function validateRescopeReferenceStructure(
	filePath: string,
	parsed: unknown,
	policy: FloorPolicy,
	currentCommit: string,
	currentBinarySha256: string,
): { value: Record<string, unknown>; transfer: Record<string, unknown> } {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} must be an object.`);
	const value = parsed as Record<string, unknown>;
	if (value.retired === true || (typeof value.status === "string" && value.status !== "accepted")) {
		throw new CheckpointError("RescopeReferenceRetired", `Re-scope reference ${filePath} is retired or not accepted and cannot waive a floor.`);
	}
	// Positive authorization only: an omitted or non-string status must never waive
	// a floor. Waiver authority requires an explicit, typed `status: "accepted"`.
	if (value.status !== "accepted") {
		throw new CheckpointError("RescopeReferenceRetired", `Re-scope reference ${filePath} lacks an explicit "accepted" status and cannot waive a floor.`);
	}
	const required = ["schemaVersion", "status", "milestone", "referenceId", "gitCommit", "baselineStableTreeMedianBytes", "currentStableTreeMedianBytes", "repairedHarnessBinarySha256", "attributionBasis", "transferTarget", "reason"];
	for (const field of required) if (!(field in value)) throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} is missing required field ${field}.`);
	const target = value.transferTarget;
	if (!target || typeof target !== "object" || Array.isArray(target)) throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} has an invalid transferTarget.`);
	const transfer = target as Record<string, unknown>;
	if (value.schemaVersion !== 1 || value.milestone !== policy.milestone || typeof value.referenceId !== "string" || value.referenceId.length === 0 || typeof value.gitCommit !== "string" || value.gitCommit !== currentCommit || typeof value.baselineStableTreeMedianBytes !== "number" || typeof value.currentStableTreeMedianBytes !== "number" || typeof value.repairedHarnessBinarySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.repairedHarnessBinarySha256) || value.repairedHarnessBinarySha256 !== currentBinarySha256 || typeof value.attributionBasis !== "string" || value.attributionBasis.trim().length === 0 || typeof value.reason !== "string" || value.reason.trim().length === 0 || typeof transfer.milestone !== "string" || typeof transfer.minimumImprovementPercent !== "number") throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} does not match the schema or invoked milestone ${policy.milestone}.`);
	if (policy.milestone === "W1c" && (transfer.milestone !== "W3b" || transfer.minimumImprovementPercent !== 15)) throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} has an invalid transfer target for W1c.`);
	return { value, transfer };
}

export async function readRescopeReferenceStructural(
	filePath: string,
	policy: FloorPolicy,
	currentCommit: string,
	currentBinarySha256: string,
): Promise<{ value: Record<string, unknown>; transfer: Record<string, unknown> }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch (error) {
		throw new CheckpointError("RescopeReferenceInvalid", `Unable to read re-scope reference ${filePath}: ${String(error)}`);
	}
	return validateRescopeReferenceStructure(filePath, parsed, policy, currentCommit, currentBinarySha256);
}

export async function loadRescopeReference(filePath: string, policy: FloorPolicy, currentCommit: string, currentBinarySha256: string, currentStableTreeMedianBytes: number, baselineStableTreeMedianBytes: number): Promise<Metadata["rescopeReference"]> {
	const { value, transfer } = await readRescopeReferenceStructural(filePath, policy, currentCommit, currentBinarySha256);
	const noise = (baseline: number) => Math.max(baseline * 0.12, 16 * 1024 * 1024);
	if (Math.abs((value.baselineStableTreeMedianBytes as number) - baselineStableTreeMedianBytes) > noise(baselineStableTreeMedianBytes) || Math.abs((value.currentStableTreeMedianBytes as number) - currentStableTreeMedianBytes) > noise(currentStableTreeMedianBytes)) throw new CheckpointError("RescopeReferenceInvalid", `Re-scope reference ${filePath} does not match live comparison metrics.`);
	return { path: filePath, schemaVersion: 1, milestone: policy.milestone, referenceId: value.referenceId as string, gitCommit: currentCommit, baselineStableTreeMedianBytes: value.baselineStableTreeMedianBytes as number, currentStableTreeMedianBytes: value.currentStableTreeMedianBytes as number, repairedHarnessBinarySha256: currentBinarySha256, attributionBasis: value.attributionBasis as string, transferTarget: { milestone: transfer.milestone as string, minimumImprovementPercent: transfer.minimumImprovementPercent as number }, reason: value.reason as string };
}

function parseBaselineReport(value: unknown, baselinePath: string): RssReport {
	if (!value || typeof value !== "object") throw new CheckpointError("BaselineSchemaIncomplete", `Baseline ${baselinePath} is not a JSON object; regenerate it with --write-baseline.`);
	const candidate = value as Partial<RssReport>;
	if (candidate.schemaVersion !== 1 || !candidate.metadata || typeof candidate.metadata !== "object" || !Array.isArray(candidate.scenarios)) {
		throw new CheckpointError("BaselineSchemaIncomplete", `Baseline ${baselinePath} is schema-incomplete; regenerate it with --write-baseline.`, {
			required: ["schemaVersion", "metadata", "scenarios"],
		});
	}
	const seen = new Set<string>();
	for (const scenario of candidate.scenarios) {
		if (!scenario || typeof scenario !== "object" || typeof scenario.id !== "string" || !scenarioIds.has(scenario.id as ScenarioId) || (scenario.status !== "measured" && scenario.status !== "deferred")) {
			throw new CheckpointError("BaselineSchemaIncomplete", `Baseline ${baselinePath} contains an invalid scenario entry; regenerate it with --write-baseline.`);
		}
		if (seen.has(scenario.id)) throw new CheckpointError("BaselineSchemaIncomplete", `Baseline ${baselinePath} contains duplicate scenario ${scenario.id}.`);
		seen.add(scenario.id);
	}
	return candidate as RssReport;
}

function validateIdentity(metadata: Metadata | undefined, label: string, baselinePath?: string): void {
	const gitCommit = metadata?.gitCommit;
	const binarySha256 = metadata?.binarySha256;
	if (typeof gitCommit !== "string" || gitCommit.length === 0 || gitCommit === "unknown" || typeof binarySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(binarySha256)) {
		const prefix = baselinePath ? `Baseline ${baselinePath}` : label;
		throw new CheckpointError("BaselineIdentityMissing", `${prefix} has no usable git commit and binary SHA-256 identity.`, {
			gitCommit,
			binarySha256,
		});
	}
}

function ensureRequestedScenarios(current: RssReport, baseline: RssReport, requested: ScenarioId[], baselinePath: string): void {
	const currentIds = new Set(current.scenarios.map(scenario => scenario.id));
	const baselineIds = new Set(baseline.scenarios.map(scenario => scenario.id));
	for (const id of requested) {
		if (!currentIds.has(id)) throw new CheckpointError("CurrentScenarioMissing", `Current report is missing requested scenario ${id}.`);
		if (!baselineIds.has(id)) throw new CheckpointError("BaselineScenarioMissing", `Baseline ${baselinePath} is missing requested scenario ${id}.`);
	}
	for (const id of requested) {
		const currentScenario = current.scenarios.find(scenario => scenario.id === id);
		const baselineScenario = baseline.scenarios.find(scenario => scenario.id === id);
		if (currentScenario?.status !== baselineScenario?.status) {
			throw new CheckpointError("ScenarioStatusMismatch", `Scenario ${id} status differs between current and baseline.`, {
				current: currentScenario?.status,
				baseline: baselineScenario?.status,
			});
		}
	}
}

async function compareReports(current: RssReport, baselinePath: string, requested: ScenarioId[], floorPolicy?: FloorPolicy, rescopeReference?: Metadata["rescopeReference"], allowBaselineDrift = false): Promise<Regression[]> {
	let baseline: RssReport;
	try {
		baseline = parseBaselineReport(JSON.parse(await fs.readFile(baselinePath, "utf8")) as unknown, baselinePath);
	} catch (error) {
		if (error instanceof CheckpointError) throw error;
		throw new CheckpointError("BaselineReadFailed", `Unable to read baseline ${baselinePath}: ${String(error)}`);
	}
	validateIdentity(current.metadata, "Current report");
	validateIdentity(baseline.metadata, "Baseline report", baselinePath);
	const baselineDrift =
		baseline.metadata.gitCommit !== current.metadata.gitCommit ||
		baseline.metadata.binarySha256 !== current.metadata.binarySha256;
	// A milestone entry baseline is BY DEFINITION a different commit/binary, so requiring
	// identity equality would make every improvement-floor and cross-milestone regression gate
	// unrunnable. Drift is therefore allowed only when the caller acknowledges it explicitly,
	// and it is always recorded in the report so the comparison stays auditable.
	if (baselineDrift && !allowBaselineDrift) {
		throw new CheckpointError(
			"BaselineIdentityMismatch",
			`Baseline ${baselinePath} was produced by a different commit/binary. Pass --allow-baseline-drift to compare across builds (required for milestone floor gates).`,
			{
				current: { gitCommit: current.metadata.gitCommit, binarySha256: current.metadata.binarySha256 },
				baseline: { gitCommit: baseline.metadata.gitCommit, binarySha256: baseline.metadata.binarySha256 },
			},
		);
	}
	current.metadata.baselineProvenance = {
		gitCommit: baseline.metadata.gitCommit,
		binarySha256: baseline.metadata.binarySha256,
		drift: baselineDrift,
	};
	ensureRequestedScenarios(current, baseline, requested, baselinePath);

	// Polling `ps` remains diagnostic for sampled peaks and child-process accounting; the gate
	// uses the explicit whole-process-tree barrier/exit metric recorded in `stableTree`.
	const regressions: Regression[] = [];
	for (const id of requested) {
		const scenario = current.scenarios.find(item => item.id === id)!;
		if (scenario.status !== "measured") continue;
		if (!scenario.rssBytes?.stableTree) throw new CheckpointError("CurrentMetricMissing", `Current report is missing stableTree RSS metrics for ${scenario.id}.`);
		const previous = baseline.scenarios.find(item => item.id === id)!;
		if (previous.status !== "measured") continue;
		if (!previous.rssBytes?.stableTree) throw new CheckpointError("BaselineMetricMissing", `Baseline ${baselinePath} is missing stableTree RSS metrics for ${scenario.id}; regenerate it with --write-baseline.`);
		const currentMedian = scenario.rssBytes.stableTree.median;
		const baselineMedian = previous.rssBytes.stableTree?.median;
		if (baselineMedian === undefined) {
			throw new CheckpointError("BaselineMetricMissing", `Baseline ${baselinePath} is missing stableTree RSS metrics for ${scenario.id}; regenerate it with --write-baseline.`);
		}
		if (medianRegression(currentMedian, baselineMedian)) {
			regressions.push({
				id: scenario.id,
				metric: "rssBytes.stableTree.median",
				baseline: baselineMedian,
				current: currentMedian,
				allowed: Math.max(baselineMedian * 0.12, 16 * 1024 * 1024),
			});
		}
		const currentP95 = scenario.rssBytes.stableTree.p95;
		const baselineP95 = previous.rssBytes.stableTree?.p95;
		if (baselineP95 === undefined) {
			throw new CheckpointError("BaselineMetricMissing", `Baseline ${baselinePath} is missing stableTree RSS metrics for ${scenario.id}; regenerate it with --write-baseline.`);
		}
		if (p95Regression(currentP95, baselineP95)) {
			regressions.push({
				id: scenario.id,
				metric: "rssBytes.stableTree.p95",
				baseline: baselineP95,
				current: currentP95,
				allowed: baselineP95 * 0.1,
			});
		}
	}
	if (floorPolicy) {
		const currentScenario = current.scenarios.find(scenario => scenario.id === floorPolicy.scenario);
		const baselineScenario = baseline.scenarios.find(scenario => scenario.id === floorPolicy.scenario);
		if (!currentScenario?.rssBytes?.stableTree || !baselineScenario?.rssBytes?.stableTree) {
			throw new CheckpointError("FloorMetricMissing", `Floor metric ${floorPolicy.metric} is missing for ${floorPolicy.milestone}.`);
		}
		const baselineValue = baselineScenario.rssBytes.stableTree.median;
		const currentValue = currentScenario.rssBytes.stableTree.median;
		const improvementPercent = baselineValue > 0 ? ((baselineValue - currentValue) / baselineValue) * 100 : 0;
		if (improvementPercent < floorPolicy.minimumImprovementPercent && !rescopeReference) {
			throw new CheckpointError("FloorMissed", `${floorPolicy.milestone} floor missed: ${floorPolicy.scenario} stable-tree RSS improved ${improvementPercent.toFixed(2)}%, required ${floorPolicy.minimumImprovementPercent.toFixed(2)}%.`, {
				floorPolicy,
				baselineValue,
				currentValue,
				improvementPercent,
			});
		}
	}
	return regressions;
}

function formatMiB(value: number): string {
	return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

async function writeMarkdown(report: RssReport, outputPath: string, regressions: Regression[] = []): Promise<void> {
	const lines = [
		"# RSS Checkpoints",
		"",
		`Commit: \`${report.metadata.gitCommit}\`  `,
		`Timestamp: ${report.metadata.timestamp}  `,
		`Bun: ${report.metadata.bun} (${report.metadata.os}/${report.metadata.arch})`,
		...(report.metadata.milestone ? [`Milestone: ${report.metadata.milestone} floor ${report.metadata.floorPolicy?.minimumImprovementPercent ?? 0}% on ${report.metadata.floorPolicy?.metric ?? "unknown"}`] : []),
		...(report.metadata.rescopeReference ? [`Accepted re-scope: ${report.metadata.rescopeReference.referenceId} (${report.metadata.rescopeReference.reason})`] : []),
		"Stable-tree RSS is the maximum whole-process-tree RSS observed at the explicit barrier and process exit; this is the deciding metric. Sampled peak remains diagnostic.",
		"",
		"| Scenario | Status | Deciding stable-tree RSS median | Deciding stable-tree RSS p95 | Sampled peak RSS median | Sampled peak RSS p95 | Child peak median | Child distinct median | Samples |",
		"|---|---|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const scenario of report.scenarios) {
		if (scenario.status === "deferred") {
			lines.push(`| ${scenario.id} | deferred: ${scenario.reason} | — | — | — | — | — | — | — |`);
		} else {
			lines.push(
				`| ${scenario.id} | measured | ${formatMiB(scenario.rssBytes?.stableTree.median ?? 0)} | ${formatMiB(scenario.rssBytes?.stableTree.p95 ?? 0)} | ${formatMiB(scenario.rssBytes?.peak.median ?? 0)} | ${formatMiB(scenario.rssBytes?.peak.p95 ?? 0)} | ${scenario.childCount?.peak.median ?? 0} | ${scenario.childCount?.distinct?.median ?? 0} | ${scenario.sampleCount} |`,
			);
		}
	}
	if (regressions.length > 0) {
		lines.push("", "## Regressions", "");
		for (const regression of regressions)
			lines.push(
				`- ${regression.id} ${regression.metric}: baseline ${formatMiB(regression.baseline)}, current ${formatMiB(regression.current)}, allowed delta ${formatMiB(regression.allowed)}`,
			);
	}
	await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function printError(error: unknown, json: boolean): never {
	const typed = error instanceof CheckpointError ? error : new CheckpointError("InternalError", String(error));
	if (json) console.error(JSON.stringify({ error: { type: typed.code, message: typed.message, details: typed.details } }, null, 2));
	else {
		console.error(`${typed.code}: ${typed.message}`);
		if (typed.details !== undefined) console.error(JSON.stringify(typed.details, null, 2));
		if (typed.code === "UsageError") console.error(`\n${usage()}`);
	}
	process.exit(1);
}

async function main(): Promise<void> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		printError(error, process.argv.includes("--json"));
		return;
	}
	const currentCommit = runSync(["git", "rev-parse", "HEAD"]) || "unknown";
	if (options.compare && !options.baseline) {
		try {
			options.baseline = resolveDefaultBaseline(currentCommit);
		} catch (error) {
			printError(error, options.json);
			return;
		}
	}

	const selected = options.all ? ([...allMeasuredScenarios.slice(0, 5), "S6", "S7"] as ScenarioId[]) : [...new Set(options.scenarios)];

	if (selected.includes("S6") && !options.all) {
		printError(new CheckpointError("ScenarioUnavailable", `S6 is unavailable — ${deferredS6Reason}`), options.json);
		return;
	}
	if (!(await fs.stat(binaryPath).catch(() => null))) {
		printError(
			new CheckpointError(
				"BuildArtifactMissing",
				`Compiled RSS artifact is missing: ${binaryPath}. Build it with: ${buildCommand}`,
			),
			options.json,
		);
		return;
	}

	const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rss-checkpoints-")));
	let provider: Awaited<ReturnType<typeof startProviderStub>> | undefined;
	try {
		const activeProvider = await startProviderStub();
		provider = activeProvider;
		const referenceRoot = path.join(tempRoot, "reference-workspace");
		await fs.mkdir(referenceRoot, { recursive: true });
		const referenceWorkspace = await generateReferenceWorkspace(referenceRoot);
		const binarySha256 = await sha256File(binaryPath);
		const home = path.join(tempRoot, "home");
		const xdgConfig = path.join(tempRoot, "xdg-config");
		const agentDir = path.join(tempRoot, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdgConfig, { recursive: true });
		await writeModelsConfig(agentDir, activeProvider.url, activeProvider.s7Url);

		const baseEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(Bun.env)) if (!key.startsWith("GJC_") && value !== undefined) baseEnv[key] = value;
		baseEnv.HOME = home;
		baseEnv.USERPROFILE = home;
		baseEnv.XDG_CONFIG_HOME = xdgConfig;
		baseEnv.GJC_CODING_AGENT_DIR = agentDir;
		baseEnv.GJC_AGENT_DIR = agentDir;
		const gitCommit = currentCommit;
		const floorPolicy = options.milestone ? FLOOR_POLICIES[options.milestone] : undefined;
		if (options.rescopeRef && !floorPolicy) throw new CheckpointError("RescopeReferenceInvalid", "--rescope-ref requires --milestone.");
		// Fail fast: a structurally invalid, retired, or unaccepted re-scope record
		// must be rejected BEFORE any expensive scenario measurement runs; only the
		// live-metric consistency check is deferred until after measurement.
		if (options.rescopeRef && floorPolicy) {
			await readRescopeReferenceStructural(options.rescopeRef, floorPolicy, gitCommit, binarySha256);
		}
		const reports: ScenarioReport[] = [];
		for (const id of selected) {
			if (id === "S6") {
				reports.push(deferredScenario());
				continue;
			}
			const scenarioReport = await measureScenario(id, tempRoot, baseEnv, referenceRoot, activeProvider);
			reports.push(scenarioReport);
		}
		const report: RssReport = {
			schemaVersion: 1,
			metadata: await metadata(binarySha256, referenceWorkspace, options.matrix, options.milestone, floorPolicy),
			scenarios: reports,
		};
		let rescopeReference: Metadata["rescopeReference"];
		if (options.rescopeRef && floorPolicy && options.baseline) {
			const baseline = parseBaselineReport(JSON.parse(await fs.readFile(options.baseline, "utf8")) as unknown, options.baseline);
			const currentScenario = reports.find(item => item.id === floorPolicy.scenario);
			const baselineScenario = baseline.scenarios.find(item => item.id === floorPolicy.scenario);
			if (!currentScenario?.rssBytes?.stableTree || !baselineScenario?.rssBytes?.stableTree) throw new CheckpointError("FloorMetricMissing", `Floor metric ${floorPolicy.metric} is missing for ${floorPolicy.milestone}.`);
			rescopeReference = await loadRescopeReference(options.rescopeRef, floorPolicy, gitCommit, binarySha256, currentScenario.rssBytes.stableTree.median, baselineScenario.rssBytes.stableTree.median);
			report.metadata.rescopeReference = rescopeReference;
		}
		let regressions: Regression[] = [];
		if (options.compare && options.baseline) regressions = await compareReports(report, options.baseline, selected, floorPolicy, rescopeReference, options.allowBaselineDrift);
		const outputPath = baselineOutputPath(gitCommit);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		// A non-baseline run must never leave the commit-stem baseline JSON and the
		// regenerated Markdown describing different runs: every run writes its own
		// JSON twin so the md/json audit pair is always internally consistent.
		const reportJsonPath = options.writeBaseline ? outputPath : outputPath.replace(/\.json$/, ".last-run.json");
		const markdownPath = reportJsonPath.replace(/\.json$/, ".md");
		await writeMarkdown(report, markdownPath, regressions);
		await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		const result = { ...report, outputPath: reportJsonPath, markdownPath, regressions };
		if (options.json) console.log(JSON.stringify(result, null, 2));
		else {
			console.log(`RSS checkpoints for ${report.metadata.gitCommit}`);
			for (const scenario of report.scenarios) {
				if (scenario.status === "deferred") console.log(`${scenario.id}: deferred (${scenario.reason})`);
				else console.log(`${scenario.id}: deciding stable-tree median ${formatMiB(scenario.rssBytes?.stableTree.median ?? 0)}, p95 ${formatMiB(scenario.rssBytes?.stableTree.p95 ?? 0)} (sampled peak diagnostic median ${formatMiB(scenario.rssBytes?.peak.median ?? 0)})`);
			}
			console.log(`JSON: ${reportJsonPath}`);
			console.log(`Markdown: ${markdownPath}`);
			if (regressions.length > 0) console.error(`FAIL: ${regressions.length} RSS regression(s) exceeded tolerance`);
		}
		if (regressions.length > 0) process.exitCode = 1;
	} finally {
		provider?.close();
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		printError(error, process.argv.includes("--json"));
	}
}
