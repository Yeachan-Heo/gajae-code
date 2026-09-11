/**
 * Devin CLI provider tests.
 *
 * Devin CLI is not installable in CI, so the provider runs against
 * `test/fixtures/devin-acp-agent.ts`: a real subprocess speaking ACP v1 over
 * stdio through the official `@agentclientprotocol/sdk` — the same protocol
 * surface `devin acp` implements. Nothing here claims live Devin traffic.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";
import { devinModelManagerOptions } from "../src/provider-models/special";
import {
	DEVIN_ACP_BASE_URL,
	DEVIN_ACP_CONTEXT_WINDOW,
	DEVIN_ACP_MAX_TOKENS,
	type DevinAcpConfig,
	devinAcpBridgeIdentity,
	devinAcpResolvePermissionMode,
	fetchDevinAcpModels,
	streamDevinAcp,
} from "../src/providers/devin-acp";
import { stream } from "../src/stream";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	isKnownProvider,
	KNOWN_PROVIDERS,
	type Model,
	type ProviderSessionState,
} from "../src/types";

const FIXTURE = path.join(import.meta.dir, "fixtures", "devin-acp-agent.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function devinModel(id = "adaptive"): Model<"devin-acp"> {
	return {
		id,
		name: id,
		api: "devin-acp",
		provider: "devin",
		baseUrl: DEVIN_ACP_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEVIN_ACP_CONTEXT_WINDOW,
		maxTokens: DEVIN_ACP_MAX_TOKENS,
	};
}

function userContext(text: string): Context {
	return { messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
}

/** Launch configuration for the ACP fixture (`<cliPath> <cliArgs...> acp`). */
function fixtureCli(scenario: string, receiptPath?: string): { cliPath: string; cliArgs: string[] } {
	return {
		cliPath: process.execPath,
		cliArgs: receiptPath === undefined ? [FIXTURE, scenario] : [FIXTURE, scenario, receiptPath],
	};
}

/**
 * Stream options for one interactive Devin turn. A Devin turn always belongs to
 * a GJC session, so the session identity is part of the fixture defaults.
 */
function fixtureTurn(
	scenario: string,
	extra: Partial<DevinAcpConfig> = {},
	receiptPath?: string,
): { devinAcp: DevinAcpConfig; providerSessionId: string } {
	return {
		devinAcp: { ...fixtureCli(scenario, receiptPath), ...extra },
		providerSessionId: "test-conversation",
	};
}

async function drain(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

function assistantText(message: AssistantMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function closeAll(state: Map<string, ProviderSessionState>): void {
	for (const entry of state.values()) entry.close();
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
		await Bun.sleep(25);
	}
	throw new Error(`receipt ${file} was never written`);
}

/** Fails when the child is still alive at the deadline; a reaped child raises ESRCH. */
async function expectProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`child ${pid} was never reaped after its turn settled`);
}

describe("devin provider registration", () => {
	test("is a known provider with a default model and keyless descriptor", () => {
		expect(isKnownProvider("devin")).toBe(true);
		expect(KNOWN_PROVIDERS).toContain("devin");
		expect(DEFAULT_MODEL_PER_PROVIDER.devin).toBe("adaptive");
	});

	test("dispatches through the provider stream without an API key", async () => {
		const { message } = await drain(
			stream(devinModel(), userContext("hi"), fixtureTurn("chat")) as AssistantMessageEventStream,
		);
		expect(message.stopReason).toBe("stop");
		expect(assistantText(message)).toBe("hello world done");
	});
});

