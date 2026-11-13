import * as crypto from "node:crypto";
import { getOAuthProviders, resolveOAuthStorageProvider } from "@gajae-code/ai/core";
import type { OAuthPrompt } from "@gajae-code/ai/utils/oauth/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

import type { AuthorizationControlOperation } from "./protocol/client-control-contracts";

export {
	AUTHORIZATION_CONTROL_OPERATIONS,
	AUTHORIZATION_MUTATION_OPERATIONS,
	AUTHORIZATION_QUERY_OPERATIONS,
	type AuthorizationControlOperation,
	isAuthorizationControlOperation,
} from "./protocol/client-control-contracts";

export interface AuthorizationProviderStatus {
	provider: string;
	/** Enrollment calls the real AuthStorage provider login implementation. */
	canEnroll: boolean;
	canStoreApiKey: boolean;
	stored: boolean;
	/** Effective auth includes this registry's overrides and this session's selector. */
	configured: boolean;
	credentialKinds: ("api_key" | "oauth")[];
	/** Session-wide recovery selectors, not initiating-client ownership or presentation. */
	flow?: {
		flowId: string;
		status: AuthorizationFlowState["status"];
		/** Cancellation/deadline presentation does not prove provider-task settlement. */
		providerSettled: boolean;
	};
}

export interface AuthorizationFlowState {
	id: string;
	provider: string;
	status: "authorizing" | "waiting" | "stored" | "cancelled" | "error";
	/** Current persistent credential presence, not a claim that cancellation rolled storage back. */
	stored: boolean;
	catalogRefreshed?: boolean;
	/** Ephemeral secure-local presentation only; never a public event or cache entry. */
	url?: string;
	/** One-time browser device challenge, never a stored access token. */
	verificationCode?: string;
	prompt?: { id: string; message: string; allowEmpty: boolean };
	error?: string;
}

export interface AuthorizationKeyStored {
	provider: string;
	saved: true;
	catalogRefreshed: boolean;
}

export type AuthorizationControlResult =
	| AuthorizationProviderStatus[]
	| AuthorizationProviderStatus
	| AuthorizationFlowState
	| AuthorizationKeyStored;

export interface AuthorizationControlsOptions {
	/** Trusted host lifetime, not a caller-supplied cancellation capability. */
	signal?: AbortSignal;
	deadlineMs?: number;
	joinMs?: number;
}

interface AuthorizationFlow {
	state: AuthorizationFlowState;
	abort: AbortController;
	answers: string[];
	promptCount: number;
	timer?: Timer;
	task?: Promise<void>;
	pending?: { id: string; resolve: (answer: string) => void; reject: (error: Error) => void };
}

function requireFields(input: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Invalid authorization input");
}

function requireText(input: Record<string, unknown>, field: string, maximum: number): string {
	const value = input[field];
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
		throw new Error("Invalid authorization input");
	return value;
}

function decodedUrl(raw: string): string {
	let decoded = raw;
	for (let depth = 0; depth < 3; depth += 1) {
		const next = decodeURIComponent(decoded);
		if (/[\u0000-\u001f\u007f]/.test(next)) throw new Error("Unsafe URL");
		if (next === decoded) return decoded;
		decoded = next;
	}
	if (/%[a-fA-F0-9]{2}/.test(decoded)) throw new Error("Unsafe URL");
	return decoded;
}

function boundedDuration(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid authorization timeout");
	return value;
}

/**
 * Trusted, exact-session service. Every operation requires an exact secure-local
 * transport capability; this class is not a transport authorization mechanism.
 * Hosts must exclude requests/results from shared events, logs and idempotency
 * caches. In particular answers and API keys must never become cache keys.
 * One task owns the slot until it actually settles, even after cancellation.
 */
