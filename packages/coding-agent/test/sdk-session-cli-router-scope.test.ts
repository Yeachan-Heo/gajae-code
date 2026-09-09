import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrokerDiscovery, brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import * as ensure from "../src/sdk/broker/ensure";
import type { SessionIndex } from "../src/sdk/broker/session-index";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";
import { runSdkSessionCli, type SdkSessionCliArgs } from "../src/sdk/cli/session-cli";
import type { SessionRouterClient } from "../src/sdk/router";
import * as routers from "../src/sdk/router";

test("CLI scopes real Router attachment to its target and broker lists to no hosts", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cli-router-scope-")));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const incarnation = brokerProcessIncarnation(process.pid);
	if (!incarnation) throw new Error("Fixture process identity unavailable");
	const discovery: BrokerDiscovery = {
		version: SDK_STATE_VERSION,
		protocolVersion: 3,
		packageGeneration: "scope-fixture",
		ownerId: "scope-fixture",
		pid: process.pid,
		incarnation,
		host: "127.0.0.1",
		port: 1,
		url: "ws://127.0.0.1:1",
		token: "fixture-only",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
	await writeBrokerDiscovery(agentDir, discovery);
	const rows = await Promise.all(
		["stalled", "selected"].map(async sessionId => {
			const endpointFile = path.join(stateRoot, "sdk", `${sessionId}.json`);
			await Bun.write(
				endpointFile,
				JSON.stringify({ sessionId, url: `ws://${sessionId}.test`, token: "fixture-only", pid: 42 }),
			);
			return {
				sessionId,
				locator: { cwd: root, worktreeRoot: null, stateRoot },
				endpointGeneration: 1,
				pid: 42,
				endpointMtimeMs: (await fs.stat(endpointFile)).mtimeMs,
				live: true,
				indexSeq: 1,
				ambiguous: false,
				terminal: false,
			};
		}),
	);
	let selectedIndexed = true;
	const listing = () => ({
		indexSeq: 1,
		sessions: rows.filter(row => selectedIndexed || row.sessionId !== "selected"),
		warnings: [],
	});
	const index = {
		open: async () => {},
		refresh: async () => {},
		refreshIfChanged: async () => true,
		listSessions: listing,
	} as unknown as SessionIndex;
	const connected: string[] = [];
	const dispatched: Record<string, unknown>[] = [];
	const scopes: (readonly string[] | undefined)[] = [];
	const stalled = Promise.withResolvers<SessionRouterClient>();
	const client: SessionRouterClient = {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		close: async () => {},
		send: () => {},
		request: async (frame, options) => {
			const context = { frame, connectionId: "fixture", generation: 1 };
			options?.beforeDispatch?.(context);
			options?.onDispatch?.(context);
			if (frame.type === "event_replay") return { ok: true, generation: 1, lastSeq: 0, events: [] };
			dispatched.push(frame);
			if (frame.type === "broker_request") return { ok: true, result: listing() };
			return { ok: true, result: { status: "in_flight" } };
		},
	};
	const RealRouter = routers.SessionRouter;
	using _ensure = vi.spyOn(ensure, "ensureBroker").mockResolvedValue(discovery);
	// Replace only construction dependencies. Real Router selection, endpoint
	// file verification, replay, dispatch admission and shutdown still execute.
	const constructors = routers as unknown as {
		SessionRouter: (options: ConstructorParameters<typeof RealRouter>[0]) => InstanceType<typeof RealRouter>;
	};
	using _router = vi.spyOn(constructors, "SessionRouter").mockImplementation(options => {
		scopes.push(options.sessionIds);
		return new RealRouter({
			...options,
			deps: {
				...options.deps,
				createIndex: () => index,
				startupAttachBudgetMs: 20,
				createClient: async authority => {
					connected.push(authority.sessionId);
					return authority.sessionId === "stalled" ? stalled.promise : client;
				},
				createBrokerClient: async () => client,
			},
		});
	});
	const invoke = async (args: SdkSessionCliArgs) => {
		let output: unknown;
		let exitCode: number | undefined;
		await runSdkSessionCli(
			{ agentDir, repo: root, sessionId: "selected", ...args },
			value => {
				output = value;
			},
			code => {
				exitCode = code;
			},
		);
		return { output, exitCode };
	};
	try {
		for (const args of [
			{ action: "send", text: "synthetic prompt", opRef: "scope-prompt" },
			{ action: "status", opRef: "scope-prompt" },
			{ action: "control", operation: "thinking.cycle", jsonInput: "{}" },
			{ action: "query", query: "turn.result", jsonInput: '{"kind":"prompt","clientRef":"scope-prompt"}' },
		] satisfies SdkSessionCliArgs[]) {
			connected.length = 0;
			const result = await invoke(args);
			expect(result.exitCode).toBeUndefined();
			expect(result.output).toMatchObject({ ok: true });
			expect(scopes.at(-1)).toEqual(["selected"]);
			expect(connected).toEqual(["selected"]);
		}
		expect(dispatched.some(frame => frame.operation === "turn.prompt")).toBe(true);
		expect(dispatched.some(frame => frame.operation === "thinking.cycle")).toBe(true);
		for (const args of [
			{ action: "list", scope: "all" },
			{ action: "global", operation: "session.list", jsonInput: "{}" },
		] satisfies SdkSessionCliArgs[]) {
			connected.length = 0;
			expect((await invoke(args)).output).toMatchObject({ ok: true });
			expect(scopes.at(-1)).toEqual([]);
			expect(connected).toEqual([]);
		}
		selectedIndexed = false;
		connected.length = 0;
		const missing = await invoke({ action: "send", text: "must not dispatch" });
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toMatchObject({ ok: false, error: { code: "session_unavailable" } });
		expect(connected).toEqual([]);
		selectedIndexed = true;
		// Selection is not authorization: a replaced endpoint must still fail
		// the real Router's indexed PID/file identity checks before connecting.
		await Bun.write(
			path.join(stateRoot, "sdk", "selected.json"),
			JSON.stringify({
				sessionId: "selected",
				url: "ws://selected.test",
				token: "fixture-only",
				pid: 43,
			}),
		);
		const invalid = await invoke({ action: "status", opRef: "scope-prompt" });
		expect(invalid.exitCode).toBe(1);
		expect(invalid.output).toMatchObject({ ok: false, error: { code: "session_unavailable" } });
		expect(connected).toEqual([]);
	} finally {
		stalled.resolve(client);
		await fs.rm(root, { recursive: true, force: true });
	}
});
