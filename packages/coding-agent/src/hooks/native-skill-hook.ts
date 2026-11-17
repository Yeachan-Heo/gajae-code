import * as fsSync from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigDirName } from "@gajae-code/utils";
import { projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { YAML } from "bun";
import type { SkillDiscoverySettings } from "../config/skill-settings-defaults";
import { DEFAULT_DISABLED_EXTENSIONS, DEFAULT_SKILL_DISCOVERY_SETTINGS } from "../config/skill-settings-defaults";
import { GJC_DIR, sessionLogsDir } from "../gjc-runtime/session-layout";
import { trustedCoordinatorEnv } from "../gjc-runtime/sidecar-bootstrap-env";
import {
	detectMcpDelegateFlowActivation,
	type McpDelegateHostContextV1,
	persistMcpDelegateHostContext,
} from "./mcp-delegate-host-context";
import {
	buildActiveUltragoalPromptContext,
	buildSkillActivationAdditionalContext,
	buildSkillStopOutput,
	buildStateRecoveryDiagnosticsContext,
	collectUserPromptStateRecoveryDiagnostics,
	type EffectiveSkillConfigInput,
	recordSkillActivation,
} from "./skill-state";

export type GjcNativeHookEventName = "UserPromptSubmit" | "Stop";

export interface GjcNativeHookDispatchResult {
	hookEventName: GjcNativeHookEventName | null;
	outputJson: Record<string, unknown> | null;
}

type HookPayload = Record<string, unknown>;

interface GjcNativeHookDispatchOptions {
	cwd?: string;
	stateDir?: string;
	effectiveSkillConfig?: EffectiveSkillConfigInput;
	configPaths?: string[];
}

interface ConfigCacheEntry {
	fingerprint: string;
	value: EffectiveSkillConfigInput;
}

const effectiveSkillConfigCache = new Map<string, ConfigCacheEntry>();
let effectiveSkillConfigResolutionCount = 0;

async function configPathFingerprint(configPaths: readonly string[]): Promise<string> {
	const parts: string[] = [];
	for (const configPath of configPaths) {
		try {
			const stats = await stat(configPath);
			parts.push(`${configPath}:${stats.mtimeMs}:${stats.size}`);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				parts.push(`${configPath}:missing`);
				continue;
			}
			parts.push(`${configPath}:unavailable`);
		}
	}
	return parts.join("|");
}

function configCacheKey(input: {
	cwd: string;
	configPaths: readonly string[];
	sessionId?: string;
	threadId?: string;
	stateDir?: string;
}): string {
	return JSON.stringify({
		cwd: input.cwd,
		configPaths: input.configPaths,
		sessionId: input.sessionId ?? "",
		threadId: input.threadId ?? "",
		stateDir: input.stateDir ?? "",
	});
}

export function clearGjcNativeSkillHookCachesForTesting(): void {
	effectiveSkillConfigCache.clear();
	effectiveSkillConfigResolutionCount = 0;
}

export function getGjcNativeSkillHookCacheStatsForTesting(): { effectiveSkillConfigResolutions: number } {
	return { effectiveSkillConfigResolutions: effectiveSkillConfigResolutionCount };
}

function readNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const nested = value[key];
	return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function buildDefaultEffectiveSkillConfig(): EffectiveSkillConfigInput {
	return {
		skillsSettings: {
			...DEFAULT_SKILL_DISCOVERY_SETTINGS,
			customDirectories: [...(DEFAULT_SKILL_DISCOVERY_SETTINGS.customDirectories ?? [])],
			ignoredSkills: [...(DEFAULT_SKILL_DISCOVERY_SETTINGS.ignoredSkills ?? [])],
			includeSkills: [...(DEFAULT_SKILL_DISCOVERY_SETTINGS.includeSkills ?? [])],
		},
		disabledExtensions: [...DEFAULT_DISABLED_EXTENSIONS],
	};
}

