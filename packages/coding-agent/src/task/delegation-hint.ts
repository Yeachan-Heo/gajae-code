import * as crypto from "node:crypto";
import * as http from "node:http";
import * as stream from "node:stream";
import { AUTOROUTING_TIERS, type AutoroutingTier } from "../config/autorouting-contract";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";

export const KEV_SYSTEMONE_ENDPOINT = "http://127.0.0.1:8009/v1/systemone";
export const KEV_SYSTEMONE_MODEL = "kev-latest";
export const DELEGATION_HINT_TIMEOUT_MS = 750;

const TIERS = AUTOROUTING_TIERS;
const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "ast_edit"]);
const MAX_COUNTER = 10_000;
const MAX_TASKS = 32;
const MAX_PATCH_INPUT_CHARS = 64 * 1024;
const MAX_TRACKED_FILES = 128;
const MAX_TRACKED_PACKAGES = 32;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_HINT_SIGNATURES = 64;
const MIN_TURNS_BETWEEN_HINTS = 3;
const MIN_FILES_TO_CLASSIFY = 3;
const MIN_PACKAGES_TO_CLASSIFY = 2;
const MIN_EDITS_WITHOUT_VERIFICATION = 3;
const MIN_ACTIVE_PLAN_STEPS_TO_CLASSIFY = 3;
const SYSTEM_INSTRUCTIONS =
	'Classify only the aggregate numeric metrics provided. activePlanStepCount is the number of active peer tasks in the largest explicit plan phase; remainingContextRatio is the remaining fraction of the context window. Return exactly one JSON object with the keys "noul", "p_delegate", and "choice". "noul" is a boolean meaning whether the agent should delegate; "p_delegate" is a number from 0 to 1; "choice" must be one of the supplied tiers, or null when no tiers are available. Do not request or infer from raw paths, source text, assignments, prompts, or session content.';

type Tier = AutoroutingTier;

export interface DelegationHintMetrics {
	toolCount: number;
	editCount: number;
	fileCount: number;
	packageCount: number;
	verificationCount: number;
	consecutiveEdits: number;
	/** Pending/in-progress peer tasks in the largest explicit plan phase. */
	activePlanStepCount: number;
	/** Remaining fraction of the context window, omitted when usage is unknown. */
	remainingContextRatio?: number;
}

export interface KevDecision {
	noul: boolean;
	pDelegate: number;
	choice: Tier | null;
}

export type KevDecisionFetcher = (
	metrics: DelegationHintMetrics,
	choices: readonly Tier[],
	signal?: AbortSignal,
) => Promise<KevDecision | undefined>;

export type KevFetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DelegationHintOptions {
	getMode: () => unknown;
	getAutoroutingEnabled: () => unknown;
	getAutoroutingTiers: () => unknown;
	notify: (message: string) => void;
	fetcher?: KevFetchImplementation;
}

function boundedCount(value: number): number {
	return Number.isFinite(value) ? Math.min(MAX_COUNTER, Math.max(0, Math.floor(value))) : 0;
}

