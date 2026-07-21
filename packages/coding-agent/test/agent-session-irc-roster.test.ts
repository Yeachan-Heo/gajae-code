import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { SimpleStreamOptions } from "@gajae-code/ai";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession, type EphemeralTurnPurpose } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

registerMockApi();

type Harness = {
	session: AgentSession;
	registry: AgentRegistry;
	model: MockModel;
	snapshots: Array<readonly { role: string; customType?: string; content?: unknown }[]>;
	sessionManager: SessionManager;
};

const ROSTER_TYPE = "irc-peer-roster";
const testSessions: AgentSession[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const session of testSessions.splice(0)) await session.dispose();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createHarness(
	options: {
		sessionManager?: SessionManager;
		model?: MockModel;
		getApiKey?: () => Promise<string>;
		retryEnabled?: boolean;
		transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
		onPayload?: SimpleStreamOptions["onPayload"];
	} = {},
): Harness {
	const model = options.model ?? createMockModel({ handler: () => ({ content: ["ok"] }) });
	const snapshots: Harness["snapshots"] = [];
	const registry = new AgentRegistry();
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		streamFn: model.stream,
		convertToLlm: async messages => {
			snapshots.push(messages);
			return convertToLlm(messages);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": options.retryEnabled ?? true }),
		modelRegistry: { getApiKey: options.getApiKey ?? (async () => "test-key"), getAvailable: () => [model] } as never,
		agentId: "0-Main",
		agentRegistry: registry,
		convertToLlm: async messages => {
			snapshots.push(messages);
			return convertToLlm(messages);
		},
		transformContext: options.transformContext,
		onPayload: options.onPayload,
	});
	testSessions.push(session);
	return { session, registry, model, snapshots, sessionManager };
}

function addPeer(registry: AgentRegistry, id = "1-Worker", status: "running" | "idle" = "running"): void {
	registry.register({
		id,
		displayName: `${id} display`,
		rosterLabel: `${id} label`,
		kind: "sub",
		session: null,
		status,
	});
}

