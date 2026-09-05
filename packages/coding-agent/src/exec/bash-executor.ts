/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import * as fs from "node:fs/promises";
import type { MinimizerOptions, Shell as NativeShell, ShellOptions, ShellRunOptions } from "@gajae-code/natives";
import { postmortem } from "@gajae-code/utils";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../debug/crash-diagnostics";
import {
	DEFAULT_ARTIFACT_MAX_BYTES,
	DEFAULT_MAX_BYTES,
	OutputSink,
	type TerminalArtifactPublisher,
	truncateHeadBytes,
} from "../session/streaming-output";
import { formatArtifactReference, resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { IsolatedShell } from "./isolated-shell";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

type NativeShellBindings = Pick<typeof import("@gajae-code/natives"), "Shell">;
let nativeShellBindingsLoad: Promise<NativeShellBindings> | undefined;

async function shellNatives(): Promise<NativeShellBindings> {
	nativeShellBindingsLoad ??= Promise.resolve(require("@gajae-code/natives") as NativeShellBindings);
	return await nativeShellBindingsLoad;
}

type ShellRunResult = Awaited<ReturnType<NativeShell["run"]>> & { signal?: string };
type Shell = {
	run(options: ShellRunOptions, onChunk?: (error: Error | null, chunk: string) => void): Promise<ShellRunResult>;
	abort(): Promise<void>;
	close(): Promise<void>;
};
type ShellFactory = (options?: ShellOptions) => Shell | Promise<Shell>;
let shellFactoryForTests: ShellFactory | undefined;

export function setShellFactoryForTests(factory: ShellFactory | undefined): void {
	shellFactoryForTests = factory;
}

async function createShell(options?: ShellOptions): Promise<Shell> {
	if (shellFactoryForTests) return await shellFactoryForTests(options);
	// Windows brush exposes only its stub signal set, so the POSIX self-signal
	// hazard and session/process-group containment contract do not apply there.
	if (process.platform !== "win32") return new IsolatedShell(options);
	const { Shell } = await shellNatives();
	return new Shell(options);
}

export interface BashArtifactSaveSummary {
	artifactId: string;
	complete: boolean;
	omittedBytes?: number;
}

export type BashMinimizedSaveReturn = BashArtifactSaveResult | BashArtifactSaveSummary | string | undefined;

export type BashArtifactSaveResult =
	| { status: "saved"; artifactId: string; complete: true; omittedBytes?: undefined }
	| { status: "saved"; artifactId: string; complete: false; omittedBytes: number }
	| { status: "unavailable" }
	| { status: "failed"; diagnostic: string };

function summarizeLegacyArtifactSave(artifactId: string, originalText: string): BashArtifactSaveResult {
	const inputBytes = Buffer.byteLength(originalText, "utf-8");
	if (inputBytes <= DEFAULT_ARTIFACT_MAX_BYTES) {
		return { status: "saved", artifactId, complete: true };
	}
	const retainedBytes = truncateHeadBytes(originalText, DEFAULT_ARTIFACT_MAX_BYTES).bytes;
	return {
		status: "saved",
		artifactId,
		complete: false,
		omittedBytes: inputBytes - retainedBytes,
	};
}

function normalizeExplicitSavedArtifact(
	artifactId: string,
	complete: boolean,
	omittedBytes: number | undefined,
): BashArtifactSaveResult {
	if (complete) {
		return (omittedBytes ?? 0) > 0
			? { status: "failed", diagnostic: "artifact save reported complete output with omitted bytes" }
			: { status: "saved", artifactId, complete: true };
	}
	return typeof omittedBytes === "number" && omittedBytes > 0
		? { status: "saved", artifactId, complete: false, omittedBytes }
		: { status: "failed", diagnostic: "artifact save reported incomplete output without omitted bytes" };
}

function normalizeMinimizedSaveResult(value: BashMinimizedSaveReturn, originalText: string): BashArtifactSaveResult {
	if (typeof value === "string") return summarizeLegacyArtifactSave(value, originalText);
	if (!value) return { status: "unavailable" };
	if (!("status" in value)) {
		return normalizeExplicitSavedArtifact(value.artifactId, value.complete, value.omittedBytes);
	}
	if (value.status !== "saved") return value;
	return normalizeExplicitSavedArtifact(value.artifactId, value.complete, value.omittedBytes);
}

export function normalizeMinimizedSaveResultForTests(
	value: BashMinimizedSaveReturn,
	originalText: string,
): BashArtifactSaveResult {
	return normalizeMinimizedSaveResult(value, originalText);
}

function completeRawArtifactAvailable(summary: {
	artifactId?: string;
	artifactTruncatedBytes?: number;
	artifactFailureDiagnostic?: string;
}): boolean {
	return (
		summary.artifactId !== undefined &&
		(summary.artifactTruncatedBytes ?? 0) <= 0 &&
		summary.artifactFailureDiagnostic === undefined
	);
}

function appendModelNotice(output: string, notice: string): string {
	const separator = output.length > 0 && !output.endsWith("\n") ? "\n" : "";
	return `${output}${separator}${notice}\n`;
}

function minimizedSaveNotice(
	result: BashArtifactSaveResult,
	summary: { artifactId?: string; artifactTruncatedBytes?: number; artifactFailureDiagnostic?: string },
): string | undefined {
	if (result.status === "failed") return `Bash output artifact save failed: ${result.diagnostic}`;
	if (result.status === "unavailable" && !completeRawArtifactAvailable(summary)) {
		return "Bash output artifact unavailable: full original output could not be stored because artifact storage is unavailable.";
	}
	return undefined;
}

function minimizedArtifactFooter(result: Extract<BashArtifactSaveResult, { status: "saved" }>): string {
	const reference = result.complete
		? `artifact://${result.artifactId}`
		: formatArtifactReference(result.artifactId, result.omittedBytes);
	return `[raw output: ${reference}]`;
}

export interface BashExecutorOptions {
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). Complete saves preserve the
	 * historical `[raw output: artifact://<id>]` footer; capped saves carry an
	 * honest retained/omitted reference. A legacy string id is still accepted
	 * for non-tool callers and is classified from the original UTF-8 byte count.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<BashMinimizedSaveReturn>;
	cwd?: string;
	timeout?: number | null;
	onChunk?: (chunk: string) => void;
	/**
	 * Unthrottled per-chunk callback that fires for every sanitized stdout/stderr
	 * chunk *before* preview throttling. Background-job substrate uses this to
	 * record the complete process stream for the Monitor tool while keeping
	 * `onChunk` cheap for UI/progress rendering.
	 */
	onRawChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Session settings used for shell policy and output limits. */
	settings?: Settings;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/** Optional terminal publisher for managed artifacts without writable paths. */
	artifactPublisher?: TerminalArtifactPublisher;
	/** Optional Bash-specific retained tail budget in bytes. */
	spillThreshold?: number;
	/** Optional Bash-specific retained head budget in bytes. */
	headBytes?: number;
	/** Execute without retaining a native Shell in the persistent session registry. */
	oneShot?: boolean;
	/** Ignore user-configured shell command prefixes. Used by constrained read-only shells. */
	ignoreShellPrefix?: boolean;
	/** Skip sourced shell snapshots. Used by constrained read-only shells. */
	disableShellSnapshot?: boolean;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	/** POSIX signal that terminated the isolated shell execution boundary. */
	signal?: string;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
	artifactTruncatedBytes?: number;
	artifactFailureDiagnostic?: string;
}

