import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { resolveScopeRequest, scopeRequestV1 } from "../src/sdk/broker/session-scope";
import { scanRetainedTranscriptTail } from "../src/sdk/cli/session-cli";
import { SessionEventStream } from "../src/sdk/host/events";
import { type CursorEnvelope, signCursor, verifyCursor } from "../src/sdk/host/query/cursor";
import { SessionManager } from "../src/session/session-manager";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

// Live frames a fake host pushes only after it has answered a replay, so a tail
// that exits on replayed history alone provably never observes them.
const DEFERRED_LIVE_EVENT_DELAY_MS = 300;

// The Router's attach-time replay calls the transport directly, while the CLI's
// explicit tail replay goes through SessionRouter.request, which stamps
// connectionId onto the wire frame. That difference is the fake host's only
// deterministic discriminator between the two event_replay requests.
function isExplicitTailReplay(frame: Record<string, unknown>): boolean {
	return frame.type === "event_replay" && typeof frame.connectionId === "string";
}

function withCheckpointRevision(
	event: Record<string, unknown>,
	checkpoint: { revision: number },
): Record<string, unknown> {
	return event.revision === undefined ? { ...event, revision: checkpoint.revision } : event;
}

// Delay applied to the explicit tail replay response so live frames pushed at
// request time provably reach the client first.
const EXPLICIT_REPLAY_DELAY_MS = 250;

type CliResult = { exitCode: number; stdout: string; stderr: string };

// Capture through files rather than pipes: a piped child that outlives the
// parent's read teardown can be killed by SIGPIPE (exit 141) under CI load,
// which masks the CLI's real exit contract.
function closeCaptureFd(fd: number): void {
	// Bun.spawn may close inherited capture FDs when a short-lived child exits,
	// especially on fail-closed CLI paths. Ignore EBADF so teardown does not
	// mask the CLI exit contract under CI load (see shard-6 post-#3076 red).
	try {
		closeSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== "EBADF") throw error;
	}
}

function publicSessionArgs(args: string[]): string[] {
	const action = args[0];
	return action === "control" || action === "query" || action === "global"
		? ["sdk", "session", "raw", ...args]
		: ["sdk", "session", ...args];
}

async function runCliArgs(repo: string, agentDir: string, commandArgs: string[]): Promise<CliResult> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-cli-capture-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	const stdoutFd = openSync(stdoutPath, "w");
	const stderrFd = openSync(stderrPath, "w");
	try {
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, ...commandArgs], {
			cwd: repo,
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
			stdout: stdoutFd,
			stderr: stderrFd,
		});
		const exitCode = await child.exited;
		// Close before reading so file contents are durable even if Bun still
		// held a write handle; tolerate already-closed FDs from the child.
		closeCaptureFd(stdoutFd);
		closeCaptureFd(stderrFd);
		// Re-open read-only and fsync parent side so CI load cannot observe a
		// truncated capture of a finished child (exit code alone is not enough).
		const stdout = await fs.readFile(stdoutPath, "utf8");
		const stderr = await fs.readFile(stderrPath, "utf8");
		return { exitCode, stdout, stderr };
	} finally {
		closeCaptureFd(stdoutFd);
		closeCaptureFd(stderrFd);
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

async function runCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	return await runCliArgs(repo, agentDir, publicSessionArgs(args));
}

async function runSdkCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	return await runCliArgs(repo, agentDir, ["sdk", ...args]);
}

// Broker `session.list` rows always carry a v2 locator: legacy shapes are
// quarantined at index admission, so the CLI row projection rejects a row
// without one instead of inventing a placeholder. Stubbed pages must therefore
// look like real broker rows.
const stubLocator = { cwd: "/stub/cwd", worktreeRoot: null, stateRoot: "/stub/cwd/.gjc/state" };
const stubRow = (sessionId: string) => ({ sessionId, locator: stubLocator });

