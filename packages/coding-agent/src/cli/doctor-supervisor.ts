/**
 * Doctor bootstrap isolation supervisor (parent side).
 *
 * `gjc doctor` must stay usable when the normal runtime is broken (malformed
 * config, a faulting native addon, an unbounded filesystem stall). A
 * `Promise.race` inside the in-process runner cannot bound synchronous or
 * native work (fs realpath/read, native addon calls, fsync) — only an owned
 * child-process boundary can. This module owns that boundary from the
 * parent's side; the child worker entry (imports `./doctor/runner` and is
 * re-entered via `cli.ts`'s `--internal-doctor-worker` admission branch) is
 * implemented in `doctor-worker.ts`.
 *
 * Protocol: newline-delimited JSON over the child's stdin/stdout, each
 * message authenticated by a random per-run token delivered only via
 * `DOCTOR_WORKER_TOKEN_ENV` (never argv, never logged, never in the report).
 * Token comparison is constant-time. The child's stdio is fully owned by
 * this protocol, so the interactive confirmation prompt (default No, exact
 * action/target/value, SIGINT- and deadline-aware) is rendered by THIS
 * parent against the real terminal — the child never touches the TTY.
 *
 * "Repair admitted" is a permanent fence: it is latched synchronously the
 * instant the `admitted` message is observed, before any further await, and
 * is never cleared. Any abnormal ending after admission is reported as an
 * uncertain post-effect outcome (exit 4); before admission it is "nothing
 * started" (exit 3), and a runtime that itself was admitted-then-lost is
 * evidenced with `worker_termination_unverified`, never a silently clean
 * exit. SIGINT is forwarded to the child; a verified clean stop after SIGINT
 * and before admission reports 130, never fabricated merely because a
 * `Promise.race` resolved. No successor worker is ever spawned after an
 * unverified termination.
 */

import type { ChildProcessByStdio } from "node:child_process";
import * as childProcess from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import * as readline from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { VERSION } from "@gajae-code/utils/dirs";
import type { DoctorAction, DoctorConfirmationResult, DoctorOptions } from "./doctor/args";
import { DOCTOR_EXIT_CODES, finalizeReport } from "./doctor/report";
import type { DoctorRepair, DoctorReport } from "./doctor/types";

/** Re-entrant argv marker for the isolated doctor worker. Wiring into `cli.ts`'s admission chain is a coordinated follow-up. */
export const DOCTOR_WORKER_ARG = "--internal-doctor-worker";
/** Per-spawn random token; the worker must refuse to run the protocol route without an exact match. */
export const DOCTOR_WORKER_TOKEN_ENV = "GJC_DOCTOR_WORKER_TOKEN";

const DIAGNOSE_BUDGET_MS = 15_000;
const SHORT_REPAIR_BUDGET_MS = 10_000;
const LONG_REPAIR_BUDGET_MS = 120_000;
const SERVICE_RESTART_BASE_BUDGET_MS = 15_000 + 15_000;
const TERMINATION_GRACE_MS = 2_000;

const WORKER_ENV_KEYS = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"SYSTEMROOT",
	"WINDIR",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"GJC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

const COMPILED = /(?:\/\$bunfs\/|\/~BUN\/|\/%7EBUN\/)/i.test(import.meta.url);

export interface SupervisedDoctorInput {
	/** Raw argv following `doctor` (unparsed). The worker re-derives options and re-runs full security admission itself. */
	readonly argv: readonly string[];
	/** Parsed options for local budget/cwd/tty decisions only; `confirmRepair`/`onRepairAdmitted` here are ignored — the parent supplies live protocol-backed equivalents. */
	readonly options: DoctorOptions;
}

export type WorkerToSupervisorMessage =
	| {
			readonly type: "confirm";
			readonly token: string;
			readonly id: number;
			readonly repair: DoctorRepair;
			readonly setValue?: boolean;
	  }
	| { readonly type: "admitted"; readonly token: string }
	| { readonly type: "report"; readonly token: string; readonly report: DoctorReport }
	| { readonly type: "error"; readonly token: string; readonly code: string; readonly message: string };
