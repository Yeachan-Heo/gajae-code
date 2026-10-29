import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getUi, SETTINGS_SCHEMA, type SettingPath } from "@gajae-code/coding-agent/config/settings-schema";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
} from "@gajae-code/coding-agent/discovery/helpers";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@gajae-code/coding-agent/extensibility/extensions";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	createSessionImageInput,
	executeAcpBuiltinSlashCommand,
	getSessionMessageEntryId,
	type SlashCommandRuntime,
} from "@gajae-code/coding-agent/sdk";
import type { AgentSession, QueuedInputSubmission } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { createDesktopActivityController, type DesktopActivityController } from "./activity-controls";
import type {
	DesktopActivityGateAnswer,
	DesktopActivityOperation,
	DesktopActivityRef,
	DesktopActivityScope,
} from "./activity-protocol";
import { prepareDesktopAttachmentInput } from "./attachment-input";
import { createDesktopBtwController, type DesktopBtwController } from "./btw-controls";
import { prepareDesktopEnvironment } from "./environment-policy";
import {
	createDesktopGatePresenter,
	DesktopGatePresentationError,
	type DesktopGatePresenter,
} from "./gate-presentation";
import { createDesktopMcpController, type DesktopMcpController } from "./mcp-controls";
import {
	projectDesktopModel,
	projectDesktopThinking,
	validateModelThinking,
	validateSessionThinking,
} from "./model-controls";
import { DesktopOAuthController } from "./oauth";
import { createDesktopOperatorController, type DesktopOperatorController } from "./operator-controls";
import { createDesktopPreferencesController, type DesktopPreferencesController } from "./preferences-controls";
import type {
	DesktopActivityUpdate,
	DesktopCapability,
	DesktopCommand,
	DesktopCommandResult,
	DesktopDiff,
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopMessage,
	DesktopProject,
	DesktopQuestion,
	DesktopQueuedInput,
	DesktopRequest,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";
import { readDesktopSessionInfo } from "./session-info";
import { createDesktopStreamRedactor } from "./stream-redactor";

const HISTORY_LIMIT = 160;
const VISIBLE_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution", "pythonExecution"]);
const TEXT_LIMIT = 8_000;
const FULL_TEXT_LIMIT = 32_000;
/** Owned controllers redact complete display fields before producing these DTOs. */
const PROJECTED_CONTROL_METHODS = new Set<DesktopRequest["method"]>([
	"activity.get",
	"activity.detail",
	"activity.operate",
	"activity.acknowledge",
	"gate.present",
	"operator.execute",
	"operator.get",
	"operator.abort",
	"operator.fold",
	"btw.open",
	"btw.get",
	"btw.submit",
	"btw.cancel",
	"btw.close",
	"mcp.get",
	"mcp.operate",
	"session.info",
]);
const HISTORY_PAGE_LIMIT = 500;
const HISTORY_PAGE_BYTES = 2_000_000;
const COMMAND_OUTPUT_LIMIT = 200_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/**
 * Settings this host can display and edit generically. Free-form strings are
 * withheld because they can carry endpoints, paths or credentials, matching the
 * conservative portable-catalog rule. Values are validated against the schema
 * before writing, the same contract as `gjc config set`.
 */
const WITHHELD_SETTING = /token|secret|password|credential|apiKey|broker|oauth/i;
/**
 * Settings that only change the terminal UI. They are still readable so the app
 * shows the truth, but saving them from the desktop would promise an effect the
 * app cannot deliver.
 */
const TERMINAL_ONLY_SETTING =
	/^(statusLine\.|theme\.|clipboard\.|ui\.|notifications?\.|symbolPreset$|syntaxTheme|footer|header|editor\.)/i;
const EDITABLE_SETTING_TYPES = new Set(["boolean", "number", "enum"]);
/**
 * Session lifecycle belongs to the desktop catalog: these builtins would rotate
 * or relocate the transcript behind the catalog's back, leaving it unreopenable.
 * They stay visibly unavailable instead of half-applying.
 */
const DESKTOP_OWNED_COMMANDS = new Set(["move", "session", "star", "unstar", "handoff"]);
/** Refusal copy names the app control that does the job, because one generic hint fits none. */
const DESKTOP_OWNED_REFUSALS: Record<string, string> = {
	move: "/move는 세션 파일 경로를 바꾸므로 지원하지 않습니다. 프로젝트 목록의 '새 대화'로 세션을 시작하세요.",
	session: "/session은 지원하지 않습니다. 대화 목록에서 세션을 선택하거나 상단 '삭제' 버튼을 사용하세요.",
	star: "즐겨찾기는 대화 목록의 별표 버튼으로 설정하세요.",
	unstar: "즐겨찾기 해제는 대화 목록의 별표 버튼으로 설정하세요.",
	handoff: "/handoff는 세션 정체성을 바꾸므로 앱에서 지원하지 않습니다. 새 대화로 이어가세요.",
};
const DESKTOP_UNAVAILABLE = "이 명령은 데스크톱 앱에서 사용할 수 없습니다. 일반 메시지는 슬래시 없이 보내세요.";
/** Commands the palette advertises; everything else is refused before dispatch. */
const ADVERTISED_COMMANDS = new Set(
	ACP_BUILTIN_SLASH_COMMANDS.filter(command => !DESKTOP_OWNED_COMMANDS.has(command.name)).map(command => command.name),
);

export const CAPABILITIES: DesktopCapability[] = [
	{ id: "sessions", label: "Independent SDK sessions and streaming", available: true },
	{ id: "questions", label: "Select, confirm, input and editor questions", available: true },
	{ id: "settings", label: "Schema-validated boolean, number and enum settings", available: true },
	{ id: "slash-commands", label: "Builtin slash commands via the public SDK dispatcher", available: true },
	{
		id: "terminal-ui",
		label: "Terminal components and interactive terminal",
		available: false,
		reason: "Terminal-only SDK UI cannot be rendered by the desktop protocol.",
	},
	{
		id: "upstream-7322",
		label: "Terminal-only selectors and remaining runtime parity",
		available: false,
		reason: "TUI modal commands and private controllers are not exposed as SDK operations yet.",
	},
	{
		id: "subprocess-reentry",
		label: "CLI subprocess workers and daemon reentry",
		available: false,
		reason:
			"The standalone desktop entrypoint has no CLI subcommand dispatcher; worker/daemon reentry requires #7322 embedding support.",
	},
	{
		id: "oauth",
		label: "App-owned account authorization",
		available: true,
	},
];

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function requiredString(params: Record<string, unknown>, key: string, max = 32_000): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new Error(`Invalid ${key}`);
	return value;
}
function identifier(params: Record<string, unknown>, key: string): string {
	const value = requiredString(params, key, 36);
	if (!ID.test(value)) throw new Error(`Invalid ${key}`);
	return value;
}
export function validateQuestionAnswer(
	question: DesktopQuestion,
	params: Record<string, unknown>,
): string | boolean | null {
	if (identifier(params, "sessionId") !== question.sessionId) throw new Error("Question does not belong to session");
	const value = params.value;
	if (value === null) return null;
	if (question.kind === "confirm") {
		if (typeof value !== "boolean") throw new Error("Invalid question answer");
		return value;
	}
	if (typeof value !== "string" || value.length > 32_000) throw new Error("Invalid question answer");
	if (question.kind === "select" && !question.options?.includes(value)) throw new Error("Invalid question option");
	return value;
}

function readActivityScope(value: unknown): DesktopActivityScope {
	const scope = record(value);
	if (!scope) throw new Error("Invalid activity scope");
	return {
		sessionGeneration: requiredString(scope, "sessionGeneration", 128),
		connectionGeneration: requiredString(scope, "connectionGeneration", 128),
	};
}
function readActivityRef(value: unknown): DesktopActivityRef {
	const scope = readActivityScope(value);
	const reference = record(value)!;
	return { ...scope, key: requiredString(reference, "key", 128) };
}
function readActivityOperation(value: unknown): DesktopActivityOperation {
	switch (value) {
		case "cancel":
		case "delete":
		case "stop":
		case "pause":
		case "resume":
			return value;
		default:
			throw new Error("Invalid activity operation");
	}
}
function readGateAnswer(value: unknown): DesktopActivityGateAnswer {
	const answer = record(value);
	if (answer?.kind === "choice") return { kind: "choice", choiceKey: requiredString(answer, "choiceKey", 128) };
	if (answer?.kind === "json") return { kind: "json", json: requiredString(answer, "json", 64 * 1024) };
	throw new Error("Invalid gate answer");
}

export function desktopDataDir(): string {
	return path.resolve(
		process.env.GJC_DESKTOP_DATA_DIR ||
			path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
	);
}

/**
 * Settings the desktop host can read and write without a feature-specific
 * controller: schema-constrained scalars only. Free-form strings, arrays and
 * records are withheld rather than guessed at.
 */
export function desktopSettings(settings: Settings): DesktopSetting[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).flatMap(path => {
		const definition = SETTINGS_SCHEMA[path];
		if (!EDITABLE_SETTING_TYPES.has(definition.type) || WITHHELD_SETTING.test(path)) return [];
		const ui = getUi(path);
		const choices =
			definition.type === "enum"
				? [...((definition as { values: readonly string[] }).values ?? [])]
				: ui?.options && ui.options !== "runtime"
					? ui.options.map(option => option.value)
					: undefined;
		return [
			{
				path,
				value: settings.get(path),
				type: definition.type,
				description: TERMINAL_ONLY_SETTING.test(path)
					? `${ui?.description ?? ""} (터미널 전용: 데스크톱 앱 화면에는 영향을 주지 않습니다.)`.trim()
					: (ui?.description ?? "Application-wide setting; persisted to the desktop config."),
				...(choices && choices.length > 0 ? { choices } : {}),
				writable: settings.canPersistDurableConfig() && !TERMINAL_ONLY_SETTING.test(path),
			} satisfies DesktopSetting,
		];
	});
}

