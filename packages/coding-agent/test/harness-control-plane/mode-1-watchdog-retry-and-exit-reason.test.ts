import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Harness from "../../src/commands/harness";
import * as ownerModule from "../../src/harness-control-plane/owner";
import * as sdkTransport from "../../src/harness-control-plane/sdk-transport";
import type { HarnessSessionTransport, SessionStateSnapshot } from "../../src/harness-control-plane/session-transport";
import {
	generateSessionId,
	readSessionState,
	sessionPaths,
	writeSessionState,
} from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";

type JsonRecord = Record<string, unknown>;
type SignalName = "SIGTERM" | "SIGINT";

interface RestorableMock {
	mockRestore(): void;
}

interface OwnerCommandRun {
	promise: Promise<void>;
	settled: boolean;
	outputStart: number;
	listenersBefore: Record<SignalName, readonly unknown[]>;
}

interface RunningOwner {
	command: OwnerCommandRun;
	initialResponse: JsonRecord;
	pollCount(): number;
	injectedFailureCount(): number;
	consumedFaultCount(): number;
	restoreResolver(): void;
}

class FakeTransport implements HarnessSessionTransport {
	#cursor = 0;

	async getState(): Promise<SessionStateSnapshot> {
		return { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	}

	async sendPrompt(): Promise<{ commandId: string; ack: boolean }> {
		this.#cursor += 1;
		return { commandId: "watchdog-test-command", ack: true };
	}

	eventCursor(): number {
		return this.#cursor;
	}

	async waitForAgentStart(afterCursor: number, _timeoutMs: number): Promise<{ cursor: number } | null> {
		return { cursor: afterCursor + 1 };
	}

	async close(): Promise<void> {}
}

let root = "";
let workspace = "";
let sessionId = "";
let originalStateRoot: string | undefined;
let originalExitCode: typeof process.exitCode;
let outputChunks: string[] = [];
let activeOwnerCommand: OwnerCommandRun | null = null;
let leaseBeforeCorruption: string | undefined;
const activeMocks: RestorableMock[] = [];

function trackMock<T extends RestorableMock>(mock: T): T {
	activeMocks.push(mock);
	return mock;
}

function restoreMock(mock: RestorableMock): void {
	const index = activeMocks.indexOf(mock);
	if (index === -1) return;
	activeMocks.splice(index, 1);
	mock.mockRestore();
}

function restoreAllMocks(): void {
	for (const mock of activeMocks.splice(0).reverse()) mock.mockRestore();
}

function asRecord(value: unknown): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected_json_object");
	return value as JsonRecord;
}

function parseJsonChunk(chunk: string): JsonRecord {
	return asRecord(JSON.parse(chunk));
}