function boundedRatio(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function normalizeMetrics(metrics: DelegationHintMetrics): DelegationHintMetrics {
	const remainingContextRatio = boundedRatio(metrics.remainingContextRatio);
	return {
		toolCount: boundedCount(metrics.toolCount),
		editCount: boundedCount(metrics.editCount),
		fileCount: boundedCount(metrics.fileCount),
		packageCount: boundedCount(metrics.packageCount),
		verificationCount: boundedCount(metrics.verificationCount),
		consecutiveEdits: boundedCount(metrics.consecutiveEdits),
		activePlanStepCount: boundedCount(metrics.activePlanStepCount),
		...(remainingContextRatio === undefined ? {} : { remainingContextRatio }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDecision(content: string, choices: readonly Tier[]): KevDecision | undefined {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value).sort();
	if (keys.length !== 3 || keys[0] !== "choice" || keys[1] !== "noul" || keys[2] !== "p_delegate") {
		return undefined;
	}
	const choice = value.choice;
	if (
		typeof value.noul !== "boolean" ||
		typeof value.p_delegate !== "number" ||
		!Number.isFinite(value.p_delegate) ||
		value.p_delegate < 0 ||
		value.p_delegate > 1 ||
		(choices.length === 0 ? choice !== null : typeof choice !== "string" || !choices.includes(choice as Tier))
	) {
		return undefined;
	}
	return {
		noul: value.noul,
		pDelegate: value.p_delegate,
		choice: typeof choice === "string" ? (choice as Tier) : null,
	};
}

async function readBoundedBody(response: Response): Promise<string | undefined> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		return undefined;
	}
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function directKevRequest(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input);
	if (
		!init ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.port !== "8009" ||
		url.pathname !== "/v1/systemone" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		init.method?.toUpperCase() !== "POST" ||
		typeof init.body !== "string"
	) {
		return Promise.reject(new TypeError("Kev decision requests must use the fixed loopback endpoint."));
	}

	const headers = new Headers(init.headers);
	const requestHeaders: Record<string, string> = {};
	headers.forEach((value, key) => {
		requestHeaders[key] = value;
	});
	const deferred = Promise.withResolvers<Response>();
	try {
		const agent = new http.Agent({ proxyEnv: {} });
		const request = http.request(
			{
				hostname: "127.0.0.1",
				port: 8009,
				path: "/v1/systemone",
				method: "POST",
				// Do not inherit Bun's process-wide HTTP_PROXY/NODE_USE_ENV_PROXY settings.
				agent,
				headers: requestHeaders,
				signal: init.signal ?? undefined,
			},
			incoming => {
				try {
					const status = incoming.statusCode ?? 500;
					if (status < 200 || status > 599) {
						incoming.destroy();
						deferred.resolve(new Response(null, { status: 500 }));
						return;
					}
					const responseHeaders = new Headers();
					for (const [key, value] of Object.entries(incoming.headers)) {
						if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
					}
					if (status >= 300 || [204, 205, 304].includes(status)) {
						incoming.destroy();
						deferred.resolve(new Response(null, { status, headers: responseHeaders }));
						return;
					}
					const body = stream.Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
					deferred.resolve(new Response(body, { status, headers: responseHeaders }));
				} catch (error) {
					incoming.destroy();
					deferred.reject(error);
				}
			},
		);
		request.on("error", error => deferred.reject(error));
		request.end(init.body);
	} catch (error) {
		deferred.reject(error);
	}
	return deferred.promise;
}

/** Create a fixed-loopback, bounded Kev-compatible classifier client. */
export function createKevDecisionFetcher(
	fetchImplementation: KevFetchImplementation = directKevRequest,
): KevDecisionFetcher {
	return async (metrics, choices, callerSignal) => {
		if (choices.some(choice => !TIERS.includes(choice)) || new Set(choices).size !== choices.length) return undefined;
		if (callerSignal?.aborted) return undefined;
		const controller = new AbortController();
		const abortFromCaller = () => controller.abort(callerSignal?.reason);
		callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		const timeout = setTimeout(
			() => controller.abort(new Error("Kev decision hint timed out.")),
			DELEGATION_HINT_TIMEOUT_MS,
		);
		const aborted = Promise.withResolvers<undefined>();
		const onAbort = () => aborted.resolve(undefined);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const requestBody = JSON.stringify({
				model: KEV_SYSTEMONE_MODEL,
				messages: [
					{ role: "system", content: SYSTEM_INSTRUCTIONS },
					{
						role: "user",
						content: JSON.stringify({
							noul: "should delegate",
							choice: choices,
							metrics: normalizeMetrics(metrics),
						}),
					},
				],
				temperature: 0,
				max_tokens: 64,
			});
			const request = (async (): Promise<KevDecision | undefined> => {
				try {
					const response = await fetchImplementation(KEV_SYSTEMONE_ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: requestBody,
						redirect: "error",
						signal: controller.signal,
					});
					if (!response.ok) {
						await response.body?.cancel();
						return undefined;
					}
					if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
						await response.body?.cancel();
						return undefined;
					}
					const responseText = await readBoundedBody(response);
					if (responseText === undefined) return undefined;
					const envelope: unknown = JSON.parse(responseText);
					if (!isRecord(envelope) || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
						return undefined;
					}
					const firstChoice = envelope.choices[0];
					if (
						!isRecord(firstChoice) ||
						!isRecord(firstChoice.message) ||
						typeof firstChoice.message.content !== "string"
					) {
						return undefined;
					}
					return parseDecision(firstChoice.message.content, choices);
				} catch {
					return undefined;
				}
			})();
			return await Promise.race([request, aborted.promise]);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", abortFromCaller);
			controller.signal.removeEventListener("abort", onAbort);
		}
	};
}

