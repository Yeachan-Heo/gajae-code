import crypto from "node:crypto";
import { ComputerController } from "@gajae-code/natives";
import { isCompiledBinary } from "@gajae-code/utils/env";
import {
	GATE0_LIFECYCLE_TIMEOUT_MS,
	type Gate0LifecycleMarker,
	runGate0TmuxLifecycle,
} from "./computer-broker-gate0-tmux";
import { resolveGjcTmuxBinary } from "./tmux-common";

export const GATE0_INPUT_ENV = "GJC_COMPUTER_GATE0_INPUT";
const GATE0_PERSISTENT_CHILD_ENV = "GJC_COMPUTER_GATE0_PERSISTENT_CHILD";
const GATE0_INTERNAL_TIMEOUT_MS = GATE0_LIFECYCLE_TIMEOUT_MS - 1_000;

export type Gate0Code =
	| "ok"
	| "invalid_input"
	| "permission_denied"
	| "permission_pending"
	| "probe_failed"
	| "timeout"
	| "native_unavailable"
	| "internal_error";

export type Gate0AncestryKind = "persistent_child" | "outer_owner";
export type { Gate0LifecycleMarker };

export interface Gate0NativeController {
	gate0PermissionStatus(): { accessibility: boolean; screenRecording: boolean };
	gate0RequestScreenRecording(): boolean;
	gate0HarmlessProbe(): { screenshot: boolean; accessibility: boolean; pointerMoveRestore: boolean };
}

/** The sole redacted schema emitted by the hidden Gate-0 dispatcher. */
export interface Gate0Result {
	topology: "gate0";
	phase: "probe" | "A1" | "A2";
	permission: { accessibility: boolean; screenRecording: boolean };
	requestAttempted: boolean;
	success: boolean;
	code: Gate0Code;
	ancestry: { kind: Gate0AncestryKind; bounded: true };
	lifecycle: Gate0LifecycleMarker[];
}