const shellSessions = new Map<string, Shell>();
const retiringShellSessions = new Set<Shell>();
// Cover pi-shell's normal cancellation kill waves without turning a stalled
// native cleanup into a multi-second JavaScript tool stall.
const CANCEL_CLEANUP_WAIT_MS = 400;

/** Number of persistent shell sessions currently retained (owner gauge). */
export function getShellSessionCount(): number {
	return shellSessions.size;
}

/**
 * Dispose all persistent shell sessions: abort in-flight work and drop the
 * strong references so the native shells can be finalized. Healthy persistent
 * sessions are otherwise retained for the whole process lifetime (MEM-7). This
 * is registered as a postmortem cleanup so shutdown/signals release native
 * shell resources, and is also callable directly (e.g. on owner teardown).
 */
export async function disposeAllShellSessions(): Promise<void> {
	// Snapshot and drop strong references up front so concurrent callers cannot
	// reuse a session that is being torn down, then await every native close so
	// shutdown/signal cleanup does not return before resources are released.
	// Include retiring shells whose JS call returned after bounded abort cleanup
	// while the native run is still unwinding; they are no longer reusable but
	// remain owned until their run promise settles.
	// `close` rather than `abort`: aborting only cancels in-flight commands and
	// leaves a completed session retained for reuse, which keeps the native shell
	// alive for the rest of the process lifetime.
	const sessions = new Set([...shellSessions.values(), ...retiringShellSessions]);
	shellSessions.clear();
	retiringShellSessions.clear();
	await Promise.allSettled([...sessions].map(session => session.close()));
}