function mergeRawSkillConfig(
	current: EffectiveSkillConfigInput,
	raw: Record<string, unknown>,
): EffectiveSkillConfigInput {
	const rawSkills = readNestedRecord(raw, "skills");
	const enabled = readBoolean(rawSkills.enabled);
	const enableSkillCommands = readBoolean(rawSkills.enableSkillCommands);
	const trustProjectSkills = readBoolean(rawSkills.trustProjectSkills);
	const trustUserSkills = readBoolean(rawSkills.trustUserSkills);
	const enablePiUser = readBoolean(rawSkills.enablePiUser);
	const enablePiProject = readBoolean(rawSkills.enablePiProject);
	const enableCodexUser = readBoolean(rawSkills.enableCodexUser);
	const enableClaudeUser = readBoolean(rawSkills.enableClaudeUser);
	const enableClaudeProject = readBoolean(rawSkills.enableClaudeProject);
	const customDirectories = readStringArray(rawSkills.customDirectories);
	const ignoredSkills = readStringArray(rawSkills.ignoredSkills);
	const includeSkills = readStringArray(rawSkills.includeSkills);
	const disabledExtensions = readStringArray(raw.disabledExtensions);
	const currentSkills = current.skillsSettings ?? {};
	const skillsSettings: SkillDiscoverySettings = {
		...currentSkills,
		...(enabled !== undefined ? { enabled } : {}),
		...(enableSkillCommands !== undefined ? { enableSkillCommands } : {}),
		...(trustProjectSkills !== undefined ? { trustProjectSkills } : {}),
		...(trustUserSkills !== undefined ? { trustUserSkills } : {}),
		...(enablePiUser !== undefined ? { enablePiUser } : {}),
		...(enablePiProject !== undefined ? { enablePiProject } : {}),
		...(enableCodexUser !== undefined ? { enableCodexUser } : {}),
		...(enableClaudeUser !== undefined ? { enableClaudeUser } : {}),
		...(enableClaudeProject !== undefined ? { enableClaudeProject } : {}),
		...(customDirectories ? { customDirectories } : {}),
		...(ignoredSkills ? { ignoredSkills } : {}),
		...(includeSkills ? { includeSkills } : {}),
	};
	return {
		skillsSettings,
		disabledExtensions: disabledExtensions ?? current.disabledExtensions,
	};
}

