import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import {
	boundPreviewText,
	boundToolInput,
	buildOrcaHookUrl,
	createOrcaStatusBridge,
	extractAssistantText,
	parseOrcaEndpointFile,
	shouldRegisterOrcaStatusBridge,
	validateOrcaHookToken,
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
	/** When set, answers /hook/gjc with 404 (route-negotiation tests). */
	gjcRouteMissing: boolean;
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
		gjcRouteMissing: false,
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
			if (receiver.gjcRouteMissing && post.url === "/hook/gjc") {
				return new Response("not found", { status: 404 });
			}
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
		ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
		...extra,
	} as NodeJS.ProcessEnv;
}

const REGISTER_BASE = { enabled: true } as const;

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

describe("buildOrcaHookUrl", () => {
	it("builds a loopback URL for a strictly numeric port", () => {
		expect(buildOrcaHookUrl("57343")).toBe("http://127.0.0.1:57343/hook/gjc");
		expect(buildOrcaHookUrl("007")).toBe("http://127.0.0.1:7/hook/gjc");
		expect(buildOrcaHookUrl("57343", "/hook/pi")).toBe("http://127.0.0.1:57343/hook/pi");
	});

	it("rejects authority-injection and malformed port values", () => {
		expect(buildOrcaHookUrl("80@evil.example")).toBeNull();
		expect(buildOrcaHookUrl("80/evil")).toBeNull();
		expect(buildOrcaHookUrl("80?x=1")).toBeNull();
		expect(buildOrcaHookUrl("80#frag")).toBeNull();
		expect(buildOrcaHookUrl("80 81")).toBeNull();
		expect(buildOrcaHookUrl("-1")).toBeNull();
		expect(buildOrcaHookUrl("0")).toBeNull();
		expect(buildOrcaHookUrl("65536")).toBeNull();
		expect(buildOrcaHookUrl("")).toBeNull();
		expect(buildOrcaHookUrl(undefined)).toBeNull();
	});
});

describe("validateOrcaHookToken", () => {
	it("accepts UUID-shaped tokens and rejects injection attempts", () => {
		expect(validateOrcaHookToken("a6d786d1-c208-4347-81c2-cf56872b16fd")).toBe(
			"a6d786d1-c208-4347-81c2-cf56872b16fd",
		);
		expect(validateOrcaHookToken("bad\r\nX-Injected: 1")).toBeNull();
		expect(validateOrcaHookToken("has space")).toBeNull();
		expect(validateOrcaHookToken("short")).toBeNull();
		expect(validateOrcaHookToken(undefined)).toBeNull();
	});
});

describe("preview bounding", () => {
	it("bounds preview text with a truncation marker", () => {
		expect(boundPreviewText("short")).toBe("short");
		const bounded = boundPreviewText("x".repeat(5000));
		expect(bounded.length).toBeLessThan(2100);
		expect(bounded.endsWith("…[truncated by GJC]")).toBe(true);
	});

	it("forwards small tool inputs verbatim and collapses oversized ones", () => {
		const small = { command: "ls" };
		expect(boundToolInput(small)).toBe(small);
		const huge = { blob: "y".repeat(10000) };
		const bounded = boundToolInput(huge) as { gjc_truncated: boolean; preview: string };
		expect(bounded.gjc_truncated).toBe(true);
		expect(bounded.preview.length).toBeLessThan(2100);
	});
});

