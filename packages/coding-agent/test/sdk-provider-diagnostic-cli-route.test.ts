import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { APIError } from "@anthropic-ai/sdk";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AssistantMessage, Context, Model } from "@gajae-code/ai";
import { streamAnthropic } from "@gajae-code/ai";
import type { Server } from "bun";
import { Broker } from "../src/sdk/broker/broker";
import type { KindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import { createReconciliationStore } from "../src/sdk/bus/reconciliation-store";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import type { SdkFrame } from "../src/sdk/host/types";
import { SessionManager } from "../src/session/session-manager";

/**
 * Acceptance for the LAST hop: a real `gjc` CLI process, run against a
 * task-owned broker and a task-owned fixture host, must print exactly the
 * diagnostic the real adapter produced — and must print none when the record
 * carries a legacy or malformed one. The payload the fixture host serves is the
 * product's own reconciliation projection, not hand-written output.
 */

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

/** The CLI resolves a project root; a bare temp directory is not one. */
async function initializeTestRepository(repo: string): Promise<void> {
	const result = Bun.spawn(["git", "init", "--quiet"], { cwd: repo, stdout: "ignore", stderr: "pipe" });
	if ((await result.exited) !== 0) throw new Error(await new Response(result.stderr).text());
}
const SECRET_MARKER = "sk-ant-secret-DO-NOT-LEAK";

const AUTH_DIAGNOSTIC = {
	category: "auth",
	httpStatus: 401,
	code: "authentication_error",
	evidence: "structured_code",
} as const;

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const correlation = { commandId: "c1", turnId: "t1" };

type CliResult = { exitCode: number; stdout: string; stderr: string };

function closeCaptureFd(fd: number): void {
	try {
		closeSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== "EBADF") throw error;
	}
}

