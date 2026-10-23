import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import type { Settings } from "../src/config/settings";
import { validateSettingPatch } from "../src/config/settings-schema";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { createOrchestrationNotificationsExtension } from "./helpers/telegram-topic-test";

const BINDING_PATHS = [
	"notifications.telegram.chatId",
	"notifications.discord.applicationId",
	"notifications.discord.guildId",
	"notifications.discord.parentChannelId",
	"notifications.slack.workspaceId",
	"notifications.slack.channelId",
	"notifications.slack.authorizedUserId",
] as const;

const BINDING_DETAIL = "Notification binding fields cannot be changed through config.patch.";

const STILL_ALLOWED_PATCHES = [
	{ "notifications.enabled": true },
	{ "notifications.enabled": false },
	{ "notifications.verbosity": "lean" },
	{ "notifications.verbosity": "verbose" },
	{ "notifications.redact": true },
	{ "notifications.sessionScope": "primary" },
	{ "notifications.telegram.sound": "none" },
	{ "notifications.telegram.enabled": true },
	{ "notifications.slack.enabled": false },
	{ "notifications.discord.enabled": true },
] as const;

const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	await Promise.all(sockets.splice(0).map(closeSocket));
	for (const dir of dirs) await brokerOwnerForTest(dir)?.stop();
	for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
	delete process.env.GJC_NOTIFICATIONS;
});

test("property refuses notification binding paths for arbitrary values", () => {
	fc.assert(
		fc.property(
			fc.constantFrom(...BINDING_PATHS),
			fc.oneof(fc.string(), fc.constant(null), fc.boolean(), fc.integer()),
			(settingPath, value) => {
				const issues = validateSettingPatch({ [settingPath]: value });
				const again = validateSettingPatch({ [settingPath]: value });
				return (
					issues.length === 1 &&
					issues[0]?.path === settingPath &&
					issues[0]?.detail === BINDING_DETAIL &&
					JSON.stringify(issues) === JSON.stringify(again)
				);
			},
		),
		{ seed: 88421, numRuns: 64 },
	);
});

test("property still allows non-binding notification settings", () => {
	fc.assert(
		fc.property(fc.constantFrom(...STILL_ALLOWED_PATCHES), patch => {
			const issues = validateSettingPatch({ ...patch });
			const again = validateSettingPatch({ ...patch });
			return issues.length === 0 && JSON.stringify(issues) === JSON.stringify(again);
		}),
		{ seed: 88422, numRuns: 64 },
	);
});

test("SDK config.patch refuses notification binding keys and writes nothing", async () => {
	const writes: Array<[string, unknown]> = [];
	const host = await bootHost(writes);
	try {
		for (const settingPath of BINDING_PATHS) {
			const response = await host.request(`bind-${settingPath}`, {
				type: "control_request",
				id: `bind-${settingPath}`,
				operation: "config.patch",
				input: { patch: { [settingPath]: "attacker-value" } },
			});
			expect(response).toEqual({
				type: "control_response",
				id: `bind-${settingPath}`,
				ok: false,
				error: {
					code: "invalid_input",
					message: `config.patch rejects invalid settings: ${settingPath} (${BINDING_DETAIL})`,
				},
			});
		}
		const mixed = await host.request("mixed", {
			type: "control_request",
			id: "mixed",
			operation: "config.patch",
			input: {
				patch: {
					"notifications.slack.authorizedUserId": "U-ATTACKER",
					"notifications.enabled": true,
				},
			},
		});
		expect(mixed.ok).toBe(false);
		expect(writes).toEqual([]);
		const secret = await host.request("secret", {
			type: "control_request",
			id: "secret",
			operation: "config.patch",
			input: { patch: { "notifications.slack.botToken": "xoxb-attacker" } },
		});
		expect(secret).toEqual({
			type: "control_response",
			id: "secret",
			ok: false,
			error: { code: "invalid_input", message: "config.patch rejects secret fields at the SDK host." },
		});
		expect(writes).toEqual([]);
	} finally {
		await host.shutdown();
	}
}, 30_000);

test("SDK config.patch still allows a non-binding notification setting", async () => {
	const writes: Array<[string, unknown]> = [];
	const host = await bootHost(writes);
	try {
		const response = await host.request("enabled", {
			type: "control_request",
			id: "enabled",
			operation: "config.patch",
			input: { patch: { "notifications.enabled": true, "notifications.verbosity": "verbose" } },
		});
		expect(response).toMatchObject({
			ok: true,
			result: {
				patched: ["notifications.enabled", "notifications.verbosity"],
			},
		});
		expect(writes).toEqual([
			["notifications.enabled", true],
			["notifications.verbosity", "verbose"],
		]);
	} finally {
		await host.shutdown();
	}
}, 30_000);

async function bootHost(writes: Array<[string, unknown]>): Promise<{
	request: (id: string, command: Record<string, unknown>) => Promise<Record<string, unknown>>;
	shutdown: () => Promise<void>;
}> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-config-patch-binding-"));
	dirs.push(cwd);
	const sessionId = `binding-${Date.now()}`;
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		getThinkingLevel: () => "low",
		sendUserMessage: () => Promise.resolve(undefined),
	};
	const settings = {
		get: () => undefined,
		set: (key: string, value: unknown) => {
			writes.push([key, value]);
		},
	} as unknown as Settings;
	process.env.GJC_NOTIFICATIONS = "1";
	createOrchestrationNotificationsExtension(api as never, { settings });
	const ctx = hostContext(cwd, sessionId);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	return {
		request: async (id, command) => {
			socket.send(
				JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
			);
			await waitFor(
				() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
				`${id} response`,
			);
			return JSON.parse(
				String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
			) as Record<string, unknown>;
		},
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		},
	};
}

function hostContext(cwd: string, sessionId: string): Record<string, unknown> {
	return {
		cwd,
		sessionMetadata: { kind: "main", taskDepth: 0 },
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionName: () => "binding patch",
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
			getBranch: () => [],
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100, percent: 0 }),
		model: { provider: "fixture-provider", id: "reasoning-model" },
		getThinkingLevel: () => "low",
		getActivePromptHandle: () => undefined,
		modelRegistry: { getAll: () => [], getActiveProviders: () => [] },
		getSystemPrompt: () => ["test"],
		isIdle: () => true,
		hasPendingMessages: () => false,
		getPendingMessageCounts: () => ({ steering: 0, followUp: 0, nextTurn: 0 }),
		getTranscript: () => [],
		getTranscriptBody: () => undefined,
		getGoalState: () => undefined,
		getTodoState: () => [],
		getQueuedMessages: () => [],
		cycleModel: async () => undefined,
		cycleThinkingLevel: () => "low",
		setQueueMode: () => false,
		getSkillState: () => [],
		getConfigItems: () => [],
		getBranchCandidates: () => [],
		getExtensions: () => [],
		getArtifact: () => undefined,
		getJobs: () => undefined,
		sdkBindings: () => [],
		clearContext: async () => true,
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = performance.now() + 15_000;
	while (!predicate()) {
		if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.addEventListener("close", () => resolve(), { once: true });
	socket.close();
	await Promise.race([promise, Bun.sleep(500)]);
}
