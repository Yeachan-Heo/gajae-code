import { describe, expect, test } from "bun:test";
import { type NotificationConfig, telegramActivationIdentity } from "../src/sdk/bus/config";
import {
	type BoundNotificationSession,
	type NotificationRuntimePolicy,
	type NotificationSessionContext,
	NotificationSessionController,
	type NotificationSessionRuntime,
} from "../src/sdk/bus/session-control";

const BASE_CONFIG: NotificationConfig = {
	enabled: false,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
		applicationId: undefined,
		guildId: undefined,
		parentChannelId: undefined,
	},
	slack: {
		botToken: undefined,
		appToken: undefined,
		workspaceId: undefined,
		channelId: undefined,
		authorizedUserId: undefined,
	},
	redact: false,
	verbosity: "lean",
	sessionScope: "all",
	idleTimeoutMs: 60_000,
	rich: { enabled: true },
	richDraft: { enabled: false },
	toolActivity: { enabled: true },
	streaming: { enabled: true },
	topics: { nameTemplate: undefined },
	btw: { enabled: true },
};

type Call = { kind: "start" | "stop" | "daemon"; cwd: string; sessionId: string };

function createContext(
	cwd = "/workspace/one",
	sessionId = "session-one",
): {
	context: NotificationSessionContext;
	setSession(cwd: string, sessionId: string): void;
} {
	let currentCwd = cwd;
	let currentSessionId = sessionId;
	return {
		context: {
			sessionManager: {
				getCwd: () => currentCwd,
				getSessionId: () => currentSessionId,
			},
		},
		setSession: (nextCwd, nextSessionId) => {
			currentCwd = nextCwd;
			currentSessionId = nextSessionId;
		},
	};
}

function createRuntime(calls: Call[]): NotificationSessionRuntime {
	const running = new Set<string>();
	const record = (kind: Call["kind"], binding: BoundNotificationSession): void => {
		calls.push({ kind, cwd: binding.cwd, sessionId: binding.sessionId });
	};
	return {
		isRunning: binding => running.has(binding.sessionId),
		start: async binding => {
			record("start", binding);
			if (running.has(binding.sessionId)) return "already";
			running.add(binding.sessionId);
			return "started";
		},
		stop: async binding => {
			record("stop", binding);
			return running.delete(binding.sessionId);
		},
		ensureTelegramDaemon: async binding => {
			record("daemon", binding);
			return "ready";
		},
	};
}

interface ConnectedFakeClient {
	readonly frames: string[];
	receive(frame: string): void;
}

function createConnectedFakeClient(): ConnectedFakeClient {
	const frames: string[] = [];
	return {
		frames,
		receive: frame => {
			frames.push(frame);
		},
	};
}

function createFrameRuntime(
	calls: Call[],
	client: ConnectedFakeClient,
	input: { startGate?: Promise<void>; onStart?: () => void } = {},
): NotificationSessionRuntime {
	const running = new Set<string>();
	const record = (kind: Call["kind"], binding: BoundNotificationSession): void => {
		calls.push({ kind, cwd: binding.cwd, sessionId: binding.sessionId });
	};
	return {
		isRunning: binding => running.has(binding.sessionId),
		start: async binding => {
			record("start", binding);
			if (running.has(binding.sessionId)) return "already";
			input.onStart?.();
			await input.startGate;
			running.add(binding.sessionId);
			client.receive(`identity_header:${binding.sessionId}`);
			return "started";
		},
		stop: async binding => {
			record("stop", binding);
			return running.delete(binding.sessionId);
		},
		ensureTelegramDaemon: async () => "ready",
	};
}

const telegramConfig = (): NotificationConfig => ({
	...BASE_CONFIG,
	enabled: true,
	botToken: "telegram-token",
	chatId: "telegram-chat",
});

const discordConfig = (): NotificationConfig => ({
	...BASE_CONFIG,
	enabled: true,
	discord: {
		botToken: "discord-token",
		applicationId: "discord-application",
		guildId: "discord-guild",
		parentChannelId: "discord-parent",
	},
});

