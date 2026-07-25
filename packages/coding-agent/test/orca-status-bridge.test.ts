import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import {
	createOrcaStatusBridge,
	extractAssistantText,
	parseOrcaEndpointFile,
	shouldRegisterOrcaStatusBridge,
} from "../src/utils/orca-status-bridge";

type ExtensionEventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function captureHandlers(): { api: ExtensionAPI; handlers: Map<string, ExtensionEventHandler> } {
	const handlers = new Map<string, ExtensionEventHandler>();
	const api = {
		on(event: string, handler: ExtensionEventHandler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function fakeContext(
	overrides: Partial<{ isIdle: () => boolean; hasUI: boolean; setEditorText: (text: string) => void }> = {},
): ExtensionContext {
	return {
		hasUI: overrides.hasUI ?? false,
		ui: { setEditorText: overrides.setEditorText ?? (() => {}) },
		sessionManager: {
			getSessionId: () => "orca-test-session",
			getSessionFile: () => undefined,
		},
		isIdle: overrides.isIdle ?? (() => true),
	} as unknown as ExtensionContext;
}

interface ReceivedPost {
	url: string;
	token: string | null;
	body: {
		paneKey: string;
		tabId: string;
		worktreeId: string;
		payload: Record<string, unknown>;
	};
}

interface HookReceiver {
	port: number;
	received: ReceivedPost[];
	nextDelivery: () => Promise<ReceivedPost>;
	/** When set, holds responses open until released (for queue-collapse tests). */
	hold: boolean;
	releaseHeld: () => void;
	stop: () => void;
}

function startHookReceiver(): HookReceiver {
	const received: ReceivedPost[] = [];
	let waiters: Array<(post: ReceivedPost) => void> = [];
	let heldReleases: Array<() => void> = [];
	const receiver: HookReceiver = {
		port: 0,
		received,
		hold: false,
		nextDelivery: () => {
			const { promise, resolve } = Promise.withResolvers<ReceivedPost>();
			waiters.push(resolve);
			return promise;
		},
		releaseHeld: () => {
			const releases = heldReleases;
			heldReleases = [];
			for (const release of releases) release();
		},
		stop: () => server.stop(true),
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const post: ReceivedPost = {
				url: new URL(request.url).pathname,
				token: request.headers.get("X-Orca-Agent-Hook-Token"),
				body: (await request.json()) as ReceivedPost["body"],
			};
			received.push(post);
			const pendingWaiters = waiters;
			waiters = [];
			for (const waiter of pendingWaiters) waiter(post);
			if (receiver.hold) {
				const { promise, resolve } = Promise.withResolvers<void>();
				heldReleases.push(resolve);
				await promise;
			}
			return new Response("ok");
		},
	});
	if (server.port === undefined) throw new Error("Hook receiver failed to bind a port.");
	receiver.port = server.port;
	return receiver;
}

function bridgeEnv(receiver: HookReceiver, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		ORCA_PANE_KEY: "tab-1:leaf-1",
		ORCA_TAB_ID: "tab-1",
		ORCA_WORKTREE_ID: "repo::wt",
		ORCA_AGENT_HOOK_PORT: String(receiver.port),
		ORCA_AGENT_HOOK_TOKEN: "test-token",
		...extra,
	} as NodeJS.ProcessEnv;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("parseOrcaEndpointFile", () => {
	it("parses POSIX KEY=VALUE lines", () => {
		expect(parseOrcaEndpointFile("ORCA_AGENT_HOOK_PORT=57343\nORCA_AGENT_HOOK_TOKEN=abc\n")).toEqual({
			ORCA_AGENT_HOOK_PORT: "57343",
			ORCA_AGENT_HOOK_TOKEN: "abc",
		});
	});

	it("parses Windows `set KEY=VALUE` lines and strips CR", () => {
		expect(parseOrcaEndpointFile("set ORCA_AGENT_HOOK_PORT=57343\r\nset ORCA_AGENT_HOOK_TOKEN=abc\r\n")).toEqual({
			ORCA_AGENT_HOOK_PORT: "57343",
			ORCA_AGENT_HOOK_TOKEN: "abc",
		});
	});

	it("ignores non-matching lines", () => {
		expect(parseOrcaEndpointFile("# comment\nlowercase=skip\nORCA_AGENT_HOOK_ENV=production")).toEqual({
			ORCA_AGENT_HOOK_ENV: "production",
		});
	});
});

describe("shouldRegisterOrcaStatusBridge", () => {
	it("requires an Orca pane identity", () => {
		expect(shouldRegisterOrcaStatusBridge({ env: {} as NodeJS.ProcessEnv })).toBe(false);
		expect(shouldRegisterOrcaStatusBridge({ env: { ORCA_PANE_KEY: "t:l" } as NodeJS.ProcessEnv })).toBe(true);
	});

	it("stays silent for helper and subagent sessions", () => {
		const env = { ORCA_PANE_KEY: "t:l" } as NodeJS.ProcessEnv;
		expect(shouldRegisterOrcaStatusBridge({ env, taskDepth: 1 })).toBe(false);
		expect(shouldRegisterOrcaStatusBridge({ env, parentTaskPrefix: "6-Extensions" })).toBe(false);
		expect(shouldRegisterOrcaStatusBridge({ env, currentAgentType: "executor" })).toBe(false);
	});

	it("defers to a pane already owned by another process", () => {
		const otherPid = String(process.pid + 1);
		expect(
			shouldRegisterOrcaStatusBridge({
				env: { ORCA_PANE_KEY: "t:l", ORCA_PI_STATUS_OWNED: otherPid } as NodeJS.ProcessEnv,
			}),
		).toBe(false);
		expect(
			shouldRegisterOrcaStatusBridge({
				env: { ORCA_PANE_KEY: "t:l", ORCA_PI_STATUS_OWNED: String(process.pid) } as NodeJS.ProcessEnv,
			}),
		).toBe(true);
	});
});

describe("extractAssistantText", () => {
	it("returns string content directly and concatenates text parts", () => {
		expect(extractAssistantText({ role: "assistant", content: "plain" })).toBe("plain");
		expect(
			extractAssistantText({
				role: "assistant",
				content: [
					{ type: "text", text: "first " },
					{ type: "toolCall", id: "x" },
					{ type: "text", text: "second" },
				],
			}),
		).toBe("first second");
	});

	it("returns empty for tool-only or malformed messages", () => {
		expect(extractAssistantText(undefined)).toBe("");
		expect(extractAssistantText({ content: [{ type: "toolCall" }] })).toBe("");
	});
});

describe("createOrcaStatusBridge delivery", () => {
	it("posts pi-protocol lifecycle payloads with pane identity and token", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext();

		let delivery = receiver.nextDelivery();
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		let post = await delivery;
		expect(post.url).toBe("/hook/pi");
		expect(post.token).toBe("test-token");
		expect(post.body.paneKey).toBe("tab-1:leaf-1");
		expect(post.body.tabId).toBe("tab-1");
		expect(post.body.worktreeId).toBe("repo::wt");
		expect(post.body.payload.hook_event_name).toBe("session_start");

		delivery = receiver.nextDelivery();
		handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "fix the bug" }, ctx);
		post = await delivery;
		expect(post.body.payload).toMatchObject({ hook_event_name: "before_agent_start", prompt: "fix the bug" });

		delivery = receiver.nextDelivery();
		handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
			ctx,
		);
		post = await delivery;
		expect(post.body.payload).toMatchObject({
			hook_event_name: "tool_execution_start",
			tool_name: "bash",
			tool_input: { command: "ls" },
		});

		delivery = receiver.nextDelivery();
		handlers.get("message_end")?.(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done!" }] } },
			ctx,
		);
		post = await delivery;
		expect(post.body.payload).toMatchObject({ hook_event_name: "message_end", role: "assistant", text: "done!" });
	});

	it("prefers coordinates from the endpoint file over the environment", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-orca-endpoint-"));
		cleanups.push(() => void fs.rm(dir, { recursive: true, force: true }));
		const endpointPath = path.join(dir, "endpoint.env");
		await Bun.write(
			endpointPath,
			`ORCA_AGENT_HOOK_PORT=${receiver.port}\nORCA_AGENT_HOOK_TOKEN=file-token\nORCA_AGENT_HOOK_ENV=production\n`,
		);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
				// Stale env coordinates that the endpoint file must win over.
				ORCA_AGENT_HOOK_PORT: "1",
				ORCA_AGENT_HOOK_TOKEN: "stale-token",
			} as NodeJS.ProcessEnv,
		});
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		expect(post.token).toBe("file-token");
		expect(post.body.payload.hook_event_name).toBe("agent_start");
	});

	it("collapses bursts to the latest snapshot while a post is in flight", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext();

		receiver.hold = true;
		const first = receiver.nextDelivery();
		handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "one" } },
			ctx,
		);
		await first;
		// Queued while the first post is held open; only the latest may survive.
		handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "two" } },
			ctx,
		);
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash" }, ctx);
		const second = receiver.nextDelivery();
		receiver.hold = false;
		receiver.releaseHeld();
		const post = await second;
		expect(post.body.payload.hook_event_name).toBe("tool_execution_end");
		expect(receiver.received).toHaveLength(2);
	});

	it("defers agent_end until the session is idle and reports it once", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		let idle = false;
		const ctx = fakeContext({ isIdle: () => idle });

		const started = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await started;

		const ended = receiver.nextDelivery();
		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		await Bun.sleep(60);
		expect(receiver.received.filter(post => post.body.payload.hook_event_name === "agent_end")).toHaveLength(0);
		idle = true;
		const post = await ended;
		expect(post.body.payload.hook_event_name).toBe("agent_end");
		// A second agent_end for the same run must not double-report.
		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		await Bun.sleep(60);
		expect(receiver.received.filter(p => p.body.payload.hook_event_name === "agent_end")).toHaveLength(1);
	});

	it("cancels a pending agent_end check when a new agent loop starts", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext({ isIdle: () => false });

		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		const restarted = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await restarted;
		await Bun.sleep(120);
		expect(receiver.received.filter(post => post.body.payload.hook_event_name === "agent_end")).toHaveLength(0);
	});

	it("applies the Orca startup prefill once on session_start when a UI exists", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		const env = bridgeEnv(receiver, { ORCA_PI_PREFILL: "continue the review" });
		createOrcaStatusBridge(api, { env });
		const prefills: string[] = [];
		const ctx = fakeContext({ hasUI: true, setEditorText: text => prefills.push(text) });

		const delivery = receiver.nextDelivery();
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await delivery;
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		expect(prefills).toEqual(["continue the review"]);
		expect(env.ORCA_PI_PREFILL).toBeUndefined();
	});

	it("stays inert without Orca coordinates", async () => {
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: { ORCA_PANE_KEY: "tab-1:leaf-1" } as NodeJS.ProcessEnv });
		// No port/token anywhere: handler must be a silent no-op.
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
	});

	it("falls back to Windows curl delivery on WSL when loopback posting fails", async () => {
		const { api, handlers } = captureHandlers();
		const spawned: Array<{ command: string[]; body: string }> = [];
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "1",
				ORCA_AGENT_HOOK_TOKEN: "test-token",
			} as NodeJS.ProcessEnv,
			fetchImpl: (() => Promise.reject(new Error("loopback unreachable"))) as unknown as typeof fetch,
			isWslRuntime: () => true,
			spawnCurl: (command, body) => spawned.push({ command, body }),
		});
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].command).toContain("http://127.0.0.1:1/hook/pi");
		expect(spawned[0].command).toContain("X-Orca-Agent-Hook-Token: test-token");
		expect(JSON.parse(spawned[0].body).payload.hook_event_name).toBe("agent_start");
	});
});
