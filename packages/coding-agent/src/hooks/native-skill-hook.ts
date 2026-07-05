import { appendFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { SkillDiscoverySettings } from "../config/skill-settings-defaults";
import { DEFAULT_DISABLED_EXTENSIONS, DEFAULT_SKILL_DISCOVERY_SETTINGS } from "../config/skill-settings-defaults";
import { sessionLogsDir } from "../gjc-runtime/session-layout";
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

function resolveConfigPaths(cwd: string, override?: string[]): string[] {
	if (override) return override;
	const configDirName = process.env.GJC_CONFIG_DIR ?? process.env.PI_CONFIG_DIR ?? ".gjc";
	const userAgentDir = process.env.GJC_CODING_AGENT_DIR ?? path.join(os.homedir(), configDirName, "agent");
	return [path.join(userAgentDir, "config.yml"), path.join(cwd, configDirName, "config.yml")];
}

async function resolveEffectiveSkillConfig(
	cwd: string,
	override?: EffectiveSkillConfigInput,
	configPaths?: string[],
): Promise<EffectiveSkillConfigInput> {
	if (override) return override;
	try {
		let config = buildDefaultEffectiveSkillConfig();
		for (const configPath of resolveConfigPaths(cwd, configPaths)) {
			const raw = await readRawConfig(configPath);
			if (raw) config = mergeRawSkillConfig(config, raw);
		}
		return config;
	} catch {
		return {
			unavailableReason: "config unavailable",
		};
	}
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

function readSessionFile(payload: HookPayload): string | undefined {
	return (
		safeString(
			payload.session_file ?? payload.sessionFile ?? payload.transcript_path ?? payload.transcriptPath,
		).trim() ||
		process.env.GJC_SESSION_FILE?.trim() ||
		undefined
	);
}

export async function dispatchGjcNativeSkillHook(
	payload: HookPayload,
	options: GjcNativeHookDispatchOptions = {},
): Promise<GjcNativeHookDispatchResult> {
	const hookEventName = readHookEventName(payload);
	const cwd = (options.cwd ?? safeString(payload.cwd).trim()) || process.cwd();
	if (hookEventName === "UserPromptSubmit") {
		const recoveryDiagnostics = await collectUserPromptStateRecoveryDiagnostics({
			cwd,
			sessionId: readSessionId(payload),
			threadId: readThreadId(payload),
			stateDir: options.stateDir,
			prompt: readPromptText(payload),
			sessionFile: readSessionFile(payload),
		});
		const recoveryContext = buildStateRecoveryDiagnosticsContext(recoveryDiagnostics);
		const prompt = readPromptText(payload);
		const skillState = prompt
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
			? await resolveEffectiveSkillConfig(cwd, options.effectiveSkillConfig, options.configPaths)
			: undefined;
		const activeUltragoalContext = skillState
			? null
			: await buildActiveUltragoalPromptContext({
					cwd,
					sessionId: readSessionId(payload),
					threadId: readThreadId(payload),
					stateDir: options.stateDir,
					prompt,
					sessionFile: readSessionFile(payload),
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
				sessionFile: readSessionFile(payload),
			}),
		};
	}

	return { hookEventName, outputJson: null };
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

async function logHookError(cwd: string, type: string, error: unknown): Promise<void> {
	const gjcSessionId = process.env.GJC_SESSION_ID?.trim();
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
	const logsDir = sessionLogsDir(cwd, gjcSessionId);
	await mkdir(logsDir, { recursive: true }).catch(() => {});
	await appendFile(
		path.join(logsDir, `native-hook-${new Date().toISOString().split("T")[0]}.jsonl`),
		`${JSON.stringify({ timestamp: new Date().toISOString(), type, error: error instanceof Error ? error.message : String(error) })}\n`,
	).catch(() => {});
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
