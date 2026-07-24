import { logger } from "@gajae-code/utils";
import { getCmuxEnvironmentIdentifier, sanitizeCmuxDisplayText } from "../utils/cmux-workspace";

interface CmuxIdentifyContext {
	workspaceId?: string;
	surfaceId?: string;
}

const CMUX_COMMAND = "cmux";
const CAPABILITY_RETRIES = 2;
const DISPLAY_LIMIT = 480;
const DIAGNOSTIC_LIMIT = 8;
const PROGRESS_CHANNEL = "task:subagent:progress";
const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

function cmuxIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function parseCmuxIdentify(output: string): CmuxIdentifyContext | null {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!isObject(parsed) || !isObject(parsed.caller)) return null;
		const caller = parsed.caller;
		const workspaceId = cmuxIdentityValue(caller.workspace_id ?? caller.workspaceId);
		const surfaceId = cmuxIdentityValue(caller.surface_id ?? caller.surfaceId);
		return workspaceId ? { workspaceId, surfaceId } : null;
	} catch {
		return null;
	}
}
export type CmuxCapability = "unknown" | "verified" | "disabled";

export interface CmuxDiagnostic {
	operation: string;
	message: string;
}

export interface CmuxCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CmuxCommandRunner {
	run(command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CmuxCommandResult>;
}

export interface CmuxResearchPresenter {
	presentResearch(url: string, signal?: AbortSignal): Promise<boolean>;
}

export interface CmuxPresentationAdapterOptions {
	env?: NodeJS.ProcessEnv;
	runner?: CmuxCommandRunner;
	command?: string;
	timeoutMs?: number;
	diagnostics?: (diagnostic: CmuxDiagnostic) => void;
}

export interface CmuxAgentSurfaceUpdate {
	id: string;
	status: string;
	text?: string;
}

interface EventBusLike {
	on(channel: string, handler: (payload: unknown) => void): () => void;
}

interface ProgressLike {
	id?: unknown;
	status?: unknown;
	agent?: unknown;
	currentTool?: unknown;
}

interface LifecycleLike {
	id?: unknown;
	status?: unknown;
	agent?: unknown;
}

const SAFE_SURFACE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;

/** Only allow controlled identifier-like tokens (tool names, agent roles) into cmux tab titles.
 * Free-text output, descriptions, tasks, and URLs are rejected so credentials/PII never persist. */
function safeSurfaceToken(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return SAFE_SURFACE_TOKEN.test(trimmed) ? trimmed : "";
}

function redactCmuxDiagnostic(value: unknown): string {
	return sanitizeCmuxDisplayText(String(value ?? "cmux command failed"), 240)
		.replace(/https?:\/\/[^\s]+/gi, "[url]")
		.replace(/(?:token|password|authorization|cookie)=?[^\s,;]+/gi, "$1=[redacted]");
}

function isHelpEvidence(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		normalized.includes("browser open") &&
		normalized.includes("--focus") &&
		normalized.includes("new-surface") &&
		normalized.includes("agent-session") &&
		normalized.includes("surface") &&
		normalized.includes("identify") &&
		normalized.includes("capabilities")
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function defaultRunner(): CmuxCommandRunner {
	return {
		async run(command, args, timeoutMs, signal) {
			if (signal?.aborted) return { exitCode: 124, stdout: "", stderr: "aborted" };
			const process = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			let terminated = false;
			const kill = () => {
				terminated = true;
				process.kill();
			};
			const timer = setTimeout(kill, timeoutMs);
			timer.unref?.();
			const onAbort = () => kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					process.exited,
					new Response(process.stdout).text(),
					new Response(process.stderr).text(),
				]);
				return { exitCode: terminated ? 124 : exitCode, stdout, stderr };
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

/** A session-scoped, one-way cmux presenter. It never owns task execution or surfaces cleanup. */
export class CmuxPresentationAdapter implements CmuxResearchPresenter {
	readonly #env: NodeJS.ProcessEnv;
	readonly #runner: CmuxCommandRunner;
	readonly #command: string;
	readonly #timeoutMs: number;
	readonly #diagnostics: (diagnostic: CmuxDiagnostic) => void;
	readonly #surfaceIds = new Map<string, string>();
	readonly #lastUpdates = new Map<string, string>();
	readonly #surfaceUpdates = new Map<string, Promise<void>>();
	readonly #reportedDiagnostics = new Set<string>();
	readonly #surfaceCreations = new Map<string, Promise<string | null>>();
	#capability: CmuxCapability = "unknown";
	#checking: Promise<boolean> | null = null;
	#disposed = false;

	constructor(options: CmuxPresentationAdapterOptions = {}) {
		this.#env = options.env ?? process.env;
		this.#runner = options.runner ?? defaultRunner();
		this.#command = options.command ?? CMUX_COMMAND;
		this.#timeoutMs = options.timeoutMs ?? 1_500;
		this.#diagnostics =
			options.diagnostics ?? (diagnostic => logger.debug("cmux presentation disabled", { ...diagnostic }));
	}

	get capability(): CmuxCapability {
		return this.#capability;
	}

	async presentResearch(url: string, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted || !(await this.#available(signal))) return false;
		const result = await this.#invoke("browser", ["browser", "open", url, "--focus", "false"], signal);
		return result !== null;
	}

	async updateAgentSurface(update: CmuxAgentSurfaceUpdate): Promise<void> {
		if (!update.id || !(await this.#available())) return;
		const id = sanitizeCmuxDisplayText(update.id, 128);
		if (!id) return;
		const text = sanitizeCmuxDisplayText(update.text, DISPLAY_LIMIT);
		const updateKey = `${update.status}\u0000${text}`;
		if (this.#lastUpdates.get(id) === updateKey) return;
		this.#lastUpdates.set(id, updateKey);

		const prior = this.#surfaceUpdates.get(id) ?? Promise.resolve();
		const queued = prior
			.catch(() => undefined)
			.then(async () => {
				let surfaceId = this.#surfaceIds.get(id);
				if (!surfaceId) {
					surfaceId = (await this.#createSurface(id)) ?? undefined;
					if (!surfaceId) return;
				}
				await this.#invoke("rename-tab", [
					"rename-tab",
					"--surface",
					surfaceId,
					`GJC ${id} ${sanitizeCmuxDisplayText(update.status, 64)}: ${text}`.slice(0, DISPLAY_LIMIT),
				]);
			});
		const retained = queued.finally(() => {
			if (this.#surfaceUpdates.get(id) === retained) this.#surfaceUpdates.delete(id);
		});
		this.#surfaceUpdates.set(id, retained);
		await retained;
	}

	dispose(): void {
		this.#disposed = true;
	}

	async #available(signal?: AbortSignal): Promise<boolean> {
		if (this.#disposed || this.#capability === "disabled") return false;
		if (this.#capability === "verified") return true;
		this.#checking ??= this.#verify(signal);
		return this.#checking;
	}

	async #verify(signal?: AbortSignal): Promise<boolean> {
		const workspaceId = getCmuxEnvironmentIdentifier(this.#env, "CMUX_WORKSPACE_ID");
		if (!workspaceId) return this.#disable("environment", "cmux workspace identifier is unavailable");
		if (this.#env.CMUX_SURFACE_ID?.trim() && !getCmuxEnvironmentIdentifier(this.#env, "CMUX_SURFACE_ID")) {
			this.#report("environment", "cmux surface identifier is invalid");
		}
		for (let attempt = 0; attempt < CAPABILITY_RETRIES; attempt++) {
			try {
				const [help, capabilities, identify] = await Promise.all([
					this.#runner.run(this.#command, ["help"], this.#timeoutMs, signal),
					this.#runner.run(this.#command, ["capabilities"], this.#timeoutMs, signal),
					this.#runner.run(this.#command, ["--id-format", "uuids", "identify"], this.#timeoutMs, signal),
				]);
				if (
					help.exitCode === 0 &&
					capabilities.exitCode === 0 &&
					identify.exitCode === 0 &&
					capabilities.stdout.trim() !== "" &&
					identify.stdout.trim() !== "" &&
					isHelpEvidence(help.stdout)
				) {
					const identity = parseCmuxIdentify(identify.stdout);
					const surfaceId = getCmuxEnvironmentIdentifier(this.#env, "CMUX_SURFACE_ID");
					if (identity?.workspaceId === workspaceId && (!surfaceId || identity.surfaceId === surfaceId)) {
						this.#capability = "verified";
						return true;
					}
					this.#report("identity", "cmux identify did not match the caller workspace and surface");
				}
				this.#report("verification", `${help.stderr} ${capabilities.stderr} ${identify.stderr}`);
			} catch (error) {
				this.#report("verification", error);
			}
		}
		return this.#disable("verification", "public cmux capability verification failed");
	}

	async #createSurface(id: string): Promise<string | null> {
		const existing = this.#surfaceCreations.get(id);
		if (existing) return existing;
		const creation = this.#invoke("new-surface", ["new-surface", "--type", "agent-session", "--focus", "false"])
			.then(result => {
				const surfaceId = this.#surfaceId(result?.stdout);
				if (!surfaceId) {
					this.#disable("new-surface", "cmux did not return a surface identifier");
					return null;
				}
				this.#surfaceIds.set(id, surfaceId);
				return surfaceId;
			})
			.finally(() => this.#surfaceCreations.delete(id));
		this.#surfaceCreations.set(id, creation);
		return creation;
	}

	async #invoke(operation: string, args: string[], signal?: AbortSignal): Promise<CmuxCommandResult | null> {
		if (this.#capability !== "verified" || this.#disposed) return null;
		try {
			const result = await this.#runner.run(this.#command, args, this.#timeoutMs, signal);
			if (result.exitCode !== 0) {
				this.#disable(operation, result.stderr || result.stdout || `exit ${result.exitCode}`);
				return null;
			}
			return result;
		} catch (error) {
			this.#disable(operation, error);
			return null;
		}
	}

	#surfaceId(output: string | undefined): string | null {
		const id = output?.trim().match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)?.[0];
		return id ?? null;
	}

	#disable(operation: string, error: unknown): false {
		this.#capability = "disabled";
		this.#report(operation, error);
		return false;
	}

	#report(operation: string, error: unknown): void {
		if (this.#reportedDiagnostics.size >= DIAGNOSTIC_LIMIT || this.#reportedDiagnostics.has(operation)) return;
		this.#reportedDiagnostics.add(operation);
		this.#diagnostics({ operation, message: redactCmuxDiagnostic(error) });
	}
}

/** Projects existing subagent EventBus data to retained cmux surfaces without task-control authority. */
export class CmuxProjectionSubscription {
	readonly #adapter: CmuxPresentationAdapter;
	readonly #progress = new Map<string, ProgressLike>();
	readonly #unsubscribers: readonly (() => void)[];
	#disposed = false;

	constructor(eventBus: EventBusLike, adapter: CmuxPresentationAdapter) {
		this.#adapter = adapter;
		this.#unsubscribers = [
			eventBus.on(PROGRESS_CHANNEL, payload => this.#onProgress(payload)),
			eventBus.on(LIFECYCLE_CHANNEL, payload => this.#onLifecycle(payload)),
		];
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#progress.clear();
	}

	#onProgress(payload: unknown): void {
		if (this.#disposed || !isObject(payload) || !isObject(payload.progress)) return;
		const progress = payload.progress as ProgressLike;
		const id = typeof progress.id === "string" ? progress.id : "";
		if (!id) return;
		this.#progress.set(id, progress);
		void this.#adapter.updateAgentSurface({
			id,
			status: typeof progress.status === "string" ? progress.status : "running",
			text: this.#progressText(progress),
		});
	}

	#onLifecycle(payload: unknown): void {
		if (this.#disposed || !isObject(payload)) return;
		const lifecycle = payload as LifecycleLike;
		const id = typeof lifecycle.id === "string" ? lifecycle.id : "";
		if (!id) return;
		const status = typeof lifecycle.status === "string" ? lifecycle.status : "unknown";
		const progress = this.#progress.get(id);
		const terminal = status === "completed" || status === "failed" || status === "aborted";
		const hasMatchingTerminalProgress = progress?.status === status;
		const text = terminal
			? hasMatchingTerminalProgress && progress
				? this.#progressText(progress)
				: "No final progress snapshot"
			: safeSurfaceToken(lifecycle.agent);
		void this.#adapter.updateAgentSurface({ id, status, text });
	}

	#progressText(progress: ProgressLike): string {
		const agent = safeSurfaceToken(progress.agent);
		const tool = safeSurfaceToken(progress.currentTool);
		return [agent, tool ? `Tool: ${tool}` : ""].filter(Boolean).join(" ");
	}
}

export interface CmuxInvocationPresentation {
	adapter: CmuxPresentationAdapter;
	presentation: CmuxResearchPresenter;
	dispose(): void;
}

export function createCmuxInvocationPresentation(
	options: CmuxPresentationAdapterOptions = {},
): CmuxInvocationPresentation {
	const adapter = new CmuxPresentationAdapter(options);
	return { adapter, presentation: adapter, dispose: () => adapter.dispose() };
}