/** Distributes `Omit` over the message union so each variant keeps its own extra fields (plain `Omit<Union, K>` only keeps keys common to every member). */
export type WorkerToSupervisorPayload = WorkerToSupervisorMessage extends infer M
	? M extends { readonly token: string }
		? Omit<M, "token">
		: never
	: never;

export type SupervisorToWorkerMessage =
	| {
			readonly type: "init";
			readonly token: string;
			readonly argv: readonly string[];
			readonly cwd: string;
			readonly tty: boolean;
			readonly runId: string;
			readonly timeoutMs: number;
			readonly deadlineAt: number;
	  }
	| {
			readonly type: "confirm-result";
			readonly token: string;
			readonly id: number;
			readonly result: DoctorConfirmationResult;
	  };

function actionCeilingMs(action: DoctorAction, drainSeconds: number | undefined): number {
	switch (action) {
		case "config.set-validated":
		case "mcp.set-startup-policy":
		case "permissions.restrict-owned-config":
		case "install.repair-managed-link":
		case "service.detach-owned-stale-artifact":
			return SHORT_REPAIR_BUDGET_MS;
		case "install.restore-binary":
		case "plugin.restore-known-artifact":
		case "plugin.quarantine-selected":
			return LONG_REPAIR_BUDGET_MS;
		case "service.restart-owned":
			return SERVICE_RESTART_BASE_BUDGET_MS + (drainSeconds ? drainSeconds * 1_000 : 0);
	}
}

/** An explicit `--timeout-ms` may only shorten the action-specific ceiling, never raise it. */
export function resolveSupervisedBudgetMs(options: DoctorOptions): number {
	const ceiling =
		options.mode === "fix" && options.repair
			? actionCeilingMs(options.repair, options.drainSeconds)
			: DIAGNOSE_BUDGET_MS;
	return options.timeoutMs !== undefined ? Math.min(options.timeoutMs, ceiling) : ceiling;
}

function resolveWorkerSpawnArgv(): string[] | undefined {
	if (COMPILED) return [process.execPath, DOCTOR_WORKER_ARG];
	try {
		const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
		const configPath = fileURLToPath(new URL("../sdk/broker/internal-source.bunfig.toml", import.meta.url));
		if (!path.isAbsolute(cliPath) || !path.isAbsolute(configPath)) return undefined;
		return [process.execPath, "--no-env-file", `--config=${configPath}`, cliPath, DOCTOR_WORKER_ARG];
	} catch {
		return undefined;
	}
}