interface Gate0PersistentChild {
	stdin: { write(value: string): void; flush(): Promise<void>; end(): Promise<void> };
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

export interface Gate0Dependencies {
	controllerFactory?: () => Gate0NativeController;
	timeoutMs?: number;
	tmuxCommand?: string;
	lifecycleRunner?: typeof runGate0TmuxLifecycle;
	/** Internal test seam for the experiment-owned A1 child. */
	persistentChildSpawner?: (options: { nonce: string }) => Gate0PersistentChild;
	/** Test seam; A1 is supported only by packaged release artifacts. */
	isCompiledBinary?: () => boolean;
	/** Test seam for a single lifecycle deadline. */
	now?: () => number;
}

type Gate0Input = { operation: "probe"; request?: boolean } | { operation: "lifecycle"; phase: "A1" | "A2" };

interface PersistentInput {
	operation: "persistent-child";
	phase: "A1";
	nonce: string;
}

const GATE0_CODES = new Set<Gate0Code>([
	"ok",
	"invalid_input",
	"permission_denied",
	"permission_pending",
	"probe_failed",
	"timeout",
	"native_unavailable",
	"internal_error",
]);
const PERSISTENT_PROBE_CODES = new Set<Gate0Code>(["ok", "permission_denied", "probe_failed", "internal_error"]);
const GATE0_MARKERS = new Set<Gate0LifecycleMarker>([
	"preflight",
	"tmux_created",
	"attached",
	"detached",
	"reattached",
	"cleaned",
]);

function nativeController(): Gate0NativeController {
	return new ComputerController() as Gate0NativeController;
}

function result(
	phase: Gate0Result["phase"],
	permission: Gate0Result["permission"],
	ancestry: Gate0AncestryKind,
	overrides: Partial<Omit<Gate0Result, "topology" | "phase" | "permission" | "ancestry">> = {},
): Gate0Result {
	return {
		topology: "gate0",
		phase,
		permission: { accessibility: permission.accessibility, screenRecording: permission.screenRecording },
		requestAttempted: overrides.requestAttempted === true,
		success: overrides.success === true,
		code: overrides.code ?? "internal_error",
		ancestry: { kind: ancestry, bounded: true },
		lifecycle: overrides.lifecycle ? [...overrides.lifecycle] : [],
	};
}

/** Builds the exact redacted failure DTO for failures before dispatch can begin. */
export function gate0InternalErrorResult(
	phase: Gate0Result["phase"] = "probe",
	ancestry: Gate0AncestryKind = "outer_owner",
): Gate0Result {
	return result(phase, { accessibility: false, screenRecording: false }, ancestry, { code: "internal_error" });
}

function parseInput(input: string | undefined): Gate0Input | null {
	if (!input) return null;
	try {
		const value: unknown = JSON.parse(input);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (
			record.operation === "probe" &&
			(record.request === undefined || typeof record.request === "boolean") &&
			Object.keys(record).every(key => key === "operation" || key === "request")
		)
			return { operation: "probe", request: record.request === true };
		if (
			record.operation === "lifecycle" &&
			(record.phase === "A1" || record.phase === "A2") &&
			Object.keys(record).every(key => key === "operation" || key === "phase")
		)
			return { operation: "lifecycle", phase: record.phase };
	} catch {}
	return null;
}

function parsePersistentInput(input: string | undefined): PersistentInput | null {
	try {
		const value: unknown = input ? JSON.parse(input) : null;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		return record.operation === "persistent-child" &&
			record.phase === "A1" &&
			typeof record.nonce === "string" &&
			/^[a-f0-9]{32,64}$/.test(record.nonce) &&
			Object.keys(record).length === 3
			? { operation: "persistent-child", phase: "A1", nonce: record.nonce }
			: null;
	} catch {
		return null;
	}
}

function errorCode(error: unknown): Gate0Code {
	const message = error instanceof Error ? error.message : "";
	if (message === "GATE0_TIMEOUT" || message === "GATE0_OPERATION_TIMEOUT") return "timeout";
	if (message === "GATE0_PERMISSION_PENDING") return "permission_pending";
	if (message === "GATE0_PERMISSION_DENIED") return "permission_denied";
	if (message === "COMPUTER_NATIVE_UNAVAILABLE" || message === "COMPUTER_NATIVE_UNSUPPORTED")
		return "native_unavailable";
	return "internal_error";
}

function permissionStatus(controller: Gate0NativeController): Gate0Result["permission"] {
	const status = controller.gate0PermissionStatus();
	if (typeof status.accessibility !== "boolean" || typeof status.screenRecording !== "boolean")
		throw new Error("GATE0_PERMISSION_STATUS_FAILURE");
	return { accessibility: status.accessibility, screenRecording: status.screenRecording };
}

async function probe(
	controller: Gate0NativeController,
	phase: Gate0Result["phase"],
	ancestry: Gate0AncestryKind,
	request: boolean,
): Promise<Gate0Result> {
	let permission: Gate0Result["permission"] = { accessibility: false, screenRecording: false };
	let requestAttempted = false;
	try {
		permission = permissionStatus(controller);
		if (request && !permission.screenRecording) {
			requestAttempted = true;
			controller.gate0RequestScreenRecording();
			permission = permissionStatus(controller);
		}
		const probeResult = controller.gate0HarmlessProbe();
		permission = permissionStatus(controller);
		const harmless =
			probeResult.screenshot === true &&
			probeResult.accessibility === true &&
			probeResult.pointerMoveRestore === true;
		const success = harmless && permission.accessibility && permission.screenRecording;
		const code: Gate0Code = success
			? "ok"
			: requestAttempted && !permission.screenRecording
				? "permission_pending"
				: !permission.screenRecording || !permission.accessibility
					? "permission_denied"
					: "probe_failed";
		return result(phase, permission, ancestry, { success, code, requestAttempted });
	} catch (error) {
		return result(phase, permission, ancestry, { code: errorCode(error), requestAttempted });
	}
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).length === keys.length && keys.every(key => key in record);
}

