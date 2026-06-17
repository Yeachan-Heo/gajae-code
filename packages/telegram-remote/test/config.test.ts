import { describe, expect, test } from "bun:test";
import { loadConfigFromEnv } from "../src/config";
import { presetName } from "../src/presets";

const presetsJson = JSON.stringify([
	{
		id: "demo",
		name: "Demo preset",
		workdir: "/home/bot/src/project",
		sessionCommand: "gjc --worktree",
		taskTemplate: "Do: {{task}}",
	},
]);

function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		GJC_TELEGRAM_REMOTE_BOT_TOKEN: "123:abc",
		GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS: "100, 200",
		GJC_TELEGRAM_REMOTE_PRESETS: presetsJson,
		...extra,
	};
}

describe("loadConfigFromEnv", () => {
	test("loads a minimal, valid config", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.botToken).toBe("123:abc");
		expect([...config.policy.allowedUserIds]).toEqual(["100", "200"]);
		expect(config.policy.presets.has("demo")).toBe(true);
		expect(config.policy.presets.get("demo")?.name).toBe("Demo preset");
		expect(config.coordinator.command).toBe("gjc");
		expect(config.coordinator.args).toEqual(["mcp-serve", "coordinator"]);
		expect(config.backend).toBe("coordinator");
		expect(config.rpc).toBeUndefined();
	});

	test("parses RPC backend knobs", () => {
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_BACKEND: "rpc",
				GJC_TELEGRAM_REMOTE_RPC_SOCKET: "/tmp/gjc-rpc.sock",
				GJC_TELEGRAM_REMOTE_STATE_DIR: "/tmp/telegram-remote-rpc",
				GJC_TELEGRAM_REMOTE_LIVENESS_MS: "120000",
				GJC_TELEGRAM_REMOTE_ALLOW_ATTACH_SOCKET_ARG: "true",
			}),
		);
		expect(config.backend).toBe("rpc");
		expect(config.rpc).toEqual({
			socketPath: "/tmp/gjc-rpc.sock",
			stateDir: "/tmp/telegram-remote-rpc",
			livenessMs: 120_000,
			allowAttachSocketArg: true,
		});
	});

	test("RPC backend requires socket and state dir with safe defaults", () => {
		expect(() => loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_BACKEND: "rpc" }))).toThrow(/RPC_SOCKET/);
		expect(() =>
			loadConfigFromEnv(
				baseEnv({ GJC_TELEGRAM_REMOTE_BACKEND: "rpc", GJC_TELEGRAM_REMOTE_RPC_SOCKET: "/tmp/gjc.sock" }),
			),
		).toThrow(/STATE_DIR/);
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_BACKEND: "rpc",
				GJC_TELEGRAM_REMOTE_RPC_SOCKET: "/tmp/gjc.sock",
				GJC_TELEGRAM_REMOTE_STATE_DIR: "/tmp/gtr",
			}),
		);
		expect(config.rpc?.livenessMs).toBe(60_000);
		expect(config.rpc?.allowAttachSocketArg).toBe(false);
	});

	test("requires a bot token", () => {
		const env = baseEnv();
		delete env.GJC_TELEGRAM_REMOTE_BOT_TOKEN;
		expect(() => loadConfigFromEnv(env)).toThrow(/missing_env:GJC_TELEGRAM_REMOTE_BOT_TOKEN/);
	});

	test("default-denies when no allowlist is configured", () => {
		const env = baseEnv();
		delete env.GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS;
		expect(() => loadConfigFromEnv(env)).toThrow(/no_allowlist/);
	});

	test("forces the smallest mutation set and never enables questions", () => {
		const readOnly = loadConfigFromEnv(baseEnv());
		expect(readOnly.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).toBe("sessions");
		const withStop = loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_ENABLE_STOP: "true" }));
		expect(withStop.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).toBe("sessions,reports");
		expect(withStop.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).not.toContain("questions");
	});

	test("derives workdir roots and session command from presets", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.coordinator.env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS).toBe("/home/bot/src/project");
		expect(config.coordinator.env.GJC_COORDINATOR_MCP_SESSION_COMMAND).toBe("gjc --worktree");
	});

	test("preset name is optional", () => {
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_PRESETS: JSON.stringify([
					{ id: "plain", workdir: "/home/bot/src/project", sessionCommand: "gjc --worktree" },
				]),
			}),
		);
		expect(config.policy.presets.get("plain")?.name).toBeUndefined();
	});

	test("presetName falls back to id", () => {
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_PRESETS: JSON.stringify([
					{ id: "plain", workdir: "/home/bot/src/project", sessionCommand: "gjc --worktree" },
				]),
			}),
		);
		const plain = config.policy.presets.get("plain");
		expect(plain && presetName(plain)).toBe("plain");
	});

	test("rejects ambiguous session commands without an explicit override", () => {
		const env = baseEnv({
			GJC_TELEGRAM_REMOTE_PRESETS: JSON.stringify([
				{ id: "a", workdir: "/home/bot/a", sessionCommand: "gjc --worktree" },
				{ id: "b", workdir: "/home/bot/b", sessionCommand: "gjc --tmux" },
			]),
		});
		expect(() => loadConfigFromEnv(env)).toThrow(/ambiguous_session_command/);
	});

	test("rejects a preset workdir outside explicit roots", () => {
		const env = baseEnv({ GJC_COORDINATOR_MCP_WORKDIR_ROOTS: "/home/bot/other" });
		expect(() => loadConfigFromEnv(env)).toThrow(/workdir_outside_roots/);
	});

	test("rejects malformed preset JSON", () => {
		expect(() => loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_PRESETS: "{not json" }))).toThrow(
			/presets_invalid_json/,
		);
	});

	test("rich UI knobs have safe defaults and never enable questions", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.policy.enableRichMessages).toBe(true);
		expect(config.policy.richCallbackTtlMs).toBe(600_000);
		expect(config.policy.richCallbackMaxTokens).toBe(500);
		expect(config.enableEditMessageText).toBe(false);
		expect(config.registerBotCommands).toBe(true);
		expect(config.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).not.toContain("questions");
	});

	test("push subscription knobs have safe defaults", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.stateDir).toBeUndefined();
		expect(config.followTtlMs).toBe(86_400_000);
		expect(config.enablePush).toBe(false);
		expect(config.subscriptionsMax).toBe(1000);
	});

	test("rich UI can be disabled and tuned via env", () => {
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_ENABLE_RICH: "false",
				GJC_TELEGRAM_REMOTE_RICH_CALLBACK_TTL_MS: "120000",
				GJC_TELEGRAM_REMOTE_RICH_CALLBACK_MAX_TOKENS: "50",
				GJC_TELEGRAM_REMOTE_ENABLE_EDIT_MESSAGE_TEXT: "true",
				GJC_TELEGRAM_REMOTE_REGISTER_COMMANDS: "false",
			}),
		);
		expect(config.policy.enableRichMessages).toBe(false);
		expect(config.policy.richCallbackTtlMs).toBe(120_000);
		expect(config.policy.richCallbackMaxTokens).toBe(50);
		expect(config.enableEditMessageText).toBe(true);
		expect(config.registerBotCommands).toBe(false);
	});

	test("push subscription knobs can be tuned via env", () => {
		const config = loadConfigFromEnv(
			baseEnv({
				GJC_TELEGRAM_REMOTE_STATE_DIR: "/tmp/telegram-remote-state",
				GJC_TELEGRAM_REMOTE_FOLLOW_TTL_MS: "120000",
				GJC_TELEGRAM_REMOTE_ENABLE_PUSH: "true",
				GJC_TELEGRAM_REMOTE_SUBSCRIPTIONS_MAX: "25",
			}),
		);
		expect(config.stateDir).toBe("/tmp/telegram-remote-state");
		expect(config.followTtlMs).toBe(120_000);
		expect(config.enablePush).toBe(true);
		expect(config.subscriptionsMax).toBe(25);
	});

	test("rejects invalid state directories", () => {
		for (const stateDir of ["relative/state", "/tmp/../state", "/tmp/state\0bad"]) {
			expect(() => loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_STATE_DIR: stateDir }))).toThrow(
				/telegram_remote_invalid_state_dir/,
			);
		}
	});
});
