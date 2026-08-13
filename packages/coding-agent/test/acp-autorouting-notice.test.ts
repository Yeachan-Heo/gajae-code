import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AUTOROUTING_INACTIVE_WARNING } from "../src/config/autorouting-contract";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import {
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cleanupRoots: FixtureRootCleanup[] = [];

afterEach(async () => {
	await cleanupFixtureRoots(cleanupRoots);
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function thoughtText(update: SessionNotification): string | undefined {
	const value = update.update as { sessionUpdate?: unknown; content?: unknown };
	if (value.sessionUpdate !== "agent_thought_chunk") return undefined;
	const content = value.content as { type?: unknown; text?: unknown } | undefined;
	return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

async function runAutoroutingSession(
	config: string,
): Promise<{ updates: SessionNotification[]; sessionId: string; cwd: string; agent: AcpAgent; close: () => void }> {
	const root = await mkdtemp(path.join(tmpdir(), "gjc-acp-autorouting-notice-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await mkdir(path.join(cwd, ".gjc"), { recursive: true });
	await writeFile(path.join(cwd, ".gjc", "config.yml"), config);

	const environment = createFixtureBrokerEnvironment(root, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: environment }),
	);
	const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
	cleanupRoots.push(cleanup);

	const updates: SessionNotification[] = [];
	const controller = new AbortController();
	const closed = Promise.withResolvers<void>();
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => {
				updates.push(update);
			},
			signal: controller.signal,
			closed: closed.promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);

	try {
		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const created = await waitForSession(agent, cwd);
		return {
			updates,
			sessionId: created.sessionId,
			cwd,
			agent,
			close: () => {
				controller.abort();
				closed.resolve();
			},
		};
	} catch (error) {
		controller.abort();
		closed.resolve();
		throw error;
	}
}

async function waitForSession(agent: AcpAgent, cwd: string): Promise<{ sessionId: string }> {
	return await Promise.race([
		agent.newSession({ cwd, additionalDirectories: [], mcpServers: [] }),
		Bun.sleep(20_000).then(() => {
			throw new Error("Timed out waiting for ACP session/new");
		}),
	]);
}

const inactiveConfig = `configSchemaVersion: 1
task:
  autorouting:
    enabled: true
`;

const activeConfig = `configSchemaVersion: 1
task:
  autorouting:
    enabled: true
    tiers:
      balanced:
        - anthropic/claude-sonnet-4
`;

const disabledConfig = `configSchemaVersion: 1
task:
  autorouting:
    enabled: false
    tiers:
      balanced:
        - anthropic/claude-sonnet-4
`;

test("AC10b: ACP newSession receives one replayed inactive-autorouting warning thought", async () => {
	const { updates, sessionId, close } = await runAutoroutingSession(inactiveConfig);
	try {
		const warningText = `[warning:autorouting] ${AUTOROUTING_INACTIVE_WARNING}\n`;
		await waitFor(
			() => updates.some(update => update.sessionId === sessionId && thoughtText(update) === warningText),
			"inactive autorouting warning thought",
		);
		await Bun.sleep(150);

		const thoughts = updates
			.filter(update => update.sessionId === sessionId)
			.map(thoughtText)
			.filter(Boolean);
		expect(thoughts).toEqual([warningText]);
	} finally {
		close();
	}
});

test("AC10c: usable autorouting tiers and disabled autorouting produce no thought warning", async () => {
	for (const config of [activeConfig, disabledConfig]) {
		const { updates, sessionId, close } = await runAutoroutingSession(config);
		try {
			await Bun.sleep(250);
			expect(
				updates
					.filter(update => update.sessionId === sessionId)
					.map(thoughtText)
					.filter(Boolean),
			).toEqual([]);
		} finally {
			close();
		}
	}
});