describe("devin turn mapping", () => {
	test("streams text, thinking and remote tool calls without dispatching them to GJC", async () => {
		const { events, message } = await drain(
			streamDevinAcp(devinModel(), userContext("run the tests"), fixtureTurn("chat")),
		);

		expect(message.stopReason).toBe("stop");
		expect(message.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall", "text"]);
		const thinking = message.content[0];
		expect(thinking.type === "thinking" && thinking.thinking).toBe("planning");
		const text = message.content[1];
		expect(text.type === "text" && text.text).toBe("hello world");
		const toolCall = message.content[2];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type === "toolCall") {
			expect(toolCall.id).toBe("call-1");
			expect(toolCall.name).toBe("bash");
			expect(toolCall.arguments.command).toBe("bun test");
			expect(toolCall.arguments._acp).toEqual({ toolCallId: "call-1", kind: "execute", status: "completed" });
			expect(toolCall.intent).toBe("Run the test suite");
		}
		// The provider must never ask GJC to execute a Devin tool call.
		expect(message.stopReason).not.toBe("toolUse");
		expect(events.some(event => event.type === "toolcall_end")).toBe(true);
		expect(events.filter(event => event.type === "done")).toHaveLength(1);
	});

	test("maps ACP stop reasons onto GJC stop reasons", async () => {
		const refusal = await drain(streamDevinAcp(devinModel(), userContext("hi"), fixtureTurn("refusal")));
		expect(refusal.message.stopReason).toBe("stop");

		const limits = await drain(streamDevinAcp(devinModel(), userContext("hi"), fixtureTurn("limits")));
		expect(limits.message.stopReason).toBe("length");
		expect(limits.message.errorMessage).toContain("turn or token limit");
	});

	test("reports a crashed agent as an error turn with the child's stderr tail", async () => {
		const { message } = await drain(streamDevinAcp(devinModel(), userContext("hi"), fixtureTurn("crash")));
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("exited with code 9");
	});

	test("reports a missing Devin CLI without throwing out of the stream factory", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("hi"), {
				devinAcp: { cliPath: path.join(os.tmpdir(), "gjc-missing-devin-cli") },
				providerSessionId: "test-conversation",
			}),
		);
		expect(message.stopReason).toBe("error");
		expect(`${message.errorMessage}`).toContain("devin auth login");
	});

	test("surfaces an unauthenticated Devin CLI with the login instruction", async () => {
		const { message } = await drain(streamDevinAcp(devinModel(), userContext("hi"), fixtureTurn("auth")));
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("devin auth login");
	});

	test("rejects a model the account does not advertise", async () => {
		const { message } = await drain(streamDevinAcp(devinModel("gpt-9"), userContext("hi"), fixtureTurn("model")));
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("does not offer model");
	});

	test("applies the selected model to the ACP session", async () => {
		const { message } = await drain(streamDevinAcp(devinModel("opus"), userContext("hi"), fixtureTurn("model")));
		expect(message.stopReason).toBe("stop");
		expect(assistantText(message)).toBe("model:opus");
	});

	test("keeps the agent's own model when it advertises no model selector", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel("opus"), userContext("hi"), fixtureTurn("no-model-option")),
		);
		expect(message.stopReason).toBe("stop");
	});

	test("refuses a turn with no user message instead of sending an empty prompt", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), { systemPrompt: ["summarize"], messages: [] }, fixtureTurn("chat")),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("empty prompt is not sent");
	});

	test("refuses GJC maintenance calls instead of billing them to Devin", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("summarize the conversation"), {
				...fixtureTurn("chat"),
				maintenanceCall: true,
			}),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("maintenance calls");
		// The agent must never have seen a prompt: the chat scenario would have
		// streamed text into the turn.
		expect(message.content).toEqual([]);
	});

	test("refuses agent-attributed maintenance calls", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("summarize the conversation"), {
				...fixtureTurn("chat"),
				initiatorOverride: "agent",
			}),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("maintenance calls");
	});

	test("refuses utility one-shots that carry no session identity", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("title this session"), { devinAcp: fixtureCli("chat") }),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("session identity");
		expect(message.content).toEqual([]);
	});
});

describe("devin permission policy", () => {
	test("grants allow_once — never allow_always — in the default allow policy", async () => {
		const { message } = await drain(streamDevinAcp(devinModel(), userContext("clean up"), fixtureTurn("permission")));
		expect(assistantText(message)).toBe('decision:{"outcome":"selected","optionId":"allow-once"}');
	});

	test("rejects with reject_once when the caller configures deny", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("clean up"), fixtureTurn("permission", { permissionMode: "deny" })),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"selected","optionId":"reject-once"}');
	});

	test("cancels the request when no offered option matches the policy", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("clean up"), fixtureTurn("permission-reject-only")),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"cancelled"}');
	});

	test("cancels rather than escalating to allow_always when allow_once is not offered", async () => {
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("clean up"), fixtureTurn("permission-allow-always-only")),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"cancelled"}');
	});

	test("deny may fall back to reject_always when reject_once is not offered", async () => {
		const { message } = await drain(
			streamDevinAcp(
				devinModel(),
				userContext("clean up"),
				fixtureTurn("permission-allow-always-only", { permissionMode: "deny" }),
			),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"selected","optionId":"reject-always"}');
	});

	test("honours an explicit permission handler", async () => {
		const { message } = await drain(
			streamDevinAcp(
				devinModel(),
				userContext("clean up"),
				fixtureTurn("permission", {
					permissionMode: "deny",
					permissionHandler: request => {
						expect(request.toolCallId).toBe("call-perm");
						expect(request.options.map(option => option.kind)).toContain("allow_once");
						return { optionId: "allow-always" };
					},
				}),
			),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"selected","optionId":"allow-always"}');
	});

	test("never converts a throwing handler into an approval", async () => {
		const { message } = await drain(
			streamDevinAcp(
				devinModel(),
				userContext("clean up"),
				fixtureTurn("permission", {
					permissionHandler: () => {
						throw new Error("permission UI exploded");
					},
				}),
			),
		);
		expect(assistantText(message)).toBe('decision:{"outcome":"cancelled"}');
	});

	test("resolves the documented policy from the environment and fails closed", () => {
		expect(devinAcpResolvePermissionMode(undefined, {})).toBe("allow");
		expect(devinAcpResolvePermissionMode(undefined, { GJC_DEVIN_PERMISSION_MODE: "" })).toBe("allow");
		expect(devinAcpResolvePermissionMode(undefined, { GJC_DEVIN_PERMISSION_MODE: "  " })).toBe("allow");
		expect(devinAcpResolvePermissionMode(undefined, { GJC_DEVIN_PERMISSION_MODE: "agent-free" })).toBe("deny");
		// Case and surrounding whitespace are normalized; anything unrecognized is denied.
		expect(devinAcpResolvePermissionMode(undefined, { GJC_DEVIN_PERMISSION_MODE: " ALLOW " })).toBe("allow");
		expect(devinAcpResolvePermissionMode(undefined, { GJC_DEVIN_PERMISSION_MODE: "allow_always" })).toBe("deny");
		// An explicit typed mode always wins over the environment.
		expect(devinAcpResolvePermissionMode("deny", { GJC_DEVIN_PERMISSION_MODE: "allow" })).toBe("deny");
		expect(devinAcpResolvePermissionMode("allow", { GJC_DEVIN_PERMISSION_MODE: "deny" })).toBe("allow");
	});
});