/** Validate one generic settings write against the schema before it is persisted. */
export function validateDesktopSetting(path: unknown, value: unknown): SettingPath {
	if (typeof path !== "string" || !(path in SETTINGS_SCHEMA)) throw new Error("Unknown setting path");
	const settingPath = path as SettingPath;
	const definition = SETTINGS_SCHEMA[settingPath];
	if (!EDITABLE_SETTING_TYPES.has(definition.type) || WITHHELD_SETTING.test(settingPath))
		throw new Error("Setting is not editable from the desktop host");
	if (TERMINAL_ONLY_SETTING.test(settingPath))
		throw new Error("Setting only affects the terminal UI and cannot be changed from the desktop host");
	if (definition.type === "boolean" && typeof value !== "boolean") throw new Error("Setting requires a boolean");
	if (definition.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Setting requires a number");
		const validate = (definition as { validate?: (candidate: number) => boolean }).validate;
		if (validate?.(value) === false) throw new Error("Setting value is out of range");
	}
	if (definition.type === "enum") {
		const values = (definition as { values?: readonly string[] }).values ?? [];
		if (typeof value !== "string" || !values.includes(value)) throw new Error("Setting value is not a valid choice");
	}
	return settingPath;
}

/**
 * Only visible text is projected: model thinking, tool-call arguments, images
 * and headers are never serialized. Explicit user execution code/output remains
 * visible even when excluded from model context. The host redacts known secrets.
 * `limit` bounds per-message text; the caller decides how many messages to keep.
 */
function projectVisibleMessage(value: unknown, index: number, limit: number): DesktopMessage | undefined {
	const message = record(value);
	if (!message || !VISIBLE_MESSAGE_ROLES.has(String(message.role))) return undefined;
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		const source = message.role === "bashExecution" ? message.command : message.code;
		if (typeof source !== "string" || typeof message.output !== "string") return undefined;
		const text = `${source}\n${message.output}`;
		return {
			id: `${index}:${String(message.timestamp ?? "")}`,
			role: "tool",
			toolName: message.role === "bashExecution" ? "셸 직접 실행" : "Python 직접 실행",
			text: text.slice(-limit),
			excludeFromContext: message.excludeFromContext === true,
			...(text.length > limit || message.truncated === true ? { truncated: true } : {}),
			...(message.cancelled === true
				? { cancelled: true }
				: typeof message.exitCode === "number" && message.exitCode !== 0
					? { isError: true }
					: {}),
		};
	}
	const role = message.role === "toolResult" ? "tool" : (message.role as "user" | "assistant");
	const content =
		typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content
						.flatMap(part => {
							const block = record(part);
							return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
						})
						.join("\n")
				: "";
	// A provider failure arrives as an assistant turn with an empty body and the
	// reason in errorMessage; dropping it renders a blank bubble the user cannot act on.
	const failed = message.stopReason === "error";
	const errorText = failed && typeof message.errorMessage === "string" ? message.errorMessage : "";
	const text = content || errorText;
	const entryId = role === "user" ? getSessionMessageEntryId(value as AgentMessage) : undefined;
	return {
		id: `${index}:${String(message.timestamp ?? "")}`,
		...(entryId ? { entryId } : {}),
		role,
		text: text.slice(-limit),
		...(text.length > limit ? { truncated: true } : {}),
		...(typeof message.toolName === "string" ? { toolName: message.toolName.slice(0, 100) } : {}),
		...(message.isError === true || failed ? { isError: true } : {}),
	};
}

function projectVisibleMessages(messages: readonly unknown[], limit: number): DesktopMessage[] {
	const projected: DesktopMessage[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = projectVisibleMessage(messages[index], index, limit);
		if (message) projected.push(message);
	}
	return projected;
}

/** How many messages the transcript view would show, without projecting text. */
function countVisibleMessages(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		const role =
			message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
				? (message as { role: string }).role
				: "";
		if (VISIBLE_MESSAGE_ROLES.has(role)) {
			const execution = record(message);
			if (
				(role === "bashExecution" || role === "pythonExecution") &&
				(typeof (role === "bashExecution" ? execution?.command : execution?.code) !== "string" ||
					typeof execution?.output !== "string")
			)
				continue;
			count += 1;
		}
	}
	return count;
}

/** Bounded snapshot projection used for every session in the snapshot frame. */
export function projectMessages(messages: readonly unknown[]): DesktopMessage[] {
	return projectVisibleMessages(messages.slice(-HISTORY_LIMIT), TEXT_LIMIT);
}

/**
 * On-demand projection for the explicit history view: no message-count cap.
 * `offset` is applied to the full projection so every page is addressable.
 */
export function projectHistoryPage(
	messages: readonly unknown[],
	offset: number,
	limit: number,
): { total: number; page: DesktopMessage[]; truncated: boolean } {
	const total = countVisibleMessages(messages);
	const page: DesktopMessage[] = [];
	// Bound the response by characters as well as message count so one huge page
	// cannot exceed the frame budget.
	let budget = HISTORY_PAGE_BYTES;
	let visible = 0;
	for (let index = 0; index < messages.length && page.length < limit; index += 1) {
		const message = projectVisibleMessage(messages[index], index, FULL_TEXT_LIMIT);
		if (!message) continue;
		if (visible < offset) {
			visible += 1;
			continue;
		}
		visible += 1;
		// Project only the requested page: the whole transcript would be allocated
		// (32k chars per message) just to discard all but one page.
		if (page.length > 0 && message.text.length > budget) break;
		budget -= message.text.length;
		page.push(message);
	}
	return { total, page, truncated: offset + page.length < total };
}