postmortem.register("bash-executor:shell-sessions", () => disposeAllShellSessions());

async function resolveShellCwd(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) return undefined;

	try {
		// Brush preserves the working directory string verbatim, so resolve symlinks
		// up front to keep `pwd` aligned with tools like `git worktree list`.
		return await fs.realpath(cwd);
	} catch {
		return cwd;
	}
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = options?.settings ?? (await Settings.init());
	const { shell, env: shellEnv, prefix } = settings.getShellConfig();
	const configuredPrefix = options?.ignoreShellPrefix ? undefined : prefix;
	const snapshotPath =
		!options?.disableShellSnapshot && shell.includes("bash") ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));

	const commandCwd = await resolveShellCwd(options?.cwd);
	const commandEnv = options?.env ? { ...NON_INTERACTIVE_ENV, ...options.env } : NON_INTERACTIVE_ENV;

	// Apply command prefix if configured and allowed for this execution.
	const prefixedCommand = configuredPrefix ? `${configuredPrefix} ${command}` : command;
	const finalCommand = prefixedCommand;

	// Create output sink for truncation and artifact handling
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		onRawChunk: options?.onRawChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		artifactPublisher: options?.artifactPublisher,
		spillThreshold: options?.spillThreshold ?? DEFAULT_MAX_BYTES,
		headBytes: options?.headBytes ?? resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		// Throttle the streaming preview callback to avoid saturating the
		// event loop when commands produce massive output (e.g. seq 1 50M).
		chunkThrottleMs: options?.onChunk ? 50 : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump("Command cancelled")),
		};
	}
	const usePersistentShell = options?.oneShot !== true;
	const sessionKey = buildSessionKey(shell, configuredPrefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);

	let shellSession = usePersistentShell ? shellSessions.get(sessionKey) : undefined;
	if (!shellSession && usePersistentShell) {
		shellSession = await createShell({
			sessionEnv: shellEnv,
			snapshotPath: snapshotPath ?? undefined,
			minimizer,
		});
		shellSessions.set(sessionKey, shellSession);
	}
	// Non-persistent invocations still need an owned native Shell so its lifetime
	// can be ended explicitly. executeShell creates a native shell outside the
	// persistent registry, leaving its cleanup untrackable by the host process.
	const oneShotShell = !usePersistentShell
		? await createShell({
				sessionEnv: shellEnv,
				snapshotPath: snapshotPath ?? undefined,
				minimizer,
			})
		: undefined;
	const activeShell = shellSession ?? oneShotShell;
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		if (activeShell && !abortPromise) {
			abortPromise = activeShell.abort();
		}
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	let abortPromise: Promise<unknown> | undefined;
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	const awaitAbortCleanup = async (runPromise: Promise<unknown>): Promise<boolean> => {
		const settled = await Promise.race([
			runPromise.then(
				() => true,
				() => true,
			),
			Bun.sleep(CANCEL_CLEANUP_WAIT_MS).then(() => false),
		]);
		if (abortPromise) {
			await Promise.race([abortPromise.catch(() => undefined), Bun.sleep(CANCEL_CLEANUP_WAIT_MS)]);
		}
		return settled;
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const executionTimeoutMs = options?.timeout === null ? undefined : (options?.timeout ?? 300_000);
	const baseTimeoutMs = executionTimeoutMs === undefined ? undefined : Math.max(1_000, executionTimeoutMs);
	if (baseTimeoutMs !== undefined) {
		timeoutTimer = setTimeout(() => {
			abortCurrentExecution();
			timeoutDeferred.resolve("timeout");
		}, baseTimeoutMs);
	}

	let resetSession = false;
	let runSettled = false;

	try {
		const runPromise = activeShell!.run(
			{
				command: finalCommand,
				cwd: commandCwd,
				env: commandEnv,
				timeoutMs: executionTimeoutMs,
				signal: runAbortController.signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);

		const winner = await Promise.race([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			if (shellSession) {
				resetSession = true;
				retiringShellSessions.add(shellSession);
				if (shellSessions.get(sessionKey) === shellSession) {
					shellSessions.delete(sessionKey);
				}
				runSettled = await awaitAbortCleanup(runPromise);
				// A retired session is never reused, so release the native shell instead
				// of leaving it retained for the rest of the process lifetime.
				if (runSettled) {
					retiringShellSessions.delete(shellSession);
					void shellSession.close().catch(() => undefined);
				} else {
					void runPromise
						.finally(() => {
							retiringShellSessions.delete(shellSession);
							if (shellSessions.get(sessionKey) === shellSession) {
								shellSessions.delete(sessionKey);
							}
							void shellSession.close().catch(() => undefined);
						})
						.catch(() => undefined);
				}
			} else {
				runSettled = await awaitAbortCleanup(runPromise);
				if (!runSettled) void runPromise.catch(() => undefined);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(
					winner.kind === "timeout" && baseTimeoutMs !== undefined
						? `Command timed out after ${Math.round(baseTimeoutMs / 1000)} seconds`
						: "Command cancelled",
				)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		// Handle timeout
		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(annotation)),
			};
		}

		// Handle cancellation
		if (winner.result.cancelled) {
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
			};
		}

		// A self-signal terminates the isolated worker rather than the GJC host.
		// Retire that worker-backed shell immediately; the next command with the
		// same session key creates a fresh persistent shell.
		if (winner.result.signal) {
			resetSession = true;
			runSettled = true;
			if (shellSession && shellSessions.get(sessionKey) === shellSession) {
				shellSessions.delete(sessionKey);
			}
			void activeShell?.close().catch(() => undefined);
		}

		// When the native minimizer rewrote the output, swap the sink's accumulated
		// raw stream for the minimized text, persist the original as a session
		// artifact, and splice an artifact footer into the visible text so the agent
		// can retrieve retained raw bytes without a false completeness claim.
		const minimized = winner.result.minimized;
		let minimizedSaveResult: BashArtifactSaveResult | undefined;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text);
			const saved = options?.onMinimizedSave
				? await options.onMinimizedSave(minimized.originalText, {
						filter: minimized.filter,
						inputBytes: minimized.inputBytes,
						outputBytes: minimized.outputBytes,
					})
				: undefined;
			minimizedSaveResult = normalizeMinimizedSaveResult(saved, minimized.originalText);
			if (minimizedSaveResult.status === "saved") {
				const sep = minimized.text.endsWith("\n") ? "" : "\n";
				sink.push(`${sep}${minimizedArtifactFooter(minimizedSaveResult)}\n`);
			}
		}

		const crashReport = await writeCrashReport(
			{
				kind: "bash",
				command: [shell, "-lc", finalCommand],
				exitCode: winner.result.exitCode,
				stderr: undefined,
			},
			{ cwd: commandCwd },
		);
		const crashNotice = formatCrashDiagnosticNotice(crashReport);
		if (crashNotice) {
			const separator = "\n";
			sink.push(`${separator}${crashNotice}\n`);
		}

		// Normal completion
		const summary = await sink.dump();
		const saveNotice = minimizedSaveResult ? minimizedSaveNotice(minimizedSaveResult, summary) : undefined;
		return {
			exitCode: winner.result.exitCode,
			...(winner.result.signal ? { signal: winner.result.signal } : {}),
			cancelled: false,
			...summary,
			...(saveNotice ? { output: appendModelNotice(summary.output, saveNotice) } : {}),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (resetSession && runSettled && shellSessions.get(sessionKey) === shellSession) {
			shellSessions.delete(sessionKey);
		}
		if (oneShotShell) {
			// Always close: a successful run keeps its session retained, so aborting
			// alone would leak the native shell and hold the event loop open.
			const disposePromise = (abortPromise ?? Promise.resolve()).then(() => oneShotShell.close());
			await Promise.race([disposePromise.catch(() => undefined), Bun.sleep(CANCEL_CLEANUP_WAIT_MS)]);
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