function gate0Result(value: unknown): Gate0Result | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!exactKeys(record, [
			"topology",
			"phase",
			"permission",
			"requestAttempted",
			"success",
			"code",
			"ancestry",
			"lifecycle",
		])
	)
		return null;
	const permission = record.permission;
	const ancestry = record.ancestry;
	if (
		record.topology !== "gate0" ||
		(record.phase !== "probe" && record.phase !== "A1" && record.phase !== "A2") ||
		!permission ||
		typeof permission !== "object" ||
		Array.isArray(permission) ||
		!exactKeys(permission as Record<string, unknown>, ["accessibility", "screenRecording"]) ||
		typeof (permission as Record<string, unknown>).accessibility !== "boolean" ||
		typeof (permission as Record<string, unknown>).screenRecording !== "boolean" ||
		typeof record.requestAttempted !== "boolean" ||
		typeof record.success !== "boolean" ||
		typeof record.code !== "string" ||
		!GATE0_CODES.has(record.code as Gate0Code) ||
		record.success !== (record.code === "ok") ||
		!ancestry ||
		typeof ancestry !== "object" ||
		Array.isArray(ancestry) ||
		!exactKeys(ancestry as Record<string, unknown>, ["kind", "bounded"]) ||
		((ancestry as Record<string, unknown>).kind !== "persistent_child" &&
			(ancestry as Record<string, unknown>).kind !== "outer_owner") ||
		(ancestry as Record<string, unknown>).bounded !== true ||
		(record.phase === "A1"
			? (ancestry as Record<string, unknown>).kind !== "persistent_child"
			: (ancestry as Record<string, unknown>).kind !== "outer_owner") ||
		!Array.isArray(record.lifecycle) ||
		!record.lifecycle.every(
			marker => typeof marker === "string" && GATE0_MARKERS.has(marker as Gate0LifecycleMarker),
		) ||
		(record.phase === "probe" &&
			(record.lifecycle.length !== 0 ||
				(record.requestAttempted &&
					record.code === "permission_pending" &&
					(permission as Record<string, unknown>).screenRecording === true))) ||
		(record.phase !== "probe" && record.requestAttempted) ||
		(record.code === "ok" &&
			(!(permission as Record<string, unknown>).accessibility ||
				!(permission as Record<string, unknown>).screenRecording)) ||
		(record.code === "permission_denied" &&
			(permission as Record<string, unknown>).accessibility === true &&
			(permission as Record<string, unknown>).screenRecording === true) ||
		(record.code === "permission_pending" &&
			(!record.requestAttempted || (permission as Record<string, unknown>).screenRecording !== false)) ||
		(record.success && record.phase !== "probe" && !completeLifecycle(record.lifecycle))
	)
		return null;
	return result(
		record.phase,
		{
			accessibility: (permission as Record<string, unknown>).accessibility as boolean,
			screenRecording: (permission as Record<string, unknown>).screenRecording as boolean,
		},
		(ancestry as Record<string, unknown>).kind as Gate0AncestryKind,
		{
			requestAttempted: record.requestAttempted,
			success: record.success,
			code: record.code as Gate0Code,
			lifecycle: record.lifecycle as Gate0LifecycleMarker[],
		},
	);
}

export function isGate0Result(value: unknown): value is Gate0Result {
	return gate0Result(value) !== null;
}

function gate0Wait<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void | Promise<void>): Promise<T> {
	const deferred = Promise.withResolvers<T>();
	let settled = false;
	const timer = setTimeout(
		async () => {
			if (settled) return;
			settled = true;
			try {
				await onTimeout();
				deferred.reject(new Error("GATE0_TIMEOUT"));
			} catch {
				deferred.reject(new Error("GATE0_CLEANUP_FAILURE"));
			}
		},
		Math.min(Math.max(timeoutMs, 1), GATE0_LIFECYCLE_TIMEOUT_MS),
	);
	void promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			deferred.resolve(value);
		},
		error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			deferred.reject(error);
		},
	);
	return deferred.promise;
}