async function readRawConfig(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed = YAML.parse(await Bun.file(filePath).text());
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Config files that decide skill discovery, resolved through the trusted helpers.
 *
 * These paths pick the `config.yml` whose `skills.customDirectories` the agent
 * then loads skills from, so the directory they are built from is a trust
 * boundary. Bun loads `cwd/.env` into `process.env` before any module runs, so
 * reading `GJC_CODING_AGENT_DIR` / `GJC_CONFIG_DIR` directly let a repository
 * point this at a directory it ships and inject its own skill directories.
 *
 * `getAgentDir()` and `getConfigDirName()` apply the escalation guards that
 * already exist for exactly this (`trustedAgentDirOverride`,
 * `trustedConfigDirName`), and resolve to the same locations this used to build
 * by hand: `dirs.agentDir` is `path.join(os.homedir(), getConfigDirName(), "agent")`
 * when no trusted override is present.
 */
function resolveConfigPaths(cwd: string, override?: string[]): string[] {
	if (override) return override;
	return [path.join(getAgentDir(), "config.yml"), path.join(cwd, getConfigDirName(), "config.yml")];
}

async function resolveEffectiveSkillConfig(
	cwd: string,
	override?: EffectiveSkillConfigInput,
	configPaths?: string[],
	cacheContext: { sessionId?: string; threadId?: string; stateDir?: string } = {},
): Promise<EffectiveSkillConfigInput> {
	if (override) return override;
	const resolvedConfigPaths = resolveConfigPaths(cwd, configPaths);
	const cacheKey = configCacheKey({ cwd, configPaths: resolvedConfigPaths, ...cacheContext });
	const fingerprint = await configPathFingerprint(resolvedConfigPaths);
	const cached = effectiveSkillConfigCache.get(cacheKey);
	if (cached?.fingerprint === fingerprint) {
		return cached.value;
	}
	try {
		effectiveSkillConfigResolutionCount += 1;
		let config = buildDefaultEffectiveSkillConfig();
		for (const configPath of resolvedConfigPaths) {
			const raw = await readRawConfig(configPath);
			if (raw) config = mergeRawSkillConfig(config, raw);
		}
		effectiveSkillConfigCache.set(cacheKey, { fingerprint, value: config });
		return config;
	} catch {
		const unavailableConfig = {
			unavailableReason: "config unavailable",
		};
		effectiveSkillConfigCache.set(cacheKey, { fingerprint, value: unavailableConfig });
		return unavailableConfig;
	}
}

export async function resolveGjcNativeSkillConfigForTesting(input: {
	cwd: string;
	configPaths?: string[];
	sessionId?: string;
	threadId?: string;
	stateDir?: string;
}): Promise<EffectiveSkillConfigInput> {
	return await resolveEffectiveSkillConfig(input.cwd, undefined, input.configPaths, {
		sessionId: input.sessionId,
		threadId: input.threadId,
		stateDir: input.stateDir,
	});
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readHookEventName(payload: HookPayload): GjcNativeHookEventName | null {
	const raw = safeString(payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? payload.name).trim();
	return raw === "UserPromptSubmit" || raw === "Stop" ? raw : null;
}

function readPromptText(payload: HookPayload): string {
	return safeString(payload.prompt ?? payload.user_prompt ?? payload.userPrompt).trim();
}

const QUESTION_ONLY_ADVISORY_CONTEXT =
	"Question-only prompt advisory: Treat bare '?' and unambiguous informational questions as answer-only/read-only; do not modify files, run commands, or execute workflow changes unless the user explicitly asks for action.";

const QUESTION_EXPLICIT_ACTION_PATTERN =
	/\b(add|apply|build|change|commit|create|delete|edit|execute|fix|implement|install|merge|modify|move|patch|refactor|remove|rename|replace|run|ship|start|stop|test|update|write)\b/i;
const QUESTION_START_PATTERN =
	/^(what|why|how|when|where|who|which|does|do|did|is|are|was|were|can|could|should|would)\b/i;

function classifyQuestionOnlyPrompt(prompt: string): string | null {
	const normalized = prompt.trim().replace(/\s+/g, " ");
	if (!normalized) {
		return null;
	}
	if (normalized === "?") {
		return QUESTION_ONLY_ADVISORY_CONTEXT;
	}
	if (!normalized.endsWith("?")) {
		return null;
	}
	if (QUESTION_EXPLICIT_ACTION_PATTERN.test(normalized)) {
		return null;
	}
	if (!QUESTION_START_PATTERN.test(normalized)) {
		return null;
	}
	return QUESTION_ONLY_ADVISORY_CONTEXT;
}

function readSessionId(payload: HookPayload): string | undefined {
	return safeString(payload.session_id ?? payload.sessionId).trim() || undefined;
}

function readThreadId(payload: HookPayload): string | undefined {
	return safeString(payload.thread_id ?? payload.threadId).trim() || undefined;
}

function readTurnId(payload: HookPayload): string | undefined {
	return safeString(payload.turn_id ?? payload.turnId).trim() || undefined;
}

function readSessionFile(payload: HookPayload, cwd: string): string | undefined {
	const explicit = safeString(
		payload.session_file ?? payload.sessionFile ?? payload.transcript_path ?? payload.transcriptPath,
	).trim();
	if (explicit) return explicit;
	// Bun has already copied the project dotenv into the environment. A value
	// that matches that snapshot must not select another transcript.
	return trustedCoordinatorEnv("GJC_SESSION_FILE", process.env, projectEnvSnapshot(cwd));
}

export async function dispatchGjcNativeSkillHook(
	payload: HookPayload,
	options: GjcNativeHookDispatchOptions = {},
): Promise<GjcNativeHookDispatchResult> {
	const hookEventName = readHookEventName(payload);
	const cwd = (options.cwd ?? safeString(payload.cwd).trim()) || process.cwd();
	const sessionFile = readSessionFile(payload, cwd);
	if (hookEventName === "UserPromptSubmit") {
		const recoveryDiagnostics = await collectUserPromptStateRecoveryDiagnostics({
			cwd,
			sessionId: readSessionId(payload),
			threadId: readThreadId(payload),
			stateDir: options.stateDir,
			prompt: readPromptText(payload),
			sessionFile,
		});
		const recoveryContext = buildStateRecoveryDiagnosticsContext(recoveryDiagnostics);
		const prompt = readPromptText(payload);
		let delegateHostContext: { path: string; context: McpDelegateHostContextV1 } | null = null;
		try {
			delegateHostContext = await persistMcpDelegateHostContext({
				cwd,
				sessionId: readSessionId(payload),
				threadId: readThreadId(payload),
				turnId: readTurnId(payload),
				prompt,
			});
		} catch (error) {
			await logHookError(cwd, "mcp_delegate_host_context_persist_error", error);
		}
		const skillState =
			prompt && !detectMcpDelegateFlowActivation(prompt)
				? await recordSkillActivation({
						cwd,
						text: prompt,
						sessionId: readSessionId(payload),
						threadId: readThreadId(payload),
						turnId: readTurnId(payload),
						stateDir: options.stateDir,
					})
				: null;
		const effectiveSkillConfig = skillState
			? await resolveEffectiveSkillConfig(cwd, options.effectiveSkillConfig, options.configPaths, {
					sessionId: readSessionId(payload),
					threadId: readThreadId(payload),
					stateDir: options.stateDir,
				})
			: undefined;
		const activeUltragoalContext = skillState
			? null
			: await buildActiveUltragoalPromptContext({
					cwd,
					sessionId: readSessionId(payload),
					threadId: readThreadId(payload),
					stateDir: options.stateDir,
					prompt,
					sessionFile,
				});
		if (activeUltragoalContext?.startsWith("BLOCK_ULTRAGOAL_COMPLETION:")) {
			return {
				hookEventName,
				outputJson: {
					decision: "block",
					reason: activeUltragoalContext,
					hookSpecificOutput: {
						hookEventName,
						additionalContext: activeUltragoalContext,
					},
				},
			};
		}
		const additionalContext = [
			skillState ? buildSkillActivationAdditionalContext(skillState, effectiveSkillConfig) : activeUltragoalContext,
			delegateHostContext ? `GJC MCP delegate-flow host context persisted at ${delegateHostContext.path}.` : null,
			recoveryContext,
			classifyQuestionOnlyPrompt(prompt),
		]
			.filter((value): value is string => Boolean(value))
			.join(" ");
		return {
			hookEventName,
			outputJson: additionalContext
				? {
						hookSpecificOutput: {
							hookEventName,
							additionalContext,
						},
					}
				: null,
		};
	}

	if (hookEventName === "Stop") {
		return {
			hookEventName,
			outputJson: await buildSkillStopOutput({
				cwd,
				sessionId: readSessionId(payload),
				threadId: readThreadId(payload),
				stateDir: options.stateDir,
				sessionFile,
			}),
		};
	}

	return { hookEventName, outputJson: null };
}

export async function runGjcNativeSkillHookInProcess(payload: HookPayload): Promise<string> {
	const result = await dispatchGjcNativeSkillHook(payload);
	if (result.outputJson) {
		return `${JSON.stringify(result.outputJson)}\n`;
	}
	if (result.hookEventName === "Stop") {
		return "{}\n";
	}
	return "";
}

async function readStdinJson(): Promise<{ payload: HookPayload; parseError: Error | null }> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf-8").trim();
	if (!raw) return { payload: {}, parseError: null };
	try {
		return { payload: JSON.parse(raw) as HookPayload, parseError: null };
	} catch (error) {
		return { payload: {}, parseError: error instanceof Error ? error : new Error(String(error)) };
	}
}

const NATIVE_HOOK_LOG_DIR_ERROR = "native hook log directory is not a real directory";
const NATIVE_HOOK_LOG_FILE_ERROR = "native hook log path is not a regular file";
const HOOK_LOG_NO_FOLLOW = process.platform === "win32" ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0);

