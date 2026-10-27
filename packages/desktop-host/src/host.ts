import * as crypto from "node:crypto";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@gajae-code/coding-agent/config/settings-schema";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@gajae-code/coding-agent/extensibility/extensions";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { setAgentDir } from "@gajae-code/utils";
import type {
	DesktopCapability,
	DesktopDiff,
	DesktopFrame,
	DesktopMessage,
	DesktopProject,
	DesktopQuestion,
	DesktopRequest,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

const HISTORY_LIMIT = 160;
const TEXT_LIMIT = 8_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SETTING_PATHS = ["compaction.enabled", "retry.enabled"] as const;

export const CAPABILITIES: DesktopCapability[] = [
	{ id: "sessions", label: "Independent SDK sessions and streaming", available: true },
	{ id: "questions", label: "Select, confirm, input and editor questions", available: true },
	{ id: "settings", label: "Auto-compaction and retry settings", available: true },
	{
		id: "terminal-ui",
		label: "Terminal components and interactive terminal",
		available: false,
		reason: "Terminal-only SDK UI cannot be rendered by the desktop protocol.",
	},
	{
		id: "upstream-7322",
		label: "Full upstream settings, approvals and runtime parity",
		available: false,
		reason: "Requires upstream #7322 public SDK support; private controllers and endpoints are not used.",
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
		label: "OAuth account login",
		available: false,
		reason: "This host supports explicit API keys only; no desktop OAuth lifecycle is implemented.",
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

export function desktopDataDir(): string {
	return path.resolve(
		process.env.GJC_DESKTOP_DATA_DIR ||
			path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
	);
}

/** Only visible text is projected: thinking, arguments, images, headers and credentials are never serialized. */
export function projectMessages(messages: readonly unknown[]): DesktopMessage[] {
	return messages.slice(-HISTORY_LIMIT).flatMap((value, index) => {
		const message = record(value);
		if (!message || !["user", "assistant", "toolResult"].includes(String(message.role))) return [];
		const role = message.role === "toolResult" ? "tool" : (message.role as "user" | "assistant");
		const text =
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
		return [
			{
				id: `${index}:${String(message.timestamp ?? "")}`,
				role,
				text: text.slice(-TEXT_LIMIT),
				...(text.length > TEXT_LIMIT ? { truncated: true } : {}),
				...(typeof message.toolName === "string" ? { toolName: message.toolName.slice(0, 100) } : {}),
				...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
			},
		];
	});
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
interface LiveSession {
	sdk: AgentSession;
	metadata: SavedSession;
	busy: boolean;
	error?: string;
	timer?: Timer;
	unsubscribe: () => void;
	settings: Settings;
	notices: DesktopMessage[];
	streamingMessage?: unknown;
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
		return path.join(this.#dataDir, "agent");
	}
	#emit: (frame: DesktopFrame) => void;
	#createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	#catalog: Catalog = { version: 1, projects: [], sessions: [] };
	#live = new Map<string, LiveSession>();
	#opening = new Map<string, Promise<LiveSession>>();
	#questions = new Map<string, PendingQuestion>();
	#auth?: AuthStorage;
	#registry?: ModelRegistry;
	#settings?: Settings;
	#init?: Promise<void>;
	#saving: Promise<void> = Promise.resolve();
	#closed = false;
	#closing?: Promise<void>;
	#tasks = new Set<Promise<unknown>>();
	#secrets = new Set<string>();

	constructor(options: HostOptions) {
		this.#dataDir = path.resolve(options.dataDir ?? desktopDataDir());
		this.#emit = frame => {
			// Redact host-owned credentials even when a provider echoes one in visible text.
			const serialized = JSON.stringify(frame, (key, value: unknown) =>
				typeof value === "string" &&
				!["id", "sessionId", "projectId", "type", "status", "kind", "role", "provider"].includes(key)
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
		await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 });
		this.#dataDir = await fs.realpath(this.#dataDir);
		await fs.chmod(this.dataDir, 0o700);
		// The entrypoint's environment module isolates import-time discovery first.
		process.env.HOME = path.join(this.dataDir, "home");
		process.env.USERPROFILE = process.env.HOME;
		process.env.GJC_CODING_AGENT_DIR = this.agentDir;
		process.env.PI_CODING_AGENT_DIR = this.agentDir;
		process.env.GJC_CONFIG_DIR = ".gjc-desktop";
		process.env.PI_CONFIG_DIR = ".gjc-desktop";
		process.env.XDG_CONFIG_HOME = path.join(this.dataDir, "config");
		process.env.XDG_DATA_HOME = path.join(this.dataDir, "data");
		process.env.XDG_STATE_HOME = path.join(this.dataDir, "state");
		process.env.XDG_CACHE_HOME = path.join(this.dataDir, "cache");
		process.env.GJC_LOG_DIR = path.join(this.dataDir, "logs");
		for (const key of Object.keys(process.env)) {
			if (
				/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY|AUTH_BROKER|GOOGLE_APPLICATION_CREDENTIALS|AWS_PROFILE|AWS_SHARED_CREDENTIALS_FILE)/i.test(
					key,
				)
			)
				delete process.env[key];
		}
		await fs.mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
		setAgentDir(this.agentDir);
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
		for (const entries of Object.values(this.#auth.getAll())) {
			for (const credential of Array.isArray(entries) ? entries : [entries]) {
				if (credential.type === "api_key" && credential.key) this.#secrets.add(credential.key);
			}
		}
		this.#registry = new ModelRegistry(this.#auth, path.join(this.agentDir, "models.yml"), this.#settings, {
			agentDir: this.agentDir,
		});
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
		return {
			id: metadata.id,
			projectId: metadata.projectId,
			title: metadata.title,
			starred: metadata.starred,
			status: question ? "waiting" : live?.busy ? "running" : live?.error ? "error" : "idle",
			...(live?.sdk.model ? { model: `${live.sdk.model.provider}/${live.sdk.model.id}` } : {}),
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
			...(live?.error ? { error: live.error } : {}),
		};
	}
	snapshot(): DesktopSnapshot {
		return {
			protocolVersion: PROTOCOL_VERSION,
			projects: this.#catalog.projects.map(project => ({ ...project })),
			sessions: this.#catalog.sessions.map(session => {
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
			models:
				this.#registry
					?.getAll()
					.map(model => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider })) ??
				[],
			capabilities: CAPABILITIES.map(capability => ({ ...capability })),
		};
	}
	#publishSnapshot(): void {
		this.#emit({ type: "snapshot", snapshot: this.snapshot() });
	}
	#publish(live: LiveSession): void {
		if (live.timer) clearTimeout(live.timer);
		live.timer = undefined;
		this.#emit({ type: "session", session: this.#dto(live.metadata) });
	}
	#schedule(live: LiveSession): void {
		live.timer ??= setTimeout(() => this.#publish(live), 75);
	}
	#metadata(params: Record<string, unknown>): SavedSession {
		const id = identifier(params, "sessionId");
		const metadata = this.#catalog.sessions.find(session => session.id === id);
		if (!metadata) throw new Error("Session not found");
		return metadata;
	}
	async #open(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
		const existing = this.#live.get(metadata.id);
		if (existing) return existing;
		const pending = this.#opening.get(metadata.id);
		if (pending) return pending;
		const promise = this.#load(metadata, manager);
		this.#opening.set(metadata.id, promise);
		try {
			return await promise;
		} finally {
			this.#opening.delete(metadata.id);
		}
	}
	async #load(metadata: SavedSession, manager?: SessionManager): Promise<LiveSession> {
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
		const settings = await Settings.loadForScope({ cwd: this.dataDir, agentDir: this.agentDir });
		try {
			const result = await this.#createSession({
				cwd: project.path,
				agentDir: this.agentDir,
				profileAuthority: "custom",
				authStorage: this.#auth,
				modelRegistry: this.#registry,
				settings,
				sessionManager,
				hasUI: true,
				notificationHostModeSupported: false,
				sdkHostModeSupported: false,
				disableExtensionDiscovery: true,
			});
			const live: LiveSession = {
				sdk: result.session,
				metadata,
				settings,
				busy: false,
				unsubscribe: () => {},
				notices: [],
			};
			this.#live.set(metadata.id, live);
			result.setToolUIContext(this.#ui(live), true);
			live.unsubscribe = result.session.subscribe(event => {
				if (event.type === "message_update") live.streamingMessage = event.message;
				if (event.type === "message_end" || event.type === "agent_end") live.streamingMessage = undefined;
				this.#schedule(live);
			});
			// The SDK reserves a path before it writes a transcript. Use its public
			// persistence API so even an empty desktop session can be resumed.
			if (!existingFile) await result.session.setSessionName(metadata.title, "user");
			await sessionManager.ensureOnDisk();
			await this.#flushSession(live);
			await this.#save();
			return live;
		} catch (error) {
			const failed = this.#live.get(metadata.id);
			if (failed) {
				this.#cancelQuestions(metadata.id);
				failed.unsubscribe();
				if (failed.timer) clearTimeout(failed.timer);
				this.#live.delete(metadata.id);
				await failed.sdk.dispose();
			}
			await settings.close();
			throw error;
		}
	}
	async #flushSession(live: LiveSession): Promise<void> {
		await live.sdk.sessionManager.flush();
		const file = live.sdk.sessionManager.getSessionFile();
		if (!file) {
			if (live.metadata.file) throw new Error("Persisted session file unavailable");
			return;
		}
		let stat: nodeFs.Stats;
		try {
			stat = await fs.stat(file);
		} catch (error) {
			if (record(error)?.code === "ENOENT" && !live.metadata.file) return;
			throw error;
		}
		if (!stat.isFile()) throw new Error("Invalid persisted session file");
		const relative = path.relative(path.join(this.dataDir, "sessions"), file);
		this.#sessionPath(relative);
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
	async #exclusive<T>(live: LiveSession, operation: () => Promise<T>): Promise<T> {
		if (live.busy || live.sdk.isStreaming) throw new Error("Session busy");
		live.busy = true;
		live.error = undefined;
		this.#publish(live);
		try {
			return await operation();
		} catch (error) {
			live.error = this.#error(error);
			throw error;
		} finally {
			live.streamingMessage = undefined;
			this.#cancelQuestions(live.metadata.id);
			try {
				if (this.#live.has(live.metadata.id)) await this.#flushSession(live);
				await this.#save();
			} finally {
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
			this.#emit({ type: "response", id: request.id, ok: true, result: result ?? null });
		} catch (error) {
			this.#emit({ type: "response", id: request.id, ok: false, error: this.#error(error) });
		}
	}
	async #dispatch({ method, params }: DesktopRequest): Promise<unknown> {
		if (method === "bootstrap") {
			const snapshot = this.snapshot();
			this.#emit({ type: "snapshot", snapshot });
			return snapshot;
		}
		if (method === "shutdown") {
			await this.close();
			return null;
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
		if (method === "question.answer") {
			const pending = this.#questions.get(identifier(params, "questionId"));
			if (!pending) throw new Error("Question not found or already answered");
			pending.settle(validateQuestionAnswer(pending.question, params));
			return null;
		}
		if (method === "auth.setKey") {
			const provider = requiredString(params, "provider", 100);
			const key = requiredString(params, "key", 16_384);
			this.#secrets.add(key);
			if (!this.#registry?.getAll().some(model => model.provider === provider)) throw new Error("Unknown provider");
			await this.#auth!.set(provider, { type: "api_key", key });
			this.#publishSnapshot();
			return { provider, saved: true };
		}
		if (method === "settings.get") {
			const settings = params.sessionId ? (await this.#open(this.#metadata(params))).settings : this.#settings!;
			return SETTING_PATHS.map(
				settingPath =>
					({
						path: settingPath,
						value: settings.get(settingPath),
						type: SETTINGS_SCHEMA[settingPath].type,
						description: "Application-wide; applies to all live desktop sessions.",
						writable: true,
					}) satisfies DesktopSetting,
			);
		}
		if (method === "settings.set") {
			const settingPath = requiredString(params, "path", 100);
			if (settingPath !== "compaction.enabled" && settingPath !== "retry.enabled")
				throw new Error(
					"Setting unavailable: desktop supports only public live auto-compaction and retry controls; broader settings parity requires #7322",
				);
			if (typeof params.value !== "boolean") throw new Error("Setting requires boolean value");
			if (params.sessionId) await this.#open(this.#metadata(params));
			// These SDK setters persist application settings, so update every live scope.
			const targets = [...this.#live.values()];
			if (targets.some(live => live.busy || live.sdk.isStreaming)) throw new Error("Session busy");
			for (const live of targets) {
				if (settingPath === "compaction.enabled") live.sdk.setAutoCompactionEnabled(params.value);
				else live.sdk.setAutoRetryEnabled(params.value);
				await live.settings.flushOrThrow();
			}
			this.#settings!.set(settingPath, params.value);
			await this.#settings!.flushOrThrow();
			return null;
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
			"model.set",
			"diff.get",
			"tools.list",
			"tools.set",
			"goal.operate",
		];
		if (!sessionMethods.includes(method)) throw new Error("Unknown method");
		const metadata = this.#metadata(params);
		const live = await this.#open(metadata);
		if (method === "session.select") {
			this.#publish(live);
			return this.#dto(metadata);
		}
		if (method === "abort") {
			this.#cancelQuestions(metadata.id);
			await live.sdk.abort();
			this.#publish(live);
			return null;
		}
		if (method === "tools.list")
			return { available: live.sdk.getAllToolNames(), active: live.sdk.getActiveToolNames() };
		if (method === "diff.get") return this.#diff(metadata.projectId);
		return this.#exclusive(live, async () => {
			switch (method) {
				case "prompt":
					await live.sdk.prompt(requiredString(params, "text"));
					return null;
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
					live.unsubscribe();
					if (live.timer) clearTimeout(live.timer);
					await live.sdk.dispose();
					await live.settings.close();
					this.#live.delete(metadata.id);
					if (metadata.file) {
						const file = this.#sessionPath(metadata.file);
						await fs.rm(file, { force: true });
						if (file.endsWith(".jsonl")) await fs.rm(file.slice(0, -6), { recursive: true, force: true });
					}
					this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== metadata);
					this.#publishSnapshot();
					return null;
				}
				case "session.fork": {
					await live.sdk.sessionManager.flush();
					const file = live.sdk.sessionManager.getSessionFile();
					if (!file) throw new Error("Session has no persisted transcript");
					const project = this.#catalog.projects.find(item => item.id === metadata.projectId)!;
					const manager = await SessionManager.forkFrom(
						file,
						project.path,
						path.join(this.dataDir, "sessions", metadata.projectId),
					);
					const fork: SavedSession = {
						id: crypto.randomUUID(),
						projectId: metadata.projectId,
						title: `${metadata.title.slice(0, 190)} (fork)`,
						starred: false,
					};
					this.#catalog.sessions.push(fork);
					try {
						await this.#open(fork, manager);
					} catch (error) {
						this.#catalog.sessions = this.#catalog.sessions.filter(item => item !== fork);
						throw error;
					}
					this.#publishSnapshot();
					return this.#dto(fork);
				}
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
						path: await live.sdk.exportToHtml(path.join(directory, `${metadata.id}-${crypto.randomUUID()}.html`)),
					};
				}
				case "model.set": {
					const modelId = requiredString(params, "modelId", 500);
					const model = this.#registry!.getAll().find(model => `${model.provider}/${model.id}` === modelId);
					if (!model) throw new Error("Model not found");
					await live.sdk.setModel(model);
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
		});
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
			[...this.#live.values()].map(async live => {
				live.unsubscribe();
				if (live.timer) clearTimeout(live.timer);
				await attempt(() => live.sdk.dispose());
				await attempt(() => live.settings.close());
			}),
		);
		this.#live.clear();
		await attempt(() => this.#saving);
		await attempt(() => this.#registry?.dispose());
		await attempt(() => this.#settings?.close());
		await attempt(() => this.#auth?.close());
		if (failures.length) throw new Error("Desktop shutdown failed to clean up all SDK resources");
	}
}
