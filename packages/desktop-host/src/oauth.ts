import * as crypto from "node:crypto";
import { getOAuthProviders } from "@gajae-code/ai";
import type { OAuthLoginCallbacks, OAuthPrompt } from "@gajae-code/ai/utils/oauth/types";
import type { DesktopAuthProvider, DesktopAuthState } from "./protocol";

export interface DesktopLoginService {
	login(provider: string, callbacks: OAuthLoginCallbacks): Promise<void>;
}
interface Flow {
	state: DesktopAuthState;
	abort: AbortController;
	answers: string[];
	timer?: Timer;
	task?: Promise<void>;
	pending?: { id: string; resolve: (value: string) => void; reject: (reason: Error) => void };
}
interface OAuthOptions {
	service: DesktopLoginService;
	emit: (state: DesktopAuthState) => void;
	redact: (text: string) => string;
	onStored: () => Promise<void>;
	providers?: () => DesktopAuthProvider[];
	deadlineMs?: number;
	joinMs?: number;
}

/** One app-owned flow; an aborted provider retains its slot until it actually settles. */
export class DesktopOAuthController {
	#options: OAuthOptions;
	#flow?: Flow;
	#active?: Flow;
	#closed = false;
	constructor(options: OAuthOptions) {
		this.#options = options;
	}
	providers(): DesktopAuthProvider[] {
		return (
			this.#options.providers?.() ??
			getOAuthProviders()
				.filter(provider => provider.available && provider.id !== "opencodex")
				.map(({ id, name }) => ({ id, name }))
		);
	}
	isActive(): boolean {
		return this.#active !== undefined;
	}
	state(): DesktopAuthState | null {
		return this.#flow ? structuredClone(this.#flow.state) : null;
	}
	#redactText(flow: Flow, text: string): string {
		for (const answer of flow.answers) text = text.split(answer).join("[redacted]");
		return this.#options.redact(text);
	}
	#publish(flow: Flow): void {
		this.#options.emit(structuredClone(flow.state));
	}
	#live(flow: Flow): boolean {
		return (
			this.#active === flow &&
			!flow.abort.signal.aborted &&
			(flow.state.status === "authorizing" || flow.state.status === "waiting")
		);
	}
	#stop(flow: Flow, status: "cancelled" | "error", error?: string): void {
		if (!this.#live(flow)) return;
		clearTimeout(flow.timer);
		flow.state = {
			id: flow.state.id,
			provider: flow.state.provider,
			status,
			...(error ? { error } : {}),
			instructions: "Authorization stopped. Credentials already saved by the provider are not removed.",
		};
		flow.abort.abort();
		flow.pending?.reject(new Error("Authorization stopped"));
		flow.pending = undefined;
		this.#publish(flow);
	}
	login(provider: string): DesktopAuthState {
		if (this.#closed) throw new Error("Authorization controller is closed");
		if (this.#active) throw new Error("An authorization flow is already active");
		if (!this.providers().some(item => item.id === provider)) throw new Error("Unknown authorization provider");
		const flow: Flow = {
			state: { id: crypto.randomUUID(), provider, status: "authorizing" },
			abort: new AbortController(),
			answers: [],
		};
		this.#flow = this.#active = flow;
		flow.timer = setTimeout(
			() => this.#stop(flow, "error", "Authorization timed out"),
			this.#options.deadlineMs ?? 300_000,
		);
		this.#publish(flow);
		const admitted = this.state()!;
		flow.task = Promise.resolve().then(async () => {
			let loginSucceeded = false;
			try {
				if (!this.#live(flow)) return;
				await this.#options.service.login(provider, {
					signal: flow.abort.signal,
					onAuth: info => {
						if (!this.#live(flow)) return;
						let url: URL;
						try {
							url = new URL(info.url);
							if (
								url.protocol !== "https:" ||
								url.username ||
								url.password ||
								info.url.length > 8192 ||
								/[\u0000-\u001f\u007f]/.test(info.url) ||
								this.#options.redact(info.url) !== info.url
							)
								throw new Error("Invalid URL");
						} catch {
							this.#stop(flow, "error", "Provider supplied an unsafe authorization URL");
							throw new Error("Unsafe authorization URL");
						}
						flow.state.url = url.href;
						flow.state.instructions = info.instructions
							? this.#redactText(flow, info.instructions).slice(0, 4000)
							: undefined;
						this.#publish(flow);
					},
					onPrompt: prompt => this.#prompt(flow, prompt),
					onManualCodeInput: () => this.#prompt(flow, { message: "Paste the authorization code or redirect URL" }),
				});
				loginSucceeded = true;
				// AuthStorage may persist before observing abort. Always collect new secrets.
				await this.#options.onStored();
				if (this.#live(flow)) {
					flow.pending?.reject(new Error("Authorization completed"));
					flow.pending = undefined;
					flow.state = { id: flow.state.id, provider, status: "complete" };
					this.#publish(flow);
				}
			} catch {
				this.#stop(
					flow,
					"error",
					loginSucceeded ? "Credentials were saved, but model catalog refresh failed" : "Authorization failed",
				);
			} finally {
				clearTimeout(flow.timer);
				flow.answers.length = 0;
				if (this.#active === flow) this.#active = undefined;
			}
		});
		return admitted;
	}
	#prompt(flow: Flow, prompt: OAuthPrompt): Promise<string> {
		if (!this.#live(flow)) return Promise.reject(new Error("Authorization stopped"));
		if (flow.pending) {
			this.#stop(flow, "error", "Provider requested overlapping authorization prompts");
			return Promise.reject(new Error("Overlapping prompts"));
		}
		const waiter = Promise.withResolvers<string>();
		// Some providers race manual input against a callback server.
		void waiter.promise.catch(() => {});
		const id = crypto.randomUUID();
		flow.pending = { id, resolve: waiter.resolve, reject: waiter.reject };
		flow.state.status = "waiting";
		flow.state.prompt = {
			id,
			message: this.#redactText(flow, prompt.message).slice(0, 4000),
			allowEmpty: prompt.allowEmpty === true,
			...(prompt.placeholder ? { placeholder: this.#redactText(flow, prompt.placeholder).slice(0, 1000) } : {}),
		};
		this.#publish(flow);
		return waiter.promise;
	}
	answer(flowId: string, promptId: string, value: string): DesktopAuthState {
		const flow = this.#active;
		if (!flow || !this.#live(flow) || flow.state.id !== flowId || flow.pending?.id !== promptId)
			throw new Error("Authorization prompt is no longer active");
		if (value.length > 32_000 || value.includes("\0")) throw new Error("Invalid authorization answer");
		if (!value && !flow.state.prompt?.allowEmpty) throw new Error("Authorization answer is required");
		if (value) flow.answers.push(value);
		const pending = flow.pending;
		flow.pending = undefined;
		delete flow.state.prompt;
		flow.state.status = "authorizing";
		pending.resolve(value);
		this.#publish(flow);
		return this.state()!;
	}
	cancel(flowId: string): DesktopAuthState {
		const flow = this.#active;
		if (!flow || flow.state.id !== flowId || !this.#live(flow))
			throw new Error("Authorization flow is no longer active");
		this.#stop(flow, "cancelled");
		return this.state()!;
	}
	async close(): Promise<void> {
		this.#closed = true;
		const flow = this.#active;
		if (!flow) return;
		this.#stop(flow, "cancelled");
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => deadline.reject(new Error("Authorization provider did not stop")),
			this.#options.joinMs ?? 1000,
		);
		try {
			await Promise.race([flow.task, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	}
}