describe("shouldRegisterOrcaStatusBridge", () => {
	it("requires an Orca pane identity", () => {
		expect(shouldRegisterOrcaStatusBridge({ ...REGISTER_BASE, env: {} as NodeJS.ProcessEnv })).toBe(false);
		expect(
			shouldRegisterOrcaStatusBridge({ ...REGISTER_BASE, env: { ORCA_PANE_KEY: "t:l" } as NodeJS.ProcessEnv }),
		).toBe(true);
	});

	it("respects the consent setting and the environment kill-switch", () => {
		const env = { ORCA_PANE_KEY: "t:l" } as NodeJS.ProcessEnv;
		expect(shouldRegisterOrcaStatusBridge({ env, enabled: false })).toBe(false);
		expect(
			shouldRegisterOrcaStatusBridge({
				enabled: true,
				env: { ORCA_PANE_KEY: "t:l", GJC_ORCA_STATUS_BRIDGE: "0" } as NodeJS.ProcessEnv,
			}),
		).toBe(false);
	});

	it("stays silent for helper and subagent sessions", () => {
		const env = { ORCA_PANE_KEY: "t:l" } as NodeJS.ProcessEnv;
		expect(shouldRegisterOrcaStatusBridge({ ...REGISTER_BASE, env, taskDepth: 1 })).toBe(false);
		expect(shouldRegisterOrcaStatusBridge({ ...REGISTER_BASE, env, parentTaskPrefix: "6-Extensions" })).toBe(false);
		expect(shouldRegisterOrcaStatusBridge({ ...REGISTER_BASE, env, currentAgentType: "executor" })).toBe(false);
	});

	it("defers to a pane already owned by another process", () => {
		const otherPid = String(process.pid + 1);
		expect(
			shouldRegisterOrcaStatusBridge({
				...REGISTER_BASE,
				env: { ORCA_PANE_KEY: "t:l", ORCA_PI_STATUS_OWNED: otherPid } as NodeJS.ProcessEnv,
			}),
		).toBe(false);
		expect(
			shouldRegisterOrcaStatusBridge({
				...REGISTER_BASE,
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
		expect(post.url).toBe("/hook/gjc");
		expect(post.token).toBe("test-token-1234");
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

	it("bounds oversized prompt and assistant text previews", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext();

		const delivery = receiver.nextDelivery();
		handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "p".repeat(6000) }, ctx);
		const post = await delivery;
		const prompt = post.body.payload.prompt as string;
		expect(prompt.length).toBeLessThan(2100);
		expect(prompt.endsWith("…[truncated by GJC]")).toBe(true);
	});

	it("drops delivery entirely for authority-injection port values", async () => {
		const fetchCalls: string[] = [];
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "80@evil.example",
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
			fetchImpl: ((input: string | URL | Request) => {
				fetchCalls.push(String(input));
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch,
		});
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
		expect(fetchCalls).toEqual([]);
	});

	it("drops delivery when the token would allow header injection", async () => {
		const fetchCalls: string[] = [];
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "57343",
				ORCA_AGENT_HOOK_TOKEN: "bad\r\nX-Injected: 1",
			} as NodeJS.ProcessEnv,
			fetchImpl: ((input: string | URL | Request) => {
				fetchCalls.push(String(input));
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch,
		});
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
		expect(fetchCalls).toEqual([]);
	});

	it("prefers coordinates from a trusted endpoint file over the environment", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-orca-endpoint-"));
		cleanups.push(() => void fs.rm(dir, { recursive: true, force: true }));
		const endpointPath = path.join(dir, "endpoint.env");
		await Bun.write(
			endpointPath,
			`ORCA_AGENT_HOOK_PORT=${receiver.port}\nORCA_AGENT_HOOK_TOKEN=file-token-1234\nORCA_AGENT_HOOK_ENV=production\n`,
		);
		await fs.chmod(endpointPath, 0o600);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
				// Stale env coordinates that the endpoint file must win over.
				ORCA_AGENT_HOOK_PORT: "1",
				ORCA_AGENT_HOOK_TOKEN: "stale-token-1234",
			} as NodeJS.ProcessEnv,
		});
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		expect(post.token).toBe("file-token-1234");
		expect(post.body.payload.hook_event_name).toBe("agent_start");
	});

	it("ignores a symlinked endpoint file and falls back to env coordinates", async () => {
		if (process.platform === "win32") return;
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-orca-endpoint-"));
		cleanups.push(() => void fs.rm(dir, { recursive: true, force: true }));
		const realPath = path.join(dir, "real.env");
		await Bun.write(realPath, `ORCA_AGENT_HOOK_PORT=${receiver.port}\nORCA_AGENT_HOOK_TOKEN=sneaky-token-1234\n`);
		const linkPath = path.join(dir, "endpoint.env");
		await fs.symlink(realPath, linkPath);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: bridgeEnv(receiver, { ORCA_AGENT_HOOK_ENDPOINT: linkPath }),
		});
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		// Symlink rejected (O_NOFOLLOW): trusted env token used, not the file's.
		expect(post.token).toBe("test-token-1234");
	});

	it("ignores a group/world-writable endpoint file", async () => {
		if (process.platform === "win32") return;
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-orca-endpoint-"));
		cleanups.push(() => void fs.rm(dir, { recursive: true, force: true }));
		const endpointPath = path.join(dir, "endpoint.env");
		await Bun.write(endpointPath, `ORCA_AGENT_HOOK_PORT=${receiver.port}\nORCA_AGENT_HOOK_TOKEN=loose-token-1234\n`);
		await fs.chmod(endpointPath, 0o666);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: bridgeEnv(receiver, { ORCA_AGENT_HOOK_ENDPOINT: endpointPath }),
		});
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		expect(post.token).toBe("test-token-1234");
	});

	it("ignores an endpoint file owned by another user", async () => {
		if (process.platform === "win32") return;
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-orca-endpoint-"));
		cleanups.push(() => void fs.rm(dir, { recursive: true, force: true }));
		const endpointPath = path.join(dir, "endpoint.env");
		await Bun.write(endpointPath, `ORCA_AGENT_HOOK_PORT=${receiver.port}\nORCA_AGENT_HOOK_TOKEN=alien-token-1234\n`);
		await fs.chmod(endpointPath, 0o600);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: bridgeEnv(receiver, { ORCA_AGENT_HOOK_ENDPOINT: endpointPath }),
			// Simulate the file belonging to a different uid than the owner check expects.
			ownerUid: (process.getuid?.() ?? 0) + 1,
		});
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		expect(post.token).toBe("test-token-1234");
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

	it("falls back to the pi route once when Orca answers 404 for /hook/gjc", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		receiver.gjcRouteMissing = true;
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext();

		const first = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		const post = await first;
		// The 404'd /hook/gjc attempt is not recorded; the same event lands on /hook/pi.
		expect(post.url).toBe("/hook/pi");
		expect(post.body.payload.hook_event_name).toBe("agent_start");

		// Negotiation is sticky: later events go straight to the pi route.
		const second = receiver.nextDelivery();
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash" }, ctx);
		expect((await second).url).toBe("/hook/pi");
	});

	it("uses a proxy-immune transport by default: inherited HTTP_PROXY never sees the payload", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const proxyHits: string[] = [];
		const proxyServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				proxyHits.push(request.url);
				return new Response("via-proxy");
			},
		});
		cleanups.push(() => proxyServer.stop(true));
		const savedProxy = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyServer.port}`;
		process.env.http_proxy = process.env.HTTP_PROXY;
		cleanups.push(() => {
			if (savedProxy.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
			else process.env.HTTP_PROXY = savedProxy.HTTP_PROXY;
			if (savedProxy.http_proxy === undefined) delete process.env.http_proxy;
			else process.env.http_proxy = savedProxy.http_proxy;
		});

		const { api, handlers } = captureHandlers();
		// No fetchImpl seam: exercises the real default transport.
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const delivery = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		const post = await delivery;
		expect(post.url).toBe("/hook/gjc");
		expect(post.token).toBe("test-token-1234");
		expect(post.body.payload.hook_event_name).toBe("agent_start");
		expect(proxyHits).toEqual([]);
	});

	it("disposes on session_shutdown: never-idle recheck stops and ownership is released", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		const env = bridgeEnv(receiver);
		createOrcaStatusBridge(api, { env });
		expect(env.ORCA_PI_STATUS_OWNED).toBe(String(process.pid));
		const ctx = fakeContext({ isIdle: () => false });

		const started = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await started;
		// Deterministic never-idle: the recheck loop is live when shutdown fires.
		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		await Bun.sleep(80);
		const finalPost = receiver.nextDelivery();
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(env.ORCA_PI_STATUS_OWNED).toBeUndefined();
		// Shutdown is the turn boundary: the deferred agent_end reports exactly once.
		expect((await finalPost).body.payload.hook_event_name).toBe("agent_end");
		const before = receiver.received.length;
		// Longer than the max recheck interval: a surviving timer would fire here.
		await Bun.sleep(400);
		expect(receiver.received.filter(post => post.body.payload.hook_event_name === "agent_end")).toHaveLength(1);
		// Disposed bridge ignores later events entirely.
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(40);
		expect(receiver.received.length).toBe(before);
	});

	it("flushes a snapshot queued at shutdown instead of dropping the final done state", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: bridgeEnv(receiver) });
		const ctx = fakeContext();

		// Hold the first post open so the next snapshot is queued, then shut
		// down while it is still pending — the race print mode exhibits.
		receiver.hold = true;
		const first = receiver.nextDelivery();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await first;
		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		await Bun.sleep(40);
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		const flushed = receiver.nextDelivery();
		receiver.hold = false;
		receiver.releaseHeld();
		expect((await flushed).body.payload.hook_event_name).toBe("agent_end");
	});

	it("does not release a pane ownership marker another process has since claimed", async () => {
		const receiver = startHookReceiver();
		cleanups.push(receiver.stop);
		const { api, handlers } = captureHandlers();
		const env = bridgeEnv(receiver);
		createOrcaStatusBridge(api, { env });
		const otherPid = String(process.pid + 1);
		env.ORCA_PI_STATUS_OWNED = otherPid;
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, fakeContext());
		expect(env.ORCA_PI_STATUS_OWNED).toBe(otherPid);
	});

	it("survives malformed and out-of-range status lines from a hostile loopback peer", async () => {
		const net = await import("node:net");
		let responseLine = "HTTP/1.1 600 Broken\r\n\r\n";
		const rawServer = net.createServer(socket => {
			socket.on("data", () => {
				socket.write(responseLine);
				socket.end();
			});
			socket.on("error", () => {});
		});
		await new Promise<void>(resolve => rawServer.listen(0, "127.0.0.1", resolve));
		const address = rawServer.address();
		if (address === null || typeof address === "string") throw new Error("raw server failed to bind");
		cleanups.push(() => rawServer.close());

		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: String(address.port),
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
		});
		const ctx = fakeContext();
		// 600 escapes the Response constructor's range; must be a silent drop,
		// never an uncaught callback exception.
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(60);
		// Garbage head without CRLF up to the cap: bounded reject, no crash.
		responseLine = "x".repeat(4096);
		handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "still alive" }, ctx);
		await Bun.sleep(60);
		// Bridge is still functional afterwards (state machine not poisoned).
		responseLine = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n";
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "c", toolName: "bash" }, ctx);
		await Bun.sleep(60);
	});

	it("drops the post fail-closed when an envelope coordinate is oversized", async () => {
		const fetchCalls: string[] = [];
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "x".repeat(4096),
				ORCA_AGENT_HOOK_PORT: "57343",
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
			fetchImpl: ((input: string | URL | Request) => {
				fetchCalls.push(String(input));
				return Promise.resolve(new Response("ok"));
			}) as typeof fetch,
		});
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
		expect(fetchCalls).toEqual([]);
	});

	it("aborts the in-flight request on shutdown and never retries the pi route afterwards", async () => {
		const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
		let resolveFirst: ((response: Response) => void) | undefined;
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "57343",
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
			fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(input), signal: init?.signal ?? undefined });
				const { promise, resolve } = Promise.withResolvers<Response>();
				resolveFirst ??= resolve;
				return promise;
			}) as typeof fetch,
		});
		const ctx = fakeContext();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(10);
		expect(calls).toHaveLength(1);
		expect(calls[0].signal?.aborted).toBe(false);
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		// Disposal aborts the in-flight non-flush request immediately.
		expect(calls[0].signal?.aborted).toBe(true);
		// Even if the held request now resolves 404, the pi-route retry is gone.
		resolveFirst?.(new Response(null, { status: 404 }));
		await Bun.sleep(20);
		expect(calls).toHaveLength(1);
	});

	it("does not spawn the WSL curl fallback for work failing after shutdown", async () => {
		const spawned: string[] = [];
		let rejectFirst: ((error: Error) => void) | undefined;
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "57343",
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
			fetchImpl: (() => {
				const { promise, reject } = Promise.withResolvers<Response>();
				rejectFirst ??= reject;
				return promise;
			}) as unknown as typeof fetch,
			isWslRuntime: () => true,
			spawnCurl: command => {
				spawned.push(command.join(" "));
			},
		});
		const ctx = fakeContext();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(10);
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		rejectFirst?.(new Error("loopback unreachable"));
		await Bun.sleep(20);
		expect(spawned).toEqual([]);
	});

	it("stays inert without Orca coordinates", async () => {
		const { api, handlers } = captureHandlers();
		createOrcaStatusBridge(api, { env: { ORCA_PANE_KEY: "tab-1:leaf-1" } as NodeJS.ProcessEnv });
		// No port/token anywhere: handler must be a silent no-op.
		handlers.get("agent_start")?.({ type: "agent_start" }, fakeContext());
		await Bun.sleep(20);
	});

	it("falls back to hardened Windows curl delivery on WSL with a single-flight cap", async () => {
		const { api, handlers } = captureHandlers();
		const spawned: Array<{ command: string[]; body: string }> = [];
		let releaseFirst: (() => void) | undefined;
		createOrcaStatusBridge(api, {
			env: {
				ORCA_PANE_KEY: "tab-1:leaf-1",
				ORCA_AGENT_HOOK_PORT: "1",
				ORCA_AGENT_HOOK_TOKEN: "test-token-1234",
			} as NodeJS.ProcessEnv,
			fetchImpl: (() => Promise.reject(new Error("loopback unreachable"))) as unknown as typeof fetch,
			isWslRuntime: () => true,
			spawnCurl: (command, body) => {
				spawned.push({ command, body });
				const { promise, resolve } = Promise.withResolvers<void>();
				releaseFirst ??= resolve;
				return promise;
			},
		});
		const ctx = fakeContext();
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(20);
		expect(spawned).toHaveLength(1);
		// curlrc processing disabled before any other option.
		expect(spawned[0].command[1]).toBe("-q");
		expect(spawned[0].command).toContain("http://127.0.0.1:1/hook/gjc");
		expect(spawned[0].command).toContain("X-Orca-Agent-Hook-Token: test-token-1234");
		expect(JSON.parse(spawned[0].body).payload.hook_event_name).toBe("agent_start");
		// Second delivery attempt while the first child is alive is dropped.
		handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "x" }, ctx);
		await Bun.sleep(20);
		expect(spawned).toHaveLength(1);
		releaseFirst?.();
		await Bun.sleep(20);
		// Slot cleared: the next event spawns again.
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await Bun.sleep(20);
		expect(spawned).toHaveLength(2);
	});
});