function hookErrno(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

/** Refuse chmod of `/` or the home directory. The log path is always nested under the workspace. */
function isProtectedHookPath(candidate: string): boolean {
	const resolved = path.resolve(candidate);
	if (resolved === path.parse(resolved).root) return true;
	const home = os.homedir();
	return home.length > 0 && resolved === path.resolve(home);
}

function hookLogInside(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function sameHookFile(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

async function tightenHookDirectory(dir: string): Promise<void> {
	if (isProtectedHookPath(dir)) throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dir, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0) | HOOK_LOG_NO_FOLLOW);
		const st = await handle.stat();
		if (!st.isDirectory()) throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
		if (process.platform === "win32" || (st.mode & 0o077) === 0) return;
		await handle.chmod(0o700);
		const after = await handle.stat();
		if (!after.isDirectory() || (after.mode & 0o777) !== 0o700) throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
	} catch (error) {
		if (error instanceof Error && error.message === NATIVE_HOOK_LOG_DIR_ERROR) throw error;
		const code = hookErrno(error);
		if (code === "ELOOP" || code === "ENOTDIR" || code === "EPERM") throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
		throw error;
	} finally {
		await handle?.close();
	}
}

/**
 * Create `<cwd>/.gjc/_session-…/logs` without following a symlink component.
 * A pre-existing `.gjc` directory keeps its mode; the session and logs directories are owner-only.
 */