const slackConfig = (): NotificationConfig => ({
	...BASE_CONFIG,
	enabled: true,
	slack: {
		botToken: "slack-token",
		appToken: "slack-app-token",
		workspaceId: "slack-workspace",
		channelId: "slack-channel",
	},
});

test("commits the stable policy before activating a cold runtime", async () => {
	const policies: Array<{ redact: boolean; stream: boolean; mode: string }> = [];
	let running = false;
	let activated = 0;
	const runtime: NotificationSessionRuntime = {
		isRunning: () => running,
		start: async () => {
			running = true;
			return "started";
		},
		stop: async () => {
			running = false;
			return true;
		},
		ensureTelegramDaemon: async () => "ready",
		refreshPolicy: (_binding, policy) =>
			policies.push({ redact: policy.redact, stream: policy.stream, mode: policy.mode }),
		activate: () => activated++,
	};
	const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
	controller.attachRuntime(runtime);

	expect((await controller.reconcileCurrentSession(createContext().context)).outcome).toBe("started");
	expect(policies).toEqual([
		{ redact: true, stream: false, mode: "provisional" },
		{ redact: false, stream: true, mode: "committed" },
		{ redact: false, stream: true, mode: "committed" },
	]);
	expect(activated).toBe(1);
});

test("maps a thrown Telegram daemon preflight to a failed restrictive outcome", async () => {
	const policies: Array<{ redact: boolean; mode: string }> = [];
	const runtime: NotificationSessionRuntime = {
		isRunning: () => false,
		start: async () => "started",
		stop: async () => false,
		ensureTelegramDaemon: async () => {
			throw new Error("daemon unavailable");
		},
		refreshPolicy: (_binding, policy) => policies.push({ redact: policy.redact, mode: policy.mode }),
	};
	const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
	controller.attachRuntime(runtime);

	const result = await controller.reconcileCurrentSession(createContext().context);

	expect(result.outcome).toBe("failed");
	expect(result.status.running).toBe(false);
	expect(policies).toEqual([{ redact: true, mode: "provisional" }]);
});
test("holds streaming disabled until deferred Telegram ownership confirms the unchanged config", async () => {
	let config = telegramConfig();
	const ensureEntered = Promise.withResolvers<void>();
	const releaseEnsure = Promise.withResolvers<void>();
	const policies: { redact: boolean; stream: boolean }[] = [];
	const calls: Call[] = [];
	const runtime: NotificationSessionRuntime = {
		isRunning: () => false,
		start: async binding => {
			calls.push({ kind: "start", cwd: binding.cwd, sessionId: binding.sessionId });
			return "started";
		},
		stop: async () => false,
		ensureTelegramDaemon: async binding => {
			calls.push({ kind: "daemon", cwd: binding.cwd, sessionId: binding.sessionId });
			ensureEntered.resolve();
			await releaseEnsure.promise;
			return "ready";
		},
		refreshPolicy: (_binding, policy) => policies.push({ redact: policy.redact, stream: policy.stream }),
	};
	const controller = new NotificationSessionController({ eligible: true, getConfig: () => config, env: {} });
	controller.attachRuntime(runtime);
	const reconciliation = controller.reconcileCurrentSession(createContext().context);

	await ensureEntered.promise;
	expect(policies).toEqual([{ redact: true, stream: false }]);
	config = { ...telegramConfig(), enabled: false, redact: true };
	releaseEnsure.resolve();

	const result = await reconciliation;
	expect(result.outcome).toBe("disabled");
	expect(calls.map(call => call.kind)).toEqual(["daemon"]);
	expect(policies.at(-1)).toEqual({ redact: true, stream: false });
});