export class AuthorizationControls {
	readonly #session: AgentSession;
	readonly #manager: SessionManager;
	readonly #sessionId: string;
	readonly #managerSessionId: string;
	readonly #credentialSessionId: string;
	readonly #identity: number;
	readonly #deadlineMs: number;
	readonly #joinMs: number;
	readonly #signal: AbortSignal | undefined;
	readonly #onAbort = (): void => {
		void this.close().catch(() => {});
	};
	readonly #unregister: (() => void)[] = [];
	#closed = false;
	#active: AuthorizationFlow | undefined;
	#retained: AuthorizationFlow | undefined;
	#keyTask: Promise<AuthorizationKeyStored> | undefined;

	constructor(session: AgentSession, options: AuthorizationControlsOptions = {}) {
		if (session.isDisposed || options.signal?.aborted) throw new Error("Authorization service is unavailable");
		this.#deadlineMs = boundedDuration(options.deadlineMs, 300_000, 900_000);
		this.#joinMs = boundedDuration(options.joinMs, 1000, 10_000);
		this.#session = session;
		this.#manager = session.sessionManager;
		this.#sessionId = session.sessionId;
		this.#managerSessionId = this.#manager.getSessionId();
		this.#credentialSessionId = session.credentialSessionId;
		this.#identity = this.#manager.getSessionIdentityGeneration();
		this.#signal = options.signal;
		this.#unregister.push(session.registerToolSessionCleanup(() => this.close()));
		this.#unregister.push(session.registerToolSessionTransitionCleanup(() => this.close()));
		this.#unregister.push(session.subscribeSessionIdentityChanges(() => this.close()));
		this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	#current(): boolean {
		return (
			!this.#closed &&
			!this.#signal?.aborted &&
			!this.#session.isDisposed &&
			this.#session.sessionManager === this.#manager &&
			this.#session.sessionId === this.#sessionId &&
			this.#manager.getSessionId() === this.#managerSessionId &&
			this.#session.credentialSessionId === this.#credentialSessionId &&
			this.#manager.getSessionIdentityGeneration() === this.#identity
		);
	}

	#assertCurrent(): void {
		if (this.#current()) return;
		void this.close().catch(() => {});
		throw new Error("Authorization service is no longer active");
	}

	#providerIds(): Set<string> {
		const ids = new Set(getOAuthProviders().map(provider => provider.id));
		for (const model of this.#session.modelRegistry.getAll(this.#session.credentialSessionId))
			ids.add(model.provider);
		return ids;
	}

	#provider(input: Record<string, unknown>): string {
		const provider = requireText(input, "provider", 128);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || !this.#providerIds().has(provider))
			throw new Error("Unknown authorization provider");
		return provider;
	}

	#status(provider: string): AuthorizationProviderStatus {
		const auth = this.#session.modelRegistry.authStorage;
		const credentialKinds = new Set<"api_key" | "oauth">();
		for (const row of auth.listCredentialInventory(resolveOAuthStorageProvider(provider))) {
			if (!row.disabled && (row.credentialKind === "api_key" || row.credentialKind === "oauth"))
				credentialKinds.add(row.credentialKind);
		}
		return {
			provider,
			canEnroll: getOAuthProviders().some(item => item.id === provider && item.available && item.id !== "opencodex"),
			canStoreApiKey: provider !== "opencodex",
			stored: credentialKinds.size > 0,
			configured: auth.hasAuth(provider, this.#session.credentialSessionId, {
				owner: this.#session.modelRegistry.getAuthStorageOwner(),
			}),
			credentialKinds: [...credentialKinds].sort(),
		};
	}

	async execute(
		operation: AuthorizationControlOperation,
		input: Record<string, unknown>,
	): Promise<AuthorizationControlResult> {
		this.#assertCurrent();
		try {
			switch (operation) {
				case "auth.providers.status":
					requireFields(input, []);
					return [...this.#providerIds()]
						.filter(provider => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider))
						.sort()
						.map(provider => this.#status(provider));
				case "auth.status": {
					requireFields(input, ["provider"]);
					const provider = this.#provider(input);
					const status = this.#status(provider);
					const flow = this.#retained;
					if (flow?.state.provider === provider) {
						status.flow = {
							flowId: flow.state.id,
							status: flow.state.status,
							providerSettled: this.#active !== flow,
						};
					}
					return status;
				}
				case "auth.start":
					requireFields(input, ["provider", "manualCode"]);
					if (input.manualCode !== undefined && typeof input.manualCode !== "boolean")
						throw new Error("Invalid authorization input");
					return this.#start(this.#provider(input), input.manualCode === true);
				case "auth.read":
					requireFields(input, ["flowId"]);
					return this.#snapshot(this.#flow(requireText(input, "flowId", 128)));
				case "auth.answer":
					requireFields(input, ["flowId", "promptId", "value"]);
					return this.#answer(input);
				case "auth.cancel": {
					requireFields(input, ["flowId"]);
					const flow = this.#flow(requireText(input, "flowId", 128));
					if (!this.#live(flow)) throw new Error("Authorization flow is no longer active");
					this.#stop(flow, "cancelled");
					return this.#snapshot(flow);
				}
				case "auth.apiKey.store":
					requireFields(input, ["provider", "key"]);
					return await this.#storeKey(this.#provider(input), requireText(input, "key", 32_000));
				default:
					throw new Error("Unknown authorization operation");
			}
		} catch {
			// Neither provider/storage exception text nor request values cross this boundary.
			throw new Error("Authorization operation failed or is no longer available");
		}
	}

	#flow(id: string): AuthorizationFlow {
		if (!this.#retained || this.#retained.state.id !== id) throw new Error("Authorization flow is no longer active");
		return this.#retained;
	}

	#snapshot(flow: AuthorizationFlow): AuthorizationFlowState {
		return structuredClone(flow.state);
	}

	#live(flow: AuthorizationFlow): boolean {
		if (!this.#current()) {
			void this.close().catch(() => {});
			return false;
		}
		return (
			this.#active === flow &&
			!flow.abort.signal.aborted &&
			(flow.state.status === "authorizing" || flow.state.status === "waiting")
		);
	}

	#stop(flow: AuthorizationFlow, status: "cancelled" | "error", error?: string): void {
		if (flow.abort.signal.aborted) return;
		clearTimeout(flow.timer);
		if (flow.state.status === "authorizing" || flow.state.status === "waiting") {
			flow.state = {
				id: flow.state.id,
				provider: flow.state.provider,
				status,
				stored: flow.state.stored,
				...(error ? { error } : {}),
			};
		}
		flow.abort.abort();
		flow.pending?.reject(new Error("Authorization stopped"));
		flow.pending = undefined;
	}

	#safeUrl(flow: AuthorizationFlow, raw: string): string {
		if (raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error("Unsafe URL");
		const url = new URL(raw);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			(url.hash && !/^#[a-zA-Z0-9/_-]{1,128}$/.test(url.hash))
		)
			throw new Error("Unsafe URL");
		const decoded = decodedUrl(raw);
		for (const candidate of [url, new URL(decoded)]) {
			for (const [key, value] of candidate.searchParams) {
				// These credential-looking names are literal flags in the existing providers.
				if (key === "code" && value === "true" && flow.state.provider === "anthropic") continue;
				if (key === "id_token_add_organizations" && value === "true" && flow.state.provider === "openai-codex")
					continue;
				if (/(?:token|secret|password|credential|api.?key|^code$|^authorization$)/i.test(key))
					throw new Error("Unsafe URL");
			}
		}
		if (this.#containsSecret(flow, `${raw}\n${decoded}`)) throw new Error("Unsafe URL");
		return url.href;
	}

	#containsSecret(flow: AuthorizationFlow, text: string): boolean {
		const secrets = [...flow.answers];
		for (const entry of Object.values(this.#session.modelRegistry.authStorage.getAll())) {
			for (const credential of Array.isArray(entry) ? entry : [entry]) {
				if (credential.type === "api_key") secrets.push(credential.key);
				else secrets.push(credential.access, credential.refresh);
			}
		}
		return secrets.some(secret => secret.length > 0 && text.includes(secret));
	}

	#start(provider: string, manualCode: boolean): AuthorizationFlowState {
		if (this.#active || this.#keyTask) throw new Error("Authorization is busy");
		if (!this.#status(provider).canEnroll) throw new Error("Provider enrollment is unavailable");
		const flow: AuthorizationFlow = {
			state: { id: crypto.randomUUID(), provider, status: "authorizing", stored: this.#status(provider).stored },
			abort: new AbortController(),
			answers: [],
			promptCount: 0,
		};
		this.#active = this.#retained = flow;
		flow.timer = setTimeout(() => this.#stop(flow, "error", "Authorization timed out"), this.#deadlineMs);
		flow.task = Promise.resolve().then(async () => {
			try {
				if (!this.#live(flow)) return;
				await this.#session.modelRegistry.authStorage.login(
					provider,
					{
						signal: flow.abort.signal,
						onAuth: info => {
							if (!this.#live(flow)) throw new Error("Authorization stopped");
							try {
								flow.state.url = this.#safeUrl(flow, info.url);
								delete flow.state.verificationCode;
								if (["github-copilot", "kilo", "kimi-code", "kiro", "openai-codex-device"].includes(provider)) {
									const match = /^Enter code: ([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){0,2})$/.exec(
										info.instructions ?? "",
									);
									if (match?.[1] && !this.#containsSecret(flow, match[1]))
										flow.state.verificationCode = match[1];
								}
							} catch {
								this.#stop(flow, "error", "Provider supplied an unsafe authorization URL");
								throw new Error("Unsafe authorization URL");
							}
						},
						onPrompt: prompt => this.#prompt(flow, prompt),
						onManualCodeInput: () => this.#prompt(flow, { message: "Authorization answer required" }),
					},
					{ manualCode },
				);
				flow.state.stored = this.#status(provider).stored;
				if (!this.#live(flow)) return;
				if (!flow.state.stored) throw new Error("Provider did not store credentials");
				clearTimeout(flow.timer);
				flow.pending?.reject(new Error("Authorization completed"));
				flow.pending = undefined;
				flow.state = { id: flow.state.id, provider, status: "stored", stored: true, catalogRefreshed: false };
				flow.state.catalogRefreshed = await this.#refreshCatalog();
			} catch {
				this.#stop(flow, "error", "Authorization failed");
			} finally {
				// Providers can persist before observing cancellation. Do not report rollback.
				try {
					flow.state.stored = this.#status(provider).stored;
				} catch {
					// Storage may already be closed during retirement.
				}
				clearTimeout(flow.timer);
				flow.pending?.reject(new Error("Authorization stopped"));
				flow.pending = undefined;
				flow.answers.length = 0;
				if (this.#active === flow) this.#active = undefined;
			}
		});
		return this.#snapshot(flow);
	}

	#prompt(flow: AuthorizationFlow, prompt: OAuthPrompt): Promise<string> {
		if (!this.#live(flow)) return Promise.reject(new Error("Authorization stopped"));
		if (flow.pending || flow.promptCount >= 16) {
			this.#stop(flow, "error", "Provider authorization prompt limit exceeded");
			return Promise.reject(new Error("Authorization prompt limit exceeded"));
		}
		flow.promptCount += 1;
		const waiter = Promise.withResolvers<string>();
		void waiter.promise.catch(() => {});
		const id = crypto.randomUUID();
		flow.pending = { id, resolve: waiter.resolve, reject: waiter.reject };
		flow.state.status = "waiting";
		// Project only static labels, never provider free text which can echo keys/codes.
		const enterprisePrompt = "GitHub Enterprise URL/domain (blank for github.com)";
		flow.state.prompt = {
			id,
			message:
				flow.state.provider === "github-copilot" && prompt.message === enterprisePrompt
					? enterprisePrompt
					: "Enter the authorization answer supplied by the provider",
			allowEmpty: prompt.allowEmpty === true,
		};
		return waiter.promise;
	}

	#answer(input: Record<string, unknown>): AuthorizationFlowState {
		const flow = this.#flow(requireText(input, "flowId", 128));
		const promptId = requireText(input, "promptId", 128);
		if (!this.#live(flow) || !flow.pending || flow.pending.id !== promptId)
			throw new Error("Authorization prompt is no longer active");
		const value = input.value;
		if (
			typeof value !== "string" ||
			value.length > 32_000 ||
			/[\u0000-\u001f\u007f]/.test(value) ||
			(!value && !flow.state.prompt?.allowEmpty)
		)
			throw new Error("Invalid authorization answer");
		if (value) flow.answers.push(value);
		const pending = flow.pending;
		flow.pending = undefined;
		// A later callback must not make an already-projected URL reveal the submitted answer.
		delete flow.state.url;
		delete flow.state.verificationCode;
		delete flow.state.prompt;
		flow.state.status = "authorizing";
		pending.resolve(value);
		return this.#snapshot(flow);
	}

	async #refreshCatalog(): Promise<boolean> {
		if (!this.#current()) return false;
		try {
			await this.#session.modelRegistry.refresh("offline", this.#session.credentialSessionId);
			return this.#current();
		} catch {
			return false;
		}
	}

	async #storeKey(provider: string, key: string): Promise<AuthorizationKeyStored> {
		if (
			this.#active ||
			this.#keyTask ||
			!this.#status(provider).canStoreApiKey ||
			key.startsWith("!") ||
			key.trim() !== key
		)
			throw new Error("API key storage is unavailable");
		const task = Promise.resolve().then(async (): Promise<AuthorizationKeyStored> => {
			this.#assertCurrent();
			await this.#session.modelRegistry.authStorage.set(provider, { type: "api_key", key });
			this.#assertCurrent();
			const stored = this.#session.modelRegistry.authStorage.get(resolveOAuthStorageProvider(provider));
			if (stored?.type !== "api_key" || stored.key !== key) throw new Error("API key was not stored");
			const catalogRefreshed = await this.#refreshCatalog();
			this.#assertCurrent();
			return { provider, saved: true, catalogRefreshed };
		});
		this.#keyTask = task;
		try {
			return await task;
		} finally {
			if (this.#keyTask === task) this.#keyTask = undefined;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#signal?.removeEventListener("abort", this.#onAbort);
		for (const unregister of this.#unregister.splice(0)) unregister();
		const flow = this.#active;
		if (flow) this.#stop(flow, "cancelled");
		const tasks: Promise<unknown>[] = [];
		if (flow?.task) tasks.push(flow.task);
		if (this.#keyTask) tasks.push(this.#keyTask);
		if (tasks.length === 0) return;
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(() => deadline.reject(new Error("Authorization provider did not stop")), this.#joinMs);
		try {
			await Promise.race([Promise.allSettled(tasks), deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	}
}
