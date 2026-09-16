/**
 * Doctor bootstrap isolation worker (child side).
 *
 * This is the ONLY module that imports the real `./doctor/runner` inside the
 * isolated child spawned by `doctor-supervisor.ts`. Its own stdio is fully
 * consumed by the JSON-line protocol: the parent renders the interactive
 * confirmation prompt against the real terminal and this process forwards
 * `confirmRepair`/`onRepairAdmitted` callback activity over the wire rather
 * than touching `process.stdin`/TTY itself. `onRepairAdmitted` latches the
 * "admitted" fact on the parent's side the instant the message is sent —
 * this worker sends it synchronously before any further await, exactly once
 * per repair attempt, and never retracts it.
 *
 * No raw stderr, stack trace, or uncaught exception detail ever reaches the
 * parent: every failure path here degrades to a bounded `error` message with
 * a fixed reason code. The parent treats worker stdout as the only channel
 * of record and never forwards this process's own stderr into the report.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import { type DoctorConfirmationResult, parseDoctorArgs } from "./doctor/args";
import type { DoctorRepair, DoctorReport } from "./doctor/types";
import type { SupervisorToWorkerMessage, WorkerToSupervisorPayload } from "./doctor-supervisor";
import { DOCTOR_WORKER_TOKEN_ENV } from "./doctor-supervisor";

function send(token: string, message: WorkerToSupervisorPayload): void {
	const bytes = Buffer.from(`${JSON.stringify({ ...message, token })}\n`);
	if (bytes.byteLength > 1024 * 1024) throw new Error("worker_output_limit");
	let offset = 0;
	while (offset < bytes.length) {
		const written = fs.writeSync(1, bytes, offset, bytes.length - offset);
		if (written === 0) throw new Error("worker_output_closed");
		offset += written;
	}
}

/**
 * `--internal-doctor-worker` is only a routable protocol worker when BOTH the
 * token env var is present with a plausible shape AND stdin is not a TTY — a
 * user's own interactive terminal can never be silently routed onto the
 * worker's non-interactive confirmation-refusal path. Any other invocation
 * (missing token, short/malformed token, an attached TTY) falls back to
 * ordinary CLI usage error and never enters the protocol at all.
 */
export function isRoutableDoctorWorkerInvocation(env: NodeJS.ProcessEnv, stdinIsTTY: boolean | undefined): boolean {
	const token = env[DOCTOR_WORKER_TOKEN_ENV];
	return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) && !stdinIsTTY;
}

/** Runs the isolated worker's full protocol lifecycle to completion. Never spawns anything; never talks to a TTY. */
export async function runDoctorWorker(): Promise<void> {
	const token = process.env[DOCTOR_WORKER_TOKEN_ENV];
	if (!token || !/^[0-9a-f]{64}$/.test(token) || process.stdin.isTTY) {
		process.exitCode = 2;
		return;
	}

	type InitMessage = Extract<SupervisorToWorkerMessage, { readonly type: "init" }>;
	const init = await new Promise<InitMessage | undefined>(resolve => {
		const lineReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
		const onLine = (line: string): void => {
			lineReader.off("line", onLine);
			try {
				const message = JSON.parse(line) as SupervisorToWorkerMessage;
				resolve(message.type === "init" && message.token === token ? (message as InitMessage) : undefined);
			} catch {
				resolve(undefined);
			}
			lineReader.close();
		};
		lineReader.on("line", onLine);
		lineReader.once("close", () => resolve(undefined));
	});
	if (
		!init ||
		!Array.isArray(init.argv) ||
		!init.argv.every(argument => typeof argument === "string") ||
		typeof init.cwd !== "string" ||
		typeof init.tty !== "boolean" ||
		typeof init.runId !== "string" ||
		!/^[0-9a-f-]{36}$/.test(init.runId) ||
		!Number.isFinite(init.deadlineAt) ||
		!Number.isInteger(init.timeoutMs) ||
		init.timeoutMs <= 0 ||
		init.timeoutMs > 120_000
	) {
		send(token, {
			type: "error",
			code: "worker_init_invalid",
			message: "Worker did not receive a valid init message.",
		});
		process.exitCode = 2;
		return;
	}

	const deadline = performance.now() + Math.max(0, init.deadlineAt - Date.now());
	const parsed = parseDoctorArgs(init.argv);
	if (parsed.error || !parsed.options) {
		send(token, {
			type: "error",
			code: "worker_args_invalid",
			message: "Worker could not parse the supplied arguments.",
		});
		process.exitCode = 2;
		return;
	}

	// Every remaining protocol line after init is a `confirm-result`; route each
	// by its `id` to the pending confirmation promise the runner is awaiting.
	const pendingConfirmations = new Map<number, (result: DoctorConfirmationResult) => void>();
	let nextConfirmId = 0;
	const lineReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	lineReader.on("line", line => {
		let message: SupervisorToWorkerMessage;
		try {
			message = JSON.parse(line) as SupervisorToWorkerMessage;
		} catch {
			return;
		}
		if (message.token !== token || message.type !== "confirm-result") return;
		const resolve = pendingConfirmations.get(message.id);
		if (!resolve) return;
		pendingConfirmations.delete(message.id);
		resolve(message.result);
	});

	const confirmRepair = (repair: DoctorRepair): Promise<DoctorConfirmationResult> => {
		const id = nextConfirmId++;
		return new Promise<DoctorConfirmationResult>(resolve => {
			pendingConfirmations.set(id, resolve);
			send(token, { type: "confirm", id, repair, setValue: parsed.options?.setValue });
		});
	};

	// Sent synchronously, before any further await in this callback, so the
	// parent's admission fence latches at the exact moment the repair enters
	// its effect-capable transaction — never delayed, never re-sent, never
	// followed by a retraction.
	const onRepairAdmitted = (): void => {
		send(token, { type: "admitted" });
	};

	// Overriding the default SIGINT disposition lets a forwarded Ctrl-C (from
	// the supervisor) drive the runner's own cancellation checks to a prompt,
	// correctly `interrupted: true` report — landing on exit 130 through the
	// normal report path — instead of the process dying before it can reply.
	const sigintController = new AbortController();
	const onSigint = (): void => sigintController.abort();
	process.on("SIGINT", onSigint);

	try {
		const { collectDoctorReport } = await import("./doctor/runner");
		const report: DoctorReport = await collectDoctorReport({
			...parsed.options,
			cwd: init.cwd,
			tty: init.tty,
			runId: init.runId,
			timeoutMs: init.timeoutMs,
			deadline,
			signal: sigintController.signal,
			confirmRepair,
			onRepairAdmitted,
		});
		send(token, { type: "report", report });
		process.exitCode = 0;
	} catch {
		// The real error may carry filesystem paths, native addon detail, or
		// other host-specific text; only a bounded, fixed reason code crosses
		// the process boundary.
		send(token, {
			type: "error",
			code: "worker_runner_failed",
			message: "Doctor diagnostics could not be completed inside the isolated worker.",
		});
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
		lineReader.close();
	}
}
