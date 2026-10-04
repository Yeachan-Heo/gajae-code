import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { SdkClient, SdkClientError } from "../../src/sdk/client/client";
import { brokerOwnerForTest, ensureBroker } from "../../src/sdk/broker/ensure";
import type { BrokerDiscovery } from "../../src/sdk/broker/discovery";
import { parseJsonl } from "./jsonl";
import { compareEvidence } from "./normalize";
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { RunnerBootstrap, bootstrapDigest } from "./bootstrap";
import { runSession } from "./session-runner";
import { benchNow, REQUIRED_WORKLOAD_EVENTS, type RunnerEvent, type WorkloadEventKind } from "./types";
import { buildWorkloadScript, type WorkloadTurn, workloadDigest } from "./workload";

const CHARACTERIZE_DIRECTORY_ENV = "GJC_BENCH_CHARACTERIZE_DIR";
const SESSION_STREAM_CAPABILITIES = ["turn_stream", "session_host_observer_v1"] as const;
const TASK_WAIT_MS = 30_000;
const PROMPT_WAIT_MS = 90_000;

interface ToolStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	startedAt: number;
}

interface HostExitDiagnostics {
	pid: number | null;
	processObservation: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	exitStatusObserved: boolean;
	cleanupSignal: NodeJS.Signals | null;
	stderrTail: string;
}

export type CharacterizationOutcome =
	| { outcome: "equal"; brokerEvidenceDir: string; runnerEvidenceDir: string }
	| { outcome: "differs"; fields: string[]; brokerEvidenceDir: string; runnerEvidenceDir: string }
	| { outcome: "unavailable"; reason: string; hostExit?: HostExitDiagnostics };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = value.map(item => jsonSafe(item, seen)).filter(item => item !== undefined);
	} else {
		const clean: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const safe = jsonSafe(item, seen);
			if (safe !== undefined) clean[key] = safe;
		}
		result = clean;
	}
	seen.delete(value);
	return result;
}

function jsonLine(value: unknown): string {
	const json = JSON.stringify(jsonSafe(value));
	if (json === undefined) throw new Error("Could not serialize characterization evidence.");
	return json;
}

function appendLines(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function errorMessage(error: unknown): string {
	if (error instanceof SdkClientError) {
		return `${error.name}(${error.code}): ${error.message}; details=${JSON.stringify(jsonSafe(error.details))}`;
	}
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function responseResult(response: unknown, operation: string): Record<string, unknown> {
	if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
		const details = isRecord(response) ? response.error : response;
		throw new Error(`${operation} failed: ${JSON.stringify(jsonSafe(details))}`);
	}
	return response.result;
}

function getSessionId(response: unknown): string {
	const result = responseResult(response, "session.create");
	if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
		throw new Error(`session.create returned no sessionId: ${JSON.stringify(jsonSafe(result))}`);
	}
	return result.sessionId;
}

function getEndpoint(response: unknown): { url: string; token: string; pid: number } {
	const result = responseResult(response, "session.get_endpoint");
	if (
		typeof result.url !== "string" ||
		typeof result.token !== "string" ||
		typeof result.pid !== "number" ||
		!Number.isSafeInteger(result.pid) ||
		result.pid <= 0
	) {
		throw new Error(`session.get_endpoint returned an invalid endpoint: ${JSON.stringify(jsonSafe(result))}`);
	}
	return { url: result.url, token: result.token, pid: Number(result.pid) };
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(isRecord(error) && error.code === "ESRCH");
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processIsAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
	return !processIsAlive(pid);
}

async function retainLifecycleStderr(sourceDirectory: string, targetPath: string, signal: AbortSignal): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	while (!signal.aborted && Date.now() < deadline) {
		const entries = await fs.readdir(sourceDirectory).catch(() => []);
		for (const name of entries) {
			if (!/^lifecycle-spawn\.[A-Za-z0-9-]+\.log$/u.test(name)) continue;
			try {
				await fs.link(path.join(sourceDirectory, name), targetPath);
				return true;
			} catch (error) {
				if (isRecord(error) && error.code === "EEXIST") return true;
			}
		}
		await Bun.sleep(10);
	}
	return false;
}