test("stops a deferred start and fails closed when the latest config becomes identity-blocked", async () => {
	let config = telegramConfig();
	const startEntered = Promise.withResolvers<void>();
	const releaseStart = Promise.withResolvers<void>();
	const policies: { redact: boolean; stream: boolean }[] = [];
	const calls: Call[] = [];
	let running = false;
	const runtime: NotificationSessionRuntime = {
		isRunning: () => running,
		start: async binding => {
			calls.push({ kind: "start", cwd: binding.cwd, sessionId: binding.sessionId });
			startEntered.resolve();
			await releaseStart.promise;
			running = true;
			return "started";
		},
		stop: async binding => {
			calls.push({ kind: "stop", cwd: binding.cwd, sessionId: binding.sessionId });
			running = false;
			return true;
		},
		ensureTelegramDaemon: async binding => {
			calls.push({ kind: "daemon", cwd: binding.cwd, sessionId: binding.sessionId });
			return "ready";
		},
		refreshPolicy: (_binding, policy) => policies.push({ redact: policy.redact, stream: policy.stream }),
	};
	const controller = new NotificationSessionController({ eligible: true, getConfig: () => config, env: {} });
	controller.attachRuntime(runtime);
	const reconciliation = controller.reconcileCurrentSession(createContext().context);

	await startEntered.promise;
	const identity = telegramActivationIdentity(config.botToken!, config.chatId!);
	config = {
		...config,
		activation: {
			[identity]: { identity, state: "inactive", reason: "saved_inactive", updatedAt: "2026-01-01T00:00:00.000Z" },
		},
	};
	releaseStart.resolve();

	const result = await reconciliation;
	expect(result.outcome).toBe("disabled");
	expect(result.status.running).toBe(false);
	expect(calls.map(call => call.kind)).toEqual(["daemon", "start", "stop"]);
	expect(policies.at(-1)).toEqual({ redact: true, stream: false });
});

test("fails closed when stale-start cleanup reports false and leaves the runtime running", async () => {
	let config = telegramConfig();
	const startEntered = Promise.withResolvers<void>();
	const releaseStart = Promise.withResolvers<void>();
	const policies: Array<{ redact: boolean; mode: string }> = [];
	let running = false;
	let starts = 0;
	const runtime: NotificationSessionRuntime = {
		isRunning: () => running,
		start: async () => {
			starts++;
			startEntered.resolve();
			await releaseStart.promise;
			running = true;
			return "started";
		},
		stop: async () => false,
		ensureTelegramDaemon: async () => "ready",
		refreshPolicy: (_binding, policy) => policies.push({ redact: policy.redact, mode: policy.mode }),
	};
	const controller = new NotificationSessionController({ eligible: true, getConfig: () => config, env: {} });
	controller.attachRuntime(runtime);
	const reconciliation = controller.reconcileCurrentSession(createContext().context);

	await startEntered.promise;
	config = { ...config, streaming: { enabled: false } };
	releaseStart.resolve();

	const result = await reconciliation;
	expect(result.outcome).toBe("failed");
	expect(result.status.running).toBe(true);
	expect(starts).toBe(1);
	expect(policies.at(-1)).toEqual({ redact: true, mode: "provisional" });
});

test("installs restrictive policy before a malformed reload and fails closed", async () => {
	let malformed = false;
	let running = false;
	const policies: NotificationRuntimePolicy[] = [];
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => {
			if (malformed) throw new Error("malformed notifications config");
			return telegramConfig();
		},
		env: {},
	});
	controller.attachRuntime({
		isRunning: () => running,
		start: async () => {
			running = true;
			return "started";
		},
		stop: async () => {
			running = false;
			return true;
		},
		ensureTelegramDaemon: async () => "ready",
		refreshPolicy: (_binding, policy) => policies.push(policy),
	});
	const context = createContext().context;
	await controller.reconcileCurrentSession(context);
	malformed = true;

	const result = await controller.reconcileCurrentSession(context);

	expect(result.outcome).toBe("failed");
	expect(result.status).toMatchObject({ effectiveEnabled: false, running: false, environment: "off" });
	expect(policies.at(-1)).toMatchObject({ redact: true, verbosity: "lean", stream: false, mode: "provisional" });
});
test("bounds repeated config churn and leaves the runtime at the restrictive policy", async () => {
	let reads = 0;
	const calls: Call[] = [];
	const policies: { redact: boolean; verbosity: string; stream: boolean }[] = [];
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => ({ ...telegramConfig(), redact: reads++ % 2 === 0 }),
		env: {},
	});
	controller.attachRuntime({
		isRunning: () => false,
		start: async () => "started",
		stop: async () => false,
		ensureTelegramDaemon: async binding => {
			calls.push({ kind: "daemon", cwd: binding.cwd, sessionId: binding.sessionId });
			return "ready";
		},
		refreshPolicy: (_binding, policy) => policies.push(policy),
	});

	const result = await controller.reconcileCurrentSession(createContext().context);

	expect(result.outcome).toBe("disabled");
	expect(calls.map(call => call.kind)).toEqual(["daemon", "daemon", "daemon"]);
	expect(policies).toHaveLength(4);
	expect(policies.every(policy => policy.redact && policy.verbosity === "lean" && !policy.stream)).toBe(true);
});