function stringsFromPathFields(args: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const key of ["path", "file_path"]) {
		if (typeof args[key] === "string") paths.push((args[key] as string).slice(0, 4096));
	}
	if (Array.isArray(args.paths)) {
		for (const value of args.paths.slice(0, MAX_TASKS)) {
			if (typeof value === "string") paths.push(value.slice(0, 4096));
		}
	}
	if (Array.isArray(args.edits)) {
		for (const value of args.edits.slice(0, MAX_TASKS)) {
			if (!isRecord(value)) continue;
			for (const key of ["path", "file_path", "rename"]) {
				if (typeof value[key] === "string") paths.push((value[key] as string).slice(0, 4096));
			}
		}
	}
	const input = args.input;
	if (
		typeof input === "string" &&
		input.length <= MAX_PATCH_INPUT_CHARS &&
		input.trimStart().startsWith("*** Begin Patch")
	) {
		try {
			for (const entry of expandApplyPatchToEntries({ input }).slice(0, MAX_TRACKED_FILES)) {
				paths.push(entry.path.slice(0, 4096));
				if (entry.rename) paths.push(entry.rename.slice(0, 4096));
			}
		} catch {
			// A malformed patch simply contributes no parsed file counts.
		}
	}
	return paths;
}

function packageFromPath(path: string): string | undefined {
	const segments = path.split(/[\\/]/u);
	const packageIndex = segments.lastIndexOf("packages");
	return packageIndex >= 0 ? segments[packageIndex + 1] : undefined;
}

function configuredTiers(value: unknown): Tier[] {
	if (!isRecord(value)) return [];
	return TIERS.filter(tier => {
		const chain = value[tier];
		return (
			(typeof chain === "string" && chain.trim().length > 0) ||
			(Array.isArray(chain) && chain.some(item => typeof item === "string" && item.trim().length > 0))
		);
	});
}

function isVerificationCommand(command: unknown): boolean {
	return typeof command === "string" && /\b(test|check|lint|build|verify|typecheck)\b/iu.test(command);
}

function shouldClassify(metrics: DelegationHintMetrics, successfulTodoWrite: boolean): boolean {
	return (
		metrics.fileCount >= MIN_FILES_TO_CLASSIFY ||
		metrics.packageCount >= MIN_PACKAGES_TO_CLASSIFY ||
		metrics.consecutiveEdits >= MIN_EDITS_WITHOUT_VERIFICATION ||
		(successfulTodoWrite && metrics.activePlanStepCount >= MIN_ACTIVE_PLAN_STEPS_TO_CLASSIFY)
	);
}