interface SavedSession {
	id: string;
	projectId: string;
	title: string;
	starred: boolean;
	file?: string;
}
interface Catalog {
	version: 1;
	projects: DesktopProject[];
	sessions: SavedSession[];
}
interface TrackedQueuedInput {
	dto: DesktopQueuedInput;
	submission: QueuedInputSubmission;
}
interface SessionCandidate {
	sdk: AgentSession;
	factory: CreateAgentSessionResult;
	metadata: SavedSession;
	settings: Settings;
	registry: ModelRegistry;
	notices: DesktopMessage[];
}
interface LiveSession extends SessionCandidate {
	serviceGeneration: number;
	unsubscribeActivity: () => void;
	unsubscribeIdentity: () => void;
	busy: boolean;
	error?: string;
	timer?: Timer;
	unsubscribe: () => void;
	activity: DesktopActivityController;
	preferences: DesktopPreferencesController;
	mcp: DesktopMcpController;
	operator?: DesktopOperatorController;
	operatorCurrentId?: string;
	btw?: DesktopBtwController;
	gatePresenter?: DesktopGatePresenter;
	gateUnavailable?: string;
	/** Blocks new surfaces across retirement and a catalog-owned lifecycle mutation. */
	gateMutation?: boolean;
	activityRevision: number;
	activityPublishedRevision: number;
	activityUpdate?: DesktopActivityUpdate;
	activitySerialized?: string;
	activityTimer?: Timer;
	streamingMessage?: unknown;
	/** Explicitly queued steering/follow-up submissions, in admission order. */
	queued: Map<string, TrackedQueuedInput>;
}
interface PendingQuestion {
	question: DesktopQuestion;
	settle: (value: string | boolean | null) => void;
}
export interface HostOptions {
	dataDir?: string;
	emit: (frame: DesktopFrame) => void;
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

export class DesktopHost {
	#dataDir: string;
	get dataDir(): string {
		return this.#dataDir;
	}
	get agentDir(): string {
		// Shared install by default: the app uses the same agent directory as the
		// terminal so credentials, model profiles and the default preset match. Tests
		// and QA opt into an isolated directory via GJC_DESKTOP_ISOLATED.
		const configured = process.env.GJC_CODING_AGENT_DIR?.trim();
		if (configured) return path.resolve(configured);
		return process.env.GJC_DESKTOP_ISOLATED === "1" ? path.join(this.#dataDir, "agent") : getAgentDir();
	}
	#emit: (frame: DesktopFrame, projected?: boolean) => void;
	#createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	#catalog: Catalog = { version: 1, projects: [], sessions: [] };
	#live = new Map<string, LiveSession>();
	/** Unpublished SDK ownership, retained until publication or proven disposal. */
	#candidates = new Set<SessionCandidate>();
	/** Retired publications remain owned even after their catalog/live entry is removed. */
	#retiredLive = new Set<LiveSession>();
	#cleanupRuns = new WeakMap<SessionCandidate, Promise<void>>();
	#cleanupOwners = new Map<SessionCandidate, Promise<void>>();
	#pendingForks = new Set<string>();
	#opening = new Map<string, Promise<LiveSession>>();
	#questions = new Map<string, PendingQuestion>();
	#auth?: AuthStorage;
	#oauth?: DesktopOAuthController;
	#registry?: ModelRegistry;
	#failedCatalogRefreshes = new WeakSet<ModelRegistry>();
	#catalogRefreshTail: Promise<void> = Promise.resolve();
	#settings?: Settings;
	#init?: Promise<void>;
	#saving: Promise<void> = Promise.resolve();
	#closed = false;
	readonly #connectionGeneration = crypto.randomUUID();
	#closing?: Promise<void>;
	#tasks = new Set<Promise<unknown>>();
	#secrets = new Set<string>();

	constructor(options: HostOptions) {
		this.#dataDir = path.resolve(options.dataDir ?? desktopDataDir());
		this.#emit = (frame, projected = false) => {
			// Owned controller DTOs are already redacted. Rewriting them here would
			// corrupt opaque references/enums and invalidate exact gate display proofs.
			// Still clone at the boundary so a consumer cannot mutate a private ledger.
			const completeProjection =
				projected || frame.type === "activity" || frame.type === "gate" || frame.type === "operator";
			const serialized = completeProjection
				? JSON.stringify(frame)
				: JSON.stringify(frame, (key, value: unknown) =>
						typeof value === "string" &&
						!["id", "entryId", "sessionId", "projectId", "type", "status", "kind", "role", "provider"].includes(
							key,
						)
							? this.#redact(value)
							: value,
					);
			options.emit(JSON.parse(serialized) as DesktopFrame);
		};
		this.#createSession = options.createSession ?? createAgentSession;
	}
	#redact(text: string): string {
		for (const secret of this.#secrets) text = text.split(secret).join("[redacted]");
		return text;
	}
	#error(error: unknown): string {
		return this.#redact(error instanceof Error ? error.message : "Operation failed").slice(0, 1000);
	}
	initialize(): Promise<void> {
		this.#init ??= this.#initialize();
		return this.#init;
	}
	async #initialize(): Promise<void> {
		await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		this.#dataDir = await fs.realpath(this.#dataDir);
		await fs.chmod(this.dataDir, 0o700);
		const agentDir = prepareDesktopEnvironment(process.env, this.dataDir);
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		if (process.env.GJC_DESKTOP_ISOLATED === "1")
			await fs.mkdir(path.join(this.dataDir, "home"), { recursive: true, mode: 0o700 });
		setAgentDir(agentDir);
		const catalogFile = Bun.file(path.join(this.dataDir, "catalog.json"));
		if (await catalogFile.exists()) {
			const value: unknown = await catalogFile.json();
			const catalog = record(value);
			if (catalog?.version !== 1 || !Array.isArray(catalog.projects) || !Array.isArray(catalog.sessions))
				throw new Error("Invalid desktop catalog");
			const projects = catalog.projects.map(value => {
				const item = record(value);
				if (!item) throw new Error("Invalid desktop project");
				return {
					id: identifier(item, "id"),
					name: requiredString(item, "name", 200),
					path: requiredString(item, "path"),
				};
			});
			const sessions = catalog.sessions.map(value => {
				const item = record(value);
				if (!item || typeof item.starred !== "boolean") throw new Error("Invalid desktop session");
				const session: SavedSession = {
					id: identifier(item, "id"),
					projectId: identifier(item, "projectId"),
					title: requiredString(item, "title", 200),
					starred: item.starred,
				};
				if (!projects.some(project => project.id === session.projectId)) throw new Error("Invalid session project");
				if (item.file !== undefined) {
					session.file = requiredString(item, "file");
					this.#sessionPath(session.file);
				}
				return session;
			});
			if (
				new Set(projects.map(p => p.id)).size !== projects.length ||
				new Set(sessions.map(s => s.id)).size !== sessions.length
			)
				throw new Error("Duplicate desktop IDs");
			this.#catalog = { version: 1, projects, sessions };
		}
		this.#settings = await Settings.loadForScope({ cwd: this.dataDir, agentDir: this.agentDir });
		this.#auth = await AuthStorage.create(path.join(this.agentDir, "agent.db"), {
			configValueResolver: async value => value,
		});
		this.#rememberCredentials();
		this.#registry = new ModelRegistry(this.#auth, path.join(this.agentDir, "models.yml"), this.#settings, {
			agentDir: this.agentDir,
		});
		// The terminal refreshes the model catalog before applying the default preset;
		// without it a configured profile such as cdx-lhigh cannot resolve models that
		// only exist in the online catalog, and the app silently falls back.
		try {
			await this.#registry.refresh("online");
		} catch {
			await this.#registry.refresh("offline");
		}
		this.#oauth = new DesktopOAuthController({
			service: this.#auth,
			emit: auth => this.#emit({ type: "auth", auth }),
			redact: text => this.#redact(text),
			onStored: async () => {
				this.#rememberCredentials();
				if (this.#closed) return;
				const refreshed = await this.#refreshModelCatalogs([
					{ registry: this.#registry! },
					...[...this.#live.values()].map(live => ({
						registry: live.sdk.modelRegistry,
						credentialSessionId: live.sdk.credentialSessionId,
					})),
				]);
				this.#publishSnapshot();
				if (!refreshed) throw new Error("Stored credentials could not refresh model catalogs");
			},
		});
	}
	/** Credential persistence is already committed; catalog refresh is a separate outcome. */
	#refreshModelCatalogs(
		targets: readonly { registry: ModelRegistry; credentialSessionId?: string }[],
	): Promise<boolean> {
		const refresh = this.#catalogRefreshTail.then(async () => {
			const outcomes = await Promise.allSettled(
				targets.map(async ({ registry, credentialSessionId }) => {
					try {
						if (credentialSessionId === undefined) await registry.refresh("offline");
						else await registry.refresh("offline", credentialSessionId);
						this.#failedCatalogRefreshes.delete(registry);
					} catch {
						this.#failedCatalogRefreshes.add(registry);
						throw new Error("Model catalog refresh failed");
					}
				}),
			);
			return outcomes.every(outcome => outcome.status === "fulfilled");
		});
		// Serialize refreshes so an older failure cannot overwrite a later success.
		this.#catalogRefreshTail = refresh.then(
			() => {},
			() => {},
		);
		return refresh;
	}
	#assertModelCatalogReady(registry: ModelRegistry): void {
		if (this.#failedCatalogRefreshes.has(registry))
			throw new Error(
				"모델 목록을 새로 고치지 못했습니다. 목록 다시 불러오기로 재시도하세요. 저장된 자격 증명은 유지됩니다.",
			);
	}
	#rememberCredentials(): void {
		for (const entries of Object.values(this.#auth!.getAll())) {
			for (const credential of Array.isArray(entries) ? entries : [entries]) {
				if (credential.type === "api_key" && credential.key) this.#secrets.add(credential.key);
				if (credential.type === "oauth") {
					if (credential.access) this.#secrets.add(credential.access);
					if (credential.refresh) this.#secrets.add(credential.refresh);
				}
			}
		}
	}
	#sessionPath(relative: string): string {
		const root = path.join(this.dataDir, "sessions");
		const resolved = path.resolve(root, relative);
		if (path.isAbsolute(relative) || !resolved.startsWith(`${root}${path.sep}`))
			throw new Error("Invalid session file");
		return resolved;
	}
	#save(): Promise<void> {
		const content = JSON.stringify(this.#catalog);
		const save = this.#saving
			.catch(() => {})
			.then(async () => {
				const temporary = path.join(this.dataDir, `catalog.${crypto.randomUUID()}.tmp`);
				try {
					await Bun.write(temporary, content, { mode: 0o600 });
					await fs.rename(temporary, path.join(this.dataDir, "catalog.json"));
				} finally {
					await fs.rm(temporary, { force: true });
				}
			});
		this.#saving = save;
		return save;
	}
	#dto(metadata: SavedSession): DesktopSession {
		const live = this.#live.get(metadata.id);
		const question = [...this.#questions.values()].find(item => item.question.sessionId === metadata.id)?.question;
		const gates = live?.activityUpdate?.activity.sessionState?.gates;
		const awaitingGate = gates?.available && gates.pending.length > 0;
		return {
			id: metadata.id,
			projectId: metadata.projectId,
			title: metadata.title,
			starred: metadata.starred,
			status:
				question || awaitingGate
					? "waiting"
					: live && (live.busy || live.sdk.isStreaming || live.operator?.isBusy())
						? "running"
						: live?.error
							? "error"
							: "idle",
			...(live?.sdk.model ? { model: `${live.sdk.model.provider}/${live.sdk.model.id}` } : {}),
			thinking: projectDesktopThinking(live?.sdk),
			operatorRunning: live?.operator?.isBusy() ?? false,
			controlGeneration: live?.sdk.sessionLifecycle.generation ?? null,
			imageInput: live
				? {
						supported: live.sdk.model?.input.includes("image") === true,
						blocked: live.sdk.settings.get("images.blockImages"),
					}
				: null,
			messages: live
				? [
						...projectMessages(
							live.streamingMessage ? [...live.sdk.messages, live.streamingMessage] : live.sdk.messages,
						),
						...live.notices,
					]
						.slice(-HISTORY_LIMIT)
						.map(message => ({ ...message, text: this.#redact(message.text) }))
				: [],
			...(live && live.sdk.messages.length + live.notices.length > HISTORY_LIMIT ? { historyTruncated: true } : {}),
			...(question ? { question } : {}),
			...(live && live.queued.size > 0 ? { queued: [...live.queued.values()].map(item => ({ ...item.dto })) } : {}),
			...(live?.error ? { error: live.error } : {}),
		};
	}
	snapshot(): DesktopSnapshot {
		return {
			protocolVersion: PROTOCOL_VERSION,
			projects: this.#catalog.projects.map(project => ({ ...project })),
			sessions: this.#catalog.sessions
				.filter(session => !this.#pendingForks.has(session.id))
				.map(session => {
					const dto = this.#dto(session);
					let remaining = Math.floor(500_000 / Math.max(1, this.#catalog.sessions.length));
					dto.messages = dto.messages
						.slice()
						.reverse()
						.flatMap(message => {
							if (remaining <= 0) {
								dto.historyTruncated = true;
								return [];
							}
							const text = message.text.slice(-remaining);
							remaining -= text.length;
							return [{ ...message, text, truncated: message.truncated || text.length < message.text.length }];
						})
						.reverse();
					return dto;
				}),
			models: this.#registry?.getAvailable().map(projectDesktopModel) ?? [],
			capabilities: CAPABILITIES.map(capability => ({ ...capability })),
		};
	}
	#publishSnapshot(): void {
		this.#emit({ type: "snapshot", snapshot: this.snapshot() });
	}
	#publish(live: LiveSession): void {
		if (live.timer) clearTimeout(live.timer);
		live.timer = undefined;
		if (!this.#live.has(live.metadata.id)) return;
		this.#refreshSessionServices(live);
		this.#emit({ type: "session", session: this.#dto(live.metadata) });
	}
	#activityUpdate(live: LiveSession, publish = false): DesktopActivityUpdate {
		this.#refreshSessionServices(live);
		const activity = live.activity.getSnapshot();
		if (!live.gatePresenter && activity.sessionState?.gates.available) {
			activity.sessionState.gates.pending = activity.sessionState.gates.pending.map(gate => ({
				...gate,
				answerable: false,
				reason: live.gateUnavailable ?? "이 세션에는 승인 화면 제어기가 연결되지 않았습니다.",
			}));
		}
		const serialized = JSON.stringify(activity);
		if (serialized !== live.activitySerialized || !live.activityUpdate) {
			live.activitySerialized = serialized;
			live.activityUpdate = { sessionId: live.metadata.id, revision: ++live.activityRevision, activity };
		}
		if (publish && live.activityPublishedRevision < live.activityUpdate.revision) {
			this.#emit({ type: "activity", update: live.activityUpdate });
			live.activityPublishedRevision = live.activityUpdate.revision;
		}
		return live.activityUpdate;
	}
	#scheduleActivity(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		live.activityTimer ??= setTimeout(() => {
			live.activityTimer = undefined;
			if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
			this.#activityUpdate(live, true);
			this.#publish(live);
		}, 75);
	}
	#schedule(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		live.timer ??= setTimeout(() => this.#publish(live), 75);
	}
	#metadata(params: Record<string, unknown>): SavedSession {
		const id = identifier(params, "sessionId");
		const metadata = this.#catalog.sessions.find(session => session.id === id);
		if (!metadata) throw new Error("Session not found");
		return metadata;
	}
	async #open(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
		const pending = this.#opening.get(metadata.id);
		if (pending) return pending;
		const existing = this.#live.get(metadata.id);
		if (existing) {
			this.#refreshSessionServices(existing);
			return existing;
		}
		const promise = this.#load(metadata, manager);
		this.#opening.set(metadata.id, promise);
		try {
			return await promise;
		} finally {
			this.#opening.delete(metadata.id);
		}
	}
	async #load(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
		const candidate = await this.#constructCandidate(metadata, manager);
		try {
			const live = this.#publishCandidate(candidate);
			await this.#save();
			return live;
		} catch (error) {
			const live = this.#live.get(metadata.id);
			if (live) this.#retiredLive.add(live);
			this.#live.delete(metadata.id);
			try {
				if (live) {
					this.#candidates.delete(candidate);
					await this.#disposeLive(live);
				} else await this.#disposeCandidate(candidate);
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Session publication and owned cleanup failed");
			}
			throw error;
		}
	}
	/** No catalog insertion, host subscriptions, UI binding or live controllers before publication. */
	async #constructCandidate(metadata: SavedSession, manager?: SessionManager): Promise<SessionCandidate> {
		const project = this.#catalog.projects.find(item => item.id === metadata.projectId);
		if (!project || !(await fs.stat(project.path)).isDirectory()) throw new Error("Project directory unavailable");
		const directory = path.join(this.dataDir, "sessions", metadata.projectId);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		let existingFile: string | undefined;
		if (metadata.file) {
			existingFile = await fs.realpath(this.#sessionPath(metadata.file));
			const root = await fs.realpath(path.join(this.dataDir, "sessions"));
			if (!existingFile.startsWith(`${root}${path.sep}`) || !(await fs.stat(existingFile)).isFile())
				throw new Error("Invalid saved session file");
		}
		const sessionManager =
			manager ??
			(existingFile
				? await SessionManager.open(existingFile, directory)
				: SessionManager.create(project.path, directory));
		if (path.resolve(sessionManager.getCwd()) !== path.resolve(project.path))
			throw new Error("Session project does not match catalog");
		const settings = await Settings.loadForScope({ cwd: project.path, agentDir: this.agentDir });
		const registry = new ModelRegistry(this.#auth!, path.join(this.agentDir, "models.yml"), settings, {
			agentDir: this.agentDir,
		});
		let createdSession: AgentSession | undefined;
		try {
			await registry.refresh("offline");
			const result = await this.#createSession({
				cwd: project.path,
				agentDir: this.agentDir,
				profileAuthority: "custom",
				authStorage: this.#auth,
				modelRegistry: registry,
				agentRegistry: new AgentRegistry(),
				settings,
				sessionManager,
				hasUI: true,
				notificationHostModeSupported: false,
				sdkHostModeSupported: false,
				disableExtensionDiscovery: true,
			});
			createdSession = result.session;
			const candidate: SessionCandidate = {
				sdk: result.session,
				factory: result,
				metadata,
				settings,
				registry,
				notices: [],
			};
			this.#candidates.add(candidate);
			// The terminal applies the configured default model profile at startup; without
			// the same step a new desktop session starts with no model (or a stale SDK
			// default), so the first prompt fails even though the install is configured.
			const defaultProfile = settings.get("modelProfile.default");
			if (defaultProfile) {
				try {
					const applied = await result.session.activateModelProfileForControl(defaultProfile);
					if (!applied)
						candidate.notices.push({
							id: `profile:${metadata.id}`,
							role: "system",
							text: `기본 모델 프로필(${defaultProfile})을 적용하지 못했습니다. 설정에서 모델을 선택하세요.`,
							isError: true,
						});
				} catch (error) {
					candidate.notices.push({
						id: `profile:${metadata.id}`,
						role: "system",
						text: `기본 모델 프로필(${defaultProfile})을 적용하지 못했습니다: ${String(error).slice(0, 300)}`,
						isError: true,
					});
				}
			}
			// The SDK reserves a path before it writes a transcript. Use its public
			// persistence API so even an empty desktop session can be resumed.
			if (!existingFile) await result.session.setSessionName(metadata.title, "user");
			await sessionManager.ensureOnDisk();
			await this.#flushSession(candidate);
			return candidate;
		} catch (error) {
			const failures: unknown[] = [error];
			const attempt = async (operation: () => unknown | Promise<unknown>) => {
				try {
					await operation();
				} catch (failure) {
					failures.push(failure);
				}
			};
			const candidate = [...this.#candidates].find(item => item.sdk === createdSession);
			if (candidate) await attempt(() => this.#disposeCandidate(candidate));
			else {
				await attempt(() => createdSession?.dispose());
				await attempt(() => registry.dispose());
				await attempt(() => settings.close());
			}
			if (failures.length > 1) throw new AggregateError(failures, "Session initialization and owned cleanup failed");
			throw error;
		}
	}
	#publishCandidate(candidate: SessionCandidate): LiveSession {
		if (this.#closed) throw new Error("Host is closed");
		const live: LiveSession = {
			...candidate,
			serviceGeneration: candidate.sdk.sessionLifecycle.generation,
			unsubscribeActivity: () => {},
			unsubscribeIdentity: () => {},
			unsubscribe: () => {},
			activity: createDesktopActivityController(candidate.factory, {
				connectionGeneration: this.#connectionGeneration,
				redact: text => this.#redact(text),
			}),
			preferences: createDesktopPreferencesController(candidate.sdk),
			mcp: createDesktopMcpController(candidate.factory, {
				connectionGeneration: this.#connectionGeneration,
				redact: text => this.#redact(text),
			}),
			activityRevision: 0,
			activityPublishedRevision: 0,
			busy: false,
			queued: new Map(),
		};
		this.#live.set(live.metadata.id, live);
		this.#attachGatePresenter(live);
		this.#attachOperatorController(live);
		this.#attachBtwController(live);
		live.factory.setToolUIContext(this.#ui(live), true);
		live.unsubscribe = live.sdk.subscribe(event => {
			if (event.type === "message_update") live.streamingMessage = event.message;
			if (event.type === "message_end" || event.type === "agent_end") live.streamingMessage = undefined;
			this.#schedule(live);
		});
		live.unsubscribeActivity = live.activity.onChange(() => this.#scheduleActivity(live));
		live.unsubscribeIdentity = live.sdk.subscribeSessionIdentityChanges(() => this.#schedule(live));
		this.#candidates.delete(candidate);
		return live;
	}
	async #disposeCandidate(candidate: SessionCandidate): Promise<void> {
		// dispose() has a caller deadline, not a lifetime guarantee. Start and observe
		// both promises immediately; only the retained actual owner may release dependencies.
		const bounded = candidate.sdk.dispose();
		void bounded.catch(() => {});
		let completion = this.#cleanupRuns.get(candidate);
		if (!completion) {
			completion = (async () => {
				await candidate.sdk.awaitDisposeCompletion();
				const failures: unknown[] = [];
				for (const release of [() => candidate.registry.dispose(), () => candidate.settings.close()]) {
					try {
						await release();
					} catch (error) {
						failures.push(error);
					}
				}
				if (failures.length) throw new AggregateError(failures, "Session dependencies failed to release");
				this.#candidates.delete(candidate);
			})();
			this.#cleanupRuns.set(candidate, completion);
			this.#cleanupOwners.set(candidate, completion);
			void completion.then(
				() => this.#cleanupOwners.delete(candidate),
				() => {
					this.#cleanupRuns.delete(candidate);
				},
			);
		}
		await Promise.all([bounded, completion]);
	}
	async #fork(live: LiveSession, params: Record<string, unknown>): Promise<DesktopForkResult> {
		const source = live.sdk.sessionManager;
		const sourceId = live.sdk.sessionId;
		const sourceFile = source.getSessionFile();
		const generation = live.sdk.sessionLifecycle.generation;
		const assertSource = () => {
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				this.#closed ||
				this.#live.get(live.metadata.id) !== live ||
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionManager !== source ||
				live.sdk.sessionId !== sourceId ||
				source.getSessionFile() !== sourceFile
			)
				throw new Error("Source session changed while forking");
		};
		assertSource();
		const entryId = params.entryId === undefined ? undefined : requiredString(params, "entryId", 128);
		if (entryId !== undefined) {
			const entry = source.getEntry(entryId);
			if (entry?.type !== "message" || entry.message.role !== "user")
				throw new Error("Invalid entry ID for branching");
		}
		await this.#flushSession(live);
		assertSource();
		if (!sourceFile) throw new Error("Session has no persisted transcript");
		const capture = SessionManager.captureTranscriptStrict(sourceFile);
		if (capture.kind !== "captured") throw new Error("Could not capture source transcript for fork");
		const project = this.#catalog.projects.find(item => item.id === live.metadata.projectId)!;
		const directory = path.join(this.dataDir, "sessions", live.metadata.projectId);
		const fork: SavedSession = {
			id: crypto.randomUUID(),
			projectId: live.metadata.projectId,
			title: `${live.metadata.title.slice(0, 190)} (fork)`,
			starred: false,
		};
		let manager: SessionManager | undefined;
		let candidate: SessionCandidate | undefined;
		let published: LiveSession | undefined;
		let publication: PromiseWithResolvers<LiveSession> | undefined;
		const ownedFiles = new Set<string>();
		const rememberOwnedFile = (file: string | undefined) => {
			if (!file) throw new Error("Fork has no persistent transcript");
			if (
				path.dirname(file) !== directory ||
				file === sourceFile ||
				this.#catalog.sessions.some(item => item !== fork && item.file && this.#sessionPath(item.file) === file)
			)
				throw new Error("Fork cleanup cannot claim an existing session file");
			ownedFiles.add(file);
		};
		try {
			const copied = await SessionManager.forkFromCaptured(capture.snapshot, project.path, directory);
			if (copied.kind !== "forked") throw new Error("Could not create captured session fork");
			manager = copied.manager;
			rememberOwnedFile(manager.getSessionFile());
			assertSource();
			candidate = await this.#constructCandidate(fork, manager);
			assertSource();
			let selectedText = "";
			if (entryId !== undefined) {
				const entry = candidate.sdk.sessionManager.getEntry(entryId);
				if (entry?.type !== "message" || entry.message.role !== "user")
					throw new Error("Invalid entry ID for branching");
				const result = await candidate.sdk.branch(entryId);
				// The SDK may rotate identity even when later cleanup or hooks throw.
				rememberOwnedFile(candidate.sdk.sessionManager.getSessionFile());
				assertSource();
				if (result.cancelled) {
					await this.#disposeCandidate(candidate);
					candidate = undefined;
					for (const file of ownedFiles) await new FileSessionStorage().deleteSessionWithArtifacts(file);
					return { cancelled: true };
				}
				selectedText = result.selectedText;
			}
			await this.#flushSession(candidate);
			assertSource();
			// A is deliberately retained as B's private parentSession lineage ancestor.
			// Only the uncancelled, materialized current successor B enters the catalog.
			publication = Promise.withResolvers<LiveSession>();
			void publication.promise.catch(() => {});
			this.#opening.set(fork.id, publication.promise);
			this.#pendingForks.add(fork.id);
			this.#catalog.sessions.push(fork);
			await this.#save();
			assertSource();
			published = this.#publishCandidate(candidate);
			this.#pendingForks.delete(fork.id);
			candidate = undefined;
			// Durable catalog and live-owner publication are committed. Transport or
			// DTO failures must not compensate a child that another caller can select.
			publication.resolve(published);
			this.#publishSnapshot();
			const session = this.#dto(fork);
			return { cancelled: false, session, selectedText };
		} catch (error) {
			if (published) throw error;
			const failures: unknown[] = [error];
			candidate ??= [...this.#candidates].find(item => item.metadata === fork);
			// Read actual identity before disposal: branch can reject after committing B.
			let identityKnown = true;
			try {
				if (candidate) rememberOwnedFile(candidate.sdk.sessionManager.getSessionFile());
			} catch (failure) {
				identityKnown = false;
				failures.push(failure);
			}
			let disposed = false;
			try {
				const liveCandidate = published ?? this.#live.get(fork.id);
				if (liveCandidate) {
					this.#retiredLive.add(liveCandidate);
					this.#live.delete(fork.id);
					if (candidate) this.#candidates.delete(candidate);
					await this.#disposeLive(liveCandidate);
				} else if (candidate) await this.#disposeCandidate(candidate);
				else if (manager) {
					const outcome = await manager.closeStrict();
					if (outcome.kind !== "closed") throw outcome.error;
				}
				disposed = true;
			} catch (failure) {
				failures.push(failure);
			}
			this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== fork);
			let rollbackSaved = false;
			try {
				await this.#save();
				rollbackSaved = true;
			} catch (failure) {
				failures.push(failure);
			}
			// A settled writer is insufficient when the durable catalog may still reference B.
			if (disposed && identityKnown && rollbackSaved) {
				for (const file of ownedFiles) {
					try {
						await new FileSessionStorage().deleteSessionWithArtifacts(file);
					} catch (failure) {
						failures.push(failure);
					}
				}
			}
			if (failures.length > 1) throw new AggregateError(failures, "Session fork and owned cleanup failed");
			throw error;
		} finally {
			publication?.reject(new Error("Session fork was not published"));
			if (publication && this.#opening.get(fork.id) === publication.promise) this.#opening.delete(fork.id);
			this.#pendingForks.delete(fork.id);
			capture.snapshot.close();
		}
	}
	#attachOperatorController(live: LiveSession): void {
		live.operatorCurrentId = undefined;
		live.operator = createDesktopOperatorController(live.sdk, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
			createStreamRedactor: () => createDesktopStreamRedactor([...this.#secrets], text => this.#redact(text)),
			emit: event => {
				if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
				live.operatorCurrentId = event.operation.operationId;
				this.#emit({ type: "operator", sessionId: live.metadata.id, event });
				this.#schedule(live);
			},
		});
	}
	#attachBtwController(live: LiveSession): void {
		const generation = live.sdk.sessionLifecycle.generation;
		const controller = createDesktopBtwController(live.sdk, {
			redact: text => this.#redact(text),
			createStreamRedactor: () => createDesktopStreamRedactor([...this.#secrets], text => this.#redact(text)),
			emit: event => {
				if (this.#closed || this.#live.get(live.metadata.id) !== live || live.btw !== controller) return;
				this.#emit({ type: "btw", sessionId: live.metadata.id, sessionGeneration: generation, event }, true);
			},
		});
		live.btw = controller;
	}
	#attachGatePresenter(live: LiveSession): void {
		live.gatePresenter = undefined;
		live.gateUnavailable = undefined;
		try {
			live.gatePresenter = createDesktopGatePresenter({
				session: live.sdk,
				activity: live.activity,
				connectionGeneration: this.#connectionGeneration,
				catalogSessionId: live.metadata.id,
				isCurrent: (connection, catalog) =>
					!this.#closed &&
					connection === this.#connectionGeneration &&
					catalog === live.metadata.id &&
					this.#live.get(catalog) === live,
				emit: event => this.#emit({ type: "gate", sessionId: live.metadata.id, event }),
			});
		} catch (error) {
			if (!(error instanceof DesktopGatePresentationError)) throw error;
			live.gateUnavailable = this.#error(error);
		}
	}
	#refreshSessionServices(live: LiveSession): void {
		if (this.#closed || this.#live.get(live.metadata.id) !== live) return;
		const lifecycle = live.sdk.sessionLifecycle;
		if (lifecycle.disposed || lifecycle.transitioning || lifecycle.generation <= live.serviceGeneration) return;
		live.unsubscribeActivity();
		live.btw?.dispose();
		live.operator?.dispose();
		live.gatePresenter?.dispose();
		live.preferences.dispose();
		live.mcp.dispose();
		live.activity.dispose();
		live.activity = createDesktopActivityController(live.factory, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
		});
		live.preferences = createDesktopPreferencesController(live.sdk);
		live.mcp = createDesktopMcpController(live.factory, {
			connectionGeneration: this.#connectionGeneration,
			redact: text => this.#redact(text),
		});
		live.serviceGeneration = lifecycle.generation;
		live.activityUpdate = undefined;
		live.activitySerialized = undefined;
		this.#attachGatePresenter(live);
		this.#attachOperatorController(live);
		this.#attachBtwController(live);
		live.unsubscribeActivity = live.activity.onChange(() => this.#scheduleActivity(live));
		this.#scheduleActivity(live);
	}
	async #disposeLive(live: LiveSession): Promise<void> {
		this.#retiredLive.add(live);
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		await attempt(() => live.unsubscribe());
		await attempt(() => live.unsubscribeActivity());
		await attempt(() => live.unsubscribeIdentity());
		if (live.timer) clearTimeout(live.timer);
		if (live.activityTimer) clearTimeout(live.activityTimer);
		live.timer = undefined;
		live.activityTimer = undefined;
		await attempt(() => live.btw?.dispose());
		await attempt(() => live.operator?.dispose());
		await attempt(() => live.gatePresenter?.dispose());
		await attempt(() => live.preferences.dispose());
		await attempt(() => live.mcp.dispose());
		await attempt(() => live.activity.dispose());
		const controllersReleased = failures.length === 0;
		await attempt(() => this.#disposeCandidate(live));
		if (controllersReleased) {
			void this.#cleanupRuns.get(live)?.then(
				() => this.#retiredLive.delete(live),
				() => {},
			);
		}
		if (failures.length) throw new AggregateError(failures, "Session failed to release all owned resources");
	}
	async #flushSession(live: SessionCandidate): Promise<void> {
		const manager = live.sdk.sessionManager;
		const sessionId = live.sdk.sessionId;
		const generation = live.sdk.sessionLifecycle.generation;
		const assertCurrent = (): void => {
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionManager !== manager ||
				live.sdk.sessionId !== sessionId
			) {
				throw new Error("Session changed while persisting desktop catalog");
			}
		};
		assertCurrent();
		const file = manager.getSessionFile();
		if (!file) {
			if (live.metadata.file) throw new Error("Persisted session file unavailable");
			return;
		}
		const relative = path.relative(path.join(this.dataDir, "sessions"), file);
		this.#sessionPath(relative);
		// A committed empty successor reserves its path before creating the file.
		// Materialize through the SDK, never publish a merely reserved catalog path.
		await manager.ensureOnDisk();
		assertCurrent();
		await manager.flush();
		assertCurrent();
		const stat = await fs.stat(file);
		assertCurrent();
		if (!stat.isFile()) throw new Error("Invalid persisted session file");
		live.metadata.file = relative;
	}
	#cancelQuestions(sessionId?: string): void {
		for (const pending of [...this.#questions.values()])
			if (!sessionId || pending.question.sessionId === sessionId) pending.settle(null);
	}
	async #ask(
		live: LiveSession,
		question: Omit<DesktopQuestion, "id" | "sessionId">,
		options?: ExtensionUIDialogOptions,
	): Promise<string | boolean | null> {
		if (this.#closed || options?.signal?.aborted) return null;
		if ([...this.#questions.values()].some(item => item.question.sessionId === live.metadata.id))
			throw new Error("Session already has a pending question");
		const deferred = Promise.withResolvers<string | boolean | null>();
		const dto = {
			...question,
			title: this.#redact(question.title).slice(0, 1000),
			message: question.message ? this.#redact(question.message).slice(0, TEXT_LIMIT) : undefined,
			initialValue: question.initialValue ? this.#redact(question.initialValue).slice(0, TEXT_LIMIT) : undefined,
			id: crypto.randomUUID(),
			sessionId: live.metadata.id,
		};
		if (question.options?.some(option => this.#redact(option) !== option))
			throw new Error("Question contains secret option values");
		let timer: Timer | undefined;
		const cancel = () => settle(null);
		const settle = (value: string | boolean | null) => {
			if (!this.#questions.delete(dto.id)) return;
			if (timer) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", cancel);
			deferred.resolve(value);
			this.#publish(live);
		};
		this.#questions.set(dto.id, { question: dto, settle });
		options?.signal?.addEventListener("abort", cancel, { once: true });
		if (options?.timeout !== undefined)
			timer = setTimeout(
				() => {
					settle(null);
					options.onTimeout?.();
				},
				Math.max(0, options.timeout),
			);
		this.#publish(live);
		return deferred.promise;
	}
	#ui(live: LiveSession): ExtensionUIContext {
		const unsupported = (): never => {
			throw new Error("Terminal-only UI is unavailable in desktop");
		};
		const textQuestion = async (
			kind: "input" | "editor",
			title: string,
			initialValue?: string,
			options?: ExtensionUIDialogOptions,
		) => {
			const value = await this.#ask(live, { kind, title, initialValue }, options);
			return typeof value === "string" ? value : undefined;
		};
		return {
			select: async (title, options, dialogOptions) => {
				const value = await this.#ask(live, { kind: "select", title, options }, dialogOptions);
				return typeof value === "string" ? value : undefined;
			},
			confirm: async (title, message, options) =>
				(await this.#ask(live, { kind: "confirm", title, message }, options)) === true,
			input: (title, placeholder, options) => textQuestion("input", title, placeholder, options),
			editor: (title, prefill, options) => textQuestion("editor", title, prefill, options),
			notify: (message, type) => {
				live.notices.push({
					id: crypto.randomUUID(),
					role: "system",
					text: this.#redact(message).slice(0, TEXT_LIMIT),
					isError: type === "error",
				});
				live.notices = live.notices.slice(-20);
				this.#schedule(live);
			},
			onTerminalInput: unsupported,
			setStatus: unsupported,
			setWorkingMessage: unsupported,
			setWidget: unsupported,
			setFooter: unsupported,
			setHeader: unsupported,
			setTitle: unsupported,
			custom: unsupported,
			setEditorText: unsupported,
			pasteToEditor: unsupported,
			getEditorText: unsupported,
			setEditorComponent: unsupported,
			get theme(): never {
				return unsupported();
			},
			getAllThemes: unsupported,
			getTheme: unsupported,
			setTheme: unsupported,
			getToolsExpanded: unsupported,
			setToolsExpanded: unsupported,
		};
	}
	async #exclusive<T>(
		live: LiveSession,
		operation: () => Promise<T>,
		retireGates = false,
		persistSource = true,
		// Only a prompt whose turn failed describes the conversation. No call here is a
		// prompt turn: `retry()` answers false when it declines, and a compaction that
		// fails is a refused maintenance step, so neither may mark the session failed.
		// Each reports through its own request instead.
		recordFailure = false,
	): Promise<T> {
		if (live.busy || live.sdk.isStreaming || live.operator?.isBusy())
			throw new Error("다른 작업이 실행 중입니다. 끝난 뒤 다시 시도하세요.");
		live.busy = true;
		live.gateMutation = retireGates;
		live.error = undefined;
		this.#publish(live);
		try {
			if (retireGates) await live.gatePresenter?.withdrawAll();
			return await operation();
		} catch (error) {
			if (recordFailure) live.error = this.#error(error);
			throw error;
		} finally {
			live.streamingMessage = undefined;
			this.#cancelQuestions(live.metadata.id);
			try {
				if (persistSource) {
					if (this.#live.has(live.metadata.id)) await this.#flushSession(live);
					await this.#save();
				}
			} finally {
				live.gateMutation = false;
				live.busy = false;
				if (this.#live.has(live.metadata.id)) this.#publish(live);
			}
		}
	}
	async handle(request: DesktopRequest): Promise<void> {
		try {
			if (this.#closed && request.method !== "shutdown") throw new Error("Host is closed");
			await this.initialize();
			if (this.#closed && request.method !== "shutdown") throw new Error("Host is closed");
			const task = this.#dispatch(request);
			if (request.method !== "shutdown") this.#tasks.add(task);
			let result: unknown;
			try {
				result = await task;
			} finally {
				this.#tasks.delete(task);
			}
			this.#emit(
				{ type: "response", id: request.id, ok: true, result: result ?? null },
				PROJECTED_CONTROL_METHODS.has(request.method),
			);
		} catch (error) {
			this.#emit({ type: "response", id: request.id, ok: false, error: this.#error(error) });
		}
	}
	async #dispatch(request: DesktopRequest): Promise<unknown> {
		const { method, params } = request;
		const attachmentInput = method === "prompt" ? prepareDesktopAttachmentInput(request) : undefined;
		if (method === "bootstrap") {
			const snapshot = this.snapshot();
			this.#emit({ type: "snapshot", snapshot });
			return snapshot;
		}
		if (method === "shutdown") {
			await this.close();
			return null;
		}
		if (method === "auth.providers")
			return this.#oauth!.providers().map(provider => ({
				...provider,
				configured: this.#auth!.hasAuth(provider.id),
			}));
		if (method === "auth.keyProviders") {
			// Enrollment metadata is not a model selection catalog. Unauthenticated
			// providers belong here, never in snapshot.models or models.list.
			return [
				...new Set([
					...this.#registry!.getAll().map(model => model.provider),
					...this.#registry!.getConfiguredProviderIds(),
				]),
			].sort();
		}
		if (method === "auth.state") return this.#oauth!.state();
		if (method === "auth.login") return this.#oauth!.login(requiredString(params, "provider", 100));
		if (method === "auth.cancel") return this.#oauth!.cancel(identifier(params, "flowId"));
		if (method === "auth.answer") {
			if (typeof params.value !== "string") throw new Error("Invalid authorization answer");
			return this.#oauth!.answer(identifier(params, "flowId"), identifier(params, "promptId"), params.value);
		}
		if (method === "project.open") {
			const resolved = await fs.realpath(requiredString(params, "path"));
			if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Project must be a directory");
			let project = this.#catalog.projects.find(item => item.path === resolved);
			if (!project) {
				project = {
					id: crypto.randomUUID(),
					name: (path.basename(resolved) || resolved).slice(0, 200),
					path: resolved,
				};
				this.#catalog.projects.push(project);
				await this.#save();
			}
			this.#publishSnapshot();
			return project;
		}
		if (method === "session.create") {
			const projectId = identifier(params, "projectId");
			if (!this.#catalog.projects.some(item => item.id === projectId)) throw new Error("Project not found");
			const metadata: SavedSession = { id: crypto.randomUUID(), projectId, title: "New session", starred: false };
			this.#catalog.sessions.push(metadata);
			try {
				await this.#open(metadata);
			} catch (error) {
				this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
				await this.#save();
				throw error;
			}
			this.#publishSnapshot();
			return this.#dto(metadata);
		}
		if (method === "gate.presented" || method === "gate.retired") {
			// UI acknowledgements must never wait for session opening or its active turn.
			const metadata = this.#metadata(params);
			const presenter = this.#live.get(metadata.id)?.gatePresenter;
			if (!presenter) throw new Error("No owned gate presenter for this session");
			const id = requiredString(params, "presentationId", 128);
			if (method === "gate.presented") presenter.acknowledgePresented(id);
			else presenter.acknowledgeRetired(id, requiredString(params, "nonce", 128));
			return null;
		}
		if (method === "question.answer") {
			const pending = this.#questions.get(identifier(params, "questionId"));
			if (!pending) throw new Error("Question not found or already answered");
			pending.settle(validateQuestionAnswer(pending.question, params));
			return null;
		}
		if (method === "auth.setKey") {
			if (this.#oauth!.isActive())
				throw new Error("Wait for account authorization to finish before saving an API key");
			const provider = requiredString(params, "provider", 100);
			const key = requiredString(params, "key", 16_384);
			this.#secrets.add(key);
			if (!this.#registry?.isKnownProvider(provider)) throw new Error("Unknown provider");
			await this.#auth!.set(provider, { type: "api_key", key });
			const catalogRefreshed = await this.#refreshModelCatalogs([
				{ registry: this.#registry },
				...[...this.#live.values()].map(live => ({
					registry: live.sdk.modelRegistry,
					credentialSessionId: live.sdk.credentialSessionId,
				})),
			]);
			this.#publishSnapshot();
			return { provider, saved: true, catalogRefreshed };
		}
		if (method === "settings.get") {
			const settings = params.sessionId ? (await this.#open(this.#metadata(params))).settings : this.#settings!;
			return desktopSettings(settings);
		}
		if (method === "settings.set") {
			const settingPath = validateDesktopSetting(params.path, params.value);
			if (params.sessionId) await this.#open(this.#metadata(params));
			// Settings are application-wide; refuse to change them under an active run.
			const targets = [...this.#live.values()];
			if (targets.some(live => live.busy || live.sdk.isStreaming)) throw new Error("Session busy");
			for (const live of targets) {
				if (settingPath === "compaction.enabled" && typeof params.value === "boolean")
					live.sdk.setAutoCompactionEnabled(params.value);
				if (settingPath === "retry.enabled" && typeof params.value === "boolean")
					live.sdk.setAutoRetryEnabled(params.value);
				live.settings.set(settingPath, params.value as never);
				await live.settings.flushOrThrow();
			}
			this.#settings!.set(settingPath, params.value as never);
			await this.#settings!.flushOrThrow();
			this.#publishSnapshot();
			return null;
		}
		if (method === "command.list")
			return [
				...ACP_BUILTIN_SLASH_COMMANDS.filter(command => !DESKTOP_OWNED_COMMANDS.has(command.name)).map(
					command =>
						({
							name: command.name,
							description: command.description,
							...(command.input?.hint ? { hint: command.input.hint } : {}),
						}) satisfies DesktopCommand,
				),
				{ name: "btw", description: "기존 대화와 분리된 텍스트 전용 별도 대화", hint: "<question>" },
			];
		if (method === "command.run") return this.#command(this.#metadata(params), requiredString(params, "text"));
		if (method === "history.get") {
			const live = await this.#open(this.#metadata(params));
			const offset = params.offset === undefined ? 0 : params.offset;
			const limit = params.limit === undefined ? HISTORY_PAGE_LIMIT : params.limit;
			if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
				throw new Error("Invalid history offset");
			if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_LIMIT)
				throw new Error("Invalid history limit");
			const { total, page, truncated } = projectHistoryPage(live.sdk.messages, offset, limit);
			return {
				sessionId: live.metadata.id,
				total,
				offset,
				messages: page.map(message => ({ ...message, text: this.#redact(message.text) })),
				truncated,
			} satisfies DesktopHistory;
		}
		const sessionMethods = [
			"session.select",
			"session.rename",
			"session.delete",
			"session.star",
			"session.fork",
			"session.compact",
			"session.retry",
			"session.export",
			"prompt",
			"abort",
			"activity.get",
			"activity.detail",
			"activity.operate",
			"activity.acknowledge",
			"preferences.get",
			"preferences.apply",
			"gate.present",
			"gate.answer",
			"gate.withdraw",
			"models.list",
			"operator.execute",
			"operator.get",
			"operator.abort",
			"operator.fold",
			"btw.open",
			"btw.get",
			"btw.submit",
			"btw.cancel",
			"btw.close",
			"mcp.get",
			"mcp.operate",
			"session.info",
			"model.set",
			"thinking.set",
			"diff.get",
			"tools.list",
			"tools.set",
			"goal.operate",
			"queue.cancel",
		];
		if (!sessionMethods.includes(method)) throw new Error("Unknown method");
		const metadata = this.#metadata(params);
		const live = await this.#open(metadata);
		if (method === "session.select") {
			this.#publish(live);
			return this.#dto(metadata);
		}
		if (method === "abort") {
			if (live.operator?.isBusy()) {
				if (!live.operatorCurrentId)
					throw new Error("이전 명령의 정산을 기다리고 있습니다. 현재 대화에서 중지를 증명할 수 없습니다.");
				live.operator.abort({ operationId: live.operatorCurrentId });
				this.#publish(live);
				return null;
			}
			this.#cancelQuestions(metadata.id);
			for (const tracked of live.queued.values()) tracked.submission.cancel();
			await live.sdk.abort();
			this.#publish(live);
			return null;
		}
		if (method.startsWith("btw.")) {
			this.#refreshSessionServices(live);
			const controller = live.btw;
			if (!controller) throw new Error("이 대화의 별도 대화 제어기가 연결되지 않았습니다.");
			const { sessionId: _sessionId, sessionGeneration, ...input } = params;
			if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration !== live.sdk.sessionLifecycle.generation)
				throw new Error("세션이 변경되었습니다. 별도 대화를 다시 여세요.");
			if ((method === "btw.open" || method === "btw.submit") && live.gateMutation)
				throw new Error("세션 변경이 끝난 뒤 별도 대화를 다시 여세요.");
			switch (method) {
				case "btw.get":
					if (Object.keys(input).length) throw new Error("Invalid side-chat read parameters");
					return controller.get();
				case "btw.open":
					return controller.open(input);
				case "btw.submit":
					return controller.submit(input);
				case "btw.cancel":
					return controller.cancel(input);
				case "btw.close":
					controller.close(input);
					return null;
			}
		}
		if (method.startsWith("operator.")) {
			const operator = live.operator;
			if (!operator) throw new Error("이 대화의 명령 실행 제어기가 연결되지 않았습니다.");
			const allowed =
				method === "operator.execute"
					? ["sessionId", "text"]
					: method === "operator.fold"
						? ["sessionId"]
						: ["sessionId", "operationId"];
			if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Invalid operator parameters");
			if (method === "operator.get")
				return operator.getOperation({ operationId: requiredString(params, "operationId", 128) });
			if (method === "operator.abort")
				return operator.abort({ operationId: requiredString(params, "operationId", 128) });
			if (method === "operator.fold") return operator.fold({});
			if (method === "operator.execute")
				return this.#exclusive(live, async () => {
					const text = requiredString(params, "text", 65_536);
					await live.sdk.sessionManager.ensureOnDisk();
					return operator.execute({ text });
				});
		}
		if (method === "activity.get") return this.#activityUpdate(live);
		if (method === "activity.detail") return live.activity.getDetail(readActivityRef(params.ref));
		if (method === "activity.operate") {
			live.activity.operate(readActivityRef(params.ref), readActivityOperation(params.operation));
			return this.#activityUpdate(live, true);
		}
		if (method === "activity.acknowledge") {
			live.activity.acknowledgeFailures(readActivityScope(params.scope));
			return this.#activityUpdate(live, true);
		}
		if (method === "session.info" || method === "mcp.get") {
			if (Object.keys(params).some(key => key !== "sessionId")) throw new Error("Invalid session read parameters");
			return method === "session.info"
				? readDesktopSessionInfo(live.sdk, { catalogSessionId: metadata.id, redact: text => this.#redact(text) })
				: live.mcp.getSnapshot();
		}
		if (method === "mcp.operate") {
			if (Object.keys(params).some(key => !["sessionId", "ref", "action"].includes(key)))
				throw new Error("Invalid MCP parameters");
			return this.#exclusive(live, () => live.mcp.operate(params.ref, params.action));
		}
		if (method === "preferences.get") return live.preferences.read();
		if (method === "preferences.apply") return this.#exclusive(live, () => live.preferences.apply(params.action));
		if (method === "gate.present" || method === "gate.answer" || method === "gate.withdraw") {
			const presenter = live.gatePresenter;
			if (!presenter) throw new Error(live.gateUnavailable ?? "No owned gate presenter for this session");
			if (method === "gate.present") {
				if (live.gateMutation)
					throw new Error("세션 변경 전에 기존 승인 화면을 닫고 있습니다. 변경 완료 후 다시 여세요.");
				return presenter.present(readActivityRef(params.ref));
			}
			const id = requiredString(params, "presentationId", 128);
			if (method === "gate.withdraw") {
				await presenter.withdraw(id);
				return null;
			}
			const result = await presenter.answer(id, readGateAnswer(params.answer));
			this.#activityUpdate(live, true);
			this.#publish(live);
			return result;
		}
		if (method === "models.list") {
			if (params.refresh !== undefined && typeof params.refresh !== "boolean")
				throw new Error("Invalid model catalog refresh");
			const generation = live.sdk.sessionLifecycle.generation;
			const sessionId = live.sdk.sessionId;
			const manager = live.sdk.sessionManager;
			if (params.refresh)
				await this.#refreshModelCatalogs([
					{ registry: live.sdk.modelRegistry, credentialSessionId: live.sdk.credentialSessionId },
				]);
			const lifecycle = live.sdk.sessionLifecycle;
			if (
				this.#closed ||
				this.#live.get(metadata.id) !== live ||
				lifecycle.disposed ||
				lifecycle.transitioning ||
				lifecycle.generation !== generation ||
				live.sdk.sessionId !== sessionId ||
				live.sdk.sessionManager !== manager
			)
				throw new Error("Session changed while refreshing model catalog");
			this.#assertModelCatalogReady(live.sdk.modelRegistry);
			return live.sdk.modelRegistry.getAvailable(live.sdk.credentialSessionId).map(projectDesktopModel);
		}
		if (method === "tools.list")
			return { available: live.sdk.getAllToolNames(), active: live.sdk.getActiveToolNames() };
		if (method === "diff.get") return this.#diff(metadata.projectId);
		if (method === "prompt") {
			if (!attachmentInput) throw new Error("Prompt attachment envelope was not validated");
			const { text, images } = attachmentInput;
			if (live.gateMutation) throw new Error("세션 변경이 끝난 뒤 메시지를 보내세요.");
			if (live.operator?.isBusy()) throw new Error("명령 실행이 끝난 뒤 메시지를 보내세요.");
			if (live.busy || live.sdk.isStreaming) {
				// TUI parity: an active run accepts steering or a follow-up instead of rejecting input.
				const deliverAs = params.deliverAs === "followUp" ? "followUp" : "steer";
				const submission = images.length
					? await createSessionImageInput(live.sdk).submitUserMessage(text, images, { deliverAs })
					: await live.sdk.submitUserMessage(text, { deliverAs, trackSubmission: true });
				const dto: DesktopQueuedInput = {
					id: submission.submissionId,
					text: this.#redact(text).slice(0, TEXT_LIMIT),
					deliverAs,
					cancelable: true,
				};
				live.queued.set(dto.id, { dto, submission });
				const settle = (execution?: DesktopQueuedInput["execution"]) => {
					const tracked = live.queued.get(dto.id);
					if (!tracked) return;
					if (execution) tracked.dto.execution = execution;
					// A resolved execution means the SDK already owns the input.
					tracked.dto.cancelable = false;
					this.#publish(live);
				};
				void submission.execution.then(
					outcome => settle(outcome.disposition),
					() => settle("removed"),
				);
				void submission.terminal.then(
					outcome => {
						live.queued.delete(dto.id);
						void outcome;
						this.#publish(live);
					},
					() => {
						live.queued.delete(dto.id);
						this.#publish(live);
					},
				);
				this.#publish(live);
				return { queued: true, submissionId: submission.submissionId };
			}
			return this.#exclusive(
				live,
				async () => {
					if (images.length) await createSessionImageInput(live.sdk).prompt(text, images);
					else await live.sdk.prompt(text);
					return null;
				},
				false,
				true,
				true,
			);
		}
		if (method === "queue.cancel") {
			const id = requiredString(params, "queueId", 200);
			const tracked = live.queued.get(id);
			if (!tracked) throw new Error("Queued input not found");
			const removed = tracked.submission.cancel();
			// Either way this queue id is settled: keeping it would leave a cancelable
			// chip whose delivery already happened.
			live.queued.delete(id);
			this.#publish(live);
			return { removed };
		}
		return this.#exclusive(
			live,
			async () => {
				switch (method) {
					case "session.rename": {
						const title = requiredString(params, "title", 200).trim();
						await live.sdk.setSessionName(title, "user");
						metadata.title = title;
						this.#publishSnapshot();
						return null;
					}
					case "session.star":
						if (typeof params.starred !== "boolean") throw new Error("Invalid starred");
						metadata.starred = params.starred;
						this.#publishSnapshot();
						return null;
					case "session.delete": {
						this.#cancelQuestions(metadata.id);
						live.queued.clear();
						await this.#disposeLive(live);
						this.#live.delete(metadata.id);
						const index = this.#catalog.sessions.indexOf(metadata);
						this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
						try {
							await this.#save();
						} catch (error) {
							// Persistence is uncertain: keep the transcript and a recoverable catalog entry.
							this.#catalog.sessions.splice(index, 0, metadata);
							throw error;
						}
						// Removal is committed. Artifact cleanup failure must not resurrect this entry.
						if (metadata.file) {
							const file = this.#sessionPath(metadata.file);
							await new FileSessionStorage().deleteSessionWithArtifacts(file);
						}
						this.#publishSnapshot();
						return null;
					}
					case "session.fork":
						return this.#fork(live, params);
					case "session.compact":
						await live.sdk.compact();
						return null;
					case "session.retry":
						if (!(await live.sdk.retry())) throw new Error("Session cannot be retried");
						return null;
					case "session.export": {
						const directory = path.join(this.dataDir, "exports");
						await fs.mkdir(directory, { recursive: true, mode: 0o700 });
						return {
							path: await live.sdk.exportToHtml(
								path.join(directory, `${metadata.id}-${crypto.randomUUID()}.html`),
							),
						};
					}
					case "model.set": {
						this.#assertModelCatalogReady(live.sdk.modelRegistry);
						const modelId = requiredString(params, "modelId", 500);
						const model = live.sdk.modelRegistry
							.getAvailable(live.sdk.credentialSessionId)
							.find(model => `${model.provider}/${model.id}` === modelId);
						if (!model)
							throw new Error("등록된 제공자에서 사용할 수 없는 모델입니다. 제공자 등록과 인증을 확인하세요.");
						const level =
							params.thinkingLevel === undefined
								? undefined
								: validateModelThinking(model, params.thinkingLevel);
						// The public selection transaction owns persistence, profile materialization,
						// session identity and CAS rollback; the legacy setter mutates before commit.
						await live.sdk.setDefaultModelSelection(model, level);
						return null;
					}
					case "thinking.set": {
						this.#assertModelCatalogReady(live.sdk.modelRegistry);
						const level = validateSessionThinking(live.sdk, params.level);
						await live.sdk.setThinkingLevelForControl(level, false);
						return null;
					}
					case "tools.set": {
						const names = params.names;
						if (
							!Array.isArray(names) ||
							names.some(name => typeof name !== "string" || !live.sdk.getAllToolNames().includes(name))
						)
							throw new Error("Invalid tool names");
						await live.sdk.setActiveToolsByName(names as string[], { explicit: true });
						return null;
					}
					case "goal.operate": {
						const op = requiredString(params, "op", 20);
						if (
							op !== "create" &&
							op !== "get" &&
							op !== "resume" &&
							op !== "pause" &&
							op !== "complete" &&
							op !== "drop"
						)
							throw new Error("Invalid goal operation");
						return live.sdk.operateGoal(op, op === "create" ? requiredString(params, "objective") : undefined);
					}
					default:
						throw new Error("Unknown method");
				}
			},
			method === "session.delete" || method === "session.fork",
			method !== "session.fork" && method !== "session.delete",
		);
	}
	/** Mirror the session's own title into the desktop catalog after a command changed it. */
	async #syncTitle(live: LiveSession): Promise<void> {
		const title = live.sdk.sessionManager.getSessionName?.();
		if (!title || title === live.metadata.title) {
			this.#publishSnapshot();
			return;
		}
		live.metadata.title = title.slice(0, 200);
		await this.#save().catch(() => {});
		this.#publishSnapshot();
		this.#publish(live);
	}
	/**
	 * Run one builtin slash command through the public SDK dispatcher so the app
	 * executes exactly the same handlers as text/ACP mode. Commands that only
	 * exist as TUI modals are not advertised and cannot reach this path.
	 */
	async #command(metadata: SavedSession, text: string): Promise<DesktopCommandResult> {
		const live = await this.#open(metadata);
		const name = text.trimStart().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase() ?? "";
		if (/^\s*\/btw(?:\s|$)/i.test(text)) {
			const question = text
				.trimStart()
				.replace(/^\/btw(?:\s+|$)/i, "")
				.trim();
			if (!question)
				return { consumed: false, refused: true, output: "별도 대화 메뉴를 열거나 /btw <질문>을 입력하세요." };
			this.#refreshSessionServices(live);
			if (live.gateMutation || !live.btw) throw new Error("세션 변경이 끝난 뒤 별도 대화를 다시 여세요.");
			live.btw.open({ question });
			return { consumed: true, output: "별도 대화 요청을 접수했습니다. 기존 대화 기록에는 추가하지 않습니다." };
		}
		if (DESKTOP_OWNED_COMMANDS.has(name))
			return { consumed: false, refused: true, output: DESKTOP_OWNED_REFUSALS[name] ?? DESKTOP_UNAVAILABLE };
		if (text.trimStart().startsWith("/") && !ADVERTISED_COMMANDS.has(name))
			// TUI-only or unknown names never reach the dispatcher: its own notice
			// would report success and an unknown name would spend a provider turn.
			return { consumed: false, refused: true, output: DESKTOP_UNAVAILABLE };
		// Commands mutate the same session as prompts, so they take the same lock.
		return this.#exclusive(live, () => this.#runCommand(live, text), true);
	}
	async #runCommand(live: LiveSession, text: string): Promise<DesktopCommandResult> {
		const chunks: string[] = [];
		let written = 0;
		let dropped = false;
		const append = (value: string) => {
			if (written >= COMMAND_OUTPUT_LIMIT) return;
			const redacted = this.#redact(value);
			const bounded = redacted.slice(0, COMMAND_OUTPUT_LIMIT - written);
			chunks.push(bounded);
			written += bounded.length;
			if (bounded.length < redacted.length) dropped = true;
		};
		const runtime: SlashCommandRuntime = {
			session: live.sdk,
			sessionManager: live.sdk.sessionManager,
			settings: live.settings,
			cwd: live.sdk.sessionManager.getCwd(),
			output: value => append(String(value)),
			refreshCommands: () => this.#publishSnapshot(),
			reloadPlugins: async () => {
				// Mirror the TUI runtime so /move leaves the session in a consistent state.
				const projectPath = await resolveActiveProjectRegistryPath(live.sdk.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await live.sdk.reloadSkills();
				this.#publishSnapshot();
			},
			notifyTitleChanged: () => this.#syncTitle(live),
			notifyConfigChanged: () => this.#publishSnapshot(),
		};
		try {
			const result = await executeAcpBuiltinSlashCommand(text, runtime);
			let forwarded: string | undefined;
			let consumed = false;
			if (result === false) {
				if (text.trimStart().startsWith("/")) {
					// A slash-prefixed name no builtin can drive is a TUI-only or unknown
					// command; refuse instead of silently sending it to the model.
					return {
						consumed: false,
						refused: true,
						output: "이 명령은 데스크톱 앱에서 사용할 수 없습니다. 일반 메시지는 슬래시 없이 보내세요.",
					};
				} else {
					// Plain text: forward as a prompt, matching ACP mode.
					forwarded = text;
				}
			} else if ("prompt" in result) {
				forwarded = result.prompt;
				consumed = true;
			} else {
				consumed = true;
			}
			await this.#syncTitle(live);
			if (forwarded !== undefined) {
				// A builtin that returns a prompt starts a real turn, so its failure is the
				// conversation's failure even though command.run itself is administrative.
				try {
					await live.sdk.prompt(forwarded);
				} catch (error) {
					live.error = this.#error(error);
					throw error;
				}
			}
			return {
				consumed,
				output: chunks.join("\n").trim(),
				...(forwarded !== undefined ? { prompt: forwarded } : {}),
				...(dropped ? { outputTruncated: true } : {}),
			};
		} finally {
			// A command may have stored credentials; keep redaction current even when
			// the command itself failed.
			this.#rememberCredentials();
		}
	}
	async #diff(projectId: string): Promise<DesktopDiff[]> {
		const project = this.#catalog.projects.find(item => item.id === projectId)!;
		const git = async (args: string[], acceptedCodes = [0]): Promise<string> => {
			const process = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", "-C", project.path, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...globalThis.process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: os.devNull,
				},
			});
			const timer = setTimeout(() => process.kill(), 10_000);
			const bounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
				const reader = stream.getReader();
				const decoder = new TextDecoder();
				let output = "";
				let bytes = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 4_000_000) {
							process.kill();
							throw new Error("Git output exceeds desktop limit");
						}
						output += decoder.decode(chunk.value, { stream: true });
					}
					return output + decoder.decode();
				} finally {
					reader.releaseLock();
				}
			};
			try {
				const [output, , code] = await Promise.all([
					bounded(process.stdout),
					bounded(process.stderr),
					process.exited,
				]);
				if (!acceptedCodes.includes(code))
					throw new Error("Git inspection failed (project may not be a repository)");
				return output;
			} finally {
				clearTimeout(timer);
			}
		};
		const entries = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
		const diffs: DesktopDiff[] = [];
		for (let index = 0; index < entries.length && diffs.length < 100; index++) {
			const entry = entries[index];
			if (!entry) continue;
			const status = entry.slice(0, 2);
			const filename = entry.slice(3);
			if (status.includes("R") || status.includes("C")) index++;
			const patch =
				status === "??"
					? await git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", os.devNull, filename], [0, 1])
					: [
							await git(["diff", "--no-ext-diff", "--no-textconv", "--", filename]),
							await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", filename]),
						].join("\n");
			diffs.push({
				path: filename,
				status,
				patch:
					this.#redact(patch).slice(0, 32_000) +
					(patch.length > 32_000 ? "\n[Diff truncated at 32,000 characters]" : ""),
			});
		}
		return diffs;
	}
	close(): Promise<void> {
		this.#closing ??= this.#close();
		return this.#closing;
	}
	async #close(): Promise<void> {
		this.#closed = true;
		if (this.#init) await this.#init.catch(() => {});
		const authorizationClose = this.#oauth?.close();
		// Attach a handler immediately while unrelated session cleanup drains.
		void authorizationClose?.catch(() => {});
		this.#cancelQuestions();
		await Promise.allSettled([...this.#opening.values()]);
		this.#cancelQuestions();
		await Promise.allSettled([...this.#live.values()].map(live => live.sdk.abort()));
		await Promise.allSettled([...this.#tasks]);
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		await Promise.all(
			[...new Set([...this.#live.values(), ...this.#retiredLive])].map(async live => {
				await attempt(() => this.#disposeLive(live));
			}),
		);
		this.#live.clear();
		await Promise.all([...this.#candidates].map(candidate => attempt(() => this.#disposeCandidate(candidate))));
		// Shutdown joins real retained teardown, including timed-out and rolled-back publications.
		await Promise.all([...this.#cleanupOwners.values()].map(completion => attempt(() => completion)));
		await attempt(() => this.#saving);
		let authorizationJoined = false;
		await attempt(async () => {
			await authorizationClose;
			authorizationJoined = true;
		});
		const sessionsReleased =
			this.#cleanupOwners.size === 0 && this.#candidates.size === 0 && this.#retiredLive.size === 0;
		if (sessionsReleased) {
			await attempt(() => this.#registry?.dispose());
			await attempt(() => this.#settings?.close());
		}
		// Failed or incomplete session teardown may still own these shared dependencies.
		if (authorizationJoined && sessionsReleased) await attempt(() => this.#auth?.close());
		if (failures.length) throw new Error("Desktop shutdown failed to clean up all SDK resources");
	}
}