async function waitForHostExit(pid: number, incarnation: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const observation = observeProcessIncarnation(pid);
		if (observation.status === "absent") return "absent";
		if (observation.status === "present" && observation.incarnation !== incarnation) return "pid-reused";
		if (observation.status === "unknown") return `unknown:${observation.reasonCode}`;
		await Bun.sleep(25);
	}
	const finalObservation = observeProcessIncarnation(pid);
	if (finalObservation.status === "absent") return "absent";
	if (finalObservation.status === "present" && finalObservation.incarnation !== incarnation) return "pid-reused";
	return finalObservation.status === "unknown" ? `unknown:${finalObservation.reasonCode}` : "present";
}

async function terminateOwnedProcess(
	pid: number,
	incarnation: string,
): Promise<{ observation: string; signal: NodeJS.Signals | null }> {
	let observation = await waitForHostExit(pid, incarnation, 2_000);
	if (observation !== "present") return { observation, signal: null };
	let signal: NodeJS.Signals = "SIGTERM";
	try {
		process.kill(pid, signal);
	} catch {
		// Re-observe the exact incarnation before deciding whether stronger cleanup is needed.
	}
	observation = await waitForHostExit(pid, incarnation, 3_000);
	if (observation !== "present") return { observation, signal };
	signal = "SIGKILL";
	try {
		process.kill(pid, signal);
	} catch {
		// Final observation determines whether cleanup was proven.
	}
	observation = await waitForHostExit(pid, incarnation, 3_000);
	return { observation, signal };
}

function eventPayload(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	if (frame.type !== "event" || !isRecord(frame.payload) || !isRecord(frame.payload.event)) return undefined;
	return frame.payload.event;
}

function assistantHasText(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return false;
	if (!Array.isArray(message.content)) return false;
	return message.content.some(
		block => isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0,
	);
}

function asyncTaskJobId(result: unknown): string | undefined {
	if (!isRecord(result) || !isRecord(result.details) || !isRecord(result.details.async)) return undefined;
	return typeof result.details.async.jobId === "string" ? result.details.async.jobId : undefined;
}

function findJob(value: unknown, jobId: string): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findJob(item, jobId);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id : value.jobId;
	if (id === jobId && typeof value.status === "string") return value;
	for (const item of Object.values(value)) {
		const found = findJob(item, jobId);
		if (found) return found;
	}
	return undefined;
}

async function waitForPrompt(
	client: SdkClient,
	turn: WorkloadTurn,
	turnNumber: number,
	getObservedFailure: () => Error | undefined,
	getCompletedTurnCount: () => number,
): Promise<void> {
	const clientRef = `bench-characterize-${turnNumber}`;
	const completedBefore = getCompletedTurnCount();
	let accepted: unknown;
	try {
		accepted = await client.control("turn.prompt", { text: turn.prompt, images: [], clientRef }, { timeoutMs: PROMPT_WAIT_MS });
	} catch (error) {
		throw new Error(`turn.prompt dispatch failed: ${errorMessage(error)}`);
	}
	responseResult(accepted, "turn.prompt");
	const deadline = Date.now() + PROMPT_WAIT_MS;
	while (Date.now() < deadline) {
		const observedFailure = getObservedFailure();
		if (observedFailure) throw observedFailure;
		if (getCompletedTurnCount() > completedBefore) return;
		await Bun.sleep(20);
	}
	throw new Error(`SDK prompt ${turn.key} did not emit agent_end within ${PROMPT_WAIT_MS}ms.`);
}

async function waitForTaskJob(client: SdkClient, jobId: string): Promise<void> {
	const deadline = Date.now() + TASK_WAIT_MS;
	while (Date.now() < deadline) {
		const response = await client.query("runtime.jobs.list", { limit: 50 }, undefined, { timeoutMs: 10_000 });
		// Query responses carry their payload beside `ok` (not under `result`), so
		// search the whole successful frame for the job record.
		if (!isRecord(response) || response.ok !== true) {
			throw new Error(`runtime.jobs.list failed: ${JSON.stringify(jsonSafe(response))}`);
		}
		const job = findJob(response, jobId);
		if (job?.status === "completed") return;
		if (job?.status === "failed" || job?.status === "cancelled") {
			throw new Error(`SDK child job ${jobId} ended ${String(job.status)}: ${JSON.stringify(jsonSafe(job))}`);
		}
		await Bun.sleep(100);
	}
	throw new Error(`SDK child job ${jobId} did not complete within ${TASK_WAIT_MS}ms.`);
}

