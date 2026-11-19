import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession } from "../src/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { SdkClient, type SdkFrame } from "../src/sdk/client/client";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const NOTIFICATION_ENV_KEYS = ["GJC_NOTIFY", "GJC_NOTIFICATIONS", "GJC_NOTIFICATIONS_TOKEN"] as const;

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

interface AcceptedPrompt {
	ok: true;
	result: { commandId: string; turnId: string; accepted: true };
}

// #7559: turn.abort_and_prompt carries turn.abort's authority, so an owner's
// replaced turn must end as a client cancel on both hosts, never as an agent
// failure. Real factory session, auto-installed SDK host, broker, and WebSocket.
for (const notifications of [true, false]) {
	test(`${notifications ? "notification bus" : "SDK-only"}: owner turn.abort_and_prompt ends the replaced prompt as cancelled`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-abort-and-prompt-owner-"));
		const agentDir = path.join(root, "agent");
		const savedEnv = NOTIFICATION_ENV_KEYS.map(key => [key, process.env[key]] as const);
		let cleanup: FixtureRootCleanup | undefined;
		let client: SdkClient | undefined;
		const failures: unknown[] = [];
		try {
			for (const key of NOTIFICATION_ENV_KEYS) delete process.env[key];
			if (notifications) process.env.GJC_NOTIFICATIONS = "1";
			const started = await withFixtureBrokerEnvironment(() =>
				startFixtureBrokerWithLeaseForTest({ agentDir, env: createFixtureBrokerEnvironment(root, agentDir) }),
			);
			cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
			registerMockApi();
			// The first request holds until aborted; the replacement completes.
			const mock = createMockModel({
				responses: [
					{ content: ["FIRST-PARTIAL"], delayMs: 60_000 },
					{ content: ["REPLACED-OK"], stopReason: "stop" },
				],
			});
			const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
			registerFixtureRuntime(cleanup, {
				key: "auth",
				requiredOwner: "runtime",
				dispose: async () => authStorage.close(),
			});
			const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
			await sessionManager.ensureOnDisk();
			const settings = await Settings.init({ cwd: root, agentDir });
			settings.set("compaction.enabled", false);
			settings.set("todo.enabled", false);
			settings.set("todo.reminders", false);
			const { session } = await createAgentSession({
				cwd: root,
				agentDir,
				sessionManager,
				authStorage,
				model: mock.model,
				settings,
				hasUI: false,
				toolNames: [],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			registerFixtureRuntime(cleanup, {
				key: `session:${session.sessionId}`,
				requiredOwner: "runtime-and-broker",
				shutdown: async () => void (await session.extensionRunner?.emit({ type: "session_shutdown" })),
				dispose: () => session.dispose(),
			});
			await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
			const endpointFile = Bun.file(path.join(root, ".gjc", "state", "sdk", `${session.sessionId}.json`));
			await waitFor(async () => await endpointFile.exists(), "SDK endpoint");
			const endpoint = (await endpointFile.json()) as { url: string; token: string };
			client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 5_000, reconnectAttempts: 0 });
			const frames: SdkFrame[] = [];
			client.onFrame(frame => frames.push(frame));
			await client.request({ type: "event_replay", sinceSeq: 0 });
			// The bus host publishes terminals as top-level frames; the SDK-only host
			// wraps them in an event envelope.
			const terminal = (commandId: string) =>
				frames
					.map(frame => (frame.type === "event" ? (frame.payload as SdkFrame | undefined) : frame))
					.find(
						frame =>
							(frame?.type === "agent_end" || frame?.type === "agent_failed") && frame.commandId === commandId,
					);

			const original = (await client.control("turn.prompt", { text: "first" })) as AcceptedPrompt;
			expect(original).toMatchObject({ ok: true, result: { accepted: true } });
			await waitFor(() => mock.calls.length === 1, "the original provider request");
			const replacement = (await client.control("turn.abort_and_prompt", {
				text: "replacement",
				idempotencyKey: "replace-own-turn",
			})) as AcceptedPrompt;
			expect(replacement).toMatchObject({ ok: true, result: { accepted: true } });
			expect(replacement.result).not.toHaveProperty("queuedAs");
			expect(replacement.result.commandId).not.toBe(original.result.commandId);

			await waitFor(() => terminal(original.result.commandId) !== undefined, "the replaced prompt's terminal");
			await waitFor(() => terminal(replacement.result.commandId) !== undefined, "the replacement's terminal");
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(2);
			expect(session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "REPLACED-OK" }],
			});
			expect(terminal(original.result.commandId)).toMatchObject({
				type: "agent_end",
				turnId: original.result.turnId,
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
			});
			expect(terminal(replacement.result.commandId)).toMatchObject({
				type: "agent_end",
				turnId: replacement.result.turnId,
				outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			});
		} catch (error) {
			failures.push(error);
		} finally {
			for (const release of [
				() => client?.close(),
				() => (cleanup ? cleanupFixtureRoot(cleanup) : fs.rm(root, { recursive: true, force: true })),
				() => resetSettingsForTest(),
			]) {
				try {
					await release();
				} catch (error) {
					failures.push(error);
				}
			}
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "abort_and_prompt owner fixture failed");
	}, 30_000);
}