/** Capture through files: a piped short-lived child can be masked by SIGPIPE. */
async function runCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-diagnostic-cli-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	const stdoutFd = openSync(stdoutPath, "w");
	const stderrFd = openSync(stderrPath, "w");
	try {
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session", ...args, "--json"], {
			cwd: repo,
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
			stdout: stdoutFd,
			stderr: stderrFd,
		});
		const exitCode = await child.exited;
		closeCaptureFd(stdoutFd);
		closeCaptureFd(stderrFd);
		return {
			exitCode,
			stdout: await fs.readFile(stdoutPath, "utf8"),
			stderr: await fs.readFile(stderrPath, "utf8"),
		};
	} finally {
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

/** Terminal assistant message produced by the REAL Anthropic adapter. */
async function adapterFailure(status: number, type: string): Promise<AssistantMessage> {
	const message = `provider rejected the request ${SECRET_MARKER}`;
	vi.spyOn(Messages.prototype, "create").mockImplementation(
		() =>
			({
				async withResponse(): Promise<never> {
					throw APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
				},
			}) as never,
	);
	const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test", providerRetryWait: async () => {} });
	for await (const _ of stream) {
		// drain
	}
	return await stream.result();
}

type PublishedFrames = { failed: Record<string, unknown>; ended: Record<string, unknown> };

/**
 * Run the REAL host lifecycle extension over a task-owned transport and return
 * the frames it actually published. Nothing here is hand-built: the assistant
 * message comes from the real Anthropic adapter, the outcome is produced by the
 * host's own terminal classifier, and the payloads are exactly what a client
 * would receive on the wire.
 */
async function publishRealLifecycleFrames(failure: AssistantMessage): Promise<PublishedFrames> {
	const publisherRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-diagnostic-publisher-"));
	try {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
		const broadcasts: SdkFrame[] = [];
		let deliver: ((connectionId: string, frame: SdkFrame) => void) | undefined;
		const waiters = new Map<string, (frame: Record<string, unknown>) => void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
				handlers.set(event, handler);
			},
			sendUserMessage: async (_content: unknown, options?: { onPreflightAcceptCommit?: () => Promise<void> }) => {
				await options?.onPreflightAcceptCommit?.();
				await new Promise(() => {});
				return "completed";
			},
		} as never;
		createSdkSessionRuntimeExtension(api, {
			agentDir: publisherRoot,
			createTransport: async ({
				sessionId,
				stateRoot,
				token,
			}: {
				sessionId: string;
				stateRoot: string;
				token: string;
			}) => ({
				sessionId,
				stateRoot,
				token,
				onFrame(handler: (connectionId: string, frame: SdkFrame) => void) {
					deliver = handler;
					return () => {
						deliver = undefined;
					};
				},
				sendFrame(_connectionId: string, frame: SdkFrame) {
					const response = frame as unknown as { id?: string };
					if (typeof response.id === "string") waiters.get(response.id)?.(frame as never);
				},
				broadcastFrame(frame: SdkFrame) {
					broadcasts.push(frame);
				},
				async start() {
					return { url: "inproc://publisher" };
				},
				async stop() {},
			}),
		} as never);
		const ctx = {
			cwd: publisherRoot,
			workflowGate: undefined,
			sdkBindings: () => [],
			sessionManager: {
				getSessionId: () => "publisher",
				getSessionFile: () => path.join(publisherRoot, "publisher.jsonl"),
				getSessionName: () => undefined,
				getBranch: () => [],
			},
			getTranscript: () => [],
			getGoalState: () => undefined,
		} as never;
		await handlers.get("session_start")?.({}, ctx);
		const submitted = await new Promise<Record<string, unknown>>(resolve => {
			waiters.set("publish-1", resolve);
			deliver?.("client", {
				type: "control_request",
				id: "publish-1",
				operation: "turn.prompt",
				input: { text: "failing", clientRef: "publisher-ref" },
			} as never);
		});
		expect((submitted as { ok?: boolean }).ok).toBe(true);
		await handlers.get("agent_start")?.({}, ctx);
		await handlers.get("agent_failed")?.(
			{
				error: Object.assign(new Error(`provider rejected ${SECRET_MARKER}`), {
					code: "provider_rejected",
					providerDiagnostic: failure.providerDiagnostic,
				}),
			},
			ctx,
		);
		// The stream-ended path: the host's own classifier reads the real adapter
		// message and builds the terminal outcome it publishes.
		await handlers.get("agent_end")?.({ messages: [failure] }, ctx);
		await Bun.sleep(20);
		await handlers.get("session_shutdown")?.({}, ctx);

		const failed = broadcasts.find(frame => (frame as { kind?: string }).kind === "agent_failed");
		const ended = broadcasts.find(frame => (frame as { kind?: string }).kind === "agent_end");
		if (!failed || !ended) throw new Error(`Expected published lifecycle frames, saw ${broadcasts.length}`);
		return {
			failed: (failed as unknown as { payload: Record<string, unknown> }).payload,
			ended: (ended as unknown as { payload: Record<string, unknown> }).payload,
		};
	} finally {
		await fs.rm(publisherRoot, { recursive: true, force: true });
	}
}

