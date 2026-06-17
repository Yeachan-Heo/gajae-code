/**
 * Environment-driven configuration for the gateway service. Builds the
 * authorization policy, preset map, and the coordinator subprocess spawn config
 * (with a forced, smallest mutation set) from process env.
 */
import type { McpStdioOptions } from "./coordinator-client";
import type { GatewayPolicy } from "./gateway";
import { assertValidPreset } from "./presets";
import { resolveStateDir } from "./subscriptions";
import type { GatewayPreset } from "./types";

const DEFAULT_TASK_MAX_LEN = 2000;
const DEFAULT_COORDINATOR_COMMAND = "gjc";
const DEFAULT_COORDINATOR_ARGS = ["mcp-serve", "coordinator"];
const WORKDIR_ROOT_SEPARATOR = ":";
const DEFAULT_FOLLOW_TTL_MS = 86_400_000;
const DEFAULT_SUBSCRIPTIONS_MAX = 1000;
const DEFAULT_LONG_POLL_MS = 25_000;
const DEFAULT_DIGEST_THRESHOLD = 5;
const DEFAULT_RPC_LIVENESS_MS = 60_000;

/** Fully resolved configuration for {@link runService}. */
export interface ServiceConfig {
	botToken: string;
	apiBase?: string;
	pollTimeoutSec: number;
	/** Honor reply.edit via editMessageText (transport). Default false. */
	enableEditMessageText: boolean;
	/** Register the Bot command menu at startup (transport). Default true. */
	registerBotCommands: boolean;
	stateDir?: string;
	backend: "coordinator" | "rpc";
	rpc?: {
		socketPath: string;
		stateDir: string;
		livenessMs: number;
		allowAttachSocketArg: boolean;
	};
	followTtlMs: number;
	/** Enable proactive Follow push plumbing. Default false. */
	enablePush: boolean;
	subscriptionsMax: number;
	longPollMs: number;
	digestThreshold: number;
	policy: GatewayPolicy;
	coordinator: McpStdioOptions;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
	const value = env[key];
	if (!value || value.trim().length === 0) throw new Error(`telegram_remote_missing_env:${key}`);
	return value.trim();
}

function parseIdSet(value: string | undefined): Set<string> {
	if (!value) return new Set();
	return new Set(
		value
			.split(",")
			.map(item => item.trim())
			.filter(item => item.length > 0),
	);
}

function parseList(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	const items = value
		.split(",")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	return items.length > 0 ? items : fallback;
}

function parsePresets(value: string | undefined, defaultTaskMaxLen: number): Map<string, GatewayPreset> {
	const presets = new Map<string, GatewayPreset>();
	if (!value || value.trim().length === 0) return presets;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("telegram_remote_presets_invalid_json");
	}
	if (!Array.isArray(parsed)) throw new Error("telegram_remote_presets_must_be_array");
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) throw new Error("telegram_remote_preset_must_be_object");
		const record = entry as Record<string, unknown>;
		const preset: GatewayPreset = {
			id: String(record.id ?? ""),
			name: typeof record.name === "string" ? record.name : undefined,
			workdir: String(record.workdir ?? ""),
			sessionCommand: String(record.sessionCommand ?? ""),
			taskTemplate: typeof record.taskTemplate === "string" ? record.taskTemplate : undefined,
			taskMaxLen: typeof record.taskMaxLen === "number" ? record.taskMaxLen : defaultTaskMaxLen,
		};
		assertValidPreset(preset);
		if (presets.has(preset.id)) throw new Error(`telegram_remote_duplicate_preset:${preset.id}`);
		presets.set(preset.id, preset);
	}
	return presets;
}

function isInsideRoot(workdir: string, root: string): boolean {
	return workdir === root || workdir.startsWith(`${root}/`);
}

function deriveWorkdirRoots(presets: Map<string, GatewayPreset>): string {
	const roots = new Set<string>();
	for (const preset of presets.values()) roots.add(preset.workdir);
	return [...roots].join(WORKDIR_ROOT_SEPARATOR);
}

function resolveWorkdirRoots(env: Env, presets: Map<string, GatewayPreset>): string {
	const explicit = env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS?.trim();
	const roots = explicit && explicit.length > 0 ? explicit : deriveWorkdirRoots(presets);
	if (roots.length > 0) {
		const rootList = roots.split(WORKDIR_ROOT_SEPARATOR).filter(item => item.length > 0);
		for (const preset of presets.values()) {
			if (!rootList.some(root => isInsideRoot(preset.workdir, root))) {
				throw new Error(`telegram_remote_preset_workdir_outside_roots:${preset.id}`);
			}
		}
	}
	return roots;
}

function resolveSessionCommand(env: Env, presets: Map<string, GatewayPreset>): string {
	const explicit = env.GJC_COORDINATOR_MCP_SESSION_COMMAND?.trim();
	if (explicit && explicit.length > 0) return explicit;
	const commands = new Set([...presets.values()].map(preset => preset.sessionCommand));
	if (commands.size > 1) throw new Error("telegram_remote_ambiguous_session_command");
	return commands.values().next().value ?? "";
}

