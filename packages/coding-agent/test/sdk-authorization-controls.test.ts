import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { OAuthLoginCallbacks, OAuthPrompt } from "@gajae-code/ai/utils/oauth/types";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	type AuthorizationControlResult,
	AuthorizationControls,
	type AuthorizationFlowState,
	type AuthorizationProviderStatus,
	isAuthorizationControlOperation,
} from "@gajae-code/coding-agent/sdk/authorization-controls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { hookFetch } from "@gajae-code/utils";

function flow(result: AuthorizationControlResult): AuthorizationFlowState {
	if (Array.isArray(result) || !("status" in result)) throw new Error("Expected authorization flow");
	return result;
}

function providerStatus(result: AuthorizationControlResult): AuthorizationProviderStatus {
	if (Array.isArray(result) || !("credentialKinds" in result)) throw new Error("Expected provider status");
	return result;
}

async function observe(
	controls: AuthorizationControls,
	id: string,
	predicate: (state: AuthorizationFlowState) => boolean,
): Promise<AuthorizationFlowState> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const state = flow(await controls.execute("auth.read", { flowId: id }));
		if (predicate(state)) return state;
		await Bun.sleep(1);
	}
	throw new Error("Authorization flow did not reach expected state");
}

function promptId(state: AuthorizationFlowState): string {
	if (!state.prompt) throw new Error("Expected authorization prompt");
	return state.prompt.id;
}