async function latestTranscript(directory: string): Promise<{ path: string; text: string } | undefined> {
	let newest: { path: string; modifiedAt: number } | undefined;
	const visit = async (current: string): Promise<void> => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const stat = await fs.stat(entryPath);
				if (!newest || stat.mtimeMs > newest.modifiedAt) newest = { path: entryPath, modifiedAt: stat.mtimeMs };
			}
		}
	};
	await visit(directory);
	if (!newest) return undefined;
	return { path: newest.path, text: await Bun.file(newest.path).text() };
}

function countCompactionEntries(text: string): number {
	return parseJsonl(text, "session transcript").filter(entry => isRecord(entry) && entry.type === "compaction").length;
}

/** Error text of every persisted assistant message that ended with `stopReason: "error"`. */
function transcriptAssistantErrors(text: string): string[] {
	const errors: string[] = [];
	for (const entry of parseJsonl(text, "session transcript")) {
		if (!isRecord(entry) || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "assistant" || message.stopReason !== "error") continue;
		errors.push(typeof message.errorMessage === "string" ? message.errorMessage : "unspecified provider error");
	}
	return errors;
}

/** `warn`/`error` records the isolated Broker and session host wrote under the isolated HOME. */
async function isolatedLogProblems(homeDir: string): Promise<string[]> {
	const logsDir = path.join(homeDir, ".gjc", "logs");
	const names = await fs.readdir(logsDir).catch(() => [] as string[]);
	const problems: string[] = [];
	for (const name of names.filter(name => name.endsWith(".log")).sort()) {
		const logPath = path.join(logsDir, name);
		for (const record of parseJsonl(await Bun.file(logPath).text(), logPath)) {
			if (isRecord(record) && (record.level === "error" || record.level === "warn")) problems.push(jsonLine(record));
		}
	}
	return problems.slice(-20);
}

function stepGroups(script: readonly WorkloadTurn[]): WorkloadTurn[][] {
	const groups: WorkloadTurn[][] = [];
	for (const turn of script) {
		const last = groups[groups.length - 1];
		if (last && last[0]?.phase === turn.phase) last.push(turn);
		else groups.push([turn]);
	}
	return groups;
}


function sanitizedEnvironment(input: NodeJS.ProcessEnv, agentDir: string, evidenceDir: string, homeDir: string): NodeJS.ProcessEnv {
	const allowed = new Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "BUN_INSTALL", "SYSTEMROOT"]);
	const result: NodeJS.ProcessEnv = { HOME: homeDir };
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined && allowed.has(key.toUpperCase())) result[key] = value;
	}
	result.GJC_AGENT_DIR = agentDir;
	result.GJC_CODING_AGENT_DIR = agentDir;
	result[CHARACTERIZE_DIRECTORY_ENV] = evidenceDir;
	return result;
}


function createRunnerEventWriter(events: string[]): (event: RunnerEvent) => void {
	return event => events.push(jsonLine(event));
}

async function writeEvidence(options: {
	evidenceDir: string;
	transcript: string;
	requests: string;
	tools: readonly string[];
	events: readonly string[];
	timing: readonly string[];
	sessionIndex: number;
}): Promise<void> {
	await Promise.all([
		Bun.write(path.join(options.evidenceDir, "transcript.jsonl"), options.transcript),
		Bun.write(path.join(options.evidenceDir, "requests.jsonl"), options.requests),
		Bun.write(path.join(options.evidenceDir, "tools.jsonl"), appendLines(options.tools)),
		Bun.write(path.join(options.evidenceDir, "events.jsonl"), appendLines(options.events)),
		Bun.write(path.join(options.evidenceDir, "timing.jsonl"), appendLines(options.timing)),
		Bun.write(
			path.join(options.evidenceDir, "manifest.json"),
			JSON.stringify(
				{
					bootstrap: RunnerBootstrap,
					bootstrapDigest: bootstrapDigest(),
					workloadDigest: workloadDigest(),
					sessionIndex: options.sessionIndex,
					workloadVariant: "full",
				},
				null,
				2,
			),
		),
	]);
}