function decisionHintMessage(decision: KevDecision, metrics: DelegationHintMetrics): string {
	const suggestedTask = decision.choice ? `task(executor, tier=${decision.choice})` : "task(executor)";
	const remainingContextRatio = metrics.remainingContextRatio?.toFixed(2) ?? "unknown";
	return [
		`Local delegation hint: consider ${suggestedTask} (advisory; it will not change model input or routing).`,
		`p_delegate=${decision.pDelegate.toFixed(2)}; trigger: tools=${metrics.toolCount}, successful_edits=${metrics.editCount}, files=${metrics.fileCount}, packages=${metrics.packageCount}, verification_activity=${metrics.verificationCount}, consecutive_edits_without_verification=${metrics.consecutiveEdits}, active_plan_steps=${metrics.activePlanStepCount}, remaining_context_ratio=${remainingContextRatio}.`,
	].join(" ");
}

/** Ephemeral, bounded inference state. Notices stay out of prompts and session storage. */
export class DelegationHintController {
	readonly #getMode: () => unknown;
	readonly #getAutoroutingEnabled: () => unknown;
	readonly #getAutoroutingTiers: () => unknown;
	readonly #notify: (message: string) => void;
	readonly #fetchDecision: KevDecisionFetcher;
	readonly #files = new Set<string>();
	readonly #packages = new Set<string>();
	readonly #shownSignatures = new Set<string>();
	#turnIndex = 0;
	#inputGeneration = 0;
	#toolCount = 0;
	#editCount = 0;
	#verificationCount = 0;
	#consecutiveEdits = 0;
	#activePlanStepCount = 0;
	#lastHintTurn = Number.NEGATIVE_INFINITY;
	#lastRequestTurn = Number.NEGATIVE_INFINITY;
	#enabled = false;
	#activeRequestController: AbortController | undefined;