function lifecycleTimeoutMs(dependencies: Gate0Dependencies): number {
	return Math.min(Math.max(dependencies.timeoutMs ?? GATE0_INTERNAL_TIMEOUT_MS, 1), GATE0_INTERNAL_TIMEOUT_MS);
}

function cleanupReserveMs(timeoutMs: number): number {
	return Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 3)), Math.max(0, timeoutMs - 1));
}

function cleanupSignalReserveMs(timeoutMs: number): number {
	const reserve = cleanupReserveMs(timeoutMs);
	return Math.min(reserve, Math.max(1, Math.floor(reserve / 2)));
}

function remainingMs(deadline: number, now: () => number): number {
	return Math.max(0, deadline - now());
}

function waitUntil<T>(
	promise: Promise<T>,
	deadline: number,
	now: () => number,
	onTimeout: () => void | Promise<void>,
): Promise<T> {
	const timeoutMs = remainingMs(deadline, now);
	if (timeoutMs <= 0) {
		return Promise.resolve(onTimeout()).then(
			() => Promise.reject(new Error("GATE0_TIMEOUT")),
			() => Promise.reject(new Error("GATE0_CLEANUP_FAILURE")),
		);
	}
	return gate0Wait(promise, timeoutMs, onTimeout);
}

function completeLifecycle(markers: unknown): markers is Gate0LifecycleMarker[] {
	const expected: Gate0LifecycleMarker[] = [
		"preflight",
		"tmux_created",
		"attached",
		"detached",
		"reattached",
		"cleaned",
	];
	return (
		Array.isArray(markers) &&
		markers.length === expected.length &&
		markers.every((marker, index) => marker === expected[index])
	);
}

function persistentProbeResult(value: unknown): Gate0Result | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const permission = record.permission;
	const ancestry = record.ancestry;
	if (
		!exactKeys(record, [
			"topology",
			"phase",
			"permission",
			"requestAttempted",
			"success",
			"code",
			"ancestry",
			"lifecycle",
		]) ||
		record.topology !== "gate0" ||
		record.phase !== "A1" ||
		!permission ||
		typeof permission !== "object" ||
		Array.isArray(permission) ||
		!exactKeys(permission as Record<string, unknown>, ["accessibility", "screenRecording"]) ||
		typeof (permission as Record<string, unknown>).accessibility !== "boolean" ||
		typeof (permission as Record<string, unknown>).screenRecording !== "boolean" ||
		!ancestry ||
		typeof ancestry !== "object" ||
		Array.isArray(ancestry) ||
		!exactKeys(ancestry as Record<string, unknown>, ["kind", "bounded"]) ||
		(ancestry as Record<string, unknown>).kind !== "persistent_child" ||
		(ancestry as Record<string, unknown>).bounded !== true ||
		record.requestAttempted !== false ||
		typeof record.success !== "boolean" ||
		!PERSISTENT_PROBE_CODES.has(record.code as Gate0Code) ||
		record.success !== (record.code === "ok") ||
		!Array.isArray(record.lifecycle) ||
		record.lifecycle.length !== 0 ||
		(record.code === "ok" &&
			(!(permission as Record<string, unknown>).accessibility ||
				!(permission as Record<string, unknown>).screenRecording)) ||
		(record.code === "permission_denied" &&
			(permission as Record<string, unknown>).accessibility === true &&
			(permission as Record<string, unknown>).screenRecording === true)
	)
		return null;
	return result(
		"A1",
		{
			accessibility: (permission as Record<string, unknown>).accessibility as boolean,
			screenRecording: (permission as Record<string, unknown>).screenRecording as boolean,
		},
		"persistent_child",
		{ success: record.success, code: record.code as Gate0Code },
	);
}

