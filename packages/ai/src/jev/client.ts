/**
 * Jev (TypeSafe System One) — typed judgement, not generation.
 *
 * A thin client over POST /v1/systemone. It lives in this package rather than
 * in `coding-agent` on purpose: `agent-core` sits below `coding-agent` and
 * cannot import from it, so a client placed there would be unreachable from
 * the compaction path that may eventually want it.
 *
 * Contract notes that are easy to get wrong, from docs.typesafe.ai:
 * - Several QUESTIONS about one subject are evaluated in a single parallel
 *   pass and are much cheaper than separate calls. Several SUBJECTS in one
 *   `state` are not: the model answers confidently about the wrong one.
 *   One subject per request; batch the questions.
 * - A `noul` answer IS the probability. There is no separate confidence field.
 * - Accuracy in CJK is documented as not equal to English. Callers reading
 *   user-authored text must measure per language.
 */

export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_ENDPOINT_ENV = "TYPESAFE_API_URL";
export const JEV_MODEL_ENV = "TYPESAFE_MODEL";

/**
 * Pinned, not `jev-latest`. The docs tell you to pin once thresholds are tuned
 * against a version, and every caller here carries a threshold.
 */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

export type JevState = string | Record<string, unknown> | unknown[];
export type JevInstructions = string | Record<string, unknown> | unknown[];

export interface JevNoulQuestion {
	type: "noul";
	instructions: JevInstructions;
	criteria?: { true: JevInstructions; false: JevInstructions };
}

export interface JevChoiceQuestion {
	type: "choice";
	instructions: JevInstructions;
	/** 1-255 options. `null` where the option name is its own description. */
	criteria: Record<string, JevInstructions | null>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;

export interface JevNoulAnswer {
	type: "noul";
	/** 0..1. This value is the answer; there is no separate confidence. */
	noul: number;
}

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevResponse {
	/** The version that actually answered, which may differ from what was asked. */
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevClientOptions {
	apiKey?: string;
	endpoint?: string;
	model?: string;
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	/** Total attempts including the first. Retries 429 and 529 only. */
	maxAttempts?: number;
	timeoutMs?: number;
	/** Injectable so tests do not sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export class JevError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryable = false,
	) {
		super(message);
		this.name = "JevError";
	}
}

const RETRYABLE_STATUS = new Set([429, 529]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** `retry-after` is seconds per RFC; fall back to exponential backoff. */
function retryDelayMs(response: Response | undefined, attempt: number): number {
	const header = response?.headers?.get?.("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
	}
	return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

export class JevClient {
	private readonly apiKey: string | undefined;
	private readonly endpoint: string;
	private readonly model: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxAttempts: number;
	private readonly timeoutMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: JevClientOptions = {}) {
		const env = options.env ?? process.env;
		this.apiKey = options.apiKey ?? env[JEV_API_KEY_ENV];
		this.endpoint = options.endpoint ?? env[JEV_ENDPOINT_ENV] ?? JEV_DEFAULT_ENDPOINT;
		this.model = options.model ?? env[JEV_MODEL_ENV] ?? JEV_DEFAULT_MODEL;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.sleep = options.sleep ?? defaultSleep;
	}

	/** Configured means a key is present. Callers gate on this and skip silently. */
	isConfigured(): boolean {
		return typeof this.apiKey === "string" && this.apiKey.length > 0;
	}

	async systemOne(state: JevState, questions: Record<string, JevQuestion>): Promise<JevResponse> {
		if (!this.isConfigured()) throw new JevError(`${JEV_API_KEY_ENV} is not set`);
		if (Object.keys(questions).length === 0) throw new JevError("at least one question is required");

		const body = JSON.stringify({ model: this.model, state, questions });
		let lastError: JevError | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			let response: Response | undefined;
			try {
				response = await this.fetchImpl(this.endpoint, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.apiKey}`,
						"content-type": "application/json",
					},
					body,
					signal: controller.signal,
				});
			} catch (error) {
				lastError = new JevError(error instanceof Error ? error.message : String(error), undefined, true);
			} finally {
				clearTimeout(timer);
			}

			if (response?.ok) return (await response.json()) as JevResponse;

			if (response) {
				const retryable = RETRYABLE_STATUS.has(response.status);
				const detail = await response.text().catch(() => "");
				lastError = new JevError(`jev request failed: ${response.status} ${detail.slice(0, 200)}`, response.status, retryable);
				if (!retryable) throw lastError;
			}

			if (attempt < this.maxAttempts) await this.sleep(retryDelayMs(response, attempt));
		}

		throw lastError ?? new JevError("jev request failed");
	}
}
