import { AsyncJobManager } from "../../src/async";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { heapStats } from "bun:jsc";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createAgentSession } from "../../src/sdk/session";
import { getAgentDir } from "@gajae-code/utils";
import { RunnerBootstrap, bootstrapDigest } from "./bootstrap";
import { LAG_INTERVAL_MS, LagSampler } from "./lag";
import { createBenchMockProvider, type BenchMockProvider } from "./mock-provider";
import { benchNow, REQUIRED_WORKLOAD_EVENTS, type RunnerEvent, type WorkloadEventKind } from "./types";
import { buildWorkloadScript, type WorkloadTurn, type WorkloadVariant, workloadDigest } from "./workload";

/** Error-message prefix: the sanity run could not start for lack of a model or credentials. */
export const SANITY_UNAVAILABLE = "sanity-unavailable";

interface ToolStart {
	toolName: string;
	args: unknown;
	startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = value.map(item => jsonSafe(item, seen)).filter(item => item !== undefined);
	} else {
		const record: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const clean = jsonSafe(item, seen);
			if (clean !== undefined) record[key] = clean;
		}
		result = record;
	}
	seen.delete(value);
	return result;
}

function jsonLine(value: unknown): string {
	const json = JSON.stringify(jsonSafe(value));
	if (json === undefined) throw new Error("Could not serialize runner evidence.");
	return json;
}

