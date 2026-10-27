import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { resolveSessionLocator, type SessionLocatorV2 } from "../src/sdk/broker/session-index";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
import { SdkClient, SdkClientError } from "../src/sdk/client";
import { sessionListPageFromResponse, traverseSessionList } from "../src/sdk/session-list";
import {
	cleanupFixtureRoot,
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	fixtureRootForTest,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cleanupRoots: FixtureRootCleanup[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const BROKER_SESSION_CLOSE_TIMEOUT_MS = 15_000;
const ACP_SESSION_CLOSE_TIMEOUT_MS = BROKER_SESSION_CLOSE_TIMEOUT_MS;
const FIXTURE_BROKER_STARTUP_TIMEOUT_MS = 35_000;
const SESSION_CREATE_RECONCILIATION_MS = lifecycleRequestTimeoutMs("session.create", {}) ?? 21_000;

function input(proc: AcpProc): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

function childEnv(root: string): Record<string, string> {
	const agentDir = path.join(root, "agent");
	const env: Record<string, string> = {
		...createFixtureBrokerEnvironment(root, agentDir),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_NOTIFICATIONS: "1",
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

function chatStream(chunks: Record<string, unknown>[]): Response {
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
	return {
		id: "chatcmpl-acp-deep-interview",
		object: "chat.completion.chunk",
		created: 0,
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

class FixtureSessionCloseTransportError extends Error {
	readonly cause: unknown;

	constructor(sessionId: string, cause: unknown) {
		super(`ACP connection became unavailable while closing fixture session ${sessionId}.`);
		this.cause = cause;
	}
}

class FixtureSessionCloseTimeoutError extends Error {
	constructor(sessionId: string) {
		super(`Timed out waiting for ACP session close ${sessionId}.`);
	}
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function aggregateFailures(message: string, failures: unknown[]): AggregateError {
	return new AggregateError(failures, `${message}: ${failures.map(failureMessage).join("; ")}`);
}

function isAcpCloseTimeout(error: unknown, seen = new Set<object>()): boolean {
	if (!error || typeof error !== "object") return false;
	if (seen.has(error)) return false;
	seen.add(error);
	const detail = error as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown; data?: unknown };
	if (detail.code === "timeout") return true;
	if (typeof detail.message === "string" && detail.message.includes("SDK request timed out after")) return true;
	return isAcpCloseTimeout(detail.cause, seen) || isAcpCloseTimeout(detail.data, seen);
}

function isAcpCloseUncertainAfterSend(error: unknown, seen = new Set<object>()): boolean {
	if (!error || typeof error !== "object") return false;
	if (seen.has(error)) return false;
	seen.add(error);
	const detail = error as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown; data?: unknown };
	if (
		typeof detail.message === "string" &&
		detail.message.includes("ACP session cleanup is uncertain") &&
		detail.message.includes("broker request failed")
	)
		return true;
	if (
		detail.code === "terminal_uncertain" &&
		typeof detail.details === "string" &&
		detail.details.includes("SDK request outcome is uncertain after the frame was sent")
	)
		return true;
	return isAcpCloseUncertainAfterSend(detail.cause, seen) || isAcpCloseUncertainAfterSend(detail.data, seen);
}

function classifyAcpCloseFailure(sessionId: string, error: unknown, connectionAborted: boolean): unknown {
	if (connectionAborted) return new FixtureSessionCloseTransportError(sessionId, error);
	if (isAcpCloseTimeout(error)) return new FixtureSessionCloseTimeoutError(sessionId);
	if (isAcpCloseUncertainAfterSend(error)) return new FixtureSessionCloseTransportError(sessionId, error);
	return error;
}

function isVerifiedBrokerStartupFailure(error: unknown): boolean {
	return !(
		error instanceof AggregateError &&
		error.message === "SDK broker discovery and spawned broker cleanup both failed."
	);
}

async function retireOwnedSessions(
	sessionIds: Set<string>,
	closeAcp: (sessionId: string) => Promise<unknown>,
	closeBroker: (sessionId: string) => Promise<unknown>,
	acpTimeoutMs = ACP_SESSION_CLOSE_TIMEOUT_MS,
	brokerTimeoutMs = BROKER_SESSION_CLOSE_TIMEOUT_MS,
): Promise<void> {
	const failures: unknown[] = [];
	for (const sessionId of [...sessionIds].reverse()) {
		try {
			const { promise: timeout, reject } = Promise.withResolvers<never>();
			const timer = setTimeout(() => reject(new FixtureSessionCloseTimeoutError(sessionId)), acpTimeoutMs);
			try {
				await Promise.race([closeAcp(sessionId), timeout]);
				sessionIds.delete(sessionId);
			} finally {
				clearTimeout(timer);
			}
		} catch (acpError) {
			if (
				!(acpError instanceof FixtureSessionCloseTransportError) &&
				!(acpError instanceof FixtureSessionCloseTimeoutError)
			) {
				failures.push(acpError);
				continue;
			}
			try {
				await bounded(closeBroker(sessionId), `broker session close ${sessionId}`, brokerTimeoutMs);
				sessionIds.delete(sessionId);
			} catch (brokerError) {
				failures.push(aggregateFailures(`Unable to retire ACP session ${sessionId}`, [acpError, brokerError]));
			}
		}
	}
	if (failures.length > 0) throw aggregateFailures("ACP fixture session retirement failed", failures);
}

interface FixtureBrokerListClient {
	global(operation: string, input: Record<string, unknown>): Promise<unknown>;
}

function fixtureSessionOwner(cwd = "/fixture/workspace"): SessionLocatorV2 {
	return { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") };
}

async function listedFixtureSessionIds(
	brokerClient: FixtureBrokerListClient,
	owner: SessionLocatorV2,
	timeoutMs = 15_000,
): Promise<Set<string>> {
	const pages = await traverseSessionList(
		{ cwd: owner.cwd },
		input => bounded(brokerClient.global("session.list", input), "broker session list", timeoutMs),
		sessionListPageFromResponse,
	);
	const sessionIds = new Set<string>();
	for (const { page, sessions } of pages) {
		if (!Array.isArray(page.warnings)) throw new Error("session.list page omitted its warnings array.");
		if (page.warnings.length > 0)
			throw new Error(`session.list inventory is incomplete: ${page.warnings.map(failureMessage).join("; ")}`);
		for (const session of sessions) {
			if (!session || typeof session !== "object") throw new Error("session.list returned a malformed session row.");
			if (!("sessionId" in session) || typeof session.sessionId !== "string")
				throw new Error("session.list returned a session row without sessionId.");
			if (!("locator" in session) || !session.locator || typeof session.locator !== "object")
				throw new Error(`session.list row ${session.sessionId} omitted its locator.`);
			if (!("cwd" in session.locator) || typeof session.locator.cwd !== "string")
				throw new Error(`session.list row ${session.sessionId} omitted its cwd authority.`);
			if (
				!("worktreeRoot" in session.locator) ||
				(session.locator.worktreeRoot !== null && typeof session.locator.worktreeRoot !== "string")
			)
				throw new Error(`session.list row ${session.sessionId} omitted its worktree authority.`);
			if (!("stateRoot" in session.locator) || typeof session.locator.stateRoot !== "string")
				throw new Error(`session.list row ${session.sessionId} omitted its state-root authority.`);
			if (session.locator.stateRoot !== owner.stateRoot) continue;
			const exactOwner = session.locator.cwd === owner.cwd && session.locator.worktreeRoot === owner.worktreeRoot;
			const uncertainCreateOwner = session.locator.cwd === "unknown" && session.locator.worktreeRoot === null;
			if (!exactOwner && !uncertainCreateOwner)
				throw new Error(`session.list row ${session.sessionId} conflicts with the fixture owner locator.`);
			if (!("terminal" in session) || typeof session.terminal !== "boolean")
				throw new Error(`session.list row ${session.sessionId} omitted terminal state.`);
			if (!("terminalUncertain" in session) || typeof session.terminalUncertain !== "boolean")
				throw new Error(`session.list row ${session.sessionId} omitted terminal uncertainty state.`);
			if (!("ambiguous" in session) || typeof session.ambiguous !== "boolean")
				throw new Error(`session.list row ${session.sessionId} omitted ambiguity state.`);
			if (uncertainCreateOwner && !session.terminalUncertain)
				throw new Error(`session.list row ${session.sessionId} has an invalid uncertain-create owner sentinel.`);
			if (session.ambiguous) throw new Error(`session.list row ${session.sessionId} has ambiguous ownership.`);
			if (session.terminalUncertain)
				throw new Error(`session.list row ${session.sessionId} has terminal_uncertain ownership.`);
			if (session.terminal) continue;
			sessionIds.add(session.sessionId);
		}
	}
	return sessionIds;
}

async function closeBrokerSessionAfterUncertainAcp(
	sessionId: string,
	close: () => Promise<unknown>,
	listLive: () => Promise<Set<string>>,
): Promise<void> {
	try {
		await close();
	} catch (error) {
		if (
			error instanceof SdkClientError &&
			["not_found", "resource_gone", "endpoint_stale"].includes(error.code) &&
			!(await listLive()).has(sessionId)
		)
			return;
		throw error;
	}
}

async function retireFixtureSessions(
	sessionIds: Set<string>,
	listBroker: () => Promise<Set<string>>,
	closeAcp: (sessionId: string) => Promise<unknown>,
	closeBroker: (sessionId: string) => Promise<unknown>,
	absenceObservationMs = 0,
	brokerOnlySessionIds = new Set<string>(),
): Promise<void> {
	let absentSince: number | undefined;
	for (;;) {
		const listed = await listBroker();
		if (listed.size > 0) absentSince = undefined;
		for (const sessionId of listed) {
			if (!sessionIds.has(sessionId)) brokerOnlySessionIds.add(sessionId);
			sessionIds.add(sessionId);
		}
		if (sessionIds.size > 0) {
			await retireOwnedSessions(
				sessionIds,
				sessionId => {
					if (brokerOnlySessionIds.has(sessionId))
						throw new FixtureSessionCloseTransportError(
							sessionId,
							new Error("Session is known only through broker inventory."),
						);
					return closeAcp(sessionId);
				},
				closeBroker,
			);
			for (const sessionId of brokerOnlySessionIds) {
				if (!sessionIds.has(sessionId)) brokerOnlySessionIds.delete(sessionId);
			}
		}
		const remaining = await listBroker();
		if (remaining.size === 0 && sessionIds.size === 0) {
			if (absenceObservationMs === 0) return;
			absentSince ??= Date.now();
			const remainingObservationMs = absenceObservationMs - (Date.now() - absentSince);
			if (remainingObservationMs <= 0) return;
			await Bun.sleep(Math.min(25, remainingObservationMs));
			continue;
		}
		absentSince = undefined;
		for (const sessionId of remaining) {
			if (!sessionIds.has(sessionId)) brokerOnlySessionIds.add(sessionId);
			sessionIds.add(sessionId);
		}
	}
}

class InterviewClient implements Client {
	readonly elicitations: CreateElicitationRequest[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(_params: SessionNotification): Promise<void> {}

	async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
		this.elicitations.push(params);
		return { action: "accept", content: { value: "option:0" } };
	}
}

async function stopProcess(proc: AcpProc): Promise<void> {
	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		const { promise: timeout, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => resolve(false), timeoutMs);
		try {
			return await Promise.race([proc.exited.then(() => true), timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		proc.stdin.end();
	} catch {}
	if (!(await waitForExit(2_000))) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	if (!(await waitForExit(3_000))) throw new Error("ACP subprocess did not exit after SIGKILL");
}

async function shutdownFixtureSubprocess(
	retireSessions: () => Promise<void>,
	stop: () => Promise<void>,
): Promise<void> {
	await retireSessions();
	await stop();
}

async function disposeBrokerClientAfterShutdown(
	subprocessRegistered: boolean,
	subprocessShutdownVerified: boolean,
	close: () => Promise<void>,
): Promise<void> {
	if (subprocessRegistered && !subprocessShutdownVerified)
		throw new Error("ACP fixture broker client retained until subprocess shutdown succeeds.");
	try {
		await close();
	} catch {}
}

interface FixtureSessionCreateState {
	uncertain: boolean;
	inFlight: number;
}

async function trackFixtureSessionCreate<T>(state: FixtureSessionCreateState, create: () => Promise<T>): Promise<T> {
	state.inFlight++;
	try {
		return await create();
	} catch (error) {
		state.uncertain = true;
		throw error;
	} finally {
		state.inFlight--;
	}
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await cleanupFixtureRoots(cleanupRoots);
});

describe("ACP deep-interview wire path", () => {
	it("removes a pre-registered root without an assigned broker lease", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-pre-registered-root-"));
		let leaseCloseCalls = 0;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				leaseCloseCalls++;
			},
		});
		cleanupRoots.push(cleanup);
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(leaseCloseCalls).toBe(1);
	});

	it("awaits an in-flight broker lease before removing the fixture root", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-startup-root-"));
		const startup = Promise.withResolvers<{ lease: { close(): Promise<void> } }>();
		let brokerLease: { close(): Promise<void> } | undefined;
		let leaseCloseCalls = 0;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				brokerLease ??= (await bounded(startup.promise, "fixture broker startup")).lease;
				await brokerLease.close();
			},
		});
		cleanupRoots.push(cleanup);
		const cleanupPromise = cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		await Bun.sleep(0);
		expect(fixtureRootForTest(root)).toBeDefined();
		startup.resolve({
			lease: {
				close: async () => {
					leaseCloseCalls++;
				},
			},
		});
		await cleanupPromise;
		expect(leaseCloseCalls).toBe(1);
		expect(fixtureRootForTest(root)).toBeUndefined();
	});

	it("removes the root after broker startup rejects with verified child cleanup", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-startup-failure-root-"));
		let startupFailureVerified = false;
		const startup = Promise.reject(new Error("broker startup failed after child cleanup")).catch(error => {
			startupFailureVerified = true;
			throw error;
		});
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				try {
					await startup;
				} catch (error) {
					if (!startupFailureVerified) throw error;
				}
			},
		});
		cleanupRoots.push(cleanup);
		await expect(startup).rejects.toThrow("broker startup failed after child cleanup");
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(fixtureRootForTest(root)).toBeUndefined();
	});

	it("retains the root when broker startup child cleanup is uncertain", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-startup-uncertain-root-"));
		const failure = new AggregateError(
			[new Error("startup failed"), new Error("child reap failed")],
			"SDK broker discovery and spawned broker cleanup both failed.",
		);
		let startupFailureVerified = false;
		const startup = Promise.reject(failure).catch(error => {
			startupFailureVerified = isVerifiedBrokerStartupFailure(error);
			throw error;
		});
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				try {
					await startup;
				} catch (error) {
					if (!startupFailureVerified) throw error;
				}
			},
		});
		cleanupRoots.push(cleanup);
		await expect(startup).rejects.toBe(failure);
		await expect(cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 })).rejects.toThrow(
			"Fixture broker lease close failed",
		);
		expect(fixtureRootForTest(root)).toBeDefined();
		startupFailureVerified = true;
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
	});

	it("retains the broker fallback dependency across a failed shutdown retry", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-broker-retry-root-"));
		const sessionIds = new Set(["first", "second"]);
		const retirementCalls: string[] = [];
		let semanticFailures = 0;
		let shutdownAttempts = 0;
		let brokerCloseCalls = 0;
		let subprocessShutdownVerified = false;
		let subprocessRegistered = false;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {},
		});
		cleanupRoots.push(cleanup);
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-broker-client",
			requiredOwner: "runtime-and-broker",
			dispose: () =>
				disposeBrokerClientAfterShutdown(subprocessRegistered, subprocessShutdownVerified, async () => {
					brokerCloseCalls++;
				}),
		});
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-subprocess",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				await shutdownFixtureSubprocess(
					() =>
						retireOwnedSessions(
							sessionIds,
							async sessionId => {
								retirementCalls.push(sessionId);
								if (sessionId === "first" && semanticFailures++ === 0)
									throw new Error("injected ACP retirement failure");
							},
							async () => {},
						),
					async () => {
						shutdownAttempts++;
						if (shutdownAttempts === 1) throw new Error("injected subprocess stop failure");
					},
				);
				subprocessShutdownVerified = true;
			},
		});
		subprocessRegistered = true;

		await expect(cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 })).rejects.toThrow(
			"Fixture broker runtime cleanup failed.",
		);
		expect(brokerCloseCalls).toBe(0);
		expect(sessionIds).toEqual(new Set(["first"]));
		expect(shutdownAttempts).toBe(0);
		await expect(cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 })).rejects.toThrow(
			"Fixture broker runtime cleanup failed.",
		);
		expect(brokerCloseCalls).toBe(0);
		expect(shutdownAttempts).toBe(1);
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(brokerCloseCalls).toBe(1);
		expect(retirementCalls).toEqual(["second", "first", "first"]);
		expect(shutdownAttempts).toBe(2);
		expect(sessionIds.size).toBe(0);
		expect(fixtureRootForTest(root)).toBeUndefined();
	});

	it("lets lease and root cleanup continue after broker client transport close stalls", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-client-close-root-"));
		let leaseCloseCalls = 0;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				leaseCloseCalls++;
			},
		});
		cleanupRoots.push(cleanup);
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-broker-client",
			requiredOwner: "runtime-and-broker",
			dispose: () =>
				disposeBrokerClientAfterShutdown(true, true, async () => {
					throw new SdkClientError("timeout", "broker client close timed out");
				}),
		});

		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(leaseCloseCalls).toBe(1);
		expect(fixtureRootForTest(root)).toBeUndefined();
	});

	it("marks a session create in flight before awaiting its response", async () => {
		const state: FixtureSessionCreateState = { uncertain: false, inFlight: 0 };
		const pending = Promise.withResolvers<{ sessionId: string }>();
		const create = trackFixtureSessionCreate(state, async () => await pending.promise);
		expect(state.inFlight).toBe(1);
		pending.resolve({ sessionId: "created" });
		await expect(create).resolves.toEqual({ sessionId: "created" });
		expect(state).toEqual({ uncertain: false, inFlight: 0 });

		await expect(
			trackFixtureSessionCreate(state, async () => {
				throw new Error("response lost");
			}),
		).rejects.toThrow("response lost");
		expect(state).toEqual({ uncertain: true, inFlight: 0 });
	});

	it("treats completed root cleanup as an idempotent no-op", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-idempotent-root-"));
		let leaseCloseCalls = 0;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			close: async () => {
				leaseCloseCalls++;
			},
		});
		cleanupRoots.push(cleanup);
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		await cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(leaseCloseCalls).toBe(1);
	});

	it("attempts every owned session after an ACP close failure", async () => {
		const sessionIds = new Set(["first", "second"]);
		const acpCalls: string[] = [];
		const brokerCalls: string[] = [];
		await expect(
			retireOwnedSessions(
				sessionIds,
				async sessionId => {
					acpCalls.push(sessionId);
					if (sessionId === "second")
						throw new FixtureSessionCloseTransportError(sessionId, new Error("ACP connection closed"));
				},
				async sessionId => {
					brokerCalls.push(sessionId);
					if (sessionId === "second") throw new Error("broker close failed");
				},
			),
		).rejects.toThrow("ACP fixture session retirement failed");
		expect(acpCalls).toEqual(["second", "first"]);
		expect(brokerCalls).toEqual(["second"]);
		expect(sessionIds).toEqual(new Set(["second"]));
	});

	it("does not retry sessions retired before a later close failure", async () => {
		const sessionIds = new Set(["first", "second"]);
		const firstAttempt: string[] = [];
		await expect(
			retireOwnedSessions(
				sessionIds,
				async sessionId => {
					firstAttempt.push(sessionId);
					if (sessionId === "first") throw new Error("semantic ACP close failure");
				},
				async () => {},
			),
		).rejects.toThrow("ACP fixture session retirement failed");
		expect(firstAttempt).toEqual(["second", "first"]);
		expect(sessionIds).toEqual(new Set(["first"]));

		const retry: string[] = [];
		await retireOwnedSessions(
			sessionIds,
			async sessionId => {
				retry.push(sessionId);
			},
			async () => {},
		);
		expect(retry).toEqual(["first"]);
		expect(sessionIds.size).toBe(0);
	});

	it("uses the independent broker fallback after an ACP transport failure", async () => {
		const sessionIds = new Set(["only"]);
		const acpCalls: string[] = [];
		const brokerCalls: string[] = [];
		await expect(
			retireOwnedSessions(
				sessionIds,
				async sessionId => {
					acpCalls.push(sessionId);
					throw new FixtureSessionCloseTransportError(sessionId, new Error("ACP connection closed"));
				},
				async sessionId => {
					brokerCalls.push(sessionId);
				},
			),
		).resolves.toBeUndefined();
		expect(acpCalls).toEqual(["only"]);
		expect(brokerCalls).toEqual(["only"]);
		expect(sessionIds.size).toBe(0);
	});

	it("bounds an ACP close timeout before using broker fallback", async () => {
		const pending = Promise.withResolvers<void>();
		let brokerCalled = false;
		const sessionIds = new Set(["only"]);
		const retirement = retireOwnedSessions(
			sessionIds,
			async () => await pending.promise,
			async () => {
				brokerCalled = true;
			},
			5,
		);
		await expect(retirement).resolves.toBeUndefined();
		expect(brokerCalled).toBe(true);
		expect(sessionIds.size).toBe(0);
		pending.resolve();
	});

	it("classifies the wire envelope for an uncertain ACP broker request", () => {
		const timeout = classifyAcpCloseFailure(
			"only",
			Object.assign(new Error("ACP session cleanup is uncertain"), {
				code: -32603,
				data: {
					code: "terminal_uncertain",
					details: "ACP session cleanup is uncertain: SDK request outcome is uncertain after the frame was sent.",
				},
			}),
			false,
		);
		expect(timeout).toBeInstanceOf(FixtureSessionCloseTransportError);
		const semanticEnvelope = Object.assign(new Error("ACP session cleanup is uncertain"), {
			code: -32603,
			data: { code: "terminal_uncertain", details: "ACP session cleanup is uncertain: semantic close refusal" },
		});
		expect(classifyAcpCloseFailure("only", semanticEnvelope, false)).toBe(semanticEnvelope);
		const semantic = new Error("semantic close refusal");
		expect(classifyAcpCloseFailure("only", semantic, false)).toBe(semantic);
	});

	it("treats broker not_found after an ACP timeout as already retired", async () => {
		const pending = Promise.withResolvers<void>();
		const sessionIds = new Set(["only"]);
		await expect(
			retireOwnedSessions(
				sessionIds,
				async () => await pending.promise,
				async () =>
					await closeBrokerSessionAfterUncertainAcp(
						"only",
						async () => {
							throw new SdkClientError("not_found", "session is not indexed");
						},
						async () => new Set(),
					),
				5,
			),
		).resolves.toBeUndefined();
		expect(sessionIds.size).toBe(0);
		pending.resolve();
	});

	it("accepts terminal broker races only after inventory proves the session retired", async () => {
		await expect(
			closeBrokerSessionAfterUncertainAcp(
				"retired",
				async () => {
					throw new SdkClientError("resource_gone", "session endpoint is gone");
				},
				async () => new Set(),
			),
		).resolves.toBeUndefined();

		await expect(
			closeBrokerSessionAfterUncertainAcp(
				"still-live",
				async () => {
					throw new SdkClientError("endpoint_stale", "session endpoint changed");
				},
				async () => new Set(["still-live"]),
			),
		).rejects.toThrow("session endpoint changed");

		await expect(
			closeBrokerSessionAfterUncertainAcp(
				"still-live",
				async () => {
					throw new SdkClientError("not_found", "session is not indexed");
				},
				async () => new Set(["still-live"]),
			),
		).rejects.toThrow("session is not indexed");
	});

	it("rejects warning-tainted, ambiguous, or terminal-uncertain broker inventory", async () => {
		await expect(
			listedFixtureSessionIds(
				{
					global: async () => ({ ok: true, result: { sessions: [], warnings: ["corrupt snapshot"] } }),
				},
				fixtureSessionOwner(),
			),
		).rejects.toThrow("session.list inventory is incomplete");

		await expect(
			listedFixtureSessionIds(
				{
					global: async () => ({
						ok: true,
						result: {
							sessions: [
								{
									sessionId: "ambiguous",
									locator: fixtureSessionOwner(),
									terminal: false,
									terminalUncertain: false,
									ambiguous: true,
								},
							],
							warnings: [],
						},
					}),
				},
				fixtureSessionOwner(),
			),
		).rejects.toThrow("ambiguous ownership");

		await expect(
			listedFixtureSessionIds(
				{
					global: async () => ({
						ok: true,
						result: {
							sessions: [
								{
									sessionId: "uncertain",
									locator: fixtureSessionOwner(),
									terminal: true,
									terminalUncertain: true,
									ambiguous: false,
								},
							],
							warnings: [],
						},
					}),
				},
				fixtureSessionOwner(),
			),
		).rejects.toThrow("terminal_uncertain ownership");
	});

	it("lists only live sessions owned by the fixture locator", async () => {
		const owner = fixtureSessionOwner();
		const foreignOwner = fixtureSessionOwner("/foreign/workspace");
		const ids = await listedFixtureSessionIds(
			{
				global: async () => ({
					ok: true,
					result: {
						sessions: [
							{
								sessionId: "fixture-live",
								locator: owner,
								terminal: false,
								terminalUncertain: false,
								ambiguous: false,
							},
							{
								sessionId: "fixture-terminal",
								locator: owner,
								terminal: true,
								terminalUncertain: false,
								ambiguous: false,
							},
							{
								sessionId: "foreign-live",
								locator: foreignOwner,
								terminal: false,
								terminalUncertain: false,
								ambiguous: false,
							},
						],
						warnings: [],
					},
				}),
			},
			owner,
		);
		expect(ids).toEqual(new Set(["fixture-live"]));
	});

	it("isolates foreign locators and rejects conflicting or uncertain fixture ownership", async () => {
		const owner = { ...fixtureSessionOwner(), worktreeRoot: "/fixture/repository" };
		const page = (sessions: Record<string, unknown>[]) => ({ ok: true, result: { sessions, warnings: [] } });
		const row = (sessionId: string, locator: SessionLocatorV2, terminalUncertain = false) => ({
			sessionId,
			locator,
			terminal: false,
			terminalUncertain,
			ambiguous: false,
		});
		const foreignRows = [
			row("foreign-repository", {
				cwd: "/foreign/workspace",
				worktreeRoot: owner.worktreeRoot,
				stateRoot: "/foreign/workspace/.gjc/state",
			}),
			row(
				"foreign-uncertain",
				{ cwd: "unknown", worktreeRoot: null, stateRoot: "/foreign/workspace/.gjc/state" },
				true,
			),
		];
		await expect(listedFixtureSessionIds({ global: async () => page(foreignRows) }, owner)).resolves.toEqual(
			new Set(),
		);

		await expect(
			listedFixtureSessionIds(
				{
					global: async () =>
						page([
							row("conflicting-state-owner", {
								cwd: "/other/workspace",
								worktreeRoot: "/other/repository",
								stateRoot: owner.stateRoot,
							}),
						]),
				},
				owner,
			),
		).rejects.toThrow("conflicts with the fixture owner locator");

		await expect(
			listedFixtureSessionIds(
				{
					global: async () =>
						page([
							row("uncertain-create", { cwd: "unknown", worktreeRoot: null, stateRoot: owner.stateRoot }, true),
						]),
				},
				owner,
			),
		).rejects.toThrow("terminal_uncertain ownership");
	});

	it("retires sessions discovered from the broker after an ACP response is lost", async () => {
		const sessionIds = new Set<string>();
		const acpCalls: string[] = [];
		const brokerCalls: string[] = [];
		let listCalls = 0;
		await retireFixtureSessions(
			sessionIds,
			async () => new Set(listCalls++ === 0 ? ["lost-response"] : []),
			async sessionId => {
				acpCalls.push(sessionId);
				throw new FixtureSessionCloseTransportError(sessionId, new Error("ACP response lost"));
			},
			async sessionId => {
				brokerCalls.push(sessionId);
			},
		);
		expect(acpCalls).toEqual([]);
		expect(brokerCalls).toEqual(["lost-response"]);
		expect(sessionIds.size).toBe(0);
		expect(listCalls).toBe(2);
	});

	it("preserves broker-only ownership across cleanup retries", async () => {
		const sessionIds = new Set<string>();
		const brokerOnlySessionIds = new Set<string>();
		let acpCalls = 0;
		let brokerCalls = 0;
		const retire = () =>
			retireFixtureSessions(
				sessionIds,
				async () => new Set(brokerCalls >= 2 ? [] : ["broker-only"]),
				async () => {
					acpCalls++;
				},
				async () => {
					brokerCalls++;
					if (brokerCalls === 1) throw new Error("injected broker close failure");
				},
				0,
				brokerOnlySessionIds,
			);
		await expect(retire()).rejects.toThrow("injected broker close failure");
		await expect(retire()).resolves.toBeUndefined();
		expect(acpCalls).toBe(0);
		expect(brokerCalls).toBe(2);
		expect(sessionIds.size).toBe(0);
		expect(brokerOnlySessionIds.size).toBe(0);
	});

	it("routes a session first seen by post-retirement inventory through the broker", async () => {
		const sessionIds = new Set<string>();
		const brokerOnlySessionIds = new Set<string>();
		let listCalls = 0;
		const listings = [[], ["late-broker-only"], ["late-broker-only"], []] as const;
		let acpCalls = 0;
		let brokerCalls = 0;
		await retireFixtureSessions(
			sessionIds,
			async () => new Set(listings[listCalls++] ?? []),
			async () => {
				acpCalls++;
			},
			async () => {
				brokerCalls++;
			},
			0,
			brokerOnlySessionIds,
		);
		expect(acpCalls).toBe(0);
		expect(brokerCalls).toBe(1);
		expect(sessionIds.size).toBe(0);
		expect(brokerOnlySessionIds.size).toBe(0);
	});

	it("observes the uncertain create window for a late broker session", async () => {
		const sessionIds = new Set<string>();
		const brokerCalls: string[] = [];
		let listCalls = 0;
		await retireFixtureSessions(
			sessionIds,
			async () => new Set(listCalls++ === 2 ? ["late-session"] : []),
			async sessionId => {
				throw new FixtureSessionCloseTransportError(sessionId, new Error("ACP response lost"));
			},
			async sessionId => {
				brokerCalls.push(sessionId);
			},
			20,
		);
		expect(brokerCalls).toEqual(["late-session"]);
		expect(sessionIds.size).toBe(0);
		expect(listCalls).toBeGreaterThan(4);
	});

	it("retains semantic ACP close failures without broker fallback", async () => {
		const sessionIds = new Set(["only"]);
		let brokerCalled = false;
		const failure = await retireOwnedSessions(
			sessionIds,
			async () => {
				throw new Error("semantic ACP close failure");
			},
			async () => {
				brokerCalled = true;
			},
		).catch(error => error);
		expect(brokerCalled).toBe(false);
		expect(sessionIds).toEqual(new Set(["only"]));
		expect(failure).toBeInstanceOf(AggregateError);
		if (!(failure instanceof AggregateError)) return;
		expect(failure.message).toContain("semantic ACP close failure");
		expect(failure.errors[0]).toMatchObject({ message: "semantic ACP close failure" });
	});

	it("routes an advertised skill command to a real form elicitation in a headless lifecycle host", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/v1/models")
					return Response.json({ data: [{ id: "fixture-model" }] });
				if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
					return new Response("Not found", { status: 404 });
				const body = (await request.json()) as Record<string, unknown>;
				requests.push(body);
				if (requests.length === 1)
					return chatStream([
						chunk({ role: "assistant", content: "Wire skill completed." }, null),
						chunk({}, "stop"),
					]);
				if (requests.length === 2) {
					const args = JSON.stringify({
						questions: [
							{
								id: "acp-direction",
								question: "Which ACP direction should the interview use?",
								options: [{ label: "Keep protocol choices" }, { label: "Use plain text" }],
								recommended: 0,
								deepInterview: {
									round: 0,
									component: "review-topology",
									dimension: "topology",
									ambiguity: 1,
									intent_contract: {
										items: [
											{
												id: "integration:acp",
												category: "integration",
												statement: "Preserve ACP protocol choices",
											},
										],
										confirmation_options: ["Keep protocol choices"],
									},
								},
							},
						],
					});
					return chatStream([
						chunk(
							{
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call-acp-ask",
										type: "function",
										function: { name: "ask", arguments: args },
									},
								],
							},
							null,
						),
						chunk({}, "tool_calls"),
					]);
				}
				await Bun.sleep(3_000);
				return chatStream([
					chunk({ role: "assistant", content: "Cancellation fallback should not publish." }, null),
					chunk({}, "stop"),
				]);
			},
		});
		servers.push(modelServer);

		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-deep-interview-wire-"));
		const agentDir = path.join(root, "agent");
		let brokerLease: { close(): Promise<void> } | undefined;
		let brokerStartup:
			| Promise<{
					lease: { close(): Promise<void> };
					discovery: { url: string; token: string };
			  }>
			| undefined;
		let brokerCleanupStarted = false;
		let brokerStartupFailureVerified = false;
		const cleanup = createFixtureRootCleanup(root, agentDir, {
			close: async () => {
				brokerCleanupStarted = true;
				const startup = brokerStartup;
				if (startup) {
					try {
						brokerLease ??= (await bounded(startup, "fixture broker startup", FIXTURE_BROKER_STARTUP_TIMEOUT_MS))
							.lease;
					} catch (error) {
						if (!brokerStartupFailureVerified) throw error;
					}
				}
				await brokerLease?.close();
			},
		});
		cleanupRoots.push(cleanup);
		const env = childEnv(root);
		for (const dir of [
			env.HOME,
			env.TMPDIR,
			env.XDG_DATA_HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_STATE_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_RUNTIME_DIR,
			env.GJC_CODING_AGENT_DIR,
		])
			await fs.promises.mkdir(dir, { recursive: true });
		const workspace = path.join(root, "workspace");
		await fs.promises.mkdir(path.join(workspace, ".gjc", "skills", "wire-skill"), { recursive: true });
		const sessionOwner = await resolveSessionLocator(workspace, path.join(workspace, ".gjc", "state"));
		await fs.promises.writeFile(
			path.join(workspace, ".gjc", "skills", "wire-skill", "SKILL.md"),
			"---\nname: wire-skill\ndescription: Complete one deterministic ACP turn.\n---\n\nReturn one short completion message.\n",
		);
		await fs.promises.writeFile(
			path.join(workspace, ".gjc", "settings.json"),
			JSON.stringify({ skills: { enabled: true, enablePiProject: true } }),
		);
		await fs.promises.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        contextWindow: 32768\n        maxTokens: 4096\nprofiles:\n  acp-fixture:\n    display_name: ACP Fixture\n    required_providers: [fixture]\n    model_mapping:\n      default: fixture/fixture-model\n`,
		);

		brokerStartup = withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir, env })).catch(
			error => {
				brokerStartupFailureVerified = isVerifiedBrokerStartupFailure(error);
				throw error;
			},
		);
		const started = await brokerStartup;
		brokerLease = started.lease;
		brokerStartup = undefined;
		if (brokerCleanupStarted) throw new Error("ACP fixture cleanup began during broker startup.");
		const sessionIds = new Set<string>();
		const brokerOnlySessionIds = new Set<string>();
		const sessionCreateState: FixtureSessionCreateState = { uncertain: false, inFlight: 0 };
		const brokerClient = await SdkClient.connect(started.discovery.url, started.discovery.token, {
			reconnectAttempts: 0,
		});
		let subprocessShutdownVerified = false;
		let subprocessRegistered = false;
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-broker-client",
			requiredOwner: "runtime-and-broker",
			dispose: () =>
				disposeBrokerClientAfterShutdown(subprocessRegistered, subprocessShutdownVerified, () =>
					brokerClient.close(),
				),
		});
		const proc = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "--mode", "acp", "--mpreset", "acp-fixture"], {
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		let stderrDrain = Promise.resolve();
		let connection: ClientSideConnection | undefined;
		registerFixtureRuntime(cleanup, {
			key: "acp-deep-interview-subprocess",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				await shutdownFixtureSubprocess(
					() =>
						retireFixtureSessions(
							sessionIds,
							() => listedFixtureSessionIds(brokerClient, sessionOwner),
							async sessionId => {
								if (!connection)
									throw new FixtureSessionCloseTransportError(
										sessionId,
										new Error("ACP connection unavailable"),
									);
								try {
									return await connection.closeSession({ sessionId });
								} catch (error) {
									throw classifyAcpCloseFailure(sessionId, error, connection.signal.aborted);
								}
							},
							sessionId =>
								closeBrokerSessionAfterUncertainAcp(
									sessionId,
									() =>
										brokerClient.global(
											"session.close",
											{ sessionId },
											{
												idempotencyKey: `acp-fixture-close:${sessionId}`,
												timeoutMs: BROKER_SESSION_CLOSE_TIMEOUT_MS,
											},
										),
									() => listedFixtureSessionIds(brokerClient, sessionOwner),
								),
							sessionCreateState.uncertain || sessionCreateState.inFlight > 0
								? SESSION_CREATE_RECONCILIATION_MS
								: 0,
							brokerOnlySessionIds,
						),
					() => stopProcess(proc),
				);
				subprocessShutdownVerified = true;
			},
			dispose: () => {
				if (!subprocessShutdownVerified)
					throw new Error("ACP fixture subprocess retained until session retirement and shutdown succeed.");
				return stderrDrain;
			},
		});
		subprocessRegistered = true;
		let stderr = "";
		stderrDrain = (async () => {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) stderr = `${stderr}${decoder.decode(value, { stream: true })}`.slice(-64 * 1024);
			}
		})();

		const client = new InterviewClient();
		const activeConnection = new ClientSideConnection(() => client, ndJsonStream(input(proc), proc.stdout));
		connection = activeConnection;
		const newFixtureSession = (): Promise<{ sessionId: string }> =>
			trackFixtureSessionCreate(sessionCreateState, () =>
				activeConnection.newSession({ cwd: workspace, mcpServers: [] }),
			);
		try {
			await connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
			const { sessionId } = await newFixtureSession();
			sessionIds.add(sessionId);
			const response = await bounded(
				connection.prompt({
					sessionId,
					prompt: [{ type: "text", text: "/skill:wire-skill" }],
				}),
				"completed ACP skill prompt",
			);
			expect(response.stopReason).toBe("end_turn");
			expect(requests).toHaveLength(1);
			expect(stderr).not.toContain("theme.status");
			const cancelSessionId = (await newFixtureSession()).sessionId;
			sessionIds.add(cancelSessionId);
			const cancelledPrompt = connection.prompt({
				sessionId: cancelSessionId,
				prompt: [{ type: "text", text: "/skill:deep-interview verify ACP cancellation" }],
			});
			await waitFor(() => client.elicitations.length === 1 && requests.length >= 3, "ACP form before cancellation");
			expect(client.elicitations).toHaveLength(1);
			expect(client.elicitations[0]).toMatchObject({
				sessionId: cancelSessionId,
				mode: "form",
				message: "Which ACP direction should the interview use?",
			});
			const choiceSchema = client.elicitations[0] as CreateElicitationRequest & {
				requestedSchema: { properties: { value: { oneOf: Array<{ const: string }> } } };
			};
			expect(choiceSchema.requestedSchema.properties.value.oneOf.map(choice => choice.const)).toEqual(
				expect.arrayContaining(["option:0", "option:1"]),
			);
			expect(JSON.stringify(requests[1]?.tools)).toContain('"name":"ask"');
			expect(JSON.stringify(requests[2]?.messages)).toContain("Keep protocol choices");
			await connection.cancel({ sessionId: cancelSessionId });
			await expect(bounded(cancelledPrompt, "cancelled ACP skill prompt")).resolves.toEqual({
				stopReason: "cancelled",
			});
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\nforms=${client.elicitations.length} requests=${requests.length}\n[child stderr]\n${stderr}`,
			);
		}
	}, 60_000);
});