async function runLifecycle(
	phase: "A1" | "A2",
	dependencies: Gate0Dependencies,
	abort: AbortController,
	operationDeadline: number,
	totalDeadline: number,
): Promise<Gate0LifecycleMarker[]> {
	const now = dependencies.now ?? Date.now;
	const timeoutMs = remainingMs(operationDeadline, now);
	if (timeoutMs <= 0) {
		abort.abort();
		throw new Error("GATE0_TIMEOUT");
	}
	const lifecycle = (dependencies.lifecycleRunner ?? runGate0TmuxLifecycle)({
		phase,
		tmuxCommand: dependencies.tmuxCommand ?? resolveGjcTmuxBinary({ env: process.env }).command,
		timeoutMs,
		signal: abort.signal,
	});
	let timedOut = false;
	const abortTimer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, timeoutMs);
	try {
		const markers = await waitUntil(lifecycle, totalDeadline, now, () => abort.abort());
		if (timedOut) throw new Error("GATE0_OPERATION_TIMEOUT");
		if (!completeLifecycle(markers)) throw new Error("GATE0_LIFECYCLE_FAILURE");
		return markers;
	} catch (error) {
		if (error instanceof Error && error.message === "GATE0_TIMEOUT") {
			if (remainingMs(totalDeadline, now) <= 0) throw new Error("GATE0_CLEANUP_FAILURE");
			throw new Error("GATE0_OPERATION_TIMEOUT");
		}
		throw error;
	} finally {
		clearTimeout(abortTimer);
	}
}

interface Gate0Reader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

interface PersistentFrame {
	nonce: string;
	sequence: "preflight" | "postflight";
	result: Gate0Result;
}

const GATE0_FRAME_MAX_BYTES = 4_096;

async function readPersistentFrame(
	reader: Gate0Reader,
	buffer: { value: string },
	nonce: string,
	sequence: PersistentFrame["sequence"],
): Promise<Gate0Result> {
	for (;;) {
		const newline = buffer.value.indexOf("\n");
		if (newline !== -1) {
			const line = buffer.value.slice(0, newline);
			if (new TextEncoder().encode(line).byteLength > GATE0_FRAME_MAX_BYTES)
				throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
			buffer.value = buffer.value.slice(newline + 1);
			try {
				const frame: unknown = JSON.parse(line);
				if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
				const record = frame as Record<string, unknown>;
				const parsed = persistentProbeResult(record.result);
				if (
					!exactKeys(record, ["nonce", "sequence", "result"]) ||
					record.nonce !== nonce ||
					record.sequence !== sequence ||
					!parsed
				)
					throw new Error();
				return parsed;
			} catch {
				throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
			}
		}
		if (new TextEncoder().encode(buffer.value).byteLength > GATE0_FRAME_MAX_BYTES)
			throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
		const next = await reader.read();
		if (next.done || !next.value) throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
		buffer.value += new TextDecoder().decode(next.value, { stream: true });
	}
}

function lifecycleResult(
	phase: "A1" | "A2",
	ancestry: Gate0AncestryKind,
	snapshot: Gate0Result,
	lifecycle: Gate0LifecycleMarker[],
): Gate0Result {
	return result(phase, snapshot.permission, ancestry, {
		success: snapshot.success,
		code: snapshot.code,
		lifecycle,
	});
}