function appendLines(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function assistantHasText(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return false;
	const content = message.content;
	if (typeof content === "string") return content.length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(
		block => isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0,
	);
}

function asyncTaskJobId(result: unknown): string | undefined {
	if (!isRecord(result) || !isRecord(result.details) || !isRecord(result.details.async)) return undefined;
	return typeof result.details.async.jobId === "string" ? result.details.async.jobId : undefined;
}

function observedCompactionCount(session: AgentSession): number {
	return session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length;
}

export function setAllowlistedEnvironment(): () => void {
	const original = new Map(Object.entries(process.env));
	for (const key of Object.keys(process.env)) delete process.env[key];
	for (const key of RunnerBootstrap.environment.allowlist) {
		const value = original.get(key);
		if (value !== undefined) process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		for (const [key, value] of original) process.env[key] = value;
	};
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

function requiredEventsMissing(observed: ReadonlySet<WorkloadEventKind>): WorkloadEventKind[] {
	return REQUIRED_WORKLOAD_EVENTS.filter(event => !observed.has(event));
}

export async function runSession(opts: {
	sessionIndex: number;
	rootDir: string;
	idleMs: number;
	emit: (e: RunnerEvent) => void;
	workloadVariant?: WorkloadVariant;
}): Promise<{ evidenceDir: string }> {
	if (!Number.isInteger(opts.sessionIndex) || opts.sessionIndex < 0) {
		throw new Error("sessionIndex must be a non-negative integer");
	}
	if (!Number.isFinite(opts.idleMs) || opts.idleMs < 0) throw new Error("idleMs must be a finite non-negative number");

	// Canonical root (macOS /tmp and $TMPDIR are symlinks into /private): every path
	// the session records must share one spelling so evidence normalizes identically.
	await fs.mkdir(opts.rootDir, { recursive: true });
	const sessionRoot = path.join(await fs.realpath(opts.rootDir), `session-${opts.sessionIndex}`);
	const agentDir = path.join(sessionRoot, "agent");
	const cwd = path.join(sessionRoot, "project");
	const evidenceDir = path.join(sessionRoot, "evidence");
	const requestsPath = path.join(evidenceDir, "requests.jsonl");
	const sessionDataDir = path.join(sessionRoot, "sessions");
	const workloadVariant = opts.workloadVariant ?? "full";
	const script = buildWorkloadScript(workloadVariant);
	const eventLines: string[] = [];
	const timingLines: string[] = [];
	const toolLines: string[] = [];
	const observed = new Set<WorkloadEventKind>();
	const pendingTools = new Map<string, ToolStart>();
	let pendingTaskJobId: string | undefined;
	let sessionManager: SessionManager | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let provider: BenchMockProvider | undefined;
	let unsubscribe = () => {};
	let environmentRestore: (() => void) | undefined;
	let lagTimer: NodeJS.Timeout | undefined;
	let lagSamples: number[] = [];
	let transcriptSource: string | undefined;
	let failure: unknown;
	let failed = false;

	const emit = (event: RunnerEvent, persist = true): void => {
		if (persist) eventLines.push(jsonLine(event));
		opts.emit(event);
	};
	const emitPhase = (phase: "constructed" | "ready" | "idle" | "disposing" | "disposed" | `active:${string}`): void => {
		emit({ type: "phase", sessionIndex: opts.sessionIndex, phase, t: benchNow() });
	};
	const emitWorkload = (event: WorkloadEventKind): void => {
		observed.add(event);
		emit({ type: "workload", sessionIndex: opts.sessionIndex, event });
	};
	const fail = (error: unknown): void => {
		if (failed) return;
		failed = true;
		failure = error;
		emit({
			type: "error",
			sessionIndex: opts.sessionIndex,
			message: error instanceof Error ? error.message : String(error),
		});
	};

	emitPhase("constructed");
	try {
		const sanity = workloadVariant === "sanity";
		// The sanity variant needs the operator's real credentials, so it keeps the
		// inherited environment; the gated variants run under the allowlist only.
		if (!sanity) environmentRestore = setAllowlistedEnvironment();
		await Promise.all([
			fs.mkdir(agentDir, { recursive: true }),
			fs.mkdir(cwd, { recursive: true }),
			fs.mkdir(evidenceDir, { recursive: true }),
			fs.mkdir(sessionDataDir, { recursive: true }),
		]);
		await Bun.write(requestsPath, "");
		await Bun.write(path.join(cwd, "workload.txt"), "bench-grep-marker\nsecond deterministic workload line\n");

		sessionManager = SessionManager.create(cwd, SessionManager.explicitDestination(sessionDataDir));
		await sessionManager.ensureOnDisk();
		transcriptSource = sessionManager.getSessionFile();
		const sessionShape = {
			cwd,
			sessionManager,
			systemPrompt: ["Execute each benchmark instruction exactly; use requested tools, then reply briefly."],
			toolNames: [...RunnerBootstrap.tools],
			disableExtensionDiscovery: RunnerBootstrap.settings.disableExtensionDiscovery,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: RunnerBootstrap.settings.enableMCP,
			enableMcpAutoload: RunnerBootstrap.settings.enableMcpAutoload,
			enableLsp: RunnerBootstrap.settings.enableLsp,
			sdkHostModeSupported: RunnerBootstrap.settings.sdkHostModeSupported,
			notificationHostModeSupported: RunnerBootstrap.settings.notificationHostModeSupported,
			skipPythonPreflight: true,
		};

		if (sanity) {
			// Real provider: the operator's agent dir supplies settings, credentials, and
			// the configured default model, exactly as an ordinary gjc session resolves them.
			const created = await createAgentSession({ ...sessionShape, agentDir: getAgentDir() });
			session = created.session;
			if (!session.model) throw new Error(`${SANITY_UNAVAILABLE}: no default model is configured`);
			if (!(await session.modelRegistry.getApiKey(session.model))) {
				throw new Error(
					`${SANITY_UNAVAILABLE}: no credentials for ${session.model.provider}/${session.model.id}`,
				);
			}
		} else {
			const settings = Settings.isolated({
				"compaction.enabled": RunnerBootstrap.settings.compaction.enabled,
				"compaction.strategy": RunnerBootstrap.settings.compaction.strategy,
				"compaction.thresholdTokens": RunnerBootstrap.settings.compaction.thresholdTokens,
				"compaction.thresholdPercent": -1,
				"compaction.remoteEnabled": false,
				"contextPromotion.enabled": false,
				"task.agentModelOverrides": { executor: "bench-mock/child" },
				"task.autorouting.enabled": false,
				"task.maxConcurrency": 1,
			});
			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.setRuntimeApiKey("mock", "bench-mock-test-key");
			authStorage.setRuntimeApiKey("bench-mock", "bench-mock-child-test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), settings, {
				agentDir,
				automaticRefresh: false,
			});
			provider = createBenchMockProvider(modelRegistry, opts.sessionIndex, requestsPath);
			if (!(await modelRegistry.getApiKey(provider.root))) {
				throw new Error("bench-mock root API key did not resolve after bootstrap.");
			}
			const created = await createAgentSession({
				...sessionShape,
				agentDir,
				authStorage,
				modelRegistry,
				settings,
				model: provider.root,
			});
			session = created.session;
			const activeModel = session.model;
			if (activeModel?.provider !== "mock" || activeModel.id !== "root") {
				throw new Error(
					`bench-mock root model was not active: ${activeModel?.provider ?? "none"}/${activeModel?.id ?? "none"}`,
				);
			}
			provider.register();
		}
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end" && assistantHasText(event.message)) emitWorkload("streamed-text");
			if (event.type === "tool_execution_start") {
				pendingTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, startedAt: benchNow() });
				toolLines.push(
					jsonLine({
						type: "start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						timestamp: benchNow(),
					}),
				);
			}
			if (event.type === "tool_execution_end") {
				const start = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				toolLines.push(
					jsonLine({
						type: "end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: start?.args,
						result: event.result,
						isError: event.isError === true,
						startedAt: start?.startedAt,
						timestamp: benchNow(),
					}),
				);
				if (event.isError === true) {
					fail(new Error(`Benchmark tool ${event.toolName} failed: ${JSON.stringify(jsonSafe(event.result))}`));
				} else if (event.toolName === "bash") {
					emitWorkload("tool:bash");
				} else if (event.toolName === "read") {
					emitWorkload("tool:read");
				} else if (event.toolName === "search") {
					emitWorkload("tool:grep");
				} else if (event.toolName === "task") {
					pendingTaskJobId = asyncTaskJobId(event.result);
					if (!pendingTaskJobId) {
						fail(new Error(`Benchmark task did not return an async child job: ${JSON.stringify(jsonSafe(event.result))}`));
					}
				}
			}
			if (event.type === "agent_failed") {
				fail(new Error(`Benchmark model request failed: ${session?.agent.state.error ?? event.error.message}`));
			}
			if (
				event.type === "message_end" &&
				isRecord(event.message) &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				const detail = typeof event.message.errorMessage === "string" ? event.message.errorMessage : "unspecified provider error";
				fail(new Error(`Benchmark assistant model response ended with an error: ${detail}`));
			}
		});
		emitPhase("ready");

		const sampler = new LagSampler(performance.now());
		lagSamples = sampler.samplesMs;
		lagTimer = setInterval(() => sampler.tick(performance.now()), LAG_INTERVAL_MS);

		let turnNumber = 0;
		for (const group of stepGroups(script)) {
			const phase = group[0]?.phase ?? "workload";
			emitPhase(`active:${phase}`);
			for (const turn of group) {
				turnNumber += 1;
				const beforeCompactionCount = observedCompactionCount(session);
				const startedAt = benchNow();
				try {
					if (turn.key === "compaction") {
						// The oversized pending prompt is not persisted yet; let it run, then require the post-turn check to compact real history.
						await session.prompt(turn.prompt, { skipCompactionCheck: true });
					} else {
						await session.prompt(turn.prompt);
					}
				} catch (error) {
					fail(error);
				}
				const endedAt = benchNow();
				const turnEvent: RunnerEvent = {
					type: "turn",
					sessionIndex: opts.sessionIndex,
					turn: turnNumber,
					startedAt,
					endedAt,
					ok: !failed,
				};
				emit(turnEvent);
				timingLines.push(jsonLine(turnEvent));
				if (failed) throw failure;
				if (turn.key === "task") {
					const jobId = pendingTaskJobId;
					if (!jobId) throw new Error("Benchmark task child job id was not observed.");
					const manager = AsyncJobManager.instance();
					const job = manager?.getJob(jobId);
					if (!manager || !job) throw new Error(`Benchmark task child job ${jobId} was not registered.`);
					const { promise: timeout, reject } = Promise.withResolvers<never>();
					const timer = setTimeout(() => reject(new Error(`Benchmark task child job ${jobId} timed out.`)), 30_000);
					try {
						await Promise.race([job.promise, timeout]);
					} finally {
						clearTimeout(timer);
					}
					const completedJob = manager.getJob(jobId);
					if (completedJob?.status !== "completed") {
						throw new Error(
							`Benchmark task child job ${jobId} ended ${completedJob?.status ?? "unknown"}: ${completedJob?.errorText ?? "no error details"}`,
						);
					}
					if (!provider || provider.child.calls.length === 0) {
						throw new Error("Benchmark task completed without using bench-mock/child.");
					}
					emitWorkload("task-completed");
					pendingTaskJobId = undefined;
				}
				if (turn.key === "compaction") {
					if (observedCompactionCount(session) <= beforeCompactionCount) {
						throw new Error("The compaction-sized workload turn produced no new persisted compaction entry.");
					}
					emitWorkload("compaction");
				}
			}
			emitPhase("idle");
			if (opts.idleMs > 0) await Bun.sleep(opts.idleMs);
		}

		if (workloadVariant === "full") {
			const missing = requiredEventsMissing(observed);
			if (missing.length > 0) throw new Error(`Workload did not observe required facts: ${missing.join(", ")}`);
		}
		if (sanity && !observed.has("streamed-text")) throw new Error("Sanity workload observed no streamed assistant text.");
	} catch (error) {
		fail(error);
	} finally {
		if (lagTimer !== undefined) clearInterval(lagTimer);
		if (session) {
			emitPhase("disposing");
			unsubscribe();
			try {
				await session.dispose();
			} catch (error) {
				fail(error);
			}
			emitPhase("disposed");
		} else if (sessionManager) {
			emitPhase("disposing");
			try {
				await sessionManager.close();
			} catch (error) {
				fail(error);
			}
			emitPhase("disposed");
		}

		if (session) {
			const lagEvent: RunnerEvent = { type: "lag", sessionIndex: opts.sessionIndex, samplesMs: lagSamples };
			emit(lagEvent, false);
			timingLines.push(jsonLine(lagEvent));
		}
		const stats = heapStats();
		const heapEvent: RunnerEvent = {
			type: "heap",
			sessionIndex: opts.sessionIndex,
			heapSize: stats.heapSize,
			heapCapacity: stats.heapCapacity,
			extraMemory: stats.extraMemorySize,
		};
		emit(heapEvent, false);
		timingLines.push(jsonLine(heapEvent));

		try {
			provider?.dispose();
		} catch (error) {
			fail(error);
		}
		try {
			if (transcriptSource && (await Bun.file(transcriptSource).exists())) {
				await Bun.write(path.join(evidenceDir, "transcript.jsonl"), await Bun.file(transcriptSource).text());
			} else {
				await Bun.write(path.join(evidenceDir, "transcript.jsonl"), "");
			}
			await Promise.all([
				Bun.write(path.join(evidenceDir, "tools.jsonl"), appendLines(toolLines)),
				Bun.write(path.join(evidenceDir, "events.jsonl"), appendLines(eventLines)),
				Bun.write(path.join(evidenceDir, "timing.jsonl"), appendLines(timingLines)),
				Bun.write(
					path.join(evidenceDir, "manifest.json"),
					JSON.stringify(
						{
							bootstrap: RunnerBootstrap,
							bootstrapDigest: bootstrapDigest(),
							workloadDigest: workloadDigest(),
							sessionIndex: opts.sessionIndex,
							workloadVariant,
						},
						null,
						2,
					),
				),
			]);
		} catch (error) {
			fail(error);
		}

		try {
			authStorage?.close();
		} catch (error) {
			fail(error);
		}
		environmentRestore?.();
	}

	if (failed) throw failure;
	eventLines.push(jsonLine({ type: "done", sessionIndex: opts.sessionIndex, evidenceDir }));
	await Bun.write(path.join(evidenceDir, "events.jsonl"), appendLines(eventLines));
	return { evidenceDir };
}