/** Run the real Broker-backed session host and compare its evidence with the in-process runner. */
export async function characterize(): Promise<CharacterizationOutcome> {
	// Canonical path: macOS tmpdir is a /var -> /private/var symlink, and the host's
	// managed-path containment checks compare canonical paths.
	const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bench-multisession-characterize-")));
	const agentDir = path.join(temporaryRoot, "agent");
	const cwd = path.join(temporaryRoot, "project");
	const stateRoot = path.join(cwd, ".gjc", "state");
	const homeDir = path.join(temporaryRoot, "home");
	// Same `<root>/evidence` layout as session-runner, so the normalized `done` path matches.
	const evidenceDir = path.join(temporaryRoot, "evidence");
	const runnerRoot = path.join(temporaryRoot, "runner");
	const hostStderrPath = path.join(evidenceDir, "host-stderr.log");
	const hostStderrCaptureAbort = new AbortController();
	const extensionPath = path.join(import.meta.dir, "characterize-extension.ts");
	const script = buildWorkloadScript();
	const eventLines: string[] = [];
	const toolLines: string[] = [];
	const timingLines: string[] = [];
	const observed = new Set<WorkloadEventKind>();
	const toolStarts = new Map<string, ToolStart>();
	const writer = createRunnerEventWriter(eventLines);
	let broker: BrokerDiscovery | undefined;
	let brokerClient: SdkClient | undefined;
	let sessionClient: SdkClient | undefined;
	let sessionId: string | undefined;
	let sessionHostPid: number | undefined;
	let sessionHostIncarnation: string | undefined;
	let hostCleanupSignal: NodeJS.Signals | undefined;
	let hostExited = true;
	let unsubscribeFrames = (): void => {};
	let ownerStop: { stop(): Promise<void> } | undefined;
	let hostStderrCapture: Promise<boolean> | undefined;
	let hostStderrCaptured = false;
	let hostStderrTail = "";
	let hostExitObservation = "not-started";
	let hostExitBeforeClose = "not-started";
	let hostExitDiagnostics: HostExitDiagnostics | undefined;
	let brokerStopped = false;
	let transcriptText = "";
	let runFailure: string | undefined;
	let stage = "isolated host setup";
	let modelOrToolFailure: Error | undefined;
	let taskJobId: string | undefined;
	let turnNumber = 0;
	let completedTurnCount = 0;
	let agentStartCount = 0;
	let ready = false;
	let disposed = false;
	let stopFailure: string | undefined;
	let requestsContents = "";

	const emitPhase = (phase: "constructed" | "ready" | "disposing" | "disposed" | "idle" | `active:${string}`): void => {
		writer({ type: "phase", sessionIndex: 0, phase, t: benchNow() });
	};
	const emitWorkload = (event: WorkloadEventKind): void => {
		observed.add(event);
		writer({ type: "workload", sessionIndex: 0, event });
	};
	const recordToolEvent = (event: Record<string, unknown>): void => {
		if (event.type === "tool_execution_start") {
			if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
			const startedAt = benchNow();
			const start: ToolStart = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				startedAt,
			};
			toolStarts.set(event.toolCallId, start);
			toolLines.push(
				jsonLine({
					type: "start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					timestamp: startedAt,
				}),
			);
			return;
		}
		if (event.type !== "tool_execution_end" || typeof event.toolCallId !== "string") return;
		const start = toolStarts.get(event.toolCallId);
		toolStarts.delete(event.toolCallId);
		const endedAt = benchNow();
		toolLines.push(
			jsonLine({
				type: "end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: start?.args,
				result: event.result,
				isError: event.isError === true,
				startedAt: start?.startedAt,
				timestamp: endedAt,
			}),
		);
		if (event.isError === true) {
			modelOrToolFailure = new Error(`SDK benchmark tool ${String(event.toolName)} failed: ${JSON.stringify(jsonSafe(event.result))}`);
			return;
		}
		if (event.toolName === "bash") emitWorkload("tool:bash");
		else if (event.toolName === "read") emitWorkload("tool:read");
		else if (event.toolName === "search") emitWorkload("tool:grep");
		else if (event.toolName === "task") {
			taskJobId = asyncTaskJobId(event.result);
			if (!taskJobId) modelOrToolFailure = new Error(`SDK task returned no async child job: ${JSON.stringify(jsonSafe(event.result))}`);
		}
	};

	emitPhase("constructed");
	try {
		await Promise.all([
			fs.mkdir(path.join(cwd, ".gjc", "extensions"), { recursive: true }),
			fs.mkdir(stateRoot, { recursive: true }),
			fs.mkdir(homeDir, { recursive: true }),
			fs.mkdir(evidenceDir, { recursive: true }),
		]);
		await Bun.write(path.join(cwd, "workload.txt"), "bench-grep-marker\nsecond deterministic workload line\n");
		await Bun.write(
			path.join(agentDir, "settings.json"),
			JSON.stringify(
				{
					modelRoles: { default: "bench-mock/root" },
					// Same active tool surface as the in-process runner: product tool
					// discovery would otherwise hide `task` behind search_tool_bm25.
					tools: { essentialOverride: [...RunnerBootstrap.tools] },
					task: {
						autorouting: { enabled: false },
						agentModelOverrides: { executor: "bench-mock/child" },
						maxConcurrency: 1,
					},
					compaction: {
						enabled: true,
						strategy: "context-full",
						thresholdTokens: RunnerBootstrap.settings.compaction.thresholdTokens,
						thresholdPercent: -1,
						remoteEnabled: false,
					},
				},
				null,
				2,
			),
		);
		const extensionSource = await Bun.file(extensionPath).text();
		const runtimeExtension = extensionSource
			.replace('import type { ExtensionAPI } from "../../src/extensibility/extensions/types";\n', "")
			.replace(
				'import { createBenchMockProviderDefinition } from "./mock-provider";',
				`import { createBenchMockProviderDefinition } from ${JSON.stringify(url.pathToFileURL(path.join(import.meta.dir, "mock-provider.ts")).href)};`,
			)
			.replace(
				"export default function characterizeExtension(api: ExtensionAPI): void {",
				"export default function characterizeExtension(api) {",
			);
		if (runtimeExtension === extensionSource) throw new Error("Could not prepare the isolated characterization extension entrypoint.");
		await Bun.write(path.join(cwd, ".gjc", "extensions", "characterize-extension.js"), runtimeExtension);
		await Bun.write(path.join(evidenceDir, "requests.jsonl"), "");
		await Bun.write(path.join(evidenceDir, "tools.jsonl"), "");

		const env = sanitizedEnvironment(process.env, agentDir, evidenceDir, homeDir);
		stage = "Broker startup";
		broker = await ensureBroker({ agentDir, env });
		ownerStop = brokerOwnerForTest(agentDir);
		if (!ownerStop) throw new Error("ensureBroker returned without an exact locally owned Broker stop handle.");
		stage = "Broker client connection";
		brokerClient = await SdkClient.connect(broker.url, broker.token, { timeoutMs: 20_000, reconnectAttempts: 0 });
		hostStderrCapture = retainLifecycleStderr(path.join(agentDir, "sdk"), hostStderrPath, hostStderrCaptureAbort.signal);
		stage = "session.create";
		const created = await brokerClient.request(
			{
				type: "broker_request",
				operation: "session.create",
				input: { cwd, stateRoot, readinessTimeoutMs: 45_000 },
				idempotencyKey: crypto.randomUUID(),
			},
			{ timeoutMs: 60_000 },
		);
		sessionId = getSessionId(created);
		hostStderrCaptured = hostStderrCapture ? await hostStderrCapture : false;
		hostStderrCaptureAbort.abort();
		const endpointResponse = await brokerClient.request(
			{ type: "broker_request", operation: "session.get_endpoint", input: { sessionId } },
			{ timeoutMs: 15_000 },
		);
		const endpoint = getEndpoint(endpointResponse);
		const hostIncarnation = observeProcessIncarnation(endpoint.pid);
		if (hostIncarnation.status !== "present") {
			throw new Error(`session host incarnation could not be verified: ${JSON.stringify(hostIncarnation)}`);
		}
		sessionHostIncarnation = hostIncarnation.incarnation;
		sessionHostPid = endpoint.pid;
		hostExited = false;
		stage = "session SDK connection";
		sessionClient = await SdkClient.connect(endpoint.url, endpoint.token, {
			timeoutMs: PROMPT_WAIT_MS,
			reconnectAttempts: 0,
			capabilities: SESSION_STREAM_CAPABILITIES,
		});
		unsubscribeFrames = sessionClient.onFrame(frame => {
			if (!isRecord(frame)) return;
			if (frame.type === "event" && typeof frame.kind === "string" && isRecord(frame.payload)) {
				if (frame.kind === "agent_start") agentStartCount += 1;
				if (frame.kind === "agent_end") completedTurnCount += 1;
				if (frame.kind === "agent_failed") {
					modelOrToolFailure = new Error(`SDK agent_failed event: ${JSON.stringify(jsonSafe(frame.payload.error))}`);
				}
				if (frame.kind === "agent_end" && isRecord(frame.payload.outcome) && frame.payload.outcome.kind === "failed") {
					modelOrToolFailure = new Error(`SDK agent_end reported failure: ${JSON.stringify(jsonSafe(frame.payload.outcome))}`);
				}
			}
			const event = eventPayload(frame);
			if (!event) return;
			if (event.type === "message_end" && assistantHasText(event.message)) emitWorkload("streamed-text");
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") recordToolEvent(event);
			if (
				event.type === "message_end" &&
				isRecord(event.message) &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				modelOrToolFailure = new Error(
					`SDK benchmark model response ended with an error: ${typeof event.message.errorMessage === "string" ? event.message.errorMessage : "unspecified provider error"}`,
				);
			}
		});
		stage = "model.set";
		const selection = await sessionClient.control("model.set", { id: "bench-mock/root" }, { timeoutMs: 15_000 });
		responseResult(selection, "model.set");
		ready = true;
		emitPhase("ready");

		for (const group of stepGroups(script)) {
			emitPhase(`active:${group[0]!.phase}`);
			for (const turn of group) {
				turnNumber += 1;
				const startedAt = benchNow();
				const beforeTranscript = await latestTranscript(path.join(agentDir, "sessions"));
				const beforeCompactionCount = beforeTranscript ? countCompactionEntries(beforeTranscript.text) : 0;
				try {
					stage = `SDK prompt ${turn.key}`;
					await waitForPrompt(sessionClient, turn, turnNumber, () => modelOrToolFailure, () => completedTurnCount);
					if (modelOrToolFailure) throw modelOrToolFailure;
				} catch (error) {
					const endedAt = benchNow();
					writer({ type: "turn", sessionIndex: 0, turn: turnNumber, startedAt, endedAt, ok: false });
					throw error;
				}
				const endedAt = benchNow();
				writer({ type: "turn", sessionIndex: 0, turn: turnNumber, startedAt, endedAt, ok: true });
				timingLines.push(jsonLine({ type: "turn", sessionIndex: 0, turn: turnNumber, startedAt, endedAt, ok: true }));
				if (turn.key === "task") {
					if (!taskJobId) throw new Error("SDK task job ID was not observed in the task result.");
					await waitForTaskJob(sessionClient, taskJobId);
					requestsContents = await Bun.file(path.join(evidenceDir, "requests.jsonl")).text();
					if (!parseJsonl(requestsContents, "requests.jsonl").some(request => isRecord(request) && request.modelId === "child")) {
						throw new Error("SDK task completed without an observed bench-mock/child model request.");
					}
					emitWorkload("task-completed");
				}
				if (turn.key === "compaction") {
					const afterTranscript = await latestTranscript(path.join(agentDir, "sessions"));
					if (!afterTranscript || countCompactionEntries(afterTranscript.text) <= beforeCompactionCount) {
						throw new Error("SDK compaction-sized workload turn produced no new persisted compaction entry.");
					}
					emitWorkload("compaction");
				}
			}
			emitPhase("idle");
		}
		for (const required of REQUIRED_WORKLOAD_EVENTS) {
			if (!observed.has(required)) throw new Error(`SDK workload did not observe required event ${required}.`);
		}
	} catch (error) {
		runFailure = `${stage} failed with observed error: ${errorMessage(error)}`;
		writer({ type: "error", sessionIndex: 0, message: runFailure });
	} finally {
		if (sessionId) emitPhase("disposing");
		hostStderrCaptureAbort.abort();
		if (hostStderrCapture && !hostStderrCaptured) {
			hostStderrCaptured = await hostStderrCapture.catch(() => false);
		}
		if (sessionHostPid !== undefined && sessionHostIncarnation !== undefined) {
			const observation = observeProcessIncarnation(sessionHostPid);
			hostExitObservation =
				observation.status === "present"
					? observation.incarnation === sessionHostIncarnation
						? "present-before-close"
						: "pid-reused-before-close"
					: observation.status === "absent"
						? "absent-before-close"
						: `unknown-before-close:${observation.reasonCode}`;
		}
		hostExitBeforeClose = hostExitObservation;
		unsubscribeFrames();
		if (sessionClient) {
			try {
				await sessionClient.close();
			} catch (error) {
				stopFailure ??= `SDK session client close failed: ${errorMessage(error)}`;
			}
		}
		if (brokerClient && sessionId) {
			try {
				const closed = await brokerClient.request(
					{
						type: "broker_request",
						operation: "session.close",
						input: { sessionId },
						idempotencyKey: crypto.randomUUID(),
					},
					{ timeoutMs: 30_000 },
				);
				responseResult(closed, "session.close");
				disposed = true;
			} catch (error) {
				stopFailure ??= `Broker session.close failed: ${errorMessage(error)}`;
			}
		}
		if (brokerClient) {
			try {
				await brokerClient.close();
			} catch (error) {
				stopFailure ??= `Broker client close failed: ${errorMessage(error)}`;
			}
		}
		if (broker && !ownerStop) {
			stopFailure ??= "Error: ensureBroker retained no exact owned Broker stop handle.";
			const terminated = await terminateOwnedProcess(broker.pid, broker.incarnation);
			brokerStopped = terminated.observation === "absent" || terminated.observation === "pid-reused";
		}
		if (ownerStop) {
			try {
				await ownerStop.stop();
				brokerStopped = true;
			} catch (error) {
				stopFailure ??= `Owned Broker stop failed: ${errorMessage(error)}`;
				if (broker) {
					const terminated = await terminateOwnedProcess(broker.pid, broker.incarnation);
					brokerStopped = terminated.observation === "absent" || terminated.observation === "pid-reused";
				}
			}
		} else if (!broker) {
			brokerStopped = true;
		}
		if (sessionId) {
			if (sessionHostPid === undefined || sessionHostIncarnation === undefined) {
				stopFailure ??= "Error: no SDK session host process identity was observed for disposal verification.";
			} else {
				hostExitObservation = await waitForHostExit(sessionHostPid, sessionHostIncarnation, 2_000);
				if (hostExitObservation === "present") {
					const terminated = await terminateOwnedProcess(sessionHostPid, sessionHostIncarnation);
					hostExitObservation = terminated.observation;
					hostCleanupSignal = terminated.signal ?? undefined;
				}
				hostExited = hostExitObservation === "absent" || hostExitObservation === "pid-reused";
				if (!hostExited) stopFailure ??= `Error: SDK session host shutdown was not proven (${hostExitObservation}).`;
			}
			if (disposed || hostExited) emitPhase("disposed");
		}
		hostStderrTail = hostStderrCaptured
			? await Bun.file(hostStderrPath)
					.text()
					.catch(error => `unavailable: ${errorMessage(error)}`)
			: "unavailable: lifecycle stderr log was not retained before startup cleanup";
		hostExitDiagnostics = {
			pid: sessionHostPid ?? null,
			processObservation: `${hostExitBeforeClose}->${hostExitObservation}`,
			exitCode: null,
			signal: null,
			exitStatusObserved: false,
			cleanupSignal: hostCleanupSignal ?? null,
			stderrTail: hostStderrTail || "none",
		};
		if (sessionId) {
			const transcript = await latestTranscript(path.join(agentDir, "sessions")).catch(() => undefined);
			transcriptText = transcript?.text ?? "";
			if (!transcript && !runFailure) stopFailure ??= "Error: no file-backed session transcript was observed after host disposal.";
		}
		try {
			await writeEvidence({
				evidenceDir,
				transcript: transcriptText,
				requests: await Bun.file(path.join(evidenceDir, "requests.jsonl")).text().catch(() => requestsContents),
				tools: toolLines,
				events: eventLines,
				timing: timingLines,
				sessionIndex: 0,
			});
			if (hostExitDiagnostics) await Bun.write(path.join(evidenceDir, "host-exit.json"), `${jsonLine(hostExitDiagnostics)}\n`);
			if (sessionId && !runFailure && !stopFailure) {
				const done: RunnerEvent = { type: "done", sessionIndex: 0, evidenceDir };
				writer(done);
				await Bun.write(path.join(evidenceDir, "events.jsonl"), appendLines(eventLines));
			}
		} catch (error) {
			stopFailure ??= `Characterization evidence write failed: ${errorMessage(error)}`;
		}
	}

	const unavailable = async (reason: string): Promise<CharacterizationOutcome> => {
		const safeToRemove = brokerStopped && hostExited;
		// The SDK publishes only a sanitized failure code; the persisted transcript and
		// the isolated host's own log keep the actual observed cause. Read both before
		// the isolated root is removed.
		const transcriptErrors = transcriptAssistantErrors(transcriptText);
		const logProblems = await isolatedLogProblems(homeDir);
		if (safeToRemove) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
		const diagnostics = hostExitDiagnostics ? `; hostExit=${jsonLine(hostExitDiagnostics)}` : "";
		const transcriptCause = transcriptErrors.length > 0 ? `; transcriptErrors=${jsonLine(transcriptErrors)}` : "";
		const logCause = logProblems.length > 0 ? `; hostLog=[${logProblems.join(",")}]` : "";
		const retainedRoot = safeToRemove
			? ""
			: `; isolatedRoot=${temporaryRoot}; brokerStopped=${brokerStopped}; hostExited=${hostExited}`;
		return {
			outcome: "unavailable",
			reason: `${reason}${transcriptCause}${logCause}${diagnostics}${retainedRoot}`,
			...(hostExitDiagnostics ? { hostExit: hostExitDiagnostics } : {}),
		};
	};
	let runnerEvidenceDir: string;
	try {
		const runner = await runSession({
			sessionIndex: 0,
			rootDir: runnerRoot,
			idleMs: 0,
			emit: () => {},
		});
		runnerEvidenceDir = runner.evidenceDir;
	} catch (error) {
		return unavailable(`In-process comparison runner failed with observed error: ${errorMessage(error)}`);
	}
	if (runFailure || stopFailure) {
		const errors = [runFailure, stopFailure].filter((message): message is string => message !== undefined);
		return unavailable(`Broker characterization failed with observed error: ${errors.join("; ")}`);
	}
	if (!ready || !disposed) {
		return unavailable(`Broker characterization failed with observed error: Error: lifecycle state was ready=${ready}, disposed=${disposed}.`);
	}
	try {
		const comparison = await compareEvidence(evidenceDir, runnerEvidenceDir);
		return comparison.equal
			? { outcome: "equal", brokerEvidenceDir: evidenceDir, runnerEvidenceDir }
			: { outcome: "differs", fields: comparison.diffs.slice(0, 100), brokerEvidenceDir: evidenceDir, runnerEvidenceDir };
	} catch (error) {
		return unavailable(`Evidence comparison failed with observed error: ${errorMessage(error)}`);
	}
}