describe("SDK secure-local authorization controls", () => {
	let dir: string;
	let auth: AuthStorage;
	let session: AgentSession;
	let controls: AuthorizationControls;
	const restore: (() => void)[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-auth-"));
		auth = await AuthStorage.create(path.join(dir, "auth.db"));
		const registry = new ModelRegistry(auth, path.join(dir, "models.json"), Settings.isolated());
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		const refresh = spyOn(registry, "refresh").mockResolvedValue(undefined);
		restore.push(() => refresh.mockRestore());
		controls = new AuthorizationControls(session);
	});

	afterEach(async () => {
		await controls.close();
		await session.dispose();
		for (const cleanup of restore.splice(0).reverse()) cleanup();
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("runs the actual MiniMax provider callbacks and persists the answered API key", async () => {
		using _fetch = hookFetch(
			() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const login = spyOn(auth, "login");
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "minimax-code", manualCode: true }));
		const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
		expect(waiting.url).toBe("https://platform.minimax.io/subscribe/coding-plan");
		const answer = "sk-sdk-real-minimax-secret";
		const answered = flow(
			await controls.execute("auth.answer", {
				flowId: admitted.id,
				promptId: promptId(waiting),
				value: answer,
			}),
		);
		expect(answered.status).toBe("authorizing");
		expect(answered.prompt).toBeUndefined();
		expect(answered.url).toBeUndefined();
		const stored = await observe(
			controls,
			admitted.id,
			state => state.status === "stored" && state.catalogRefreshed === true,
		);
		expect(stored).toEqual({
			id: admitted.id,
			provider: "minimax-code",
			status: "stored",
			stored: true,
			catalogRefreshed: true,
		});
		expect(auth.get("minimax-code")).toEqual({ type: "api_key", key: answer });
		expect(login).toHaveBeenCalledTimes(1);
		expect(login.mock.calls[0]?.[2]).toEqual({ manualCode: true });
		expect(JSON.stringify([admitted, waiting, answered, stored, controls])).not.toContain(answer);
		expect(await controls.execute("auth.status", { provider: "minimax-code" })).toMatchObject({
			stored: true,
			configured: true,
			credentialKinds: ["api_key"],
		});
	});

	it("recovers a discarded start admission through session-wide status without projecting private presentation", async () => {
		expect(providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow).toBeUndefined();
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/private-enrollment" });
			await callbacks.onPrompt({ message: "private-provider-prompt" });
		});
		restore.push(() => login.mockRestore());
		// Deliberately discard the admission reply: no flow selector is retained by the caller.
		await controls.execute("auth.start", { provider: "anthropic" });
		await expect(controls.execute("auth.start", { provider: "anthropic" })).rejects.toThrow(
			"Authorization operation failed",
		);
		const recovered = providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow;
		if (!recovered) throw new Error("Expected retained session flow recovery metadata");
		const waiting = await observe(controls, recovered.flowId, state => state.status === "waiting");
		expect(waiting.url).toBe("https://example.com/private-enrollment");
		expect(waiting.prompt).toBeDefined();
		const status = providerStatus(await controls.execute("auth.status", { provider: "anthropic" }));
		expect(status.flow).toEqual({ flowId: waiting.id, status: "waiting", providerSettled: false });
		expect(JSON.stringify(status)).not.toContain("private-enrollment");
		expect(JSON.stringify(status)).not.toContain("private-provider-prompt");
		expect(JSON.stringify(status)).not.toContain(promptId(waiting));
		expect(
			providerStatus(await controls.execute("auth.status", { provider: "github-copilot" })).flow,
		).toBeUndefined();
		const inventory = await controls.execute("auth.providers.status", {});
		if (!Array.isArray(inventory)) throw new Error("Expected provider inventory");
		expect(inventory.every(provider => !("flow" in provider))).toBe(true);
		expect(flow(await controls.execute("auth.cancel", { flowId: recovered.flowId })).status).toBe("cancelled");
		expect(login).toHaveBeenCalledTimes(1);
	});

	it("reports cancellation separately from provider settlement and retires recovery metadata on supersession", async () => {
		const release = Promise.withResolvers<void>();
		const login = spyOn(auth, "login").mockImplementation(async () => {
			await release.promise;
		});
		restore.push(() => login.mockRestore());
		try {
			await controls.execute("auth.start", { provider: "anthropic" });
			const recovered = providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow;
			if (!recovered) throw new Error("Expected retained session flow recovery metadata");
			await controls.execute("auth.cancel", { flowId: recovered.flowId });
			expect(providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow).toEqual({
				flowId: recovered.flowId,
				status: "cancelled",
				providerSettled: false,
			});
			await expect(controls.execute("auth.start", { provider: "github-copilot" })).rejects.toThrow(
				"Authorization operation failed",
			);
			release.resolve();
			await Bun.sleep(1);
			expect(providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow).toEqual({
				flowId: recovered.flowId,
				status: "cancelled",
				providerSettled: true,
			});
			const next = flow(await controls.execute("auth.start", { provider: "github-copilot" }));
			expect(next.id).not.toBe(recovered.flowId);
			expect(providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow).toBeUndefined();
		} finally {
			release.resolve();
		}
	});

	it("stores literal keys in real storage and returns payload-free provider status", async () => {
		const key = "sdk-api-key-not-public";
		expect(await controls.execute("auth.apiKey.store", { provider: "anthropic", key })).toEqual({
			provider: "anthropic",
			saved: true,
			catalogRefreshed: true,
		});
		expect(auth.get("anthropic")).toEqual({ type: "api_key", key });
		const listed = await controls.execute("auth.providers.status", {});
		expect(listed).toContainEqual({
			provider: "anthropic",
			canEnroll: true,
			canStoreApiKey: true,
			stored: true,
			configured: true,
			credentialKinds: ["api_key"],
		});
		expect(JSON.stringify(listed)).not.toContain(key);
		const persisted = await AuthStorage.create(path.join(dir, "auth.db"));
		try {
			expect(persisted.get("anthropic")).toEqual({ type: "api_key", key });
		} finally {
			persisted.close();
		}
	});

	it("does not claim saved credentials when storage rejects, but preserves a saved key when refresh fails", async () => {
		const set = spyOn(auth, "set").mockRejectedValue(new Error("credential-bearing storage exception"));
		try {
			await expect(
				controls.execute("auth.apiKey.store", { provider: "anthropic", key: "secret-one" }),
			).rejects.toThrow("Authorization operation failed or is no longer available");
			expect(auth.get("anthropic")).toBeUndefined();
		} finally {
			set.mockRestore();
		}
		const refresh = spyOn(session.modelRegistry, "refresh").mockRejectedValue(new Error("secret catalog text"));
		try {
			expect(await controls.execute("auth.apiKey.store", { provider: "anthropic", key: "secret-two" })).toEqual({
				provider: "anthropic",
				saved: true,
				catalogRefreshed: false,
			});
			expect(auth.get("anthropic")).toEqual({ type: "api_key", key: "secret-two" });
		} finally {
			refresh.mockRestore();
		}
	});

	it("rejects stale prompts, empty/oversized answers and provider exception secrets", async () => {
		let received = "";
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			received = await callbacks.onPrompt({ message: "secret-before-prompt", placeholder: "secret-placeholder" });
			throw new Error(received);
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
		expect(JSON.stringify(waiting)).not.toContain("secret-");
		for (const input of [
			{ flowId: "stale", promptId: promptId(waiting), value: "secret-answer" },
			{ flowId: admitted.id, promptId: "stale", value: "secret-answer" },
			{ flowId: admitted.id, promptId: promptId(waiting), value: "" },
			{ flowId: admitted.id, promptId: promptId(waiting), value: "x".repeat(32_001) },
		])
			await expect(controls.execute("auth.answer", input)).rejects.toThrow("Authorization operation failed");
		expect(received).toBe("");
		await controls.execute("auth.answer", {
			flowId: admitted.id,
			promptId: promptId(waiting),
			value: "secret-answer",
		});
		await expect(
			controls.execute("auth.answer", { flowId: admitted.id, promptId: promptId(waiting), value: "secret-replay" }),
		).rejects.toThrow("Authorization operation failed");
		const failed = await observe(controls, admitted.id, state => state.status === "error");
		expect(received).toBe("secret-answer");
		expect(failed.error).toBe("Authorization failed");
		expect(JSON.stringify(failed)).not.toContain("secret");
	});

	it("holds the concurrency slot through cancellation and reports late persisted credentials honestly", async () => {
		const release = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			signal = callbacks.signal;
			await release.promise;
			await auth.set("anthropic", { type: "api_key", key: "late-secret" });
			settled.resolve();
		});
		restore.push(() => login.mockRestore());
		try {
			const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
			await Bun.sleep(1);
			const cancelled = flow(await controls.execute("auth.cancel", { flowId: admitted.id }));
			expect(cancelled.status).toBe("cancelled");
			expect(signal?.aborted).toBe(true);
			await expect(controls.execute("auth.start", { provider: "anthropic" })).rejects.toThrow(
				"Authorization operation failed",
			);
			await expect(
				controls.execute("auth.apiKey.store", { provider: "anthropic", key: "other-secret" }),
			).rejects.toThrow("Authorization operation failed");
			release.resolve();
			await settled.promise;
			const late = await observe(controls, admitted.id, state => state.stored);
			expect(late.status).toBe("cancelled");
			expect(late.url).toBeUndefined();
			expect(JSON.stringify(late)).not.toContain("late-secret");
			await Bun.sleep(1);
			const next = flow(await controls.execute("auth.start", { provider: "anthropic" }));
			expect(next.id).not.toBe(admitted.id);
			await expect(controls.execute("auth.read", { flowId: admitted.id })).rejects.toThrow(
				"Authorization operation failed",
			);
			await observe(controls, next.id, state => state.status === "stored");
		} finally {
			release.resolve();
		}
	});

	it("rejects an outstanding answer on cancellation and removes authorization presentation", async () => {
		let rejected = false;
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/authorize", instructions: "secret-instructions" });
			try {
				await callbacks.onPrompt({ message: "secret-prompt" });
			} catch {
				rejected = true;
				throw new Error("secret-provider-error");
			}
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
		const cancelled = flow(await controls.execute("auth.cancel", { flowId: admitted.id }));
		expect(cancelled).toEqual({ id: admitted.id, provider: "anthropic", status: "cancelled", stored: false });
		await expect(
			controls.execute("auth.answer", { flowId: admitted.id, promptId: promptId(waiting), value: "secret" }),
		).rejects.toThrow("Authorization operation failed");
		await Bun.sleep(1);
		expect(rejected).toBe(true);
	});

	for (const url of [
		"http://example.com/login",
		"javascript:alert(1)",
		"https://username:password@example.com/login",
		"https://example.com/login?access_token=secret",
		"https://example.com/login?code=credential-code",
		"https://example.com/login?id_token_add_organizations=credential-token",
		"https://example.com/login?%2561ccess_token=secret",
		"https://example.com/login#access_token=secret",
		"https://example.com/login?next=%250Aunsafe",
		"https://example.com/\nlogin",
		"https://example.com/login?state=persisted-secret",
		"https://example.com/login?state=persisted%252Dsecret",
	]) {
		it(`rejects unsafe authorization URL ${JSON.stringify(url)}`, async () => {
			await auth.set("anthropic", { type: "api_key", key: "persisted-secret" });
			const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
				callbacks.onAuth({ url });
			});
			restore.push(() => login.mockRestore());
			const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
			const failed = await observe(controls, admitted.id, state => state.status === "error");
			expect(failed.url).toBeUndefined();
			expect(failed.error).toBe("Provider supplied an unsafe authorization URL");
			expect(JSON.stringify(failed)).not.toContain("persisted-secret");
		});
	}

	it("exposes only the narrow ephemeral device challenge and clears it on settlement", async () => {
		const release = Promise.withResolvers<void>();
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://github.com/login/device", instructions: "Enter code: ABCD-EFGH" });
			await release.promise;
			await auth.set("github-copilot", {
				type: "oauth",
				access: "secret-access-token",
				refresh: "secret-refresh-token",
				expires: Date.now() + 60_000,
			});
		});
		restore.push(() => login.mockRestore());
		try {
			const admitted = flow(await controls.execute("auth.start", { provider: "github-copilot" }));
			const presented = await observe(controls, admitted.id, state => state.verificationCode !== undefined);
			expect(presented.verificationCode).toBe("ABCD-EFGH");
			release.resolve();
			const stored = await observe(controls, admitted.id, state => state.status === "stored");
			expect(stored.verificationCode).toBeUndefined();
			expect(stored.url).toBeUndefined();
			expect(JSON.stringify([presented, stored])).not.toContain("secret-");
		} finally {
			release.resolve();
		}
	});

	it("answers manual-code callbacks and rejects provider URLs that echo submitted answers", async () => {
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			const manual = (callbacks as OAuthLoginCallbacks).onManualCodeInput;
			if (!manual) throw new Error("Missing manual code callback");
			const value = await manual();
			callbacks.onAuth({ url: `https://example.com/login?state=${encodeURIComponent(value)}` });
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
		await controls.execute("auth.answer", { flowId: admitted.id, promptId: promptId(waiting), value: "secret/code" });
		const failed = await observe(controls, admitted.id, state => state.status === "error");
		expect(failed.error).toBe("Provider supplied an unsafe authorization URL");
		expect(JSON.stringify(failed)).not.toContain("secret");
	});

	it("rejects overlapping callbacks and no-storage provider success", async () => {
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			await Promise.all([callbacks.onPrompt({ message: "First" }), callbacks.onPrompt({ message: "Second" })]);
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const failed = await observe(controls, admitted.id, state => state.status === "error");
		expect(failed.error).toBe("Provider authorization prompt limit exceeded");
		await Bun.sleep(1);
		login.mockResolvedValue(undefined);
		const next = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const noStorage = await observe(controls, next.id, state => state.status === "error");
		expect(noStorage.stored).toBe(false);
		expect(noStorage.error).toBe("Authorization failed");
	});

	it("bounds prompt retention and honors allowEmpty", async () => {
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			const prompt: OAuthPrompt = { message: "Continue", allowEmpty: true };
			for (let index = 0; index < 17; index += 1) await callbacks.onPrompt(prompt);
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		let previous = "";
		for (let index = 0; index < 16; index += 1) {
			const waiting = await observe(
				controls,
				admitted.id,
				state => state.status === "waiting" && state.prompt?.id !== previous,
			);
			previous = promptId(waiting);
			expect(waiting.prompt?.allowEmpty).toBe(true);
			await controls.execute("auth.answer", { flowId: admitted.id, promptId: previous, value: "" });
		}
		const failed = await observe(controls, admitted.id, state => state.status === "error");
		expect(failed.error).toBe("Provider authorization prompt limit exceeded");
		expect(failed.prompt).toBeUndefined();
	});

	it("accepts ordinary HTTPS PKCE parameters and static console fragments", async () => {
		let index = 0;
		const urls = [
			{
				provider: "anthropic",
				url: "https://example.com/oauth?code=true&response_type=code&code_challenge=public-pkce-challenge&state=public-nonce",
			},
			{ provider: "anthropic", url: "https://example.com/studio/#api-keys" },
			{
				provider: "openai-codex",
				url: "https://example.com/oauth?response_type=code&id_token_add_organizations=true&codex_cli_simplified_flow=true",
			},
		];
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.onAuth({ url: urls[index++]!.url });
			await callbacks.onPrompt({ message: "Paste code" });
		});
		restore.push(() => login.mockRestore());
		for (const { provider, url } of urls) {
			const admitted = flow(await controls.execute("auth.start", { provider }));
			const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
			expect(waiting.url).toBe(url);
			await controls.execute("auth.cancel", { flowId: admitted.id });
			await Bun.sleep(1);
		}
	});

	it("cancels an active provider during actual session disposal", async () => {
		let aborted = false;
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			callbacks.signal?.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			await callbacks.onPrompt({ message: "Wait" });
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		await observe(controls, admitted.id, state => state.status === "waiting");
		await session.dispose();
		expect(aborted).toBe(true);
		await expect(controls.execute("auth.read", { flowId: admitted.id })).rejects.toThrow(
			"Authorization service is no longer active",
		);
		expect(auth.get("anthropic")).toBeUndefined();
	});

	it("does not return success for a key write that outlives its session identity", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const originalSet = auth.set.bind(auth);
		const set = spyOn(auth, "set").mockImplementation(async (provider, credential) => {
			entered.resolve();
			await release.promise;
			await originalSet(provider, credential);
		});
		restore.push(() => set.mockRestore());
		const pending = controls.execute("auth.apiKey.store", { provider: "anthropic", key: "late-key" });
		void pending.catch(() => {});
		await entered.promise;
		const identity = spyOn(session.sessionManager, "getSessionId").mockReturnValue("replacement");
		try {
			release.resolve();
			await expect(pending).rejects.toThrow("Authorization operation failed or is no longer available");
			expect(auth.get("anthropic")).toEqual({ type: "api_key", key: "late-key" });
		} finally {
			identity.mockRestore();
			release.resolve();
		}
	});

	it("fences same-ID identity generation changes, host retirement and session disposal", async () => {
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			await callbacks.onPrompt({ message: "Wait" });
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const waiting = await observe(controls, admitted.id, state => state.status === "waiting");
		const generation = session.sessionManager.getSessionIdentityGeneration();
		const identity = spyOn(session.sessionManager, "getSessionIdentityGeneration").mockReturnValue(generation + 1);
		try {
			await expect(
				controls.execute("auth.answer", { flowId: admitted.id, promptId: promptId(waiting), value: "secret" }),
			).rejects.toThrow("Authorization service is no longer active");
		} finally {
			identity.mockRestore();
		}
		await expect(controls.execute("auth.status", { provider: "anthropic" })).rejects.toThrow(
			"Authorization service is no longer active",
		);
		const lifetime = new AbortController();
		const retired = new AuthorizationControls(session, { signal: lifetime.signal });
		lifetime.abort();
		await expect(retired.execute("auth.apiKey.store", { provider: "anthropic", key: "secret" })).rejects.toThrow(
			"Authorization service is no longer active",
		);
		await retired.close();
		const disposed = new AuthorizationControls(session);
		await session.dispose();
		await expect(disposed.execute("auth.status", { provider: "anthropic" })).rejects.toThrow(
			"Authorization service is no longer active",
		);
		expect(auth.get("anthropic")).toBeUndefined();
	});

	it("bounds close for an abort-ignoring provider and rejects callbacks after retirement", async () => {
		await controls.close();
		controls = new AuthorizationControls(session, { joinMs: 5 });
		const release = Promise.withResolvers<void>();
		let callbacks: OAuthLoginCallbacks | undefined;
		const login = spyOn(auth, "login").mockImplementation(async (_provider, value) => {
			callbacks = value;
			await release.promise;
		});
		restore.push(() => login.mockRestore());
		try {
			await controls.execute("auth.start", { provider: "anthropic" });
			await Bun.sleep(1);
			await expect(controls.close()).rejects.toThrow("Authorization provider did not stop");
			if (!callbacks) throw new Error("Expected provider callbacks");
			expect(() => callbacks?.onAuth({ url: "https://example.com/login" })).toThrow("Authorization stopped");
			release.resolve();
			await controls.close();
		} finally {
			release.resolve();
		}
	});

	it("expires pending flows and validates literal keys and closed operation names", async () => {
		await controls.close();
		controls = new AuthorizationControls(session, { deadlineMs: 5 });
		const login = spyOn(auth, "login").mockImplementation(async (_provider, callbacks) => {
			await callbacks.onPrompt({ message: "Wait" });
		});
		restore.push(() => login.mockRestore());
		const admitted = flow(await controls.execute("auth.start", { provider: "anthropic" }));
		const expired = await observe(controls, admitted.id, state => state.status === "error");
		expect(expired.error).toBe("Authorization timed out");
		await Bun.sleep(1);
		expect(providerStatus(await controls.execute("auth.status", { provider: "anthropic" })).flow).toEqual({
			flowId: admitted.id,
			status: "error",
			providerSettled: true,
		});
		for (const key of ["", "!echo credential", " key ", "key\nvalue"]) {
			await expect(controls.execute("auth.apiKey.store", { provider: "anthropic", key })).rejects.toThrow(
				"Authorization operation failed",
			);
		}
		await expect(controls.execute("auth.start", { provider: "opencodex" })).rejects.toThrow(
			"Authorization operation failed",
		);
		await expect(controls.execute("auth.status", { provider: "../../unknown" })).rejects.toThrow(
			"Authorization operation failed",
		);
		await expect(
			controls.execute("auth.status", { provider: "anthropic", key: "unexpected-secret" }),
		).rejects.toThrow("Authorization operation failed");
		expect(isAuthorizationControlOperation("auth.login.arbitrary")).toBe(false);
		expect(isAuthorizationControlOperation("auth.providers")).toBe(false);
		expect(isAuthorizationControlOperation("auth.apiKey.store")).toBe(true);
		expect(auth.get("anthropic")).toBeUndefined();
	});
});