describe("devin session lifecycle", () => {
	test("reuses one ACP session per conversation and isolates different conversations", async () => {
		const stateA = new Map<string, ProviderSessionState>();
		const stateB = new Map<string, ProviderSessionState>();
		try {
			const first = await drain(
				streamDevinAcp(devinModel(), userContext("one"), {
					...fixtureTurn("session"),
					providerSessionId: "conversation-a",
					providerSessionState: stateA,
				}),
			);
			const second = await drain(
				streamDevinAcp(devinModel(), userContext("two"), {
					...fixtureTurn("session"),
					providerSessionId: "conversation-a",
					providerSessionState: stateA,
				}),
			);
			const other = await drain(
				streamDevinAcp(devinModel(), userContext("three"), {
					...fixtureTurn("session"),
					providerSessionId: "conversation-b",
					providerSessionState: stateB,
				}),
			);
			expect(assistantText(first.message)).toBe("session:fixture-session");
			expect(assistantText(second.message)).toBe("session:fixture-session");
			expect(assistantText(other.message)).toBe("session:fixture-session");
			expect(stateA.size).toBe(1);
			expect(stateB.size).toBe(1);
			expect([...stateA.keys()]).not.toEqual([...stateB.keys()]);
		} finally {
			closeAll(stateA);
			closeAll(stateB);
		}
	});

	test("keeps an active turn alive on a gap-based idle budget", async () => {
		// 8 updates 120ms apart (~1s of activity) with a 400ms idle budget: only a
		// gap-based budget lets the turn finish, a whole-turn deadline would not.
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("long turn"), {
				...fixtureTurn("slow-chunks"),
				streamIdleTimeoutMs: 400,
			}),
		);
		expect(message.stopReason).toBe("stop");
		expect(assistantText(message)).toBe("01234567");
	});

	test("still expires the idle budget when the agent goes silent after activity", async () => {
		// Activity re-arms the budget; it must not disable it.
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("go quiet"), {
				...fixtureTurn("chunk-then-silence"),
				streamIdleTimeoutMs: 300,
			}),
		);
		expect(assistantText(message)).toBe("alive");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("timed out");
	});

	test("reaps a disposable child when a parked prompt settles the turn", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-owned-child-"));
		tempDirs.push(dir);
		const receipt = path.join(dir, "prompt-receipt.json");
		// No `providerSessionState`: this bridge is disposable, so only the turn's own
		// settlement can reap the child.
		const { message } = await drain(
			streamDevinAcp(devinModel(), userContext("go quiet"), {
				...fixtureTurn("chunk-then-silence", {}, receipt),
				streamIdleTimeoutMs: 300,
			}),
		);
		expect(message.stopReason).toBe("error");
		const receiptBody = JSON.parse(await waitForFile(receipt)) as { pid?: number };
		expect(typeof receiptBody.pid).toBe("number");
		await expectProcessExit(receiptBody.pid as number);
	});

	test("settles a cancel that races the ACP handshake without forwarding the prompt", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-slow-session-"));
		tempDirs.push(dir);
		const receipt = path.join(dir, "prompt-receipt.json");
		const controller = new AbortController();
		const streamResult = streamDevinAcp(devinModel(), userContext("cancel me"), {
			...fixtureTurn("slow-session", {}, receipt),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		const message = await streamResult.result();
		expect(message.stopReason).toBe("aborted");
		// Outlive the fixture's 600ms `session/new`: a prompt that had been forwarded
		// would have written its receipt by now.
		await Bun.sleep(900);
		expect(fs.existsSync(receipt)).toBe(false);
	});

	test("applies each turn's permission policy on a cached conversation", async () => {
		const state = new Map<string, ProviderSessionState>();
		try {
			const first = await drain(
				streamDevinAcp(devinModel(), userContext("clean up"), {
					...fixtureTurn("permission"),
					providerSessionId: "policy-conversation",
					providerSessionState: state,
				}),
			);
			expect(assistantText(first.message)).toBe('decision:{"outcome":"selected","optionId":"allow-once"}');
			const second = await drain(
				streamDevinAcp(devinModel(), userContext("clean up"), {
					...fixtureTurn("permission", { permissionMode: "deny" }),
					providerSessionId: "policy-conversation",
					providerSessionState: state,
				}),
			);
			// A cached child must not pin the policy of the turn that created it.
			expect(assistantText(second.message)).toBe('decision:{"outcome":"selected","optionId":"reject-once"}');
		} finally {
			closeAll(state);
		}
	});

	test("forwards caller cancellation as an ACP session/cancel", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-cancel-"));
		tempDirs.push(dir);
		const receipt = path.join(dir, "cancel-receipt.json");
		const controller = new AbortController();
		const streamResult = streamDevinAcp(devinModel(), userContext("wait"), {
			...fixtureTurn("cancel", {}, receipt),
			signal: controller.signal,
		});
		const events: AssistantMessageEvent[] = [];
		const consumer = (async () => {
			for await (const event of streamResult) {
				events.push(event);
				if (event.type === "text_delta") controller.abort();
			}
		})();
		const message = await streamResult.result();
		await consumer;
		expect(message.stopReason).toBe("aborted");
		const receiptBody = JSON.parse(await waitForFile(receipt)) as { cancelReceived?: boolean };
		expect(receiptBody.cancelReceived).toBe(true);
	});
	test("keys the cached ACP child on the working directory", () => {
		const argv = ["devin", "acp"];
		expect(devinAcpBridgeIdentity("chat", "/work/a", argv)).toBe(devinAcpBridgeIdentity("chat", "/work/a", argv));
		expect(devinAcpBridgeIdentity("chat", "/work/a", argv)).not.toBe(devinAcpBridgeIdentity("chat", "/work/b", argv));
		expect(devinAcpBridgeIdentity("chat", "/work/a", argv)).not.toBe(
			devinAcpBridgeIdentity("other", "/work/a", argv),
		);
	});

	test("replaces the cached child when the working directory changes", async () => {
		const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-cwd-a-"));
		const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-devin-cwd-b-"));
		tempDirs.push(dirA, dirB);
		const state = new Map<string, ProviderSessionState>();
		try {
			await drain(
				streamDevinAcp(devinModel(), userContext("one"), {
					...fixtureTurn("session", { cwd: dirA }),
					providerSessionId: "cwd-conversation",
					providerSessionState: state,
				}),
			);
			expect(state.size).toBe(1);
			await drain(
				streamDevinAcp(devinModel(), userContext("two"), {
					...fixtureTurn("session", { cwd: dirB }),
					providerSessionId: "cwd-conversation",
					providerSessionState: state,
				}),
			);
			// The new directory must miss the cache, and the superseded child must not
			// stay behind holding the abandoned directory.
			expect(state.size).toBe(1);
			expect([...state.keys()][0]).toContain(dirB);
		} finally {
			closeAll(state);
		}
	});
});