function workerEnvironment(token: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		NO_COLOR: "1",
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		[DOCTOR_WORKER_TOKEN_ENV]: token,
	};
	for (const key of WORKER_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

/** Length is compared before the constant-time byte compare so a length mismatch is not itself a timing side channel on the byte contents. */
function tokenMatches(received: string, expected: string): boolean {
	const receivedBuffer = Buffer.from(received, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");
	return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function isPlausibleDoctorReport(value: unknown): value is DoctorReport {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<DoctorReport>;
	const summary = report.summary as { exitCode?: unknown } | undefined;
	return (
		report.schemaVersion === 1 &&
		report.command === "doctor" &&
		typeof report.runId === "string" &&
		typeof summary === "object" &&
		summary !== null &&
		typeof summary.exitCode === "number" &&
		Array.isArray(report.checks) &&
		Array.isArray(report.repairs)
	);
}

function synthesizedReport(input: {
	readonly options: DoctorOptions;
	readonly runId: string;
	readonly started: number;
	readonly exitCode: number;
	readonly invocationError: string;
	readonly interrupted?: boolean;
}): DoctorReport {
	const report = finalizeReport({
		runId: input.runId,
		mode: input.options.mode,
		generatedAt: new Date().toISOString(),
		durationMs: Math.round(performance.now() - input.started),
		subject: {
			gjcVersion: VERSION,
			platform: process.platform,
			arch: process.arch,
			channel: COMPILED ? "standalone" : "source",
			scope: input.options.scope,
			rootIds: [],
		},
		selection: { checks: [], repair: input.options.repair, targetId: input.options.targetId },
		coverage: { requested: 0, expanded: 0, attempted: 0, completed: 0, blocked: 0, timedOut: 0, unsupported: 0 },
		checks: [],
		repairs: [],
		invocationError: input.invocationError,
		interrupted: input.interrupted,
	});
	// The synthesized envelope always carries a concrete supervisor-decided exit code
	// (admission-fenced, never a bare Promise.race artifact); finalizeReport's own
	// exit derivation from empty coverage/checks is not authoritative here.
	return { ...report, summary: { ...report.summary, exitCode: input.exitCode } };
}

/** Real terminal confirmation prompt, rendered by the parent against its own stdio (never the child's). */
async function promptForConfirmation(
	repair: DoctorRepair,
	setValue: boolean | undefined,
	deadline: number,
	sigintSignal: AbortSignal,
): Promise<DoctorConfirmationResult> {
	const terminal = createPromptInterface({ input: process.stdin, output: process.stderr });
	const remaining = Math.max(1, Math.floor(deadline - performance.now()));
	const timeoutSignal = AbortSignal.timeout(remaining);
	try {
		const answer = await terminal.question(
			`Apply ${repair.id} to ${repair.targetId}${setValue === undefined ? "" : `, value ${setValue}`}? [y/N] `,
			{ signal: AbortSignal.any([sigintSignal, timeoutSignal]) },
		);
		return /^(y|yes)$/i.test(answer.trim()) ? "confirmed" : "confirmation_declined";
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError")
			return sigintSignal.aborted ? "cancelled" : "confirmation_timeout";
		return "confirmation_declined";
	} finally {
		terminal.close();
	}
}

/**
 * Run doctor diagnostics/repair inside an owned, verified-terminated child.
 * Never falls back to in-process execution and never spawns a successor
 * worker after this attempt's child is gone.
 */
export async function runSupervisedDoctor(input: SupervisedDoctorInput): Promise<DoctorReport> {
	const started = performance.now();
	const runId = randomUUID();
	const options = input.options;
	const budgetMs = resolveSupervisedBudgetMs(options);
	const deadline = started + budgetMs;
	const spawnArgv = resolveWorkerSpawnArgv();
	if (!spawnArgv)
		return synthesizedReport({
			options,
			runId,
			started,
			exitCode: DOCTOR_EXIT_CODES.incomplete,
			invocationError: "worker_runtime_identity_unavailable",
		});

	const token = randomBytes(32).toString("hex");
	const [command, ...args] = spawnArgv;
	let child: ChildProcessByStdio<Writable, Readable, null>;
	try {
		child = childProcess.spawn(command!, args, {
			cwd: options.cwd ?? process.cwd(),
			env: workerEnvironment(token),
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
	} catch {
		return synthesizedReport({
			options,
			runId,
			started,
			exitCode: DOCTOR_EXIT_CODES.incomplete,
			invocationError: "worker_spawn_failed",
		});
	}

	// Latched exactly once, synchronously, on first observation of "admitted" —
	// never cleared afterward regardless of any later cancel/timeout/signal.
	let admitted = false;
	let childExited = false;
	const exitEvent = Promise.withResolvers<void>();
	child.once("exit", () => {
		childExited = true;
		exitEvent.resolve();
	});
	const waitForExit = async (milliseconds: number): Promise<boolean> => {
		if (childExited) return true;
		const timeout = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => timeout.resolve(false), milliseconds);
		try {
			return await Promise.race([exitEvent.promise.then(() => true), timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	let settled = false;
	let finalReport: DoctorReport | undefined;
	let abnormalReasonCode: string | undefined;
	const outcome = Promise.withResolvers<void>();

	const send = (message: SupervisorToWorkerMessage): void => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	const finishOnce = (report: DoctorReport | undefined, reasonCode: string | undefined): void => {
		if (settled) return;
		settled = true;
		finalReport = report;
		abnormalReasonCode = reasonCode;
		outcome.resolve();
	};

	const sigintController = new AbortController();
	const onSigint = (): void => {
		sigintController.abort();
		try {
			child.kill("SIGINT");
		} catch {
			// Child already gone.
		}
	};
	process.on("SIGINT", onSigint);

	const lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
	lineReader.on("line", line => {
		let message: WorkerToSupervisorMessage;
		try {
			message = JSON.parse(line) as WorkerToSupervisorMessage;
		} catch {
			finishOnce(undefined, "worker_protocol_invalid");
			return;
		}
		if (typeof message.token !== "string" || !tokenMatches(message.token, token)) {
			finishOnce(undefined, "worker_protocol_unauthenticated");
			return;
		}
		if (message.type === "admitted") {
			admitted = true;
			return;
		}
		if (message.type === "confirm") {
			// A confirmation that arrives after admission is refused, never defaulted to yes:
			// the repair has already crossed into effect-capable territory.
			if (admitted) {
				send({ type: "confirm-result", token, id: message.id, result: "cancelled" });
				return;
			}
			void promptForConfirmation(message.repair, message.setValue, deadline, sigintController.signal).then(
				result => {
					send({ type: "confirm-result", token, id: message.id, result });
				},
			);
			return;
		}
		if (message.type === "report") {
			if (
				!isPlausibleDoctorReport(message.report) ||
				message.report.runId !== runId ||
				message.report.mode !== options.mode ||
				message.report.selection.repair !== options.repair ||
				message.report.selection.targetId !== options.targetId
			) {
				finishOnce(undefined, "worker_report_invalid");
				return;
			}
			finishOnce(message.report, undefined);
			return;
		}
		if (message.type === "error") {
			finishOnce(undefined, "worker_reported_error");
		}
	});

	send({
		type: "init",
		token,
		argv: input.argv,
		cwd: options.cwd ?? process.cwd(),
		tty: Boolean(options.tty),
		runId,
		timeoutMs: budgetMs,
		deadlineAt: Date.now() + Math.max(1, deadline - performance.now()),
	});

	// `close` fires only after stdout/stderr are fully drained, so a report/error
	// line the worker flushed right before exiting is always processed by the
	// line reader above BEFORE this fallback can fire (matches the bash-shell
	// supervisor's own close-vs-exit ordering rationale).
	child.once("close", () => {
		finishOnce(undefined, "worker_exited_without_report");
	});
	child.once("error", () => {
		finishOnce(undefined, "worker_spawn_failed");
	});

	const timeoutHandle = setTimeout(
		() => finishOnce(undefined, "worker_deadline_exceeded"),
		Math.max(0, deadline - performance.now()),
	);
	try {
		await outcome.promise;
	} finally {
		clearTimeout(timeoutHandle);
		process.off("SIGINT", onSigint);
	}

	// Verified-termination sequence: never leave the worker running, never spawn a
	// successor, and never report success/interruption without confirming the exit.
	if (finalReport) child.stdin.end();
	let terminationVerified = childExited || (finalReport !== undefined && (await waitForExit(200)));
	if (!terminationVerified) {
		try {
			child.kill("SIGTERM");
			terminationVerified = await waitForExit(TERMINATION_GRACE_MS);
		} catch {
			terminationVerified = false;
		}
	}
	if (!terminationVerified) {
		try {
			child.kill("SIGKILL");
			terminationVerified = await waitForExit(TERMINATION_GRACE_MS);
		} catch {
			terminationVerified = false;
		}
	}
	try {
		child.stdin.destroy();
	} catch {
		// Already closed.
	}

	if (finalReport && terminationVerified && !abnormalReasonCode) return finalReport;

	if (!terminationVerified) {
		return synthesizedReport({
			options,
			runId,
			started,
			exitCode: admitted ? DOCTOR_EXIT_CODES.mutationFailure : DOCTOR_EXIT_CODES.incomplete,
			invocationError: "worker_termination_unverified",
		});
	}
	if (sigintController.signal.aborted && !admitted) {
		return synthesizedReport({
			options,
			runId,
			started,
			exitCode: DOCTOR_EXIT_CODES.interrupted,
			invocationError: "worker_interrupted",
			interrupted: true,
		});
	}
	return synthesizedReport({
		options,
		runId,
		started,
		exitCode: admitted ? DOCTOR_EXIT_CODES.mutationFailure : DOCTOR_EXIT_CODES.incomplete,
		invocationError: abnormalReasonCode ?? "worker_terminated_without_report",
	});
}