describe("provider diagnostic through the real SDK session CLI route", () => {
	let root: string;
	let stateRoot: string;
	let agentDir: string;
	let token: string;
	let broker: Broker;
	let endpointServer: Server<undefined>;
	let served: unknown;
	/** Event-ring frames the fixture host replays to a live tail. */
	let replayEvents: Array<Record<string, unknown>>;
	let checkpointMints: number;
	let replayGap: Record<string, unknown> | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-diagnostic-route-"));
		await initializeTestRepository(root);
		stateRoot = path.join(root, ".gjc", "state");
		agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		token = "route-token";
		served = undefined;
		replayEvents = [];
		checkpointMints = 0;
		replayGap = undefined;

		// Task-owned fixture host: answers only the one query under test, and
		// serves the product's own reconciliation projection verbatim.
		endpointServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				const url = new URL(request.url);
				if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
				return server.upgrade(request, { data: undefined })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					// The client waits for the server hello before sending frames.
					queueMicrotask(() => {
						try {
							socket.send(
								JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "route-conn" }),
							);
						} catch {
							// connection already closed
						}
					});
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as {
						type?: string;
						id?: string;
						query?: string;
						connectionId?: string;
					};
					if (frame.type === "query_request" && frame.query === "turn.result" && served !== undefined) {
						socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result: served }));
						return;
					}
					// Minimal live-tail protocol: one idle checkpoint, one replay of the
					// host-shaped lifecycle frames, and an empty transcript page.
					if (frame.type === "event_replay") {
						const events = replayEvents;
						socket.send(
							JSON.stringify({
								type: "event_replay_result",
								id: frame.id,
								ok: true,
								generation: 1,
								lastSeq: events.reduce(
									(maximum, event) => (typeof event.seq === "number" ? Math.max(maximum, event.seq) : maximum),
									0,
								),
								events,
								// A gap belongs to the explicit tail replay (the one the CLI
								// issues through the router with a connectionId), not to the
								// router's own attach replay.
								...(replayGap === undefined || typeof frame.connectionId !== "string"
									? {}
									: { gap: replayGap }),
							}),
						);
						return;
					}
					if (frame.type === "query_request" && frame.query === "session.checkpoint") {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result: {
									checkpoint: { revision: 1, generation: 1, seq: 1, idle: true },
									checkpointToken: `tail-cursor-${++checkpointMints}`,
								},
							}),
						);
						return;
					}
					if (frame.type === "query_request" && frame.query === "transcript.list") {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result: { page: { items: [], complete: true } },
							}),
						);
						return;
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
		vi.restoreAllMocks();
		await broker.stop();
		await endpointServer.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	/** The durable row a legacy/corrupt writer could leave behind. */
	function malformedDurableRecord(): unknown {
		return {
			kind: "prompt",
			commandId: correlation.commandId,
			turnId: correlation.turnId,
			clientRef: "route-ref",
			status: "failed",
			acceptedAt: 1,
			startedAt: 1,
			terminalAt: 2,
			error: { code: "provider_rejected", message: "Provider failure after execution started." },
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				message: "Provider failure after execution started.",
				provenance: "agent_failed",
				phase: "post_start",
				category: "provider_rejected",
				providerCode: "provider_rejected",
				providerDiagnostic: { category: "quota", evidence: "message_text", detail: SECRET_MARKER },
			},
			receiptState: "missing",
		};
	}

	/** The lifecycle frame the real host publishes at its terminal boundary. */
	function hostAgentEndFrame(outcome: Record<string, unknown>): Record<string, unknown> {
		return {
			type: "event",
			generation: 1,
			seq: 1,
			kind: "agent_end",
			payload: { type: "agent_end", sessionId: "live", ...correlation, outcome },
		};
	}

	/** Real reconciliation projection for a failure, through a real disk store. */
	async function projectionFor(
		build: (reconciliation: KindAwareReconciliation) => Promise<void>,
		durableRecords?: () => unknown[],
	): Promise<unknown> {
		const sessionFile = path.join(root, `recon-${Math.random().toString(36).slice(2)}.jsonl`);
		await fs.writeFile(sessionFile, "");
		const store = createReconciliationStore({ sessionFile, sessionId: "route", now: () => 1_000 });
		if (durableRecords) await store.transact(() => durableRecords() as never);
		const reconciliation = createKindAwareReconciliation({ store, now: () => 1_000 });
		if (durableRecords) await reconciliation.hydrateFromStore();
		await build(reconciliation);
		return reconciliation.lookupResult("prompt", { clientRef: "route-ref" });
	}

	it("replays publisher-produced frames through the live tail and its cursor resume", async () => {
		// Scope: this test covers the LIVE tail and its cursor resume only. The
		// offline (!row.live) and terminal-uncertain branches are covered by the
		// retained-transcript tests below, which have their own producer input.
		const failure = await adapterFailure(401, "authentication_error");
		const published = await publishRealLifecycleFrames(failure);

		// R4: the emitted agent_end frame itself must carry the classification.
		expect((published.failed as { error?: Record<string, unknown> }).error).toMatchObject({
			code: "provider_rejected",
			message: "Prompt submission failed.",
			providerDiagnostic: AUTH_DIAGNOSTIC,
		});
		expect((published.ended as { outcome?: Record<string, unknown> }).outcome?.providerDiagnostic).toEqual(
			AUTH_DIAGNOSTIC,
		);
		expect(JSON.stringify(published)).not.toContain(SECRET_MARKER);

		// Live tail over the ACTUAL published frames.
		replayEvents = [
			{ type: "event", generation: 1, seq: 1, kind: "agent_failed", payload: published.failed },
			{ type: "event", generation: 1, seq: 2, kind: "agent_end", payload: published.ended },
		];
		const live = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);
		expect(live.exitCode, `stdout=${live.stdout}\nstderr=${live.stderr}`).toBe(0);
		const liveResult = JSON.parse(live.stdout).result as {
			cursor?: string;
			items: Array<{ kind: string; payload: Record<string, unknown> }>;
		};
		const publishedFailed = liveResult.items.find(item => item.kind === "agent_failed");
		const publishedEnded = liveResult.items.find(item => item.kind === "agent_end");
		expect((publishedFailed?.payload as { error?: Record<string, unknown> })?.error?.providerDiagnostic).toEqual(
			AUTH_DIAGNOSTIC,
		);
		expect((publishedEnded?.payload as { outcome?: Record<string, unknown> })?.outcome?.providerDiagnostic).toEqual(
			AUTH_DIAGNOSTIC,
		);
		expect(typeof liveResult.cursor).toBe("string");
		expect(live.stdout).not.toContain(SECRET_MARKER);
		expect(live.stderr).not.toContain(SECRET_MARKER);

		// Resume the live tail with the returned cursor plus its transcript
		// boundary: the existing two-flag contract still holds with the new field.
		const resumedLive = await runCli(root, agentDir, [
			"tail",
			"live",
			"--until-idle",
			"--timeout-ms",
			"4000",
			"--cursor",
			liveResult.cursor as string,
			"--after-transcript-id",
			"row-0",
		]);
		expect(resumedLive.exitCode, `stdout=${resumedLive.stdout}\nstderr=${resumedLive.stderr}`).toBe(0);
		const resumedResult = JSON.parse(resumedLive.stdout).result as { cursor?: string; items: unknown[] };
		expect(typeof resumedResult.cursor).toBe("string");
		expect(resumedLive.stdout).not.toContain(SECRET_MARKER);
	}, 60_000);

	/** Retained transcript rows: one producer-sanitized diagnostic row, one legacy row. */
	async function retainedOfflineSession(): Promise<{ sessionId: string; diagnostic: Record<string, unknown> }> {
		const failure = await adapterFailure(401, "authentication_error");
		const diagnostic = failure.providerDiagnostic as unknown as Record<string, unknown>;
		expect(diagnostic).toEqual(AUTH_DIAGNOSTIC);

		const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await session.ensureOnDisk();
		// Legacy assistant row: never carried the field.
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "legacy row" }],
			api: failure.api,
			provider: failure.provider,
			model: failure.model,
			usage: failure.usage,
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		} as never);
		// Producer row: the diagnostic is exactly what the real adapter minted, and
		// the legacy failure fields travel with it. The provider message is kept
		// marker-free so a stdout-wide secret assertion stays meaningful for this
		// path (the raw provider text policy is pre-existing and out of scope).
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "diagnostic row" }],
			api: failure.api,
			provider: failure.provider,
			model: failure.model,
			usage: failure.usage,
			stopReason: "error",
			errorMessage: "Provider rejected the request.",
			errorStatus: failure.errorStatus,
			providerDiagnostic: diagnostic,
			timestamp: 1_700_000_000_001,
		} as never);
		await session.flush();

		const sessionId = session.getSessionId();
		const registration = {
			type: "host_registered" as const,
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		};
		await broker.index.append(registration);
		return { sessionId, diagnostic };
	}

	it("preserves a producer diagnostic through the real offline tail and its resume", async () => {
		const { sessionId } = await retainedOfflineSession();
		// Stopped session: the offline (!row.live) branch replays the retained
		// transcript instead of attaching to a host.
		await broker.index.append({
			type: "host_unregistered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		});

		const offline = await runCli(root, agentDir, ["tail", sessionId]);
		expect(offline.exitCode, `stdout=${offline.stdout}\nstderr=${offline.stderr}`).toBe(0);
		const result = JSON.parse(offline.stdout).result as {
			source: string;
			terminal: boolean;
			items: Array<{ kind: string; id?: string; payload: Record<string, unknown> }>;
		};
		expect(result.source).toBe("offline");
		expect(result.terminal).toBe(true);

		// A retained row projects as `{ type, id, parentId, timestamp, message }`,
		// so the assistant fields (and the new one) live under `payload.message`.
		const messageOf = (item?: { payload: Record<string, unknown> }) =>
			(item?.payload.message ?? {}) as Record<string, unknown>;
		const rows = result.items.filter(item => item.kind === "transcript");
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const legacyRow = rows.find(
			item => messageOf(item).role === "assistant" && messageOf(item).providerDiagnostic === undefined,
		);
		const diagnosticRow = rows.find(item => messageOf(item).providerDiagnostic !== undefined);
		expect(legacyRow).toBeDefined();
		expect(diagnosticRow).toBeDefined();

		// Legacy omission: the field is absent, not null or empty.
		expect(Object.hasOwn(messageOf(legacyRow), "providerDiagnostic")).toBe(false);
		expect(messageOf(legacyRow).stopReason).toBe("stop");
		// Bounded shape preserved verbatim, with the legacy fields beside it.
		expect(messageOf(diagnosticRow).providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		expect(messageOf(diagnosticRow).stopReason).toBe("error");
		expect(messageOf(diagnosticRow).errorStatus).toBe(401);
		expect(messageOf(diagnosticRow).errorMessage).toBe("Provider rejected the request.");
		expect(offline.stdout).not.toContain(SECRET_MARKER);
		expect(offline.stderr).not.toContain(SECRET_MARKER);

		// Resume past the diagnostic row: the boundary is honoured and the exit
		// contract is unchanged.
		const boundaryId = diagnosticRow?.id;
		expect(typeof boundaryId).toBe("string");
		const resumed = await runCli(root, agentDir, ["tail", sessionId, "--after-transcript-id", boundaryId as string]);
		expect(resumed.exitCode, `stdout=${resumed.stdout}\nstderr=${resumed.stderr}`).toBe(0);
		const resumedResult = JSON.parse(resumed.stdout).result as { source: string; items: unknown[] };
		expect(resumedResult.source).toBe("offline");
		expect(resumedResult.items).toHaveLength(0);
		expect(resumed.stdout).not.toContain("providerDiagnostic");

		// Resume from the FIRST row still yields the diagnostic row.
		const firstId = rows[0]?.id;
		expect(typeof firstId).toBe("string");
		const partial = await runCli(root, agentDir, ["tail", sessionId, "--after-transcript-id", firstId as string]);
		expect(partial.exitCode).toBe(0);
		const partialItems = (JSON.parse(partial.stdout).result as { items: Array<{ payload: Record<string, unknown> }> })
			.items;
		expect(
			partialItems.some(
				item => ((item.payload.message ?? {}) as Record<string, unknown>).providerDiagnostic !== undefined,
			),
		).toBe(true);
	}, 60_000);

	it("replays the retained diagnostic on the terminal-uncertain branch", async () => {
		const { sessionId } = await retainedOfflineSession();
		// A `lifecycle_terminal` index event is what the broker turns into
		// `terminalUncertain` on the row; the CLI then takes the same offline
		// replay branch even though the row is not a clean stop.
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		});

		const tail = await runCli(root, agentDir, ["tail", sessionId]);
		expect(tail.exitCode, `stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		const result = JSON.parse(tail.stdout).result as {
			source: string;
			session: { terminalUncertain?: boolean };
			items: Array<{ kind: string; payload: Record<string, unknown> }>;
		};
		expect(result.session.terminalUncertain).toBe(true);
		expect(result.source).toBe("offline");
		const diagnosticRow = result.items.find(
			item => ((item.payload.message ?? {}) as Record<string, unknown>).providerDiagnostic !== undefined,
		);
		expect(((diagnosticRow?.payload.message ?? {}) as Record<string, unknown>).providerDiagnostic).toEqual(
			AUTH_DIAGNOSTIC,
		);
		expect(tail.stdout).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("keeps offline replay, retention gaps and resume unchanged by the new field", async () => {
		// G3: the offline branch, the retention-gap branch and cursor resumption are
		// contract surfaces the new optional field must not disturb. Retained
		// transcripts never carried a diagnostic, so their absence is the contract.
		const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await session.ensureOnDisk();
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "retained row" }],
			timestamp: 1_700_000_000_000,
		} as never);
		await session.flush();
		const offlineId = session.getSessionId();
		const savedPath = session.getSessionFile();
		if (!savedPath) throw new Error("Expected a retained managed session path.");
		const registration = {
			type: "host_registered" as const,
			sessionId: offlineId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		};
		await broker.index.append(registration);
		await broker.index.append({ ...registration, type: "host_unregistered" as const });

		const offline = await runCli(root, agentDir, ["tail", offlineId]);
		expect(offline.exitCode, `stdout=${offline.stdout}\nstderr=${offline.stderr}`).toBe(0);
		const offlineResult = JSON.parse(offline.stdout).result as {
			source: string;
			terminal: boolean;
			items: Array<{ kind: string; id?: string }>;
		};
		expect(offlineResult.source).toBe("offline");
		expect(offlineResult.terminal).toBe(true);
		expect(offline.stdout).not.toContain("providerDiagnostic");
		expect(offline.stdout).not.toContain(SECRET_MARKER);

		// The retained transcript must actually contain a row, or the resume
		// assertion below would be vacuous.
		expect(offlineResult.items.length).toBeGreaterThan(0);
		const lastId = offlineResult.items.at(-1)?.id;
		expect(typeof lastId).toBe("string");
		const resumed = await runCli(root, agentDir, ["tail", offlineId, "--after-transcript-id", lastId as string]);
		expect(resumed.exitCode, `stdout=${resumed.stdout}\nstderr=${resumed.stderr}`).toBe(0);
		const resumedResult = JSON.parse(resumed.stdout).result as { items: unknown[]; source: string };
		expect(resumedResult.source).toBe("offline");
		expect(resumedResult.items).toHaveLength(0);
		expect(resumed.stdout).not.toContain("providerDiagnostic");

		// A live tail resumed with --cursor still requires its transcript boundary.
		const usage = await runCli(root, agentDir, ["tail", "live", "--cursor", "tail-cursor-1"]);
		expect(usage.exitCode).toBe(2);
		expect(JSON.parse(usage.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
	}, 60_000);

	it("reports a retention gap on the live route with its exact DTO and no new field", async () => {
		replayGap = { code: "retention_gap", missing: { from: 1, to: 2 } };
		replayEvents = [];

		const cli = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const result = JSON.parse(cli.stdout).result as {
			source: string;
			cursor?: string;
			gap?: { code: string; missing?: { from: number; to: number } };
			items: unknown[];
		};
		expect(result.source).toBe("session");
		expect(result.gap).toEqual({ code: "retention_gap", missing: { from: 1, to: 2 } });
		expect(typeof result.cursor).toBe("string");
		expect(result.items).toHaveLength(0);
		expect(cli.stdout).not.toContain("providerDiagnostic");
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("reports the diagnostic through the public status command wrapper", async () => {
		const failure = await adapterFailure(401, "authentication_error");
		served = await projectionFor(async reconciliation => {
			reconciliation.admit("prompt", "route-ref");
			await reconciliation.noteAccepted("prompt", correlation, "route-ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		});
		const projected = served as { receiptState: string; outcome: Record<string, unknown> };

		const cli = await runCli(root, agentDir, ["status", "live", "route-ref"]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const payload = JSON.parse(cli.stdout) as {
			result: {
				operationRef: string;
				summary: { completed: boolean };
				status: {
					status: string;
					receiptState: string;
					error: { code: string; message: string };
					outcome: Record<string, unknown>;
				};
			};
		};
		expect(payload.result.operationRef).toBe("route-ref");
		expect(payload.result.summary.completed).toBe(true);
		expect(payload.result.status.status).toBe("failed");
		// The stable terminal contract is byte-identical to the projection.
		expect(payload.result.status.receiptState).toBe(projected.receiptState);
		expect(payload.result.status.outcome.code).toBe(projected.outcome.code);
		expect(payload.result.status.outcome.message).toBe(projected.outcome.message);
		expect(payload.result.status.outcome.phase).toBe(projected.outcome.phase);
		expect(payload.result.status.outcome.category).toBe(projected.outcome.category);
		expect(payload.result.status.outcome.providerCode).toBe(projected.outcome.providerCode);
		expect(payload.result.status.outcome.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("reports no diagnostic through the status wrapper for a legacy or malformed record", async () => {
		served = await projectionFor(async reconciliation => {
			reconciliation.admit("prompt", "route-ref");
			await reconciliation.noteAccepted("prompt", correlation, "route-ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed." },
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		});
		const legacy = await runCli(root, agentDir, ["status", "live", "route-ref"]);
		expect(legacy.exitCode, `stdout=${legacy.stdout}\nstderr=${legacy.stderr}`).toBe(0);
		expect(legacy.stdout).not.toContain("providerDiagnostic");
		expect(JSON.parse(legacy.stdout).result.status.status).toBe("failed");

		served = await projectionFor(
			async () => {},
			() => [malformedDurableRecord()],
		);
		const malformed = await runCli(root, agentDir, ["status", "live", "route-ref"]);
		expect(malformed.exitCode, `stdout=${malformed.stdout}\nstderr=${malformed.stderr}`).toBe(0);
		const payload = JSON.parse(malformed.stdout) as {
			result: { status: { status: string; outcome: Record<string, unknown> } };
		};
		expect(payload.result.status.status).toBe("failed");
		expect(payload.result.status.outcome.providerCode).toBe("provider_rejected");
		expect(payload.result.status.outcome.providerDiagnostic).toBeUndefined();
		expect(malformed.stdout).not.toContain(SECRET_MARKER);
		expect(malformed.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("carries the diagnostic through the live tail wire projection", async () => {
		const failure = await adapterFailure(500, "api_error");
		const projection = (await projectionFor(async reconciliation => {
			reconciliation.admit("prompt", "route-ref");
			await reconciliation.noteAccepted("prompt", correlation, "route-ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		})) as { outcome: Record<string, unknown> };
		// The host publishes exactly this shape on its terminal boundary: an
		// agent_end lifecycle frame whose payload carries the canonical outcome.
		replayEvents = [hostAgentEndFrame(projection.outcome)];

		const cli = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const result = JSON.parse(cli.stdout).result as {
			terminal: boolean;
			items: Array<{ kind: string; payload: { outcome?: Record<string, unknown> } }>;
		};
		const agentEnd = result.items.find(item => item.kind === "agent_end");
		expect(agentEnd?.payload.outcome?.code).toBe("prompt_failed");
		expect(agentEnd?.payload.outcome?.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			httpStatus: 500,
			code: "api_error",
			evidence: "structured_code",
		});
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("emits no diagnostic through the tail projection for a malformed durable outcome", async () => {
		const projection = (await projectionFor(
			async () => {},
			() => [malformedDurableRecord()],
		)) as {
			outcome: Record<string, unknown>;
		};
		replayEvents = [hostAgentEndFrame(projection.outcome)];

		const cli = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "4000"]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const result = JSON.parse(cli.stdout).result as {
			items: Array<{ kind: string; payload: { outcome?: Record<string, unknown> } }>;
		};
		const agentEnd = result.items.find(item => item.kind === "agent_end");
		expect(agentEnd?.payload.outcome?.providerCode).toBe("provider_rejected");
		expect(agentEnd?.payload.outcome?.providerDiagnostic).toBeUndefined();
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);

	it("prints the adapter diagnostic verbatim and exits 0", async () => {
		const failure = await adapterFailure(401, "authentication_error");
		expect(failure.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		served = await projectionFor(async reconciliation => {
			reconciliation.admit("prompt", "route-ref");
			await reconciliation.noteAccepted("prompt", correlation, "route-ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		});

		const cli = await runCli(root, agentDir, [
			"raw",
			"query",
			"live",
			"--query",
			"turn.result",
			"--json-input",
			JSON.stringify({ kind: "prompt", clientRef: "route-ref" }),
		]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const payload = JSON.parse(cli.stdout) as {
			result: { status: string; error: { code: string }; outcome: Record<string, unknown> };
		};
		expect(payload.result.status).toBe("failed");
		expect(payload.result.error.code).toBe("provider_rejected");
		expect(payload.result.outcome.code).toBe("prompt_failed");
		expect(payload.result.outcome.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
		expect(cli.stdout).not.toContain("sk-ant-test");
	}, 60_000);

	it("prints no diagnostic for a legacy failure that never had one", async () => {
		served = await projectionFor(async reconciliation => {
			reconciliation.admit("prompt", "route-ref");
			await reconciliation.noteAccepted("prompt", correlation, "route-ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed." },
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		});

		const cli = await runCli(root, agentDir, [
			"raw",
			"query",
			"live",
			"--query",
			"turn.result",
			"--json-input",
			JSON.stringify({ kind: "prompt", clientRef: "route-ref" }),
		]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const payload = JSON.parse(cli.stdout) as { result: { status: string; outcome: Record<string, unknown> } };
		expect(payload.result.status).toBe("failed");
		expect(payload.result.outcome.code).toBe("prompt_failed");
		expect(payload.result.outcome.providerDiagnostic).toBeUndefined();
		expect(cli.stdout).not.toContain("providerDiagnostic");
	}, 60_000);

	it("strips a malformed durable diagnostic before it can reach the CLI", async () => {
		served = await projectionFor(
			async () => {
				// The durable row is the only source; hydration must sanitize it.
			},
			() => [
				{
					kind: "prompt",
					commandId: correlation.commandId,
					turnId: correlation.turnId,
					clientRef: "route-ref",
					status: "failed",
					acceptedAt: 1,
					startedAt: 1,
					terminalAt: 2,
					error: { code: "provider_rejected", message: "Provider failure after execution started." },
					outcome: {
						kind: "failed",
						code: "prompt_failed",
						message: "Provider failure after execution started.",
						provenance: "agent_failed",
						phase: "post_start",
						category: "provider_rejected",
						providerCode: "provider_rejected",
						providerDiagnostic: { category: "quota", evidence: "message_text", detail: SECRET_MARKER },
					},
					receiptState: "missing",
				},
			],
		);

		const cli = await runCli(root, agentDir, [
			"raw",
			"query",
			"live",
			"--query",
			"turn.result",
			"--json-input",
			JSON.stringify({ kind: "prompt", clientRef: "route-ref" }),
		]);

		expect(cli.exitCode, `stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
		const payload = JSON.parse(cli.stdout) as { result: { status: string; outcome: Record<string, unknown> } };
		expect(payload.result.status).toBe("failed");
		expect(payload.result.outcome.providerCode).toBe("provider_rejected");
		expect(payload.result.outcome.providerDiagnostic).toBeUndefined();
		expect(cli.stdout).not.toContain(SECRET_MARKER);
		expect(cli.stderr).not.toContain(SECRET_MARKER);
	}, 60_000);
});