describe("devin model discovery", () => {
	test("exposes ACP discovery through the provider's model manager options", async () => {
		const options = devinModelManagerOptions(fixtureCli("model"));
		expect(options.providerId).toBe("devin");
		expect(options.staticModels).toBeUndefined();
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["adaptive", "opus", "sonnet"]);
	});

	test("lists the account models from the ACP session model config option", async () => {
		const models = await fetchDevinAcpModels(fixtureCli("model"));
		expect(models?.map(model => model.id)).toEqual(["adaptive", "opus", "sonnet"]);
		expect(models?.[0]).toMatchObject({
			api: "devin-acp",
			provider: "devin",
			baseUrl: DEVIN_ACP_BASE_URL,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("advertises image input only when the agent supports it", async () => {
		const withoutImages = await fetchDevinAcpModels(fixtureCli("model"));
		expect(withoutImages?.[0].input).toEqual(["text"]);
		const withImages = await fetchDevinAcpModels(fixtureCli("images"));
		expect(withImages?.[0].input).toEqual(["text", "image"]);
	});

	test("returns null instead of guessing when the CLI is missing", async () => {
		const models = await fetchDevinAcpModels({
			cliPath: path.join(os.tmpdir(), "gjc-missing-devin-cli"),
		});
		expect(models).toBeNull();
	});
});