async function ensureHookLogDirectory(cwd: string, logsDir: string): Promise<void> {
	const root = path.resolve(cwd);
	const target = path.resolve(logsDir);
	if (!hookLogInside(root, target) || isProtectedHookPath(target)) throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
	let current = root;
	for (const part of path.relative(root, target).split(path.sep)) {
		if (part === "" || part === "." || part === "..") throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
		current = path.join(current, part);
		let created = false;
		let currentStat: Awaited<ReturnType<typeof lstat>>;
		try {
			currentStat = await lstat(current);
		} catch (error) {
			if (hookErrno(error) !== "ENOENT") throw error;
			try {
				await mkdir(current, { mode: 0o700 });
				created = true;
			} catch (mkdirError) {
				if (hookErrno(mkdirError) !== "EEXIST") throw mkdirError;
			}
			currentStat = await lstat(current);
		}
		if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) throw new Error(NATIVE_HOOK_LOG_DIR_ERROR);
		if (created || part !== GJC_DIR) await tightenHookDirectory(current);
	}
}

/** Append mode 0600. An existing symlink, fifo, or non-file is refused before the write. */
async function appendNativeHookLog(filePath: string, text: string): Promise<void> {
	let initial: fsSync.BigIntStats | undefined;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		initial = undefined;
		try {
			const named = await lstat(filePath, { bigint: true });
			if (named.isSymbolicLink() || !named.isFile()) throw new Error(NATIVE_HOOK_LOG_FILE_ERROR);
			initial = named;
		} catch (error) {
			if (hookErrno(error) !== "ENOENT") throw error;
		}
		const flags = initial
			? fsSync.constants.O_WRONLY |
				fsSync.constants.O_APPEND |
				HOOK_LOG_NO_FOLLOW |
				(fsSync.constants.O_NONBLOCK ?? 0)
			: fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_APPEND;
		try {
			handle = await open(filePath, flags, 0o600);
			break;
		} catch (error) {
			const code = hookErrno(error);
			if (code === "ELOOP" || code === "ENXIO" || code === "ENOTDIR") throw new Error(NATIVE_HOOK_LOG_FILE_ERROR);
			if (initial === undefined && code === "EEXIST" && attempt === 0) continue;
			throw error;
		}
	}
	if (!handle) throw new Error(NATIVE_HOOK_LOG_FILE_ERROR);
	try {
		const opened = await handle.stat({ bigint: true });
		const named = await lstat(filePath, { bigint: true });
		if (
			!opened.isFile() ||
			named.isSymbolicLink() ||
			!named.isFile() ||
			(initial !== undefined && !sameHookFile(initial, opened)) ||
			!sameHookFile(opened, named)
		) {
			throw new Error(NATIVE_HOOK_LOG_FILE_ERROR);
		}
		if (process.platform !== "win32" && (Number(opened.mode) & 0o077) !== 0) {
			await handle.chmod(0o600);
			if ((Number((await handle.stat()).mode) & 0o777) !== 0o600) throw new Error(NATIVE_HOOK_LOG_FILE_ERROR);
		}
		await handle.writeFile(text);
	} finally {
		await handle.close();
	}
}