function buildCoordinatorEnv(
	env: Env,
	presets: Map<string, GatewayPreset>,
	enableStop: boolean,
): Record<string, string> {
	const coordinatorEnv: Record<string, string> = {};
	for (const key of [
		"GJC_COORDINATOR_MCP_PROFILE",
		"GJC_COORDINATOR_MCP_REPO",
		"GJC_COORDINATOR_MCP_STATE_ROOT",
		"GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP",
	]) {
		const value = env[key]?.trim();
		if (value) coordinatorEnv[key] = value;
	}
	const workdirRoots = resolveWorkdirRoots(env, presets);
	if (workdirRoots.length > 0) coordinatorEnv.GJC_COORDINATOR_MCP_WORKDIR_ROOTS = workdirRoots;
	const sessionCommand = resolveSessionCommand(env, presets);
	if (sessionCommand.length > 0) coordinatorEnv.GJC_COORDINATOR_MCP_SESSION_COMMAND = sessionCommand;
	// Force the smallest mutation set. `questions` is never enabled.
	coordinatorEnv.GJC_COORDINATOR_MCP_MUTATIONS = enableStop ? "sessions,reports" : "sessions";
	return coordinatorEnv;
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isTruthyDefault(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim().length === 0) return fallback;
	return isTruthy(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBackend(value: string | undefined): "coordinator" | "rpc" {
	const backend = value?.trim().toLowerCase() || "coordinator";
	if (backend !== "coordinator" && backend !== "rpc") throw new Error("telegram_remote_invalid_backend");
	return backend;
}

function parseClampedPositiveInt(value: string | undefined, fallback: number, max: number): number {
	return Math.min(parsePositiveInt(value, fallback), max);
}

/** Build the full service config from environment variables. */
export function loadConfigFromEnv(env: Env): ServiceConfig {
	const botToken = required(env, "GJC_TELEGRAM_REMOTE_BOT_TOKEN");
	const defaultTaskMaxLen = Number.parseInt(env.GJC_TELEGRAM_REMOTE_DEFAULT_TASK_MAX_LEN ?? "", 10);
	const taskMaxLen =
		Number.isInteger(defaultTaskMaxLen) && defaultTaskMaxLen > 0 ? defaultTaskMaxLen : DEFAULT_TASK_MAX_LEN;

	const allowedUserIds = parseIdSet(env.GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS);
	const allowedChatIds = parseIdSet(env.GJC_TELEGRAM_REMOTE_ALLOWED_CHAT_IDS);
	if (allowedUserIds.size === 0 && allowedChatIds.size === 0) {
		throw new Error("telegram_remote_no_allowlist");
	}

	const presets = parsePresets(env.GJC_TELEGRAM_REMOTE_PRESETS, taskMaxLen);
	const enableStop = isTruthy(env.GJC_TELEGRAM_REMOTE_ENABLE_STOP);

	const pollTimeoutSec = parsePositiveInt(env.GJC_TELEGRAM_REMOTE_POLL_TIMEOUT_SEC, 30);
	const backend = parseBackend(env.GJC_TELEGRAM_REMOTE_BACKEND);
	const rpcSocket = env.GJC_TELEGRAM_REMOTE_RPC_SOCKET?.trim();
	const stateDirValue = env.GJC_TELEGRAM_REMOTE_STATE_DIR?.trim();
	let stateDir: string | undefined;
	if (stateDirValue) {
		try {
			stateDir = resolveStateDir(stateDirValue);
		} catch {
			throw new Error("telegram_remote_invalid_state_dir");
		}
	}
	if (backend === "rpc") {
		if (!rpcSocket) throw new Error("telegram_remote_missing_env:GJC_TELEGRAM_REMOTE_RPC_SOCKET");
		if (!stateDir) throw new Error("telegram_remote_missing_env:GJC_TELEGRAM_REMOTE_STATE_DIR");
	}

	return {
		botToken,
		apiBase: env.GJC_TELEGRAM_REMOTE_API_BASE?.trim() || undefined,
		pollTimeoutSec,
		enableEditMessageText: isTruthyDefault(env.GJC_TELEGRAM_REMOTE_ENABLE_EDIT_MESSAGE_TEXT, false),
		registerBotCommands: isTruthyDefault(env.GJC_TELEGRAM_REMOTE_REGISTER_COMMANDS, true),
		stateDir,
		backend,
		rpc:
			backend === "rpc"
				? {
						socketPath: rpcSocket!,
						stateDir: stateDir!,
						livenessMs: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_LIVENESS_MS, DEFAULT_RPC_LIVENESS_MS),
						allowAttachSocketArg: isTruthyDefault(env.GJC_TELEGRAM_REMOTE_ALLOW_ATTACH_SOCKET_ARG, false),
					}
				: undefined,
		followTtlMs: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_FOLLOW_TTL_MS, DEFAULT_FOLLOW_TTL_MS),
		enablePush: isTruthyDefault(env.GJC_TELEGRAM_REMOTE_ENABLE_PUSH, false),
		subscriptionsMax: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_SUBSCRIPTIONS_MAX, DEFAULT_SUBSCRIPTIONS_MAX),
		longPollMs: parseClampedPositiveInt(env.GJC_TELEGRAM_REMOTE_WATCH_TIMEOUT_MS, DEFAULT_LONG_POLL_MS, 30_000),
		digestThreshold: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_DIGEST_THRESHOLD, DEFAULT_DIGEST_THRESHOLD),
		policy: {
			allowedUserIds,
			allowedChatIds,
			presets,
			enableStop,
			enableRichMessages: isTruthyDefault(env.GJC_TELEGRAM_REMOTE_ENABLE_RICH, true),
			richCallbackTtlMs: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_RICH_CALLBACK_TTL_MS, 600_000),
			richCallbackMaxTokens: parsePositiveInt(env.GJC_TELEGRAM_REMOTE_RICH_CALLBACK_MAX_TOKENS, 500),
		},
		coordinator: {
			command: env.GJC_TELEGRAM_REMOTE_COORDINATOR_COMMAND?.trim() || DEFAULT_COORDINATOR_COMMAND,
			args: parseList(env.GJC_TELEGRAM_REMOTE_COORDINATOR_ARGS, DEFAULT_COORDINATOR_ARGS),
			env: buildCoordinatorEnv(env, presets, enableStop),
		},
	};
}