function deliveredRosters(harness: Harness): string[] {
	return harness.snapshots.flatMap(snapshot => {
		const content = JSON.stringify(snapshot);
		if (!content.includes(`"customType":"${ROSTER_TYPE}"`)) return [];
		return [content.match(/IRC peers: [^"]*/u)?.[0] ?? "IRC peers: "];
	});
}

function findRosterMessage(harness: Harness): { customType?: string; display?: boolean } | undefined {
	return harness.session.agent.state.messages.find(
		(message): message is Extract<(typeof harness.session.agent.state.messages)[number], { role: "custom" }> =>
			message.role === "custom" && message.customType === ROSTER_TYPE,
	);
}

async function prompt(harness: Harness, text = "hello"): Promise<void> {
	await harness.session.prompt(text);
}

async function ephemeral(harness: Harness, purpose: EphemeralTurnPurpose, text = "side request"): Promise<void> {
	if (purpose === "btw") {
		await harness.session.runEphemeralTurn({
			purpose,
			turn: { question: text, scope: harness.session.createBtwConversationScope("btw test instruction") },
		});
		return;
	}
	await harness.session.runEphemeralTurn({ purpose, promptText: text });
}
async function background(harness: Harness, text = "side request"): Promise<void> {
	await harness.session.respondAsBackground({ from: "1-Worker", message: text });
}

describe("AgentSession IRC roster delivery", () => {
	it("applies ephemeral context transforms and provider hooks without mutating history", async () => {
		let providerOptions: SimpleStreamOptions | undefined;
		const model = createMockModel({
			handler: async (_context, options) => {
				providerOptions = options;
				await options?.onPayload?.({ request: "ephemeral" });
				return { content: ["ok"] };
			},
		});
		const transformContext = vi.fn((messages: AgentMessage[]) => [
			...messages.filter(message => message.role !== "user" || message.content !== "filtered history"),
			{ role: "user" as const, content: "injected context", timestamp: Date.now() },
		]);
		const onPayload = vi.fn();
		const harness = createHarness({ model, transformContext, onPayload });
		const filtered: AgentMessage = { role: "user", content: "filtered history", timestamp: Date.now() };
		const retained: AgentMessage = { role: "user", content: "retained history", timestamp: Date.now() };
		harness.session.agent.appendMessage(filtered);
		harness.session.agent.appendMessage(retained);
		const historyBefore = structuredClone(harness.session.agent.state.messages);

		await harness.session.runEphemeralTurn({ promptText: "side request" });

		expect(transformContext).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.snapshots.at(-1))).not.toContain("filtered history");
		expect(JSON.stringify(harness.snapshots.at(-1))).toContain("injected context");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(providerOptions?.sessionId).not.toBe(harness.session.sessionId);
		expect(harness.session.agent.state.messages).toEqual(historyBefore);
	});
	it("emits one hidden roster reminder for the first roster change", async () => {
		const harness = createHarness();
		addPeer(harness.registry);

		await prompt(harness);

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("1-Worker (1-Worker label)");
		expect(findRosterMessage(harness)).toBeUndefined();
	});

	it("suppresses an unchanged roster and emits a new signature after a roster change", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		await prompt(harness, "first");
		await prompt(harness, "unchanged");
		addPeer(harness.registry, "2-Worker");
		await prompt(harness, "changed");

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]).toContain("2-Worker (2-Worker label)");
	});

	it("does not emit an initially empty roster, but emits once when a delivered roster becomes empty", async () => {
		const harness = createHarness();
		await prompt(harness, "empty");
		addPeer(harness.registry);
		await prompt(harness, "populated");
		harness.registry.unregister("1-Worker");
		await prompt(harness, "empty again");

		expect(deliveredRosters(harness)).toHaveLength(2);
	});

	it("ignores running-to-idle status-only changes", async () => {
		const harness = createHarness();
		addPeer(harness.registry, "1-Worker", "running");
		await prompt(harness, "running");
		harness.registry.setStatus("1-Worker", "idle");
		await prompt(harness, "idle");

		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("includes changed rosters in IRC autoreply snapshots and suppresses unchanged rosters", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		await harness.session.respondAsBackground({ from: "1-Worker", message: "ping" });
		await harness.session.respondAsBackground({ from: "1-Worker", message: "ping again" });

		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("/btw neither carries nor consumes a changed roster", async () => {
		const harness = createHarness();
		addPeer(harness.registry);

		await ephemeral(harness, "btw", "<btw>side</btw>");
		expect(deliveredRosters(harness)).toHaveLength(0);

		await ephemeral(harness, "background", "background carrier");
		expect(deliveredRosters(harness)).toHaveLength(1);
		expect(deliveredRosters(harness)[0]).toContain("1-Worker (1-Worker label)");
		expect(findRosterMessage(harness)).toBeUndefined();
	});

	it("commits direct ephemeral roster delivery without persisting it", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		const before = [...harness.session.agent.state.messages];
		await ephemeral(harness, "background", "first");
		await ephemeral(harness, "background", "second");
		addPeer(harness.registry, "2-Worker");
		await ephemeral(harness, "background", "changed");

		expect(deliveredRosters(harness)).toHaveLength(2);
		expect(deliveredRosters(harness)[1]).toContain("2-Worker (2-Worker label)");
		expect(harness.session.agent.state.messages).toEqual(before);
	});

	it("completes a /btw ephemeral turn before an active main turn releases", async () => {
		const releaseMain = Promise.withResolvers<void>();
		const mainStarted = Promise.withResolvers<void>();
		let calls = 0;
		let mainStreamSessionId: string | undefined;
		const model = createMockModel({
			handler: async (_context, options) => {
				calls += 1;
				if (calls === 1) {
					mainStreamSessionId = options?.sessionId;
					mainStarted.resolve();
					await releaseMain.promise;
				} else if (options?.sessionId === mainStreamSessionId) {
					await releaseMain.promise;
				}
				return { content: ["ok"] };
			},
		});
		const harness = createHarness({ model });
		addPeer(harness.registry);

		const main = prompt(harness, "main");
		await mainStarted.promise;
		const historyDuringMain = [...harness.session.agent.state.messages];
		const side = await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "side request", scope: harness.session.createBtwConversationScope("btw test instruction") },
		});

		expect(side.replyText).toBe("ok");
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.agent.state.messages).toEqual(historyDuringMain);
		expect(model.calls).toHaveLength(2);
		expect(model.calls[1]?.options?.sessionId).not.toBe(model.calls[0]?.options?.sessionId);

		releaseMain.resolve();
		await main;
	});

	it("releases a normal-turn roster claim after a resolving error outcome", async () => {
		let fail = true;
		const harness = createHarness({
			model: createMockModel({
				handler: () => (fail ? { content: ["failed"], stopReason: "error" } : { content: ["ok"] }),
			}),
			retryEnabled: false,
		});
		addPeer(harness.registry);

		await prompt(harness, "fails");
		fail = false;
		await prompt(harness, "retry");

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]).toBe(deliveries[1]);
	});

	it("releases a normal-turn roster claim after a resolving aborted outcome", async () => {
		let abort = true;
		const harness = createHarness({
			model: createMockModel({
				handler: () => (abort ? { content: ["aborted"], stopReason: "aborted" } : { content: ["ok"] }),
			}),
		});
		addPeer(harness.registry);

		await prompt(harness, "aborts");
		abort = false;
		await prompt(harness, "retry");

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]).toBe(deliveries[1]);
	});

	it("drops a roster claim invalidated during prompt setup and redelivers it once", async () => {
		const apiKey = Promise.withResolvers<string>();
		const claimAcquired = Promise.withResolvers<void>();
		const harness = createHarness({
			getApiKey: async () => {
				claimAcquired.resolve();
				return apiKey.promise;
			},
		});
		addPeer(harness.registry);

		const stalePrompt = prompt(harness, "stale");
		await claimAcquired.promise;
		await harness.session.newSession();
		apiKey.resolve("test-key");
		await stalePrompt;

		expect(deliveredRosters(harness)).toHaveLength(0);
		await prompt(harness, "fresh");
		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("omits a direct ephemeral roster claim invalidated during API-key resolution and redelivers it once", async () => {
		const apiKey = Promise.withResolvers<string>();
		const claimAcquired = Promise.withResolvers<void>();
		const harness = createHarness({
			getApiKey: async () => {
				claimAcquired.resolve();
				return apiKey.promise;
			},
		});
		addPeer(harness.registry);

		const staleTurn = ephemeral(harness, "background", "stale side request");
		await claimAcquired.promise;
		await harness.session.newSession();
		apiKey.resolve("test-key");
		await staleTurn;

		expect(deliveredRosters(harness)).toHaveLength(0);
		await ephemeral(harness, "background", "fresh side request");
		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("releases a failed direct ephemeral claimant so a later turn retries the same signature", async () => {
		let fail = true;
		const model = createMockModel({
			handler: () => (fail ? { throw: "temporary failure" } : { content: ["ok"] }),
		});
		const harness = createHarness({ model });
		addPeer(harness.registry);

		await expect(ephemeral(harness, "background")).rejects.toThrow("temporary failure");
		fail = false;
		await ephemeral(harness, "background");

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]).toBe(deliveries[1]);
	});
	it("releases an aborted direct ephemeral roster claim for retry", async () => {
		const apiKey = Promise.withResolvers<string>();
		const claimAcquired = Promise.withResolvers<void>();
		const harness = createHarness({
			getApiKey: async () => {
				claimAcquired.resolve();
				return apiKey.promise;
			},
		});
		addPeer(harness.registry);
		const controller = new AbortController();

		const aborted = harness.session.runEphemeralTurn({ promptText: "abort", signal: controller.signal });
		await claimAcquired.promise;
		controller.abort();
		await expect(aborted).rejects.toThrow();
		apiKey.resolve("test-key");
		await ephemeral(harness, "background", "retry");

		expect(deliveredRosters(harness)).toHaveLength(1);
	});
	it("does not commit a direct roster claim when an abort-ignoring provider completes", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const allowProviderCompletion = Promise.withResolvers<void>();
		let calls = 0;
		const harness = createHarness({
			model: createMockModel({
				handler: async () => {
					calls += 1;
					if (calls === 1) {
						providerStarted.resolve();
						await allowProviderCompletion.promise;
					}
					return { content: ["ok"] };
				},
			}),
		});
		addPeer(harness.registry);
		const controller = new AbortController();

		const aborted = harness.session.runEphemeralTurn({ promptText: "abort", signal: controller.signal });
		await providerStarted.promise;
		controller.abort();
		allowProviderCompletion.resolve();
		await expect(aborted).rejects.toThrow();

		await ephemeral(harness, "background", "retry");

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[0]).toBe(deliveries[1]);
	});

	it("delivers the newest roster signature after the outstanding claim completes", async () => {
		const release = Promise.withResolvers<void>();
		const model = createMockModel({
			handler: async () => {
				await release.promise;
				return { content: ["ok"] };
			},
		});
		const harness = createHarness({ model });
		addPeer(harness.registry, "1-Worker");

		const first = background(harness);
		await Bun.sleep(0);
		addPeer(harness.registry, "2-Worker");
		release.resolve();
		await first;
		await background(harness);

		const deliveries = deliveredRosters(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]).toContain("2-Worker (2-Worker label)");
	});

	it("invalidates a late ephemeral commit when roster delivery state resets", async () => {
		const release = Promise.withResolvers<void>();
		const model = createMockModel({
			handler: async () => {
				await release.promise;
				return { content: ["ok"] };
			},
		});
		const harness = createHarness({ model });
		addPeer(harness.registry);

		const first = background(harness);
		await Bun.sleep(0);
		await harness.session.newSession();
		release.resolve();
		await first;
		await background(harness);

		expect(deliveredRosters(harness)).toHaveLength(2);
	});

	it("preserves the delivered roster signature across same-session reload", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-irc-roster-"));
		tempDirs.push(dir);
		const harness = createHarness({ sessionManager: SessionManager.create(dir, dir) });
		addPeer(harness.registry);
		await prompt(harness, "before reload");
		await harness.session.reload();
		await prompt(harness, "after reload");

		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("redelivers the roster after a committed new-session reset", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		await prompt(harness, "before new session");
		await harness.session.newSession();
		await prompt(harness, "after new session");

		expect(deliveredRosters(harness)).toHaveLength(2);
	});

	it("never retains the roster reminder in agent or session history", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		await prompt(harness);

		expect(findRosterMessage(harness)).toBeUndefined();
		expect(
			harness.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === ROSTER_TYPE),
		).toBe(false);
	});
});
