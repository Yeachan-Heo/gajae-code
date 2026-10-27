import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import packageJson from "../../package.json" with { type: "json" };
import { AcpAgent, acpSessionStateFromConfig } from "../../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { SessionIndex } from "../../src/sdk/broker/session-index";

function config(model: string, thinking: string = "off"): unknown {
	return {
		result: {
			page: {
				items: [
					{ id: "model", value: model },
					{ id: "thinking", value: thinking },
				],
				complete: true,
			},
		},
	};
}

function catalog(model: string, validLevels: string[]): unknown {
	const [provider, id] = model.split("/", 2);
	return {
		result: {
			page: {
				items: [{ provider, id, name: id, thinking: { validLevels } }],
				complete: true,
			},
		},
	};
}

type ThinkingFixture = {
	agent: AcpAgent;
	sessionId: string;
	controlOperations: string[];
	dispose(): void;
};

async function createThinkingFixture(validLevels: string[], applyThinking: boolean): Promise<ThinkingFixture> {
	const tempDir = TempDir.createSync("@acp-thinking-options-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "acp-thinking-options-token";
	const sessionId = "thinking-options-session";
	const controlOperations: string[] = [];
	let currentThinking = "off";
	let server!: ReturnType<typeof Bun.serve>;

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-thinking-options" }));
			},
			async message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "event_replay") {
					socket.send(JSON.stringify({ type: "event_replay_result", id: frame.id, events: [] }));
					return;
				}
				if (frame.type === "register_provider") {
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					let result: Record<string, unknown> = {};
					if (frame.operation === "session.create") {
						const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
						await fs.mkdir(path.dirname(endpointPath), { recursive: true });
						await Bun.write(
							endpointPath,
							JSON.stringify({ sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
						);
						await fs.utimes(endpointPath, 0.001, 0.001);
						const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
						const index = await new SessionIndex(agentDir).open();
						await index.append({
							type: "host_registered",
							sessionId,
							locator: { cwd, worktreeRoot: null, stateRoot: path.join(cwd, ".gjc", "state") },
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs,
						});
						result = {
							sessionId,
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs,
							endpoint: { sessionId, pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token },
						};
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type === "query_request") {
					const query = String(frame.query);
					const items =
						query === "config.list/get"
							? [{ mode: "default", model: "test/reasoning-model", thinking: currentThinking }]
							: query === "models.list/current"
								? [{ provider: "test", id: "reasoning-model", name: "Reasoning", thinking: { validLevels } }]
								: query === "providers.list/active"
									? [{ provider: "test", connectionKind: "credential" }]
									: [];
					const result =
						query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1, primaryControlSurface: "sdk" }
							: query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: { page: { items, complete: true } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type !== "control_request") return;
				if (typeof frame.operation === "string") controlOperations.push(frame.operation);
				if (frame.operation === "thinking.set" && applyThinking) {
					currentThinking = String((frame.input as { level?: unknown })?.level ?? "off");
				}
				socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: {} }));
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Expected an ACP fixture server port");
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: packageJson.version,
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port,
		url: `ws://127.0.0.1:${port}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	const abort = new AbortController();
	const updates: SessionNotification[] = [];
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => {
				updates.push(update);
			},
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const created = await agent.newSession({ cwd, mcpServers: [] });
	return {
		agent,
		sessionId: created.sessionId,
		controlOperations,
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

test("advertises only off for a non-reasoning model", () => {
	const state = acpSessionStateFromConfig(config("test/off-model"), catalog("test/off-model", ["off"]));
	const thinking = state.configOptions.find(option => option.id === "thinking");

	expect(thinking?.options).toEqual([{ value: "off", name: "off" }]);
});

test("advertises the model catalog thinking levels in order", () => {
	const levels = ["off", "minimal", "low", "medium", "high"];
	const state = acpSessionStateFromConfig(config("test/reasoning-model"), catalog("test/reasoning-model", levels));
	const thinking = state.configOptions.find(option => option.id === "thinking");

	expect(thinking?.options).toEqual(levels.map(value => ({ value, name: value })));
});

test("does not advertise an unsupported thinking level", () => {
	const state = acpSessionStateFromConfig(config("test/off-model"), catalog("test/off-model", ["off"]));
	const thinking = state.configOptions.find(option => option.id === "thinking");

	expect(thinking?.options.map(option => option.value)).not.toContain("high");
});

test("rejects an unsupported thinking level without sending thinking.set", async () => {
	const fixture = await createThinkingFixture(["off"], true);
	try {
		await expect(
			fixture.agent.setSessionConfigOption({
				sessionId: fixture.sessionId,
				configId: "thinking",
				value: "high",
			}),
		).rejects.toThrow(/Unsupported thinking level/);
		expect(fixture.controlOperations).not.toContain("thinking.set");
	} finally {
		fixture.dispose();
	}
});

test("rejects a thinking level that the host does not apply", async () => {
	const fixture = await createThinkingFixture(["off", "high"], false);
	try {
		await expect(
			fixture.agent.setSessionConfigOption({
				sessionId: fixture.sessionId,
				configId: "thinking",
				value: "high",
			}),
		).rejects.toThrow(/was not applied/);
		expect(fixture.controlOperations).toContain("thinking.set");
	} finally {
		fixture.dispose();
	}
});

test("resolves a supported thinking level when the host applies it", async () => {
	const fixture = await createThinkingFixture(["off", "high"], true);
	try {
		const result = await fixture.agent.setSessionConfigOption({
			sessionId: fixture.sessionId,
			configId: "thinking",
			value: "high",
		});
		expect(result.configOptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "thinking", currentValue: "high" })]),
		);
	} finally {
		fixture.dispose();
	}
});