test("reports failure when bounded churn cannot stop a running runtime", async () => {
	let reads = 0;
	let running = true;
	const calls: Call[] = [];
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => ({ ...telegramConfig(), redact: reads++ % 2 === 0 }),
		env: {},
	});
	controller.attachRuntime({
		isRunning: () => running,
		start: async () => "already",
		stop: async binding => {
			calls.push({ kind: "stop", cwd: binding.cwd, sessionId: binding.sessionId });
			running = true;
			return false;
		},
		ensureTelegramDaemon: async () => "ready",
		refreshPolicy: () => {},
	});

	const result = await controller.reconcileCurrentSession(createContext().context);

	expect(result.outcome).toBe("failed");
	expect(result.status.running).toBe(true);
	expect(calls.map(call => call.kind)).toEqual(["stop"]);
});

describe("NotificationSessionController", () => {
	test("locally off remains stopped through setup until session-local on without restart", async () => {
		let config = BASE_CONFIG;
		const calls: Call[] = [];
		const controller = new NotificationSessionController({ eligible: true, getConfig: () => config, env: {} });
		controller.attachRuntime(createRuntime(calls));
		const { context } = createContext();

		expect((await controller.setLocalEnabled(context, false)).outcome).toBe("disabled");
		config = telegramConfig();
		expect((await controller.reconcileCurrentSession(context)).outcome).toBe("disabled");
		expect(calls).toEqual([]);

		expect((await controller.setLocalEnabled(context, true)).outcome).toBe("started");
		expect(calls).toEqual([
			{ kind: "daemon", cwd: "/workspace/one", sessionId: "session-one" },
			{ kind: "start", cwd: "/workspace/one", sessionId: "session-one" },
		]);
	});

	test("durable inactive marker blocks startup before daemon ownership checks or endpoint frames", async () => {
		const calls: Call[] = [];
		const client = createConnectedFakeClient();
		const config = telegramConfig();
		const identity = telegramActivationIdentity(config.botToken!, config.chatId!);
		config.activation = {
			[identity]: {
				identity,
				state: "inactive",
				reason: "saved_inactive",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		};
		const controller = new NotificationSessionController({ eligible: true, getConfig: () => config, env: {} });
		controller.attachRuntime(createFrameRuntime(calls, client));

		const result = await controller.reconcileCurrentSession(createContext().context);

		expect(result.outcome).toBe("disabled");
		expect(result.status.effectiveEnabled).toBe(false);
		expect(calls).toEqual([]);
		expect(client.frames).toEqual([]);
	});

	test("after a non-deferred blocked_identity commit, reconciliation keeps the endpoint stopped and emits no foreign-client frames", async () => {
		const calls: Call[] = [];
		const client = createConnectedFakeClient();
		const runtime = createFrameRuntime(calls, client);
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime(runtime);
		const { context } = createContext();

		await controller.reconcileCurrentSession(context);
		await controller.enterBlockedRuntime(context);
		const framesAtBlockResolution = client.frames.length;
		const afterBlockedReconcile = await controller.reconcileCurrentSession(context);
		const binding = controller.bind(context);
		try {
			expect(runtime.isRunning(binding)).toBe(false);
		} finally {
			binding.unbind();
		}

		expect(afterBlockedReconcile.outcome).toBe("disabled");
		expect(afterBlockedReconcile.status.running).toBe(false);
		expect(calls.map(call => call.kind)).toEqual(["start", "stop"]);
		expect(client.frames).toEqual(["identity_header:session-one"]);
		expect(client.frames.slice(framesAtBlockResolution)).toHaveLength(0);
	});

	test("fails blocked-identity entry when a running endpoint cannot stop", async () => {
		let running = true;
		const policies: NotificationRuntimePolicy[] = [];
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime({
			isRunning: () => running,
			start: async () => "already",
			stop: async () => {
				running = true;
				return false;
			},
			refreshPolicy: (_binding, policy) => policies.push(policy),
		});

		await expect(controller.enterBlockedRuntime(createContext().context)).rejects.toThrow(
			"Notification runtime remained active while entering blocked identity state",
		);
		expect(policies.at(-1)).toMatchObject({ redact: true, verbosity: "lean", stream: false, mode: "provisional" });
		expect(running).toBe(true);
	});

	test("serializes a deferred endpoint start before blocking and emits no foreign-client frames after block resolution", async () => {
		const calls: Call[] = [];
		const client = createConnectedFakeClient();
		const startEntered = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const runtime = createFrameRuntime(calls, client, {
			startGate: releaseStart.promise,
			onStart: () => startEntered.resolve(),
		});
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime(runtime);
		const { context } = createContext();

		const reconciliation = controller.reconcileCurrentSession(context);
		await startEntered.promise;
		const blocked = controller.enterBlockedRuntime(context);
		let blockResolved = false;
		void blocked.then(() => {
			blockResolved = true;
		});
		await Promise.resolve();
		expect(blockResolved).toBe(false);

		releaseStart.resolve();
		await Promise.all([reconciliation, blocked]);
		const framesAtBlockResolution = client.frames.length;
		const afterBlockedReconcile = await controller.reconcileCurrentSession(context);
		const binding = controller.bind(context);
		try {
			expect(runtime.isRunning(binding)).toBe(false);
		} finally {
			binding.unbind();
		}

		expect(afterBlockedReconcile.outcome).toBe("disabled");
		expect(calls.map(call => call.kind)).toEqual(["start", "stop"]);
		expect(client.frames).toEqual(["identity_header:session-one"]);
		expect(client.frames.slice(framesAtBlockResolution)).toHaveLength(0);
	});

	test("carries an in-flight operation barrier across a session rekey", async () => {
		const calls: Call[] = [];
		const client = createConnectedFakeClient();
		const startEntered = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const runtime = createFrameRuntime(calls, client, {
			startGate: releaseStart.promise,
			onStart: () => startEntered.resolve(),
		});
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime(runtime);
		const host = createContext();

		const firstReconciliation = controller.reconcileCurrentSession(host.context);
		await startEntered.promise;
		controller.rekeySession("session-one", "session-two");
		host.setSession("/workspace/two", "session-two");
		const rekeyedReconciliation = controller.reconcileCurrentSession(host.context);
		let rekeyedResolved = false;
		void rekeyedReconciliation.then(() => {
			rekeyedResolved = true;
		});
		await Promise.resolve();

		expect(rekeyedResolved).toBe(false);
		expect(calls).toEqual([{ kind: "start", cwd: "/workspace/one", sessionId: "session-one" }]);

		releaseStart.resolve();
		await Promise.all([firstReconciliation, rekeyedReconciliation]);
		expect(calls).toEqual([
			{ kind: "start", cwd: "/workspace/one", sessionId: "session-one" },
			{ kind: "start", cwd: "/workspace/two", sessionId: "session-two" },
		]);
		expect(client.frames).toEqual(["identity_header:session-one", "identity_header:session-two"]);
	});

	test("queues shutdown behind an in-flight endpoint start", async () => {
		const calls: Call[] = [];
		const client = createConnectedFakeClient();
		const startEntered = Promise.withResolvers<void>();
		const releaseStart = Promise.withResolvers<void>();
		const runtime = createFrameRuntime(calls, client, {
			startGate: releaseStart.promise,
			onStart: () => startEntered.resolve(),
		});
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime(runtime);
		const { context } = createContext();

		const reconciliation = controller.reconcileCurrentSession(context);
		await startEntered.promise;
		const shutdown = controller.stopCurrentSession(context);
		let shutdownResolved = false;
		void shutdown.then(() => {
			shutdownResolved = true;
		});
		await Promise.resolve();

		expect(shutdownResolved).toBe(false);
		expect(calls).toEqual([{ kind: "start", cwd: "/workspace/one", sessionId: "session-one" }]);

		releaseStart.resolve();
		await reconciliation;
		expect(await shutdown).toBe(false);
		const binding = controller.bind(context);
		try {
			expect(runtime.isRunning(binding)).toBe(false);
		} finally {
			binding.unbind();
		}
		expect(calls.map(call => call.kind)).toEqual(["start", "stop"]);
		expect(client.frames).toEqual(["identity_header:session-one"]);
	});

	test("starts generic endpoints for Discord, Slack, and token-only opt-in without Telegram daemon", async () => {
		for (const input of [
			{ config: discordConfig(), env: {} },
			{ config: slackConfig(), env: {} },
			{ config: BASE_CONFIG, env: { GJC_NOTIFICATIONS_TOKEN: "legacy-token" } },
		]) {
			const calls: Call[] = [];
			const controller = new NotificationSessionController({
				eligible: true,
				getConfig: () => input.config,
				env: input.env,
			});
			controller.attachRuntime(createRuntime(calls));
			const result = await controller.reconcileCurrentSession(createContext().context);
			expect(result.outcome).toBe("started");
			expect(calls.filter(call => call.kind === "start")).toHaveLength(1);
			expect(calls.filter(call => call.kind === "daemon")).toHaveLength(0);
		}
	});

	test("a dormant unconfigured or hard-disabled controller has no endpoint or daemon side effects", async () => {
		for (const input of [
			{ eligible: true, config: BASE_CONFIG, env: {} },
			{ eligible: false, config: telegramConfig(), env: { GJC_NOTIFICATIONS: "0" } },
		]) {
			const calls: Call[] = [];
			const controller = new NotificationSessionController({
				eligible: input.eligible,
				getConfig: () => input.config,
				env: input.env,
			});
			controller.attachRuntime(createRuntime(calls));
			expect((await controller.reconcileCurrentSession(createContext().context)).outcome).toBe("disabled");
			expect(calls).toEqual([]);
		}
	});

	test("binds cwd and session id from the session manager for every operation", async () => {
		const calls: Call[] = [];
		const controller = new NotificationSessionController({ eligible: true, getConfig: telegramConfig, env: {} });
		controller.attachRuntime(createRuntime(calls));
		const host = createContext();

		await controller.reconcileCurrentSession(host.context);
		host.setSession("/workspace/two", "session-two");
		await controller.reconcileCurrentSession(host.context);
		expect(calls).toEqual([
			{ kind: "daemon", cwd: "/workspace/one", sessionId: "session-one" },
			{ kind: "start", cwd: "/workspace/one", sessionId: "session-one" },
			{ kind: "daemon", cwd: "/workspace/two", sessionId: "session-two" },
			{ kind: "start", cwd: "/workspace/two", sessionId: "session-two" },
		]);
	});

	test("preserves authoritative GJC_NOTIFICATIONS=0 and explicit GJC_NOTIFICATIONS=1 precedence", async () => {
		const offCalls: Call[] = [];
		const offController = new NotificationSessionController({
			eligible: true,
			getConfig: telegramConfig,
			env: { GJC_NOTIFICATIONS: "0" },
		});
		offController.attachRuntime(createRuntime(offCalls));
		expect((await offController.setLocalEnabled(createContext().context, true)).outcome).toBe("disabled");
		expect(offCalls).toEqual([]);

		const explicitCalls: Call[] = [];
		const explicitController = new NotificationSessionController({
			eligible: true,
			getConfig: () => BASE_CONFIG,
			env: { GJC_NOTIFICATIONS: "1" },
		});
		explicitController.attachRuntime(createRuntime(explicitCalls));
		const host = createContext();
		expect((await explicitController.reconcileCurrentSession(host.context)).outcome).toBe("started");
		expect((await explicitController.setLocalEnabled(host.context, false)).outcome).toBe("stopped");
		expect((await explicitController.setLocalEnabled(host.context, true)).outcome).toBe("started");
		expect(explicitCalls.map(call => call.kind)).toEqual(["start", "stop", "start"]);
	});
});