	constructor(options: DelegationHintOptions) {
		this.#getMode = options.getMode;
		this.#getAutoroutingEnabled = options.getAutoroutingEnabled;
		this.#getAutoroutingTiers = options.getAutoroutingTiers;
		this.#notify = options.notify;
		this.#fetchDecision = createKevDecisionFetcher(options.fetcher);
		this.#enabled = this.#getMode() === "hint";
	}

	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		if (!enabled) this.onUserMessage();
	}

	/** Reset aggregate counters for the next assistant turn. */
	onTurnStart(): void {
		this.#turnIndex++;
		this.#toolCount = 0;
		this.#editCount = 0;
		this.#verificationCount = 0;
		this.#consecutiveEdits = 0;
		this.#activePlanStepCount = 0;
		this.#files.clear();
		this.#packages.clear();
	}

	/** Prevent a pending classifier result from crossing into a new user prompt. */
	onUserMessage(): void {
		this.#inputGeneration++;
		this.#activeRequestController?.abort();
		this.#activeRequestController = undefined;
	}

	/** Synchronous callback; inference and its user-only notice never alter tool or model state. */
	observeAfterToolCall(
		input: {
			toolName: string;
			args: Record<string, unknown>;
			isError: boolean;
			resultError?: boolean;
			getActivePlanStepCount?: () => number;
			getRemainingContextRatio?: () => number | undefined;
		},
		signal?: AbortSignal,
	): void {
		try {
			this.setEnabled(this.#getMode() === "hint");
			if (!this.#enabled) return;
			this.#toolCount = boundedCount(this.#toolCount + 1);
			if (input.toolName === "bash" && isVerificationCommand(input.args.command)) {
				this.#verificationCount = boundedCount(this.#verificationCount + 1);
				this.#consecutiveEdits = 0;
				return;
			}
			if (EDIT_TOOLS.has(input.toolName)) this.#consecutiveEdits = boundedCount(this.#consecutiveEdits + 1);
			const successfulEdit = EDIT_TOOLS.has(input.toolName) && !input.isError && input.resultError !== true;
			const successfulTodoWrite = input.toolName === "todo_write" && !input.isError && input.resultError !== true;
			if (!successfulEdit && !successfulTodoWrite) return;
			this.#activePlanStepCount = boundedCount(input.getActivePlanStepCount?.() ?? 0);
			if (successfulEdit) {
				this.#editCount = boundedCount(this.#editCount + 1);
				for (const path of stringsFromPathFields(input.args)) {
					if (this.#files.size < MAX_TRACKED_FILES)
						this.#files.add(crypto.createHash("sha256").update(path).digest("hex"));
					const packageName = packageFromPath(path);
					if (packageName && this.#packages.size < MAX_TRACKED_PACKAGES) {
						this.#packages.add(crypto.createHash("sha256").update(packageName).digest("hex"));
					}
				}
			}
			const baseMetrics = this.#metrics();
			if (
				!shouldClassify(baseMetrics, successfulTodoWrite) ||
				this.#turnIndex - this.#lastRequestTurn < MIN_TURNS_BETWEEN_HINTS ||
				this.#shownSignatures.size >= MAX_HINT_SIGNATURES
			) {
				return;
			}
			const remainingContextRatio = boundedRatio(input.getRemainingContextRatio?.());
			const metrics = {
				...baseMetrics,
				...(remainingContextRatio === undefined ? {} : { remainingContextRatio }),
			};
			this.#lastRequestTurn = this.#turnIndex;
			const requestTurn = this.#turnIndex;
			const requestGeneration = this.#inputGeneration;
			this.#activeRequestController?.abort();
			const requestController = new AbortController();
			this.#activeRequestController = requestController;
			const requestSignal = signal ? AbortSignal.any([signal, requestController.signal]) : requestController.signal;
			const choices = this.#getAutoroutingEnabled() === true ? configuredTiers(this.#getAutoroutingTiers()) : [];
			setTimeout(() => {
				if (
					!this.#enabled ||
					requestController.signal.aborted ||
					requestGeneration !== this.#inputGeneration ||
					this.#turnIndex - requestTurn > 1
				) {
					if (this.#activeRequestController === requestController) this.#activeRequestController = undefined;
					return;
				}
				void this.#classifyAndNotify(
					metrics,
					choices,
					requestSignal,
					requestTurn,
					requestGeneration,
					requestController,
				);
			}, 0);
		} catch {
			// Optional inference must not delay, replace, or fail an executed tool call.
		}
	}

	#metrics(): DelegationHintMetrics {
		return {
			toolCount: this.#toolCount,
			editCount: this.#editCount,
			fileCount: this.#files.size,
			packageCount: this.#packages.size,
			verificationCount: this.#verificationCount,
			consecutiveEdits: this.#consecutiveEdits,
			activePlanStepCount: this.#activePlanStepCount,
		};
	}

	async #classifyAndNotify(
		metrics: DelegationHintMetrics,
		choices: readonly Tier[],
		signal: AbortSignal | undefined,
		requestTurn: number,
		requestGeneration: number,
		requestController: AbortController,
	): Promise<void> {
		try {
			const decision = await this.#fetchDecision(metrics, choices, signal);
			// No probability cutoff is applied without an in-domain evaluation; the notice remains advisory.
			if (
				!decision?.noul ||
				!this.#enabled ||
				requestController.signal.aborted ||
				this.#getMode() !== "hint" ||
				requestGeneration !== this.#inputGeneration ||
				this.#turnIndex - requestTurn > 1 ||
				this.#turnIndex - this.#lastHintTurn < MIN_TURNS_BETWEEN_HINTS
			) {
				return;
			}
			const signature = JSON.stringify([
				metrics.toolCount,
				metrics.editCount,
				metrics.fileCount,
				metrics.packageCount,
				metrics.verificationCount,
				metrics.consecutiveEdits,
				metrics.activePlanStepCount,
				metrics.remainingContextRatio,
				decision.choice,
			]);
			if (this.#shownSignatures.has(signature) || this.#shownSignatures.size >= MAX_HINT_SIGNATURES) return;
			this.#notify(decisionHintMessage(decision, metrics));
			this.#lastHintTurn = this.#turnIndex;
			this.#shownSignatures.add(signature);
		} catch {
			// Advisory inference and notification are isolated from tool execution.
		} finally {
			if (this.#activeRequestController === requestController) this.#activeRequestController = undefined;
		}
	}
}
