import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
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

async function ephemeral(harness: Harness, text = "side request"): Promise<void> {
	await harness.session.runEphemeralTurn({ promptText: text });
}

describe("AgentSession IRC roster delivery", () => {
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

	it("applies the same changed-only roster rule to /btw ephemeral turns", async () => {
		const harness = createHarness();
		addPeer(harness.registry);
		await ephemeral(harness, "<btw>first</btw>");
		await ephemeral(harness, "<btw>second</btw>");

		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("delivers a concurrent main and ephemeral turn through exactly one carrier", async () => {
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const model = createMockModel({
			handler: async () => {
				calls += 1;
				if (calls === 1) await release.promise;
				return { content: ["ok"] };
			},
		});
		const harness = createHarness({ model });
		addPeer(harness.registry);

		const main = prompt(harness, "main");
		await Bun.sleep(0);
		const side = ephemeral(harness);
		release.resolve();
		await Promise.all([main, side]);

		expect(deliveredRosters(harness)).toHaveLength(1);
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

	it("omits an ephemeral roster claim invalidated during API-key resolution and redelivers it once", async () => {
		const apiKey = Promise.withResolvers<string>();
		const claimAcquired = Promise.withResolvers<void>();
		const harness = createHarness({
			getApiKey: async () => {
				claimAcquired.resolve();
				return apiKey.promise;
			},
		});
		addPeer(harness.registry);

		const staleTurn = ephemeral(harness, "stale side request");
		await claimAcquired.promise;
		await harness.session.newSession();
		apiKey.resolve("test-key");
		await staleTurn;

		expect(deliveredRosters(harness)).toHaveLength(0);
		await ephemeral(harness, "fresh side request");
		expect(deliveredRosters(harness)).toHaveLength(1);
	});

	it("releases a failed claimant so a later turn retries the same signature", async () => {
		let fail = true;
		const model = createMockModel({
			handler: () => (fail ? { throw: "temporary failure" } : { content: ["ok"] }),
		});
		const harness = createHarness({ model });
		addPeer(harness.registry);

		await expect(ephemeral(harness)).rejects.toThrow("temporary failure");
		fail = false;
		await ephemeral(harness);

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

		const first = ephemeral(harness);
		await Bun.sleep(0);
		addPeer(harness.registry, "2-Worker");
		release.resolve();
		await first;
		await ephemeral(harness);

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

		const first = ephemeral(harness);
		await Bun.sleep(0);
		await harness.session.newSession();
		release.resolve();
		await first;
		await ephemeral(harness);

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