async function runA1PersistentLifecycle(dependencies: Gate0Dependencies): Promise<Gate0Result> {
	const abort = new AbortController();
	const now = dependencies.now ?? Date.now;
	const timeoutMs = lifecycleTimeoutMs(dependencies);
	const totalDeadline = now() + timeoutMs;
	const operationDeadline = totalDeadline - cleanupReserveMs(timeoutMs);
	const signalReserveMs = cleanupSignalReserveMs(timeoutMs);
	const gracefulCleanupDeadline = totalDeadline - signalReserveMs;
	const termDeadline = totalDeadline - Math.floor(signalReserveMs / 2);
	let child: Gate0PersistentChild | undefined;
	let writer: Gate0PersistentChild["stdin"] | undefined;
	let reader: Gate0Reader | undefined;
	let exited = false;
	let cleanupFailed = false;
	let output = result("A1", { accessibility: false, screenRecording: false }, "persistent_child");
	let writerEnd: Promise<void> | undefined;
	const closeWriter = (): Promise<void> => {
		if (!writer) return Promise.resolve();
		writerEnd ??= Promise.resolve().then(() => writer!.end());
		return writerEnd;
	};
	const awaitExit = async (deadline: number): Promise<boolean> => {
		if (!child) return true;
		try {
			await waitUntil(child.exited, deadline, now, () => abort.abort());
			exited = true;
			return true;
		} catch {
			return false;
		}
	};
	const cleanupChild = async (): Promise<boolean> => {
		abort.abort();
		if (!child || exited) return true;
		try {
			await waitUntil(closeWriter(), gracefulCleanupDeadline, now, () => {});
		} catch {}
		if (exited) return true;
		try {
			child.kill("SIGTERM");
		} catch {}
		if (await awaitExit(termDeadline)) return true;
		try {
			child.kill("SIGKILL");
		} catch {}
		return awaitExit(totalDeadline);
	};
	const cleanupOnTimeout = async (): Promise<void> => {
		if (!(await cleanupChild())) throw new Error("GATE0_CLEANUP_FAILURE");
	};
	try {
		if (!(dependencies.isCompiledBinary ?? isCompiledBinary)())
			return result("A1", { accessibility: false, screenRecording: false }, "persistent_child", {
				code: "native_unavailable",
			});
		const nonce = crypto.randomBytes(24).toString("hex");
		child =
			dependencies.persistentChildSpawner?.({ nonce }) ??
			(Bun.spawn([process.execPath, "--internal-computer-gate0"], {
				env: {
					...process.env,
					[GATE0_PERSISTENT_CHILD_ENV]: "1",
					[GATE0_INPUT_ENV]: JSON.stringify({ operation: "persistent-child", phase: "A1", nonce }),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
			}) as unknown as Gate0PersistentChild);
		writer = child.stdin;
		void child.exited.then(
			() => {
				exited = true;
			},
			() => {},
		);
		reader = child.stdout.getReader();
		const buffer = { value: "" };
		const send = async (sequence: PersistentFrame["sequence"], deadline: number) => {
			if (!writer || !reader) throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
			writer.write(`${JSON.stringify({ nonce, sequence })}\n`);
			await waitUntil(Promise.resolve(writer.flush()), deadline, now, cleanupOnTimeout);
			return waitUntil(readPersistentFrame(reader, buffer, nonce, sequence), deadline, now, cleanupOnTimeout);
		};
		const preflight = await send("preflight", operationDeadline);
		const markers = await runLifecycle("A1", dependencies, abort, operationDeadline, totalDeadline);
		const postflight = await send("postflight", operationDeadline);
		await waitUntil(closeWriter(), operationDeadline, now, cleanupOnTimeout);
		if ((await waitUntil(child.exited, operationDeadline, now, cleanupOnTimeout)) !== 0)
			throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
		exited = true;
		output = lifecycleResult("A1", "persistent_child", preflight.success ? postflight : preflight, markers);
	} catch (error) {
		output = result("A1", { accessibility: false, screenRecording: false }, "persistent_child", {
			code: errorCode(error),
		});
	} finally {
		if (!(await cleanupChild())) cleanupFailed = true;
	}
	return cleanupFailed
		? result("A1", { accessibility: false, screenRecording: false }, "persistent_child", { code: "internal_error" })
		: output;
}

export async function runComputerBrokerGate0(
	inputJson: string | undefined,
	dependencies: Gate0Dependencies = {},
): Promise<Gate0Result> {
	const input = parseInput(inputJson);
	if (!input)
		return result("probe", { accessibility: false, screenRecording: false }, "outer_owner", {
			code: "invalid_input",
		});
	if (input.operation === "lifecycle" && input.phase === "A1") return runA1PersistentLifecycle(dependencies);

	if (input.operation === "lifecycle") {
		const now = dependencies.now ?? Date.now;
		const timeoutMs = lifecycleTimeoutMs(dependencies);
		const totalDeadline = now() + timeoutMs;
		const operationDeadline = totalDeadline - cleanupReserveMs(timeoutMs);
		let controller: Gate0NativeController;
		try {
			controller = (dependencies.controllerFactory ?? nativeController)();
		} catch (error) {
			return result("A2", { accessibility: false, screenRecording: false }, "outer_owner", {
				code: remainingMs(totalDeadline, now) <= 0 ? "timeout" : errorCode(error),
			});
		}
		if (remainingMs(operationDeadline, now) <= 0)
			return result("A2", { accessibility: false, screenRecording: false }, "outer_owner", { code: "timeout" });
		const preflight = await probe(controller, "A2", "outer_owner", false);
		const abort = new AbortController();
		try {
			const markers = await runLifecycle("A2", dependencies, abort, operationDeadline, totalDeadline);
			if (remainingMs(totalDeadline, now) <= 0) throw new Error("GATE0_TIMEOUT");
			const postflight = await probe(controller, "A2", "outer_owner", false);
			if (remainingMs(totalDeadline, now) <= 0) throw new Error("GATE0_TIMEOUT");
			return lifecycleResult("A2", "outer_owner", preflight.success ? postflight : preflight, markers);
		} catch (error) {
			return result("A2", preflight.permission, "outer_owner", { code: errorCode(error) });
		} finally {
			abort.abort();
		}
	}
	let controller: Gate0NativeController;
	try {
		controller = (dependencies.controllerFactory ?? nativeController)();
	} catch (error) {
		return result("probe", { accessibility: false, screenRecording: false }, "outer_owner", {
			code: errorCode(error),
		});
	}
	return probe(controller, "probe", "outer_owner", input.request === true);
}

async function runPersistentChild(inputJson: string | undefined): Promise<void> {
	const input = parsePersistentInput(inputJson);
	if (!input) {
		process.exitCode = 1;
		return;
	}
	let controller: Gate0NativeController;
	try {
		controller = nativeController();
	} catch {
		process.exitCode = 1;
		return;
	}
	const deadline = setTimeout(() => process.exit(1), GATE0_INTERNAL_TIMEOUT_MS);
	let buffer = "";
	let expected: PersistentFrame["sequence"] = "preflight";
	let count = 0;
	try {
		for await (const chunk of process.stdin) {
			buffer += chunk.toString();
			if (Buffer.byteLength(buffer, "utf8") > GATE0_FRAME_MAX_BYTES)
				throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				if (Buffer.byteLength(line, "utf8") > GATE0_FRAME_MAX_BYTES)
					throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
				buffer = buffer.slice(newline + 1);
				const command: unknown = JSON.parse(line);
				if (!command || typeof command !== "object" || Array.isArray(command))
					throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
				const record = command as Record<string, unknown>;
				if (
					!exactKeys(record, ["nonce", "sequence"]) ||
					record.nonce !== input.nonce ||
					record.sequence !== expected ||
					count >= 2
				)
					throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
				const output = await probe(controller, "A1", "persistent_child", false);
				process.stdout.write(`${JSON.stringify({ nonce: input.nonce, sequence: expected, result: output })}\n`);
				count++;
				if (count < 2) expected = "postflight";
			}
		}
		if (count === 2 && buffer.length === 0) return;
		throw new Error("GATE0_PERSISTENT_CHILD_FAILURE");
	} catch {
		process.exitCode = 1;
	} finally {
		clearTimeout(deadline);
	}
}

export async function runComputerBrokerGate0FromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	dependencies?: Gate0Dependencies,
): Promise<void> {
	if (env[GATE0_PERSISTENT_CHILD_ENV] === "1") return runPersistentChild(env[GATE0_INPUT_ENV]);
	const output = await runComputerBrokerGate0(env[GATE0_INPUT_ENV], dependencies);
	process.stdout.write(`${JSON.stringify(output)}\n`);
}