async function logHookError(cwd: string, type: string, error: unknown): Promise<void> {
	// Bun has already copied the project dotenv into the environment. A value
	// that matches that snapshot must not select another session's log directory.
	const gjcSessionId = trustedCoordinatorEnv("GJC_SESSION_ID", process.env, projectEnvSnapshot(cwd));
	if (!gjcSessionId) {
		console.error(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				type,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return;
	}
	const now = new Date();
	const logsDir = sessionLogsDir(cwd, gjcSessionId);
	const line = `${JSON.stringify({ timestamp: now.toISOString(), type, error: error instanceof Error ? error.message : String(error) })}\n`;
	try {
		await ensureHookLogDirectory(cwd, logsDir);
		await appendNativeHookLog(path.join(logsDir, `native-hook-${now.toISOString().split("T")[0]}.jsonl`), line);
	} catch {
		// Skip a symlink or unusable log path. The hook response is unchanged.
	}
}

export async function runGjcNativeSkillHookCli(): Promise<void> {
	const { payload, parseError } = await readStdinJson();
	if (parseError) {
		await logHookError(process.cwd(), "native_hook_stdin_parse_error", parseError);
		process.stdout.write(
			`${JSON.stringify({
				decision: "block",
				reason: "GJC native hook received malformed JSON input.",
				hookSpecificOutput: {
					hookEventName: "Unknown",
					additionalContext: `stdin JSON parsing failed inside gjc codex-native-hook: ${parseError.message}`,
				},
			})}\n`,
		);
		return;
	}

	try {
		const result = await dispatchGjcNativeSkillHook(payload);
		if (result.outputJson) {
			process.stdout.write(`${JSON.stringify(result.outputJson)}\n`);
		} else if (result.hookEventName === "Stop") {
			process.stdout.write("{}\n");
		}
	} catch (error) {
		const cwd = safeString(payload.cwd).trim() || process.cwd();
		await logHookError(cwd, "native_hook_dispatch_error", error);
		if (readHookEventName(payload) === "Stop") {
			const detail = error instanceof Error ? error.message : String(error);
			process.stdout.write(
				`${JSON.stringify({
					decision: "block",
					reason: "GJC native Stop hook failed before normal continuation handling.",
					stopReason: "gjc_native_stop_dispatch_failure",
					systemMessage: `GJC native Stop hook failed before normal continuation handling. Failure: ${detail}`,
				})}\n`,
			);
		} else {
			process.exitCode = 1;
		}
	}
}
