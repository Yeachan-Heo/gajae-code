import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

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

/** Spawns `gjc <argv...>` with the fixture agent dir in the environment. */
async function runCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-cli-capture-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	const stdoutFd = openSync(stdoutPath, "w");
	const stderrFd = openSync(stderrPath, "w");
	try {
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, ...args], {
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

type PromptStatusRecord = { status: string; [key: string]: unknown };

describe("SDK session CLI (gjc sdk session)", () => {
	let root: string;
	let agentDir: string;
	let stateRoot: string;
	let endpointServer: ReturnType<typeof Bun.serve>;
	let broker: Broker;
	let receivedControl: Record<string, unknown> | undefined;
	let endpointConnections = 0;
	let promptFrames = 0;
	let promptReceipts = new Map<string, Record<string, unknown>>();
	let promptStatuses = new Map<string, PromptStatusRecord>();
	let checkpointResult: unknown;
	let transcriptItems: unknown[];
	let replayEvents: unknown[];
	let replayGap: unknown;

	beforeEach(async () => {
		endpointConnections = 0;
		promptFrames = 0;
		receivedControl = undefined;
		replayGap = undefined;
		promptReceipts = new Map();
		promptStatuses = new Map();
		checkpointResult = {
			checkpointToken: '{"revision":2,"generation":1,"seq":4}',
			checkpoint: { revision: 2, generation: 1, seq: 4 },
			nonce: "nonce-1",
			cursor: "cursor:checkpoint:2",
			revision: 2,
		};
		transcriptItems = [
			{ id: "t1", role: "user", content: "hello" },
			{ id: "t2", role: "assistant", content: "hi" },
		];
		replayEvents = [];
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-cli-"));
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
					if (frame.type === "control_request") {
						receivedControl = frame;
						if (frame.operation === "turn.prompt") {
							const input = (frame.input ?? {}) as Record<string, unknown>;
							const clientRef = typeof input.clientRef === "string" ? input.clientRef : undefined;
							const existing = clientRef === undefined ? undefined : promptReceipts.get(clientRef);
							// The host answers repeats from its clientRef-indexed receipt; the
							// mock counts only prompts it actually executes (one per ref).
							if (existing === undefined) promptFrames++;
							const receipt =
								existing ??
								({
									commandId: `cmd-${promptFrames}`,
									turnId: `turn-${promptFrames}`,
									accepted: true,
									...(clientRef !== undefined ? { clientRef } : {}),
								} satisfies Record<string, unknown>);
							if (clientRef !== undefined && existing === undefined) promptReceipts.set(clientRef, receipt);
							socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: receipt }));
							return;
						}
						socket.send(
							JSON.stringify({
								type: "control_response",
								id: frame.id,
								ok: false,
								error: { code: "unknown_operation", message: "unknown operation" },
							}),
						);
						return;
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
						if (frame.query === "turn.prompt_status") {
							const input = (frame.input ?? {}) as Record<string, unknown>;
							const clientRef = typeof input.clientRef === "string" ? input.clientRef : undefined;
							const status = clientRef === undefined ? undefined : promptStatuses.get(clientRef);
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: status ?? { status: "unknown" },
								}),
							);
							return;
						}
						if (frame.query === "session.checkpoint") {
							socket.send(
								JSON.stringify({ type: "query_response", id: frame.id, ok: true, result: checkpointResult }),
							);
							return;
						}
						if (frame.query === "transcript.list") {
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									page: { items: transcriptItems, complete: true, revision: "r1" },
								}),
							);
							return;
						}
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: false,
								error: { code: "unknown_operation", message: "unknown operation" },
							}),
						);
						return;
					}
					if (frame.type === "event_replay") {
						socket.send(
							JSON.stringify({
								type: "event_replay_result",
								id: frame.id,
								ok: true,
								events: replayEvents,
								...(replayGap === undefined ? {} : { gap: replayGap }),
								generation: 1,
								lastSeq: 4,
							}),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: false,
							error: { code: "unknown_operation", message: "unknown operation" },
						}),
					);
				},
			},
		});
		await fs.mkdir(path.dirname(path.join(stateRoot, "sdk", "live.json")), { recursive: true });
		broker = new Broker({ agentDir, packageGeneration: "test" });
		await broker.start();
		await registerSession("live", "live.json");
	});

	async function registerSession(sessionId: string, fileName: string): Promise<void> {
		const endpointPath = path.join(stateRoot, "sdk", fileName);
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({
				sessionId,
				pid: process.pid,
				url: `ws://127.0.0.1:${endpointServer.port}`,
				token: "session-token",
			}),
		);
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
	}

	afterEach(async () => {
		await broker.stop();
		await endpointServer.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	it("SDK-L-G02: lists broker sessions through versioned, credential-free DTO rows", async () => {
		const list = await runCli(root, agentDir, ["sdk", "session", "list"]);
		expect(list.exitCode, `list stdout=${list.stdout}\nstderr=${list.stderr}`).toBe(0);
		expect(JSON.parse(list.stdout)).toMatchObject({
			ok: true,
			result: {
				version: 1,
				source: "broker",
				sessions: [expect.objectContaining({ sessionId: "live", live: true, deleted: false })],
			},
		});
		expect(list.stdout).not.toContain("session-token");
		expect(list.stdout).not.toContain("ws://127.0.0.1");
	}, 60_000);

	it("SDK-L-G03: routes semantic verbs through the broker and the explicit raw hatch", async () => {
		const inspect = await runCli(root, agentDir, ["sdk", "session", "inspect", "live"]);
		expect(inspect.exitCode, `inspect stdout=${inspect.stdout}\nstderr=${inspect.stderr}`).toBe(0);
		expect(JSON.parse(inspect.stdout)).toMatchObject({
			ok: true,
			result: { version: 1, source: "broker", session: expect.objectContaining({ sessionId: "live" }) },
		});
		expect(inspect.stdout).not.toContain("session-token");

		const control = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
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
		expect(endpointConnections).toBe(0);
		expect(JSON.parse(control.stdout)).toMatchObject({ error: { code: "unknown_operation" } });
		expect(control.stderr).not.toContain("session-token");

		const query = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"query",
			"live",
			"--query",
			"session.metadata",
			"--json-input",
			"{}",
		]);
		expect(query.exitCode, `query stdout=${query.stdout}\nstderr=${query.stderr}`).toBe(0);
		expect(JSON.parse(query.stdout)).toMatchObject({ ok: true, result: { sessionId: "live" } });
	}, 60_000);

	it("SDK-L-G04: rejects the removed daemon session route without an alias", async () => {
		const result = await runCli(root, agentDir, ["daemon", "session", "list"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toMatch(/Expected action to be one of/);
		expect(result.stderr).toContain('got "session"');
	}, 60_000);

	it("SDK-L-G05: gates raw endpoint credential output and never leaks it to stderr", async () => {
		const refused = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
		]);
		expect(refused.exitCode).toBe(1);
		expect(JSON.parse(refused.stdout)).toMatchObject({ error: { code: "endpoint_credential_forbidden" } });

		const disclosed = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
			"--show-endpoint-credential",
			"--yes",
		]);
		expect(disclosed.exitCode).toBe(0);
		expect(disclosed.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(disclosed.stdout)).toMatchObject({ ok: true, result: { token: "session-token" } });
		expect(disclosed.stderr).not.toContain("session-token");
	}, 60_000);

	it("reads secure raw JSON input files while rejecting permissive files", async () => {
		const inputPath = path.join(root, "endpoint-input.json");
		await Bun.write(inputPath, '{"sessionId":"live"}');
		await fs.chmod(inputPath, 0o600);
		const secure = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input-file",
			inputPath,
			"--show-endpoint-credential",
			"--yes",
		]);
		expect(secure.exitCode).toBe(0);
		expect(JSON.parse(secure.stdout)).toMatchObject({ ok: true, result: { token: "session-token" } });

		await fs.chmod(inputPath, 0o644);
		const permissive = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input-file",
			inputPath,
			"--show-endpoint-credential",
			"--yes",
		]);
		expect(permissive.exitCode).toBe(2);
		expect(JSON.parse(permissive.stdout)).toMatchObject({ error: { code: "input_file_permissions" } });
	}, 60_000);

	it("drains daemon CLI session.list continuation pages before returning sessions", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: [{ sessionId: "page-two" }] } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["sdk", "session", "list"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "page-one" }, { sessionId: "page-two" }] },
		});
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("rejects a failed daemon CLI session.list continuation without returning page one", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
					: { ok: false, error: { code: "continuation_failed", message: "page two failed" } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["sdk", "session", "list"]);
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({ ok: false, error: { code: "continuation_failed", message: "page two failed" } });
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("selects the broker specified by --agent-dir over the ambient agent directory", async () => {
		const alternateAgentDir = path.join(root, "alternate-agent");
		const alternateBroker = new Broker({ agentDir: alternateAgentDir, packageGeneration: "test" });
		await alternateBroker.start();
		try {
			await alternateBroker.index.append({
				type: "host_registered",
				sessionId: "alternate",
				locator: { repo: root, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
			});

			const result = await runCli(root, agentDir, ["sdk", "session", "list", "--agent-dir", alternateAgentDir]);
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

	it("SDK-L-G06: requires a caller lifecycle idempotency key before broker connection", async () => {
		const result = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.create",
			"--json-input",
			`{"cwd":${JSON.stringify(root)}}`,
		]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "invalid_input" } });
	}, 60_000);

	it("SDK-L-G07: send accepts an operation ref and repeats return the same receipt", async () => {
		const first = await runCli(root, agentDir, [
			"sdk",
			"session",
			"send",
			"live",
			"--text",
			"hello",
			"--op-ref",
			"01J1R2V3X4Y5Z6A7B8C9D0E1F2",
			"--agent-dir",
			agentDir,
		]);
		expect(first.exitCode, `send stdout=${first.stdout}\nstderr=${first.stderr}`).toBe(0);
		expect(JSON.parse(first.stdout)).toMatchObject({
			ok: true,
			result: {
				version: 1,
				operationRef: "01J1R2V3X4Y5Z6A7B8C9D0E1F2",
				status: "accepted",
				receipt: { accepted: true, clientRef: "01J1R2V3X4Y5Z6A7B8C9D0E1F2" },
			},
		});

		const second = await runCli(root, agentDir, [
			"sdk",
			"session",
			"send",
			"live",
			"--text",
			"hello",
			"--op-ref",
			"01J1R2V3X4Y5Z6A7B8C9D0E1F2",
			"--agent-dir",
			agentDir,
		]);
		expect(second.exitCode, `send stdout=${second.stdout}\nstderr=${second.stderr}`).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({
			ok: true,
			result: { operationRef: "01J1R2V3X4Y5Z6A7B8C9D0E1F2" },
		});
		// The host answered the repeat from its clientRef-indexed receipt: one prompt frame total.
		expect(promptFrames).toBe(1);
	}, 60_000);

	it("SDK-L-G08: send --wait times out with wait_timeout and never cancels", async () => {
		const result = await runCli(root, agentDir, [
			"sdk",
			"session",
			"send",
			"live",
			"--text",
			"hello",
			"--wait",
			"--timeout-ms",
			"250",
			"--agent-dir",
			agentDir,
		]);
		expect(result.exitCode).toBe(1);
		const payload = JSON.parse(result.stdout) as {
			error?: { code?: unknown; details?: { operationRef?: unknown; status?: unknown } };
		};
		expect(payload.error?.code).toBe("wait_timeout");
		expect(payload.error?.details?.operationRef).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(typeof payload.error?.details?.status).toBe("string");
		// No cancellation frame was ever sent for the timed-out prompt.
		expect(receivedControl).toMatchObject({ operation: "turn.prompt" });
		expect(promptFrames).toBe(1);
	}, 60_000);

	it("SDK-L-G09: status renders lossless terminal detail with a convenience summary", async () => {
		promptStatuses.set("ref-ok", {
			status: "terminal_ok",
			commandId: "cmd-1",
			turnId: "turn-1",
			clientRef: "ref-ok",
			acceptedAt: 1,
			terminalAt: 2,
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		});
		const result = await runCli(root, agentDir, ["sdk", "session", "status", "live", "ref-ok"]);
		expect(result.exitCode, `status stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: {
				version: 1,
				operationRef: "ref-ok",
				summary: { completed: true },
				status: {
					status: "terminal_ok",
					outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
				},
			},
		});
	}, 60_000);

	it("SDK-L-G10: tail replays retained history for a terminal session and exits 0", async () => {
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: "live",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		});
		transcriptItems = [
			{ id: "t1", role: "user", content: "old prompt" },
			{ id: "t2", role: "assistant", content: "old answer" },
		];
		const result = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--agent-dir", agentDir]);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			result?: { version?: unknown; source?: unknown; items?: unknown[]; terminal?: unknown; checkpoint?: unknown };
		};
		expect(payload.result?.version).toBe(1);
		expect(payload.result?.source).toBe("session");
		expect(payload.result?.terminal).toBe(true);
		expect(payload.result?.checkpoint).toEqual({ revision: 2, generation: 1, seq: 4 });
		expect(payload.result?.items).toHaveLength(2);
		expect(payload.result?.items?.[0]).toMatchObject({ kind: "transcript", id: "t1" });
	}, 60_000);

	it("SDK-L-G11: tail --until-idle exits 0 after the terminal turn event and honors --all-events", async () => {
		replayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 5,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live" },
			},
			{
				type: "event",
				generation: 1,
				seq: 6,
				kind: "agent_start",
				payload: { type: "agent_start", sessionId: "live" },
			},
			{
				type: "event",
				generation: 1,
				seq: 7,
				kind: "agent_end",
				payload: { type: "agent_end", sessionId: "live" },
			},
			{
				type: "event",
				generation: 1,
				seq: 8,
				kind: "action_needed",
				payload: { type: "action_needed", id: "ask-1", kind: "ask" },
			},
		];
		const plain = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--until-idle"]);
		expect(plain.exitCode, `tail stdout=${plain.stdout}\nstderr=${plain.stderr}`).toBe(0);
		const plainPayload = JSON.parse(plain.stdout) as { result?: { items?: unknown[]; terminal?: unknown } };
		expect(plainPayload.result?.terminal).toBe(true);
		const plainKinds = (plainPayload.result?.items ?? []).map(item => (item as { kind?: unknown }).kind);
		expect(plainKinds).toContain("agent_end");
		// Non-tail event kinds are excluded unless --all-events is passed.
		expect(plainKinds).not.toContain("action_needed");

		const all = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--until-idle", "--all-events"]);
		expect(all.exitCode, `tail stdout=${all.stdout}\nstderr=${all.stderr}`).toBe(0);
		const allKinds = ((JSON.parse(all.stdout) as { result?: { items?: unknown[] } }).result?.items ?? []).map(
			item => (item as { kind?: unknown }).kind,
		);
		expect(allKinds).toContain("action_needed");
	}, 60_000);
	it("SDK-L-G14: tail keeps distinct same-kind no-id events (dedupe by generation/seq)", async () => {
		// Two same-kind no-id events with different seq values must both be
		// delivered: dedupe keys are generation/seq (plus stable transcript ids),
		// never kind+id which would silently drop the second turn_start.
		replayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 5,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live" },
			},
			{
				type: "event",
				generation: 1,
				seq: 6,
				kind: "turn_start",
				payload: { type: "turn_start", sessionId: "live" },
			},
			{
				type: "event",
				generation: 1,
				seq: 7,
				kind: "agent_end",
				payload: { type: "agent_end", sessionId: "live" },
			},
		];
		const result = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--until-idle"]);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			result?: { items?: Array<{ kind?: string; seq?: number }> };
		};
		const kinds = (payload.result?.items ?? []).map(item => item.kind);
		expect(kinds.filter(kind => kind === "turn_start")).toHaveLength(2);
		expect(kinds).toContain("agent_end");
		// Retained transcript entries (2) plus all three ring events.
		expect(payload.result?.items).toHaveLength(5);
	}, 60_000);

	it("SDK-L-G12: tail --strict fails closed with retention_gap on a checkpoint gap", async () => {
		checkpointResult = {
			gap: {
				code: "retention_gap",
				missing: { from: 1, to: 2 },
				resync: { revision: 3, generation: 2, seq: 5 },
			},
		};
		const result = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--strict"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			error: { code: "retention_gap", details: { code: "retention_gap" } },
		});
	}, 60_000);

	it("SDK-L-G12b: tail --strict fails closed on event-ring sequence gaps", async () => {
		replayGap = { kind: "sequence_gap", fromSeq: 2, toSeq: 3, resyncQueries: ["Q01"] };
		const result = await runCli(root, agentDir, ["sdk", "session", "tail", "live", "--strict"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			error: { code: "retention_gap", details: { code: "retention_gap", missing: { from: 2, to: 3 } } },
		});
	}, 60_000);

	it("SDK-L-G15: raw lifecycle responses redact endpoint credentials by default", async () => {
		const original = broker.handleRequest.bind(broker);
		broker.handleRequest = async (operation, input, idempotencyKey, elevationRequestId) =>
			operation === "session.create"
				? {
						ok: true,
						result: { sessionId: "created", endpoint: { url: "ws://127.0.0.1:1", token: "secret-token" } },
					}
				: original(operation, input, idempotencyKey, elevationRequestId);
		const result = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.create",
			"--json-input",
			"{}",
			"--idempotency-key",
			"credential-redaction",
			"--agent-dir",
			agentDir,
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("secret-token");
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { endpoint: { url: "ws://127.0.0.1:1" } } });
	}, 60_000);

	it("SDK-L-G13: reports a typed broker-unavailable error when the broker is absent", async () => {
		const absentAgentDir = path.join(root, "absent-agent");
		const dead = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("", { status: 500 }),
		});
		const deadPort = dead.port;
		if (deadPort === undefined) throw new Error("Test server did not bind a port.");
		await dead.stop(true);
		await writeBrokerDiscovery(absentAgentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "absent-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: deadPort,
			url: `ws://127.0.0.1:${deadPort}`,
			token: "absent-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
		const result = await runCli(root, absentAgentDir, ["sdk", "session", "list", "--agent-dir", absentAgentDir]);
		expect(result.exitCode, `list stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "reconnect_exhausted" } });
		expect(result.stdout).not.toContain("absent-token");
	}, 60_000);

	it("SDK-L-G14: preserves broker endpoint refusal errors without connecting to the session", async () => {
		await fs.writeFile(path.join(stateRoot, "sdk", "live.json"), "not-json");
		const result = await runCli(root, agentDir, [
			"sdk",
			"session",
			"raw",
			"query",
			"live",
			"--query",
			"session.metadata",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "unavailable" } });
		expect(endpointConnections).toBe(0);
	}, 60_000);

	it("SDK-L-G15: preserves unreadable endpoint refusal errors without connecting", async () => {
		if (process.platform === "win32") return;
		const endpoint = path.join(stateRoot, "sdk", "live.json");
		await fs.chmod(endpoint, 0o000);
		try {
			const result = await runCli(root, agentDir, [
				"sdk",
				"session",
				"raw",
				"query",
				"live",
				"--query",
				"session.metadata",
			]);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "unavailable" } });
			expect(endpointConnections).toBe(0);
		} finally {
			await fs.chmod(endpoint, 0o600);
		}
	}, 60_000);
});