function recordProperty(value: JsonRecord, key: string): JsonRecord {
	return asRecord(value[key]);
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 12_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed_out_waiting_for_${description}`);
		await Bun.sleep(20);
	}
}

function gitInit(dir: string): void {
	const run = (args: string[]): void => {
		const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	};
	run(["init", "--quiet"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "Watchdog regression test"]);
	run(["commit", "--allow-empty", "-m", "fixture", "--quiet"]);
}

function seedState(stateRoot: string, id: string, repo: string): SessionState {
	const now = new Date().toISOString();
	const paths = sessionPaths(stateRoot, id);
	const handle: SessionHandle = {
		sessionId: id,
		harness: "gajae-code",
		mode: "implement",
		repo: null,
		workspace: repo,
		branch: "main",
		base: null,
		issueOrPr: null,
		processHandle: { kind: "runtime-owner", ownerId: null, pid: null },
		sdkHandle: { kind: "sdk-session-endpoint", sessionId: id },
		ownerHandle: { leasePath: paths.lease, endpoint: null, heartbeatAt: null },
		routerHandle: { kind: "default-in-owner", policy: "default-fallback", eventsPath: paths.events },
		viewportHandle: { kind: "event-monitor", tmuxSessionName: null, viewOnly: true },
		startedAt: now,
		updatedAt: now,
	};
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: id,
		lifecycle: "started",
		harness: "gajae-code",
		handle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

function launchOwnerCommand(args: string[]): OwnerCommandRun {
	const command: OwnerCommandRun = {
		promise: Promise.resolve(),
		settled: false,
		outputStart: outputChunks.length,
		listenersBefore: {
			SIGTERM: process.listeners("SIGTERM"),
			SIGINT: process.listeners("SIGINT"),
		},
	};
	command.promise = new Harness(args, { bin: "gjc", version: "test", commands: new Map() }).run();
	void command.promise.then(
		() => {
			command.settled = true;
		},
		() => {
			command.settled = true;
		},
	);
	activeOwnerCommand = command;
	return command;
}

async function startOwner(failureSequence: readonly boolean[]): Promise<RunningOwner> {
	const originalResolveOwner = ownerModule.resolveOwner;
	let armed = false;
	let polls = 0;
	let injectedFailures = 0;
	let consumedFaults = 0;
	let resolverRestored = false;
	const resolverSpy = trackMock(
		vi.spyOn(ownerModule, "resolveOwner").mockImplementation(async (requestedRoot, requestedSessionId) => {
			if (armed && requestedRoot === root && requestedSessionId === sessionId) {
				polls += 1;
				if (consumedFaults < failureSequence.length) {
					const shouldReject = failureSequence[consumedFaults];
					consumedFaults += 1;
					if (shouldReject) {
						injectedFailures += 1;
						throw new Error(`watchdog lease read failure ${injectedFailures}`);
					}
				}
			}
			return originalResolveOwner(requestedRoot, requestedSessionId);
		}),
	);
	const transportSpy = trackMock(
		vi.spyOn(sdkTransport, "createSdkSessionTransport").mockImplementation(async () => new FakeTransport()),
	);
	const command = launchOwnerCommand(["__owner", "--session", sessionId]);
	await waitUntil(() => outputChunks.length > command.outputStart, "owner start response");
	const initialResponse = parseJsonChunk(outputChunks[command.outputStart]);
	expect(initialResponse.ok).toBe(true);
	restoreMock(transportSpy);
	armed = true;

	return {
		command,
		initialResponse,
		pollCount: () => polls,
		injectedFailureCount: () => injectedFailures,
		consumedFaultCount: () => consumedFaults,
		restoreResolver() {
			if (resolverRestored) return;
			resolverRestored = true;
			restoreMock(resolverSpy);
		},
	};
}

async function runHarnessCommand(args: string[]): Promise<JsonRecord> {
	const firstOutput = outputChunks.length;
	await new Harness(args, { bin: "gjc", version: "test", commands: new Map() }).run();
	const writes = outputChunks.slice(firstOutput);
	expect(writes).toHaveLength(1);
	const output = writes[0];
	if (output === undefined) throw new Error("harness_command_did_not_write_json");
	return parseJsonChunk(output);
}

function ownsSignalListener(command: OwnerCommandRun, signal: SignalName): boolean {
	return process.listeners(signal).some(listener => !command.listenersBefore[signal].includes(listener));
}

function emitOwnerSignal(command: OwnerCommandRun, signal: SignalName): void {
	if (!ownsSignalListener(command, signal)) throw new Error(`owner_has_no_owned_${signal}_listener`);
	// Dispatch the Node signal argument to this owner's registered listeners only.
	// Importing the CLI also registers application-wide exit handlers; invoking
	// those would terminate the test runner rather than exercise the owner.
	for (const listener of process.listeners(signal)) {
		if (!command.listenersBefore[signal].includes(listener)) listener(signal);
	}
}

async function stopOwner(owner: RunningOwner, signal: SignalName): Promise<void> {
	emitOwnerSignal(owner.command, signal);
	await waitUntil(() => owner.command.settled, `owner ${signal} shutdown`);
	await owner.command.promise;
}

function installCallerReadFailure(): RestorableMock {
	const originalResolveOwner = ownerModule.resolveOwner;
	return trackMock(
		vi.spyOn(ownerModule, "resolveOwner").mockImplementation(async (requestedRoot, requestedSessionId) => {
			if (requestedRoot === root && requestedSessionId === sessionId) {
				throw new Error("caller-side owner lease read failed");
			}
			return originalResolveOwner(requestedRoot, requestedSessionId);
		}),
	);
}

function expectNoOwnerExitBlocker(response: JsonRecord): void {
	const state = recordProperty(response, "state");
	const blockers = state.blockers;
	if (!Array.isArray(blockers)) throw new Error("expected_state_blocker_array");
	const ownerExitBlockers = blockers.filter(
		(blocker): blocker is string => typeof blocker === "string" && blocker.startsWith("owner-exit:"),
	);
	expect(ownerExitBlockers).toEqual([]);
}

function expectLeaseReadFailure(response: JsonRecord): void {
	const evidence = recordProperty(response, "evidence");
	expect(evidence.reason).toBe("owner-lease-read-failed");
	expect(recordProperty(evidence, "ownerExit").reason).toBe("owner-lease-read-failed");
	expectNoOwnerExitBlocker(response);
}

function expectNoStaleLeaseReadFailure(response: JsonRecord): void {
	const evidence = recordProperty(response, "evidence");
	expect(evidence.reason).not.toBe("owner-lease-read-failed");
	expect(recordProperty(evidence, "ownerExit").reason).not.toBe("owner-lease-read-failed");
	expectNoOwnerExitBlocker(response);
}

beforeEach(async () => {
	originalStateRoot = process.env.GJC_HARNESS_STATE_ROOT;
	originalExitCode = process.exitCode;
	process.exitCode = 0;
	root = await mkdtemp(path.join(tmpdir(), "gjc-owner-watchdog-regression-"));
	workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	gitInit(workspace);
	sessionId = generateSessionId("watchdog");
	process.env.GJC_HARNESS_STATE_ROOT = root;
	await writeSessionState(root, seedState(root, sessionId, workspace));
	outputChunks = [];
	activeOwnerCommand = null;
	leaseBeforeCorruption = undefined;
	const stdoutSpy = trackMock(vi.spyOn(process.stdout, "write"));
	stdoutSpy.mockImplementation(((chunk: string | Uint8Array) => {
		outputChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write);
});

afterEach(async () => {
	try {
		if (leaseBeforeCorruption !== undefined) {
			await Bun.write(sessionPaths(root, sessionId).lease, leaseBeforeCorruption);
		}
		const command = activeOwnerCommand;
		if (command && !command.settled && ownsSignalListener(command, "SIGTERM")) {
			emitOwnerSignal(command, "SIGTERM");
			await waitUntil(() => command.settled, "active owner cleanup");
			await command.promise;
		}
	} finally {
		restoreAllMocks();
		if (originalStateRoot === undefined) delete process.env.GJC_HARNESS_STATE_ROOT;
		else process.env.GJC_HARNESS_STATE_ROOT = originalStateRoot;
		process.exitCode = originalExitCode ?? 0;
		if (root) await rm(root, { recursive: true, force: true });
		activeOwnerCommand = null;
	}
});

describe("Harness owner watchdog retries and generation-scoped exit evidence", () => {
	it("keeps the owner running after transient lease-read failures and resets the consecutive-failure count", async () => {
		const owner = await startOwner([true, true, false, true, true]);
		await waitUntil(() => owner.consumedFaultCount() === 5, "five watchdog polls");

		expect(owner.pollCount()).toBe(5);
		expect(owner.injectedFailureCount()).toBe(4);
		expect(owner.command.settled).toBe(false);
		const liveOwner = await ownerModule.resolveOwner(root, sessionId);
		expect(liveOwner.live).toBe(true);
		expect(liveOwner.socketPath).toBeTruthy();

		owner.restoreResolver();
		await stopOwner(owner, "SIGTERM");
		const stoppedOwner = await ownerModule.resolveOwner(root, sessionId);
		expect(stoppedOwner.live).toBe(false);
	}, 20_000);

	it("stops after three consecutive lease-read failures and reports durable typed evidence to submit and finalize", async () => {
		const owner = await startOwner([true, true, true]);
		await waitUntil(() => owner.consumedFaultCount() === 3, "three consecutive watchdog failures");
		await waitUntil(() => owner.command.settled, "watchdog owner shutdown");
		expect(owner.injectedFailureCount()).toBe(3);
		await owner.command.promise;
		owner.restoreResolver();

		const callerReadFailure = installCallerReadFailure();
		try {
			const submit = await runHarnessCommand([
				"submit",
				"--session",
				sessionId,
				"--input",
				JSON.stringify({ prompt: "exercise durable owner exit evidence" }),
			]);
			expect(submit.ok).toBe(false);
			expectLeaseReadFailure(submit);

			const finalize = await runHarnessCommand(["finalize", "--session", sessionId, "--input", "{}"]);
			expect(finalize.ok).toBe(false);
			expectLeaseReadFailure(finalize);
		} finally {
			restoreMock(callerReadFailure);
		}
	}, 20_000);

	it("exits with an actually unreadable lease and exposes the watchdog reason through lifecycle gates", async () => {
		const owner = await startOwner([]);
		owner.restoreResolver();
		leaseBeforeCorruption = await Bun.file(sessionPaths(root, sessionId).lease).text();
		await Bun.write(sessionPaths(root, sessionId).lease, "{malformed lease");
		await waitUntil(() => owner.command.settled, "terminal unreadable lease shutdown", 5_000);
		await owner.command.promise;
		expect(outputChunks.slice(owner.command.outputStart)).toHaveLength(1);
		// An unreadable lease cannot safely be deleted: it may belong to a successor.
		expect(await Bun.file(sessionPaths(root, sessionId).lease).text()).toBe("{malformed lease");

		const submit = await runHarnessCommand(["submit", "--session", sessionId, "--input", '{"prompt":"retry"}']);
		expectLeaseReadFailure(submit);
		expect(recordProperty(recordProperty(submit, "evidence"), "ownerExit").leaseStatus).toBe("unreadable");
		const finalize = await runHarnessCommand(["finalize", "--session", sessionId]);
		expectLeaseReadFailure(finalize);

		const state = await readSessionState(root, sessionId);
		if (!state) throw new Error("missing_test_state");
		state.lifecycle = "finalizing";
		state.blockers = [];
		await writeSessionState(root, state);
		const gated = await runHarnessCommand(["submit", "--session", sessionId, "--input", '{"prompt":"retry"}']);
		expectLeaseReadFailure(gated);
		expect(recordProperty(gated, "evidence").lifecycleGate).toBe("lifecycle-not-idle:finalizing");
		expect(recordProperty(gated, "state").lifecycle).toBe("finalizing");
	}, 15_000);

	it("does not apply a prior generation's watchdog error to a fresh SIGTERM-stopped owner", async () => {
		const failedGeneration = await startOwner([true, true, true]);
		await waitUntil(() => failedGeneration.consumedFaultCount() === 3, "first generation watchdog failures");
		await waitUntil(() => failedGeneration.command.settled, "first generation shutdown");
		await failedGeneration.command.promise;
		failedGeneration.restoreResolver();

		const freshGeneration = await startOwner([]);
		const failedOwnerInfo = recordProperty(failedGeneration.initialResponse, "owner");
		const freshOwnerInfo = recordProperty(freshGeneration.initialResponse, "owner");
		expect(freshOwnerInfo.ownerId).not.toBe(failedOwnerInfo.ownerId);
		await waitUntil(() => freshGeneration.pollCount() >= 1, "fresh generation watchdog poll");
		await stopOwner(freshGeneration, "SIGTERM");
		freshGeneration.restoreResolver();

		const afterSignal = await startOwner([]);
		afterSignal.restoreResolver();
		const submitted = await runHarnessCommand([
			"submit",
			"--session",
			sessionId,
			"--input",
			JSON.stringify({ prompt: "fresh owner after SIGTERM accepts normally" }),
		]);
		expect(submitted.ok).toBe(true);
		expect(recordProperty(submitted, "evidence").accepted).toBe(true);
		expectNoOwnerExitBlocker(submitted);
		await stopOwner(afterSignal, "SIGTERM");

		const submit = await runHarnessCommand([
			"submit",
			"--session",
			sessionId,
			"--input",
			JSON.stringify({ prompt: "confirm the previous generation error is not reused" }),
		]);
		expect(submit.ok).toBe(false);
		expectNoStaleLeaseReadFailure(submit);

		const finalize = await runHarnessCommand(["finalize", "--session", sessionId, "--input", "{}"]);
		expect(finalize.ok).toBe(false);
		expectNoStaleLeaseReadFailure(finalize);
	}, 25_000);

	it("treats SIGINT as a normal owner shutdown", async () => {
		const owner = await startOwner([]);
		await waitUntil(() => owner.pollCount() >= 1, "SIGINT owner watchdog poll");
		owner.restoreResolver();
		await stopOwner(owner, "SIGINT");

		const stoppedOwner = await ownerModule.resolveOwner(root, sessionId);
		expect(stoppedOwner.live).toBe(false);
	}, 15_000);
});