async function initializeTestRepository(root: string): Promise<void> {
	const result = Bun.spawn(["git", "init", "--quiet"], {
		cwd: root,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await result.exited;
	if (exitCode !== 0) {
		throw new Error(`Failed to initialize E2E repository: ${await new Response(result.stderr).text()}`);
	}
}
describe("SDK session CLI", () => {
	let root: string;
	let agentDir: string;
	let stateRoot: string;
	let endpointServer: Bun.Server<undefined>;
	let broker: Broker;
	let receivedControl: Record<string, unknown> | undefined;
	let endpointConnections = 0;
	let promptStatuses = new Map<string, { status: string }>();
	let replayEvents: Record<string, unknown>[] = [];
	let replayGap: Record<string, unknown> | undefined;
	let deferredLiveEvents: Record<string, unknown>[] = [];
	let deferredLiveDispatched = false;
	let openSockets = new Set<Bun.ServerWebSocket<undefined>>();
	// Out-of-band ordering script: events answered to the explicit tail replay
	// only, live frames pushed the moment that request arrives, and a delay on
	// the reply so the live frames provably land first.
	let explicitReplayEvents: Record<string, unknown>[] | undefined;
	let earlyLiveEvents: Record<string, unknown>[] = [];
	let preCheckpointLiveEvents: Record<string, unknown>[] = [];
	let wireLog: string[] = [];
	// Retained transcript rows served by `transcript.list`. Non-empty rows make
	// the checkpoint advertise a cursor so the CLI actually drains the page.
	let transcriptRows: Record<string, unknown>[] = [];
	let checkpointRecord = { revision: 1, generation: 1, seq: 0, idle: false };
	let checkpointInputToken: unknown;
	let transcriptCursor: unknown;
	let signedExchange: { source: string; replacement: string } | undefined;
	// Exact JSON the fake host put on the wire for the explicit tail replay, so a
	// test can prove a raw coordinate claim really was transmitted.
	let lastReplayPayload = "";

	beforeEach(async () => {
		endpointConnections = 0;
		receivedControl = undefined;
		promptStatuses = new Map();
		replayEvents = [];
		replayGap = undefined;
		deferredLiveEvents = [];
		deferredLiveDispatched = false;
		openSockets = new Set();
		explicitReplayEvents = undefined;
		earlyLiveEvents = [];
		preCheckpointLiveEvents = [];
		wireLog = [];
		transcriptRows = [];
		checkpointRecord = { revision: 1, generation: 1, seq: 0, idle: false };
		checkpointInputToken = undefined;
		transcriptCursor = undefined;
		signedExchange = undefined;
		lastReplayPayload = "";
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-cli-"));
		await initializeTestRepository(root);
		agentDir = path.join(root, "agent");
		stateRoot = path.join(root, ".gjc", "state");
		const token = "session-token";
		endpointServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				endpointConnections++;
				if (server.upgrade(request, { data: undefined })) return undefined;
				return new Response("Upgrade Required", { status: 426 });
			},
			websocket: {
				open(socket) {
					openSockets.add(socket);
					// Defer hello one tick so the client open handler can enter the
					// hello phase before the first frame is delivered (pairs with the
					// SdkClient early-hello buffer under load).
					queueMicrotask(() => {
						try {
							socket.send(
								JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test-conn" }),
							);
						} catch {
							// connection already closed
						}
					});
				},
				message(socket, message) {
					const frame = JSON.parse(String(message)) as Record<string, unknown>;
					if (frame.type === "event_replay") {
						// Out-of-band script: answer the Router's attach replay empty so it
						// cannot pre-order history, push live frames now, and delay the
						// explicit tail replay so those live frames arrive first.
						if (explicitReplayEvents !== undefined) {
							const explicit = isExplicitTailReplay(frame);
							wireLog.push(explicit ? "explicit_replay_request" : "attach_replay_request");
							if (!explicit) {
								socket.send(
									JSON.stringify({
										type: "event_replay_result",
										id: frame.id,
										ok: true,
										generation: 1,
										lastSeq: 0,
										events: [],
									}),
								);
								return;
							}
							for (const event of earlyLiveEvents) {
								socket.send(JSON.stringify(withCheckpointRevision(event, checkpointRecord)));
								wireLog.push(`live_sent:${event.kind}:${event.seq}`);
							}
							const events = explicitReplayEvents;
							const id = frame.id;
							void Bun.sleep(EXPLICIT_REPLAY_DELAY_MS).then(() => {
								try {
									lastReplayPayload = JSON.stringify({
										type: "event_replay_result",
										id,
										ok: true,
										generation: 1,
										lastSeq: events.reduce(
											(maximum, event) =>
												typeof event.seq === "number" ? Math.max(maximum, event.seq) : maximum,
											0,
										),
										events,
									});
									socket.send(lastReplayPayload);
									wireLog.push("explicit_replay_result");
									for (const event of deferredLiveEvents)
										socket.send(JSON.stringify(withCheckpointRevision(event, checkpointRecord)));
								} catch {
									// connection already closed
								}
							});
							return;
						}
						socket.send(
							JSON.stringify({
								type: "event_replay_result",
								id: frame.id,
								ok: true,
								generation: 1,
								lastSeq: replayEvents.reduce(
									(maximum, event) => (typeof event.seq === "number" ? Math.max(maximum, event.seq) : maximum),
									0,
								),
								events: replayEvents,
								...(replayGap === undefined ? {} : { gap: replayGap }),
							}),
						);
						if (deferredLiveEvents.length > 0 && !deferredLiveDispatched) {
							deferredLiveDispatched = true;
							const pending = deferredLiveEvents;
							void Bun.sleep(DEFERRED_LIVE_EVENT_DELAY_MS).then(() => {
								for (const event of pending)
									for (const target of openSockets) {
										try {
											target.send(JSON.stringify(withCheckpointRevision(event, checkpointRecord)));
										} catch {
											// connection already closed
										}
									}
							});
						}
						return;
					}
					if (frame.type === "control_request") {
						receivedControl = frame;
						if (frame.operation === "turn.prompt") {
							const input = frame.input as Record<string, unknown> | undefined;
							const clientRef = typeof input?.clientRef === "string" ? input.clientRef : undefined;
							socket.send(
								JSON.stringify({
									type: "control_response",
									id: frame.id,
									ok: true,
									result: { accepted: true, ...(clientRef === undefined ? {} : { clientRef }) },
								}),
							);
							return;
						}
					}
					if (frame.type === "query_request") {
						if (frame.query === "session.metadata") {
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: { sessionId: "live" },
								}),
							);
							return;
						}
						if (frame.query === "turn.result") {
							const input = frame.input as Record<string, unknown> | undefined;
							const clientRef = typeof input?.clientRef === "string" ? input.clientRef : undefined;
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result:
										clientRef === undefined
											? { status: "unknown" }
											: (promptStatuses.get(clientRef) ?? { status: "unknown" }),
								}),
							);
							return;
						}
						if (frame.query === "session.checkpoint") {
							checkpointInputToken = (frame.input as Record<string, unknown> | undefined)?.checkpointToken;
							if (signedExchange !== undefined && checkpointInputToken !== signedExchange.source) {
								socket.send(
									JSON.stringify({
										type: "query_response",
										id: frame.id,
										ok: false,
										error: { code: "invalid_cursor", restartQuery: true },
									}),
								);
								return;
							}
							for (const event of preCheckpointLiveEvents) {
								socket.send(JSON.stringify(event));
								wireLog.push(`pre_checkpoint_live_sent:${event.kind}:${event.seq}`);
							}
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: {
										checkpoint: checkpointRecord,
										...(transcriptRows.length > 0
											? { checkpointToken: signedExchange?.replacement ?? "transcript-page-1" }
											: {}),
										...(signedExchange === undefined ? {} : { cursor: "legacy-must-not-win" }),
									},
								}),
							);
							return;
						}
						if (frame.query === "transcript.list") {
							transcriptCursor = frame.cursor;
							if (
								signedExchange !== undefined &&
								(frame.cursor !== signedExchange.replacement ||
									verifyCursor(String(frame.cursor), "tail-e2e-key") === undefined)
							) {
								socket.send(
									JSON.stringify({
										type: "query_response",
										id: frame.id,
										ok: false,
										error: { code: "invalid_cursor", restartQuery: true },
									}),
								);
								return;
							}
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: { page: { items: transcriptRows, complete: true } },
								}),
							);
							return;
						}
					}
					socket.send(
						JSON.stringify({
							type: frame.type === "control_request" ? "control_response" : "query_response",
							id: frame.id,
							ok: false,
							error: { code: "unknown_operation", message: "unknown operation" },
						}),
					);
				},
			},
		});
		const endpointPath = path.join(stateRoot, "sdk", "live.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "live", pid: process.pid, url: `ws://127.0.0.1:${endpointServer.port}`, token }),
		);
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		broker = new Broker({ agentDir });
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "live",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
	});

	afterEach(async () => {
		await broker.stop();
		await endpointServer.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	type OfflineSession = { id: string; path: string };

	async function createStoppedSavedSession(): Promise<OfflineSession> {
		const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await session.ensureOnDisk();
		const id = session.getSessionId();
		const savedPath = session.getSessionFile();
		if (!savedPath) throw new Error("Expected a retained managed session path.");
		const registration = {
			type: "host_registered" as const,
			sessionId: id,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		};
		await broker.index.append(registration);
		await broker.index.append({ ...registration, type: "host_unregistered" as const });
		return { id, path: savedPath };
	}

	async function tailAfterBrokerSelectsOfflineSession(
		mutate: (session: OfflineSession) => Promise<void>,
		prepare?: (session: OfflineSession) => Promise<void>,
	): Promise<{ result: CliResult; selections: number }> {
		const session = await createStoppedSavedSession();
		if (prepare) await prepare(session);
		const originalHandleRequest = broker.handleRequest.bind(broker);
		let selections = 0;
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			const response = await originalHandleRequest(operation, input, idempotencyKey);
			if (operation === "session.list" && input.resolveSessionId === session.id && selections === 0) {
				selections++;
				await mutate(session);
			}
			return response;
		};
		try {
			return { result: await runCli(root, agentDir, ["tail", session.id]), selections };
		} finally {
			broker.handleRequest = originalHandleRequest;
		}
	}

	it("uses the broker and Router-owned session attachments without leaking credentials", async () => {
		const list = await runCli(root, agentDir, ["list"]);
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout)).toMatchObject({ result: { version: 2, sessions: [{ sessionId: "live" }] } });
		const connectionsAfterList = endpointConnections;

		const control = await runCli(root, agentDir, [
			"control",
			"live",
			"--op",
			"not.real",
			"--json-input",
			"{}",
			"--confirm",
		]);
		expect(control.exitCode).toBe(1);
		expect(receivedControl).toBeUndefined();
		expect(endpointConnections).toBe(connectionsAfterList);
		expect(JSON.parse(control.stdout)).toMatchObject({ error: { code: "unknown_operation" } });
		expect(control.stderr).not.toContain("session-token");

		const query = await runCli(root, agentDir, [
			"query",
			"live",
			"--query",
			"session.metadata",
			"--json-input",
			"{}",
		]);
		expect(query.exitCode, `query stdout=${query.stdout}\nstderr=${query.stderr}`).toBe(0);
		expect(JSON.parse(query.stdout)).toMatchObject({ ok: true, result: { sessionId: "live" } });

		const refused = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
		]);
		expect(refused.exitCode).toBe(1);
		expect(JSON.parse(refused.stdout)).toMatchObject({ error: { code: "endpoint_credential_forbidden" } });

		const credentialFlag = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
			"--show-endpoint-credential",
		]);
		expect(credentialFlag.exitCode).toBe(2);
		expect(`${credentialFlag.stdout}\n${credentialFlag.stderr}`).not.toContain("session-token");
	}, 60_000);
	it("returns malformed scoped broker rows in the JSON search envelope", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation !== "session.list") return await originalHandleRequest(operation, input, idempotencyKey);
			// Echo the locally resolved scope so the malformed ROW is what fails,
			// not a scope drift the stub accidentally manufactured.
			const request = scopeRequestV1((input as { scope?: unknown }).scope);
			if (!request) throw new Error("Expected a ScopeRequestV1 in the stubbed session.list input.");
			const scope = await resolveScopeRequest(request);
			return {
				ok: true,
				result: {
					indexSeq: 1,
					sessions: [{ sessionId: "malformed", locator: { cwd: root, worktreeRoot: null } }],
					warnings: [],
					scope,
					observedAt: "2026-08-26T00:00:00.000Z",
				},
			};
		};
		try {
			const result = await runSdkCli(root, agentDir, ["search", "--json"]);
			expect(result.exitCode, `search stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({
				version: 1,
				status: "unavailable",
				rows: [],
				error: { code: "malformed_response" },
			});
		} finally {
			broker.handleRequest = originalHandleRequest;
		}
	}, 60_000);

	it("routes semantic inspect, send, status, and tail through Router-owned attachments", async () => {
		const inspect = await runCli(root, agentDir, ["inspect", "live"]);
		expect(inspect.exitCode, inspect.stderr).toBe(0);
		expect(JSON.parse(inspect.stdout)).toMatchObject({
			ok: true,
			result: { version: 2, source: "broker", session: { sessionId: "live" } },
		});

		const send = await runCli(root, agentDir, ["send", "live", "--text", "hello", "--op-ref", "semantic-ref"]);
		expect(send.exitCode, `send stdout=${send.stdout}\nstderr=${send.stderr}`).toBe(0);
		expect(JSON.parse(send.stdout)).toMatchObject({
			ok: true,
			result: {
				operationRef: "semantic-ref",
				status: "accepted",
				receipt: { accepted: true, clientRef: "semantic-ref" },
			},
		});
		expect(receivedControl).toMatchObject({
			operation: "turn.prompt",
			input: { clientRef: "semantic-ref", text: "hello" },
		});

		promptStatuses.set("semantic-ref", { status: "terminal_ok" });
		const status = await runCli(root, agentDir, ["status", "live", "semantic-ref"]);
		expect(status.exitCode, `status stdout=${status.stdout}\nstderr=${status.stderr}`).toBe(0);
		expect(JSON.parse(status.stdout)).toMatchObject({
			ok: true,
			result: { operationRef: "semantic-ref", status: { status: "terminal_ok" }, summary: { completed: true } },
		});

		replayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live" },
			},
		];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "1000"]);
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		expect(JSON.parse(tail.stdout)).toMatchObject({
			ok: true,
			result: {
				version: 2,
				source: "session",
				terminal: true,
				items: [expect.objectContaining({ kind: "turn_end", seq: 1 })],
			},
		});
	}, 60_000);

	for (const strict of [false, true]) {
		it(`starts a fresh ${strict ? "strict" : "non-strict"} tail from an atomic idle checkpoint without a gap`, async () => {
			checkpointRecord = { revision: 0, generation: 1, seq: 0, idle: true };
			const args = ["tail", "live", "--until-idle", "--timeout-ms", "1000"];
			if (strict) args.push("--strict");
			const tail = await runCli(root, agentDir, args);
			expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
			const result = JSON.parse(tail.stdout).result as Record<string, unknown>;
			expect(result.terminal).toBe(true);
			expect(result.checkpoint).toEqual(checkpointRecord);
			expect(result.gap).toBeUndefined();
		}, 60_000);
	}

	for (const strict of [false, true]) {
		it(`projects a real SessionEventStream eviction in ${strict ? "strict" : "non-strict"} mode`, async () => {
			const stream = new SessionEventStream({ generation: 1, ringSize: 2 });
			stream.emit({ kind: "turn_start", payload: { type: "turn_start" } });
			stream.emit({ kind: "turn_end", payload: { type: "turn_end" } });
			stream.emit({ kind: "turn_start", payload: { type: "turn_start" } });
			const evicted = stream.replay(0, 1);
			replayEvents = evicted.events;
			replayGap = evicted.gap;
			checkpointRecord = { revision: 0, generation: 1, seq: 0, idle: false };
			deferredLiveEvents = [
				{ type: "event", generation: 1, seq: 4, kind: "turn_end", payload: { type: "turn_end" } },
			];
			const args = ["tail", "live", "--until-idle", "--timeout-ms", "40000"];
			if (strict) args.push("--strict");
			const tail = await runCli(root, agentDir, args);
			if (strict) {
				expect(tail.exitCode).toBe(1);
				expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, error: { code: "retention_gap" } });
			} else {
				expect(tail.exitCode, tail.stderr).toBe(0);
				const result = JSON.parse(tail.stdout).result;
				expect(result.gap).toMatchObject({ code: "retention_gap", missing: { from: 1, to: 1 } });
				expect(result.items.map((item: Record<string, unknown>) => item.seq)).toEqual([2, 3, 4]);
			}
		}, 90_000);
	}

	it("forwards the exchanged checkpoint token to transcript.list", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 0, idle: true };
		transcriptRows = [{ id: "assistant-1", role: "assistant", content: "saved" }];
		const sourceEnvelope: CursorEnvelope = {
			cursorVersion: 1,
			protocolMajor: 3,
			sessionId: "live",
			resource: "transcript",
			revision: "revision-1",
			highWatermark: checkpointRecord,
			issuedAt: 1,
			expiresAt: Number.MAX_SAFE_INTEGER,
			position: { offset: 0, selector: { queryId: "Q01" } },
			direction: "forward",
			pageShape: { targetBytes: 256 * 1024 },
		};
		const source = signCursor({ ...sourceEnvelope, nonce: "source" }, "tail-e2e-key");
		const replacement = signCursor({ ...sourceEnvelope, nonce: "replacement" }, "tail-e2e-key");
		signedExchange = { source, replacement };
		const tail = await runCli(root, agentDir, [
			"tail",
			"live",
			"--cursor",
			source,
			"--until-idle",
			"--timeout-ms",
			"1000",
		]);
		expect(tail.exitCode, tail.stderr).toBe(0);
		expect(verifyCursor(String(checkpointInputToken), "tail-e2e-key")).toBeDefined();
		expect(checkpointInputToken).toBe(source);
		expect(transcriptCursor).toBe(replacement);
		expect(transcriptCursor).not.toBe("legacy-must-not-win");
		const result = JSON.parse(tail.stdout).result as Record<string, unknown>;
		expect(result.terminal).toBe(true);
		expect(result.gap).toBeUndefined();
	}, 60_000);

	it("keeps --until-idle attached when a replayed terminal turn precedes a newer active turn", async () => {
		// Retained order: turn A already ended, then newer turn B started and is
		// still running. Turn B's terminal event only arrives as a live frame.
		replayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
			},
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];
		deferredLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "20000"]);

		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const result = JSON.parse(tail.stdout).result as { terminal: boolean; items: Array<Record<string, unknown>> };
		// Turn A's replayed terminal must not complete the tail; only turn B's own
		// terminal event may, and prior replayed events stay visible in order.
		expect(result.items.map(item => ({ kind: item.kind, seq: item.seq }))).toEqual([
			{ kind: "turn_end", seq: 1 },
			{ kind: "turn_start", seq: 2 },
			{ kind: "turn_end", seq: 3 },
		]);
		expect(result.terminal).toBe(true);
	}, 60_000);

	it("lets a newer active checkpoint beat an older replayed terminal", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 2, idle: false };
		replayEvents = [{ type: "event", generation: 1, seq: 1, kind: "turn_end", payload: { type: "turn_end" } }];
		deferredLiveEvents = [{ type: "event", generation: 1, seq: 3, kind: "turn_end", payload: { type: "turn_end" } }];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "5000"]);
		expect(tail.exitCode, tail.stderr).toBe(0);
		expect(JSON.parse(tail.stdout).result.items.map((item: Record<string, unknown>) => item.seq)).toEqual([1, 3]);
	}, 60_000);

	it("lets a newer idle checkpoint beat an older replayed start", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 2, idle: true };
		replayEvents = [{ type: "event", generation: 1, seq: 1, kind: "turn_start", payload: { type: "turn_start" } }];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "1000"]);
		expect(tail.exitCode, tail.stderr).toBe(0);
		expect(JSON.parse(tail.stdout).result).toMatchObject({ terminal: true, checkpoint: checkpointRecord });
	}, 60_000);

	it("keeps a newer live start active against an older idle checkpoint", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 1, idle: true };
		explicitReplayEvents = [];
		earlyLiveEvents = [{ type: "event", generation: 1, seq: 2, kind: "turn_start", payload: { type: "turn_start" } }];
		deferredLiveEvents = [{ type: "event", generation: 1, seq: 3, kind: "turn_end", payload: { type: "turn_end" } }];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);
		expect(tail.exitCode, tail.stderr).toBe(0);
		expect(JSON.parse(tail.stdout).result.items.map((item: Record<string, unknown>) => item.seq)).toEqual([2, 3]);
	}, 60_000);

	it("lets a newer live terminal beat an older active checkpoint", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 1, idle: false };
		explicitReplayEvents = [];
		earlyLiveEvents = [{ type: "event", generation: 1, seq: 2, kind: "turn_end", payload: { type: "turn_end" } }];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);
		expect(tail.exitCode, tail.stderr).toBe(0);
		expect(JSON.parse(tail.stdout).result).toMatchObject({ terminal: true });
	}, 60_000);

	it("stamps a positioned pre-checkpoint live frame before deduping its replayed copy", async () => {
		checkpointRecord = { revision: 7, generation: 1, seq: 0, idle: false };
		const duplicatedStart = {
			type: "event",
			generation: 1,
			seq: 1,
			kind: "turn_start",
			payload: { type: "turn_start", sessionId: "live" },
		};
		preCheckpointLiveEvents = [duplicatedStart];
		replayEvents = [duplicatedStart];
		deferredLiveEvents = [{ type: "event", generation: 1, seq: 2, kind: "turn_end", payload: { type: "turn_end" } }];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "5000"]);

		expect(wireLog).toContain("pre_checkpoint_live_sent:turn_start:1");
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const items = (JSON.parse(tail.stdout).result?.items ?? []) as Array<Record<string, unknown>>;
		expect(
			items.filter(
				item => item.kind === "turn_start" && item.revision === 7 && item.generation === 1 && item.seq === 1,
			),
		).toHaveLength(1);
	}, 60_000);

	it("orders lifecycle positions by revision before generation and sequence", async () => {
		checkpointRecord = { revision: 1, generation: 1, seq: 0, idle: false };
		earlyLiveEvents = [
			{
				type: "event",
				revision: 2,
				generation: 1,
				seq: 1,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				revision: 1,
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live" },
			},
		];
		deferredLiveEvents = [
			{
				type: "event",
				revision: 2,
				generation: 1,
				seq: 2,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "5000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const items = (JSON.parse(tail.stdout).result?.items ?? []) as Array<Record<string, unknown>>;
		expect(
			items.map(item => ({ kind: item.kind, revision: item.revision, generation: item.generation, seq: item.seq })),
		).toEqual([
			{ kind: "turn_end", revision: 1, generation: 1, seq: 1 },
			{ kind: "turn_start", revision: 2, generation: 1, seq: 1 },
			{ kind: "turn_end", revision: 2, generation: 1, seq: 2 },
		]);
	}, 60_000);

	// Out-of-band ordering: the Router delivers live frames as they arrive, while
	// the explicit tail replay resolves later. Canonical (generation, seq) order
	// must decide turn state, not the order frames happen to reach the client.
	function assertLiveFramesPrecededReplay(): void {
		const liveSent = wireLog.findIndex(entry => entry.startsWith("live_sent:"));
		const replayResult = wireLog.indexOf("explicit_replay_result");
		expect(wireLog).toContain("explicit_replay_request");
		expect(liveSent).toBeGreaterThanOrEqual(0);
		expect(replayResult).toBeGreaterThanOrEqual(0);
		expect(liveSent).toBeLessThan(replayResult);
	}

	it("keeps session close priority when frame arrival order delivers close first", async () => {
		// Doubles as the delivery control: this tail can only complete because the
		// early live close frame really reached the CLI before the delayed replay.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "session_closed",
				payload: { type: "session_closed", sessionId: "live" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
			},
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		expect(JSON.parse(tail.stdout)).toMatchObject({ ok: true, result: { terminal: true } });
	}, 60_000);

	it("does not complete --until-idle when frame arrival order folds an older terminal last", async () => {
		// Canonical order is turn_end(A, seq1) then turn_start(B, seq2): turn B is
		// active, so the older terminal must not complete the tail even though it
		// is the last event folded.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(1);
		expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, error: { code: "tail_timeout" } });
	}, 60_000);

	it("does not complete --until-idle when a delayed unsequenced terminal follows a newer sequenced start", async () => {
		// The host states no ring position for the replayed terminal, so it cannot
		// be proven to be at or after turn_start(B, seq2). Turn B is the newest
		// event with a canonical position and is still running, so an unsequenced
		// terminal must not complete the tail.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [{ type: "event", kind: "turn_end", payload: { type: "turn_end", sessionId: "live" } }];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(1);
		expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, error: { code: "tail_timeout" } });
	}, 60_000);

	it("fails closed when conflicting lifecycle kinds claim the same canonical position", async () => {
		// A host emitting two different lifecycle kinds at one (generation, seq)
		// states no order between them, so neither arrival order may decide turn
		// state. Both orders must fail closed identically.
		const conflictingStart = {
			type: "event",
			generation: 1,
			seq: 2,
			kind: "turn_start",
			payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
		};
		const conflictingEnd = {
			type: "event",
			generation: 1,
			seq: 2,
			kind: "turn_end",
			payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
		};
		const runConflict = async (
			early: Record<string, unknown>,
			late: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			wireLog = [];
			earlyLiveEvents = [early];
			explicitReplayEvents = [late];
			const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
			assertLiveFramesPrecededReplay();
			const parsed = JSON.parse(tail.stdout) as { ok?: boolean; error?: { code?: string } };
			return { exitCode: tail.exitCode, ok: parsed.ok === true, code: parsed.error?.code };
		};

		const startFirst = await runConflict(conflictingStart, conflictingEnd);
		const endFirst = await runConflict(conflictingEnd, conflictingStart);

		expect({ startFirst, endFirst }).toEqual({
			startFirst: { exitCode: 1, ok: false, code: "protocol_error" },
			endFirst: { exitCode: 1, ok: false, code: "protocol_error" },
		});
	}, 60_000);

	it("emits positioned event items canonically before the unpositioned event segment", async () => {
		// An unpositioned lifecycle item must not anchor positioned items around
		// it: positioned events stay canonical among themselves and precede the
		// arrival-ordered unpositioned segment, which stays visible.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-unpositioned" },
			},
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
			},
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const result = JSON.parse(tail.stdout).result as { terminal: boolean; items: Array<Record<string, unknown>> };
		expect(result.items.map(item => ({ kind: item.kind, seq: item.seq }))).toEqual([
			{ kind: "turn_end", seq: 1 },
			{ kind: "turn_start", seq: 2 },
			{ kind: "turn_end", seq: 3 },
			{ kind: "turn_end", seq: undefined },
		]);
		expect(result.terminal).toBe(true);
	}, 60_000);

	it("keeps unpositioned live events visible after positioned lifecycle items", async () => {
		// Router frames without a publication position are still evidence. They
		// remain in the unpositioned segment and cannot reorder positioned state.
		earlyLiveEvents = [
			{
				type: "event",
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-unpositioned" },
			},
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const result = JSON.parse(tail.stdout).result as { terminal: boolean; items: Array<Record<string, unknown>> };
		expect(result.items.map(item => ({ kind: item.kind, seq: item.seq }))).toEqual([
			{ kind: "turn_start", seq: 2 },
			{ kind: "turn_end", seq: 3 },
			{ kind: "turn_end", seq: undefined },
		]);
		expect(result.terminal).toBe(true);
	}, 60_000);

	it("fails closed on a same-position conflict observed with close in one replay batch", async () => {
		// A protocol conflict outranks a successful close completion, whichever
		// order the two reach the fold within one batch.
		const closeEvent = {
			type: "event",
			generation: 1,
			seq: 9,
			kind: "session_closed",
			payload: { type: "session_closed", sessionId: "live" },
		};
		const conflictPair = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];
		const runBatch = async (events: Record<string, unknown>[]): Promise<Record<string, unknown>> => {
			wireLog = [];
			earlyLiveEvents = [];
			explicitReplayEvents = events;
			const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
			const parsed = JSON.parse(tail.stdout) as { ok?: boolean; error?: { code?: string } };
			return { exitCode: tail.exitCode, ok: parsed.ok === true, code: parsed.error?.code };
		};

		const closeFirst = await runBatch([closeEvent, ...conflictPair]);
		const conflictFirst = await runBatch([...conflictPair, closeEvent]);

		expect({ closeFirst, conflictFirst }).toEqual({
			closeFirst: { exitCode: 1, ok: false, code: "protocol_error" },
			conflictFirst: { exitCode: 1, ok: false, code: "protocol_error" },
		});
	}, 60_000);

	it("keeps transcript and event dedupe domains independent at one projected position", async () => {
		// A transcript row may project the same kind/generation/seq as a real
		// event-ring row. Sharing one dedupe domain lets the transcript claim the
		// key first and suppress the event, erasing lifecycle and conflict
		// evidence. Both source-domain items must survive.
		const transcriptShapedAsEvent = {
			kind: "turn_start",
			generation: 1,
			seq: 2,
			payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
		};
		const eventTurnStart = {
			type: "event",
			generation: 1,
			seq: 2,
			kind: "turn_start",
			payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
		};

		// Both items visible, and the event still drives turn state.
		transcriptRows = [transcriptShapedAsEvent];
		explicitReplayEvents = [
			eventTurnStart,
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];
		const visible = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);
		const visibleParsed = JSON.parse(visible.stdout) as {
			result?: { items?: Array<Record<string, unknown>> };
		};
		const visibleSummary = {
			exitCode: visible.exitCode,
			turnStartCount: (visibleParsed.result?.items ?? []).filter(item => item.kind === "turn_start").length,
			totalItems: (visibleParsed.result?.items ?? []).length,
		};

		// The event ring states a genuine same-position conflict; a transcript row
		// occupying that key must not hide it.
		wireLog = [];
		transcriptRows = [transcriptShapedAsEvent];
		explicitReplayEvents = [
			eventTurnStart,
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];
		const conflict = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
		const conflictParsed = JSON.parse(conflict.stdout) as { error?: { code?: string } };

		expect({
			visibleSummary,
			conflictCode: conflictParsed.error?.code,
		}).toEqual({
			visibleSummary: { exitCode: 0, turnStartCount: 2, totalItems: 3 },
			conflictCode: "protocol_error",
		});
	}, 60_000);

	it("fails closed on malformed event-ring position coordinates", async () => {
		// Only a pair of non-negative safe integers is a canonical position. A
		// partial or invalid claim is not silently downgraded to unpositioned.
		const malformedClaims: Array<{ name: string; event: Record<string, unknown> }> = [
			{ name: "generation only", event: { generation: 1 } },
			{ name: "seq only", event: { seq: 2 } },
			{ name: "negative seq", event: { generation: 1, seq: -1 } },
			{ name: "negative generation", event: { generation: -1, seq: 2 } },
			{ name: "fractional seq", event: { generation: 1, seq: 2.5 } },
			{ name: "unsafe integer seq", event: { generation: 1, seq: 2 ** 53 } },
			{ name: "non-finite seq serialized", event: { generation: 1, seq: Number.POSITIVE_INFINITY } },
		];

		const observed: Array<{ name: string; exitCode: number; code: string | undefined }> = [];
		for (const claim of malformedClaims) {
			wireLog = [];
			transcriptRows = [];
			explicitReplayEvents = [
				{
					type: "event",
					kind: "turn_end",
					...claim.event,
					payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
				},
			];
			const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
			const parsed = JSON.parse(tail.stdout) as { error?: { code?: string } };
			observed.push({ name: claim.name, exitCode: tail.exitCode, code: parsed.error?.code });
		}

		expect(observed).toEqual(
			malformedClaims.map(claim => ({ name: claim.name, exitCode: 1, code: "protocol_error" })),
		);
	}, 120_000);

	it("fails closed on raw null event-ring position claims that projection would drop", async () => {
		// `toTailItemV1` keeps a coordinate only when it is already a number, so a
		// raw null claim loses property presence and would otherwise be accepted as
		// genuinely unpositioned. Validation must see the raw claim.
		const rawClaims: Array<{ name: string; event: Record<string, unknown>; wire: string }> = [
			{ name: "generation null, seq absent", event: { generation: null }, wire: '"generation":null' },
			{ name: "seq null, generation absent", event: { seq: null }, wire: '"seq":null' },
			{
				name: "generation null and seq null",
				event: { generation: null, seq: null },
				wire: '"generation":null,"seq":null',
			},
			{
				name: "both non-finite serialize to null",
				event: { generation: Number.POSITIVE_INFINITY, seq: Number.NaN },
				wire: '"generation":null,"seq":null',
			},
		];

		const observed: Array<{ name: string; exitCode: number; code: string | undefined; wireCarriedClaim: boolean }> =
			[];
		for (const claim of rawClaims) {
			wireLog = [];
			transcriptRows = [];
			lastReplayPayload = "";
			explicitReplayEvents = [
				{
					type: "event",
					kind: "turn_end",
					...claim.event,
					payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
				},
			];
			const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
			const parsed = JSON.parse(tail.stdout) as { error?: { code?: string } };
			observed.push({
				name: claim.name,
				exitCode: tail.exitCode,
				code: parsed.error?.code,
				// Proves the failure is acceptance of a transmitted raw claim, not a
				// fixture that never put the coordinate on the wire.
				wireCarriedClaim: lastReplayPayload.includes(claim.wire),
			});
		}

		expect(observed).toEqual(
			rawClaims.map(claim => ({
				name: claim.name,
				exitCode: 1,
				code: "protocol_error",
				wireCarriedClaim: true,
			})),
		);
	}, 120_000);

	it("fails closed when a close kind conflicts with another lifecycle kind at one position", async () => {
		// Close kinds are consumed by tail semantics, so they must claim their
		// canonical position like any other lifecycle kind. Otherwise a close at a
		// contested position silently wins instead of failing closed.
		const at = (kind: string, seq: number): Record<string, unknown> => ({
			type: "event",
			generation: 1,
			seq,
			kind,
			payload: { type: kind, sessionId: "live", turnId: "turn-b" },
		});
		const conflictPairs: Array<[string, string]> = [
			["session_closed", "turn_start"],
			["session_closed", "turn_end"],
			["session_closed", "session_terminated"],
		];

		const runBatch = async (events: Record<string, unknown>[]): Promise<Record<string, unknown>> => {
			wireLog = [];
			transcriptRows = [];
			earlyLiveEvents = [];
			explicitReplayEvents = events;
			const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
			const parsed = JSON.parse(tail.stdout) as { ok?: boolean; error?: { code?: string } };
			return { exitCode: tail.exitCode, code: parsed.error?.code };
		};

		const observed: Array<Record<string, unknown>> = [];
		for (const [closeKind, otherKind] of conflictPairs) {
			observed.push({
				case: `${closeKind} then ${otherKind}`,
				...(await runBatch([at(closeKind, 2), at(otherKind, 2)])),
			});
			observed.push({
				case: `${otherKind} then ${closeKind}`,
				...(await runBatch([at(otherKind, 2), at(closeKind, 2)])),
			});
		}

		// Control: the same two kinds at distinct positions are not a conflict, so
		// both are delivered and visible — the conflict cases above therefore fail
		// on the shared position, not on a fixture that dropped an event.
		wireLog = [];
		transcriptRows = [];
		earlyLiveEvents = [];
		explicitReplayEvents = [at("turn_start", 2), at("session_closed", 3)];
		const control = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
		const controlItems = ((JSON.parse(control.stdout).result?.items ?? []) as Array<Record<string, unknown>>).map(
			item => ({ kind: item.kind, seq: item.seq }),
		);

		// Control: a same-kind duplicate close at one position stays normal dedupe.
		wireLog = [];
		transcriptRows = [];
		earlyLiveEvents = [];
		explicitReplayEvents = [at("session_closed", 2), at("session_closed", 2)];
		const duplicate = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "2000"]);
		const duplicateParsed = JSON.parse(duplicate.stdout) as {
			result?: { items?: Array<Record<string, unknown>> };
		};

		expect({
			observed,
			controlItems,
			duplicate: {
				exitCode: duplicate.exitCode,
				closeItems: (duplicateParsed.result?.items ?? []).filter(item => item.kind === "session_closed").length,
			},
		}).toEqual({
			observed: conflictPairs.flatMap(([closeKind, otherKind]) => [
				{ case: `${closeKind} then ${otherKind}`, exitCode: 1, code: "protocol_error" },
				{ case: `${otherKind} then ${closeKind}`, exitCode: 1, code: "protocol_error" },
			]),
			controlItems: [
				{ kind: "turn_start", seq: 2 },
				{ kind: "session_closed", seq: 3 },
			],
			duplicate: { exitCode: 0, closeItems: 1 },
		});
	}, 180_000);

	it("fails closed when live lifecycle evidence conflicts with delayed replay", async () => {
		// The Router delivers the live claim before the explicit replay response;
		// the replayed claim must still fail closed rather than letting arrival
		// order or an idle shortcut decide the lifecycle.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "5000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(1);
		expect(JSON.parse(tail.stdout)).toMatchObject({ ok: false, error: { code: "protocol_error" } });
	}, 60_000);

	it("completes --until-idle in canonical order when frame arrival order delivers the newer terminal first", async () => {
		// Canonical order is turn_end(A,1), turn_start(B,2), turn_end(B,3): turn B
		// reached its own terminal, so the tail completes and reports canonical
		// order rather than the [3,1,2] order the frames arrived in.
		earlyLiveEvents = [
			{
				type: "event",
				generation: 1,
				seq: 3,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-b" },
			},
		];
		explicitReplayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live", turnId: "turn-a" },
			},
			{
				type: "event",
				generation: 1,
				seq: 2,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live", turnId: "turn-b" },
			},
		];

		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		assertLiveFramesPrecededReplay();
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const result = JSON.parse(tail.stdout).result as { terminal: boolean; items: Array<Record<string, unknown>> };
		expect(result.items.map(item => ({ kind: item.kind, seq: item.seq }))).toEqual([
			{ kind: "turn_end", seq: 1 },
			{ kind: "turn_start", seq: 2 },
			{ kind: "turn_end", seq: 3 },
		]);
		expect(result.terminal).toBe(true);
	}, 60_000);

	it("bounds offline retained-transcript tail reads for a synthetic 300 MiB history", async () => {
		const encoder = new TextEncoder();
		const retainedTail = encoder.encode(
			`${Array.from({ length: 240 }, (_, index) =>
				JSON.stringify({ id: `tail-${index}`, payload: "x".repeat(32) }),
			).join("\n")}\n`,
		);
		const prefixBytes = 300 * 1024 * 1024;
		const size = prefixBytes + retainedTail.byteLength;
		const reads: Array<{ start: number; end: number }> = [];
		const entries = await scanRetainedTranscriptTail({
			size,
			readRange: async (start, end) => {
				reads.push({ start, end });
				const result = new Uint8Array(end - start);
				const overlapStart = Math.max(start, prefixBytes);
				const overlapEnd = Math.min(end, size);
				if (overlapStart < overlapEnd)
					result.set(
						retainedTail.subarray(overlapStart - prefixBytes, overlapEnd - prefixBytes),
						overlapStart - start,
					);
				return result;
			},
		});
		expect(entries).toHaveLength(200);
		expect(entries[0]).toMatchObject({ id: "tail-40" });
		expect(entries.at(-1)).toMatchObject({ id: "tail-239" });
		expect(reads.reduce((total, read) => total + read.end - read.start, 0)).toBeLessThan(1024 * 1024);
		expect(reads.every(read => read.start >= prefixBytes - 1024 * 1024)).toBe(true);

		const corrupt = encoder.encode('{"id":"valid"}\nnot-json\n');
		await expect(
			scanRetainedTranscriptTail({
				size: corrupt.byteLength,
				readRange: async (start, end) => corrupt.slice(start, end),
			}),
		).rejects.toThrow("Retained transcript history contains unparseable entries");
	});

	it("replays an unchanged Broker-identified offline transcript", async () => {
		const session = await createStoppedSavedSession();
		const result = await runCli(root, agentDir, ["tail", session.id]);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: { version: 2, source: "offline", session: { sessionId: session.id }, terminal: true },
		});
	}, 60_000);
	it("fails closed when the Broker-selected offline transcript is rewritten in place with restored metadata", async () => {
		const retainedTimestamp = 1_700_000_000;
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(
			async session => {
				const before = await fs.stat(session.path, { bigint: true });
				const original = await Bun.file(session.path).text();
				const rewrittenId = `${session.id.slice(0, -1)}${session.id.endsWith("x") ? "y" : "x"}`;
				const rewritten = original.replace(session.id, rewrittenId);
				expect(rewritten).not.toBe(original);
				await fs.writeFile(session.path, rewritten);
				await fs.utimes(session.path, retainedTimestamp, retainedTimestamp);
				const after = await fs.stat(session.path, { bigint: true });
				expect(after.dev).toBe(before.dev);
				expect(after.ino).toBe(before.ino);
				expect(after.nlink).toBe(before.nlink);
				expect(after.size).toBe(before.size);
				expect(after.mtimeMs).toBe(before.mtimeMs);
				expect(after.mtimeNs).toBe(before.mtimeNs);
				expect(after.ctimeNs).not.toBe(before.ctimeNs);
			},
			async session => {
				await fs.utimes(session.path, retainedTimestamp, retainedTimestamp);
			},
		);
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: "retention_gap", details: { code: "retention_gap", reason: "changed" } },
		});
	}, 60_000);

	it("fails closed when the Broker-selected offline transcript is replaced before open", async () => {
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			const replacement = path.join(root, "attacker-replacement.jsonl");
			await fs.writeFile(replacement, '{"type":"session","id":"attacker"}\n{"marker":"attacker"}\n');
			await fs.rename(replacement, session.path);
		});
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: "retention_gap", details: { code: "retention_gap", reason: "changed" } },
		});
		expect(result.stdout).not.toContain("attacker");
	}, 60_000);

	it("rejects a symlink substituted for the Broker-selected offline transcript", async () => {
		if (process.platform === "win32") return;
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			const target = path.join(root, "attacker-symlink-target.jsonl");
			await fs.writeFile(target, '{"type":"session","id":"attacker"}\n{"marker":"attacker"}\n');
			await fs.unlink(session.path);
			await fs.symlink(target, session.path);
		});
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "retention_gap" } });
		expect(result.stdout).not.toContain("attacker");
	}, 60_000);

	it("rejects a FIFO substituted for the Broker-selected offline transcript without blocking", async () => {
		if (process.platform === "win32") return;
		const startedAt = Date.now();
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			await fs.unlink(session.path);
			const fifo = Bun.spawn(["mkfifo", session.path], { stdout: "ignore", stderr: "ignore" });
			expect(await fifo.exited).toBe(0);
		});
		expect(selections).toBe(1);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "retention_gap" } });
	}, 60_000);

	it("drains SDK session CLI session.list continuation pages before returning sessions", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [stubRow("page-one")], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: [stubRow("page-two")] } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list", "--scope", "all"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "page-one" }, { sessionId: "page-two" }] },
		});
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("rejects a failed SDK session CLI session.list continuation without returning page one", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [stubRow("page-one")], continuationCursor: "page-2" } }
					: { ok: false, error: { code: "continuation_failed", message: "page two failed" } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list", "--scope", "all"]);
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({ ok: false, error: { code: "continuation_failed", message: "page two failed" } });
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("rejects repeated SDK session CLI session.list cursors without partial output", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return {
					ok: true,
					result: { sessions: [stubRow("page")], continuationCursor: "repeat" },
				};
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list", "--scope", "all"]);

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a repeated continuation cursor." },
		});
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "repeat" }]);
	}, 60_000);

	it("rejects malformed SDK session CLI session.list continuation pages without partial output", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [stubRow("page-one")], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: "not-an-array" } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list", "--scope", "all"]);

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a malformed page." },
		});
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("selects the broker specified by --agent-dir over the ambient agent directory", async () => {
		const alternateAgentDir = path.join(root, "alternate-agent");
		const alternateBroker = new Broker({ agentDir: alternateAgentDir });
		await alternateBroker.start();
		try {
			await alternateBroker.index.append({
				type: "host_registered",
				sessionId: "alternate",
				locator: { cwd: root, worktreeRoot: null, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
			});

			const result = await runCli(root, agentDir, ["list", "--scope", "all", "--agent-dir", alternateAgentDir]);
			expect(result.exitCode).toBe(0);
			expect(
				(JSON.parse(result.stdout).result.sessions as Array<{ sessionId: string }>).map(
					session => session.sessionId,
				),
			).toEqual(["alternate"]);
		} finally {
			await alternateBroker.stop();
		}
	}, 60_000);

	it("requires a caller lifecycle idempotency key before broker connection", async () => {
		const result = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.create",
			"--json-input",
			`{"cwd":${JSON.stringify(root)}}`,
		]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "invalid_input" } });
	}, 60_000);

	it("fails closed on corrupt endpoint records without exposing discovery details", async () => {
		await fs.writeFile(path.join(stateRoot, "sdk", "live.json"), "not-json");
		const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "session_unavailable" } });
		expect(endpointConnections).toBe(0);
	}, 60_000);

	it("fails closed on unreadable endpoint records without exposing discovery details", async () => {
		if (process.platform === "win32") return;
		const endpoint = path.join(stateRoot, "sdk", "live.json");
		await fs.chmod(endpoint, 0o000);
		try {
			const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "session_unavailable" } });
			expect(endpointConnections).toBe(0);
		} finally {
			await fs.chmod(endpoint, 0o600);
		}
	}, 60_000);
});
