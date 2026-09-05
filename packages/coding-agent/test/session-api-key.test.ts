import { describe, expect, it } from "bun:test";
import {
	isStableSessionApiKeyCredentialType,
	lookupSessionApiKey,
	resolveLiveSessionApiKeyModel,
} from "../src/sdk/session-api-key";

describe("lookupSessionApiKey (#5081)", () => {
	it("uses getApiKey(model) when the active model matches the provider, even if getApiKeyForProvider is empty", async () => {
		const calls: string[] = [];
		const key = await lookupSessionApiKey(
			{
				async getApiKey(model) {
					calls.push(`model:${model.provider}`);
					return "model-scoped-token";
				},
				async getApiKeyForProvider(provider) {
					calls.push(`provider:${provider}`);
					return undefined;
				},
			},
			"anthropic",
			"parent-credential-scope",
			{ provider: "anthropic" },
		);
		expect(key.apiKey).toBe("model-scoped-token");
		expect(key.credentialSessionId).toBe("parent-credential-scope");
		expect(calls).toEqual(["model:anthropic"]);
	});

	it("falls back to getApiKeyForProvider when the matching model-scoped lookup misses", async () => {
		const calls: string[] = [];
		const key = await lookupSessionApiKey(
			{
				async getApiKey(model) {
					calls.push(`model:${model.provider}`);
					return undefined;
				},
				async getApiKeyForProvider(provider) {
					calls.push(`provider:${provider}`);
					return "provider-token";
				},
			},
			"anthropic",
			"scope",
			{ provider: "anthropic" },
		);
		expect(key.apiKey).toBe("provider-token");
		expect(calls).toEqual(["model:anthropic", "provider:anthropic"]);
	});

	it("falls back to getApiKeyForProvider when no model is bound", async () => {
		const key = await lookupSessionApiKey(
			{
				async getApiKey() {
					throw new Error("getApiKey should not run");
				},
				async getApiKeyForProvider() {
					return "provider-token";
				},
			},
			"anthropic",
			"scope",
			undefined,
		);
		expect(key.apiKey).toBe("provider-token");
	});

	it("throws provider_unavailable without leaking a token when both lookups miss", async () => {
		try {
			await lookupSessionApiKey(
				{
					async getApiKey() {
						return undefined;
					},
					async getApiKeyForProvider() {
						return undefined;
					},
				},
				"anthropic",
				"scope",
				{ provider: "anthropic" },
			);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe('No API key found for provider "anthropic"');
			expect((error as { code?: string }).code).toBe("provider_unavailable");
		}
	});

	it("prefers the matching live model, then the matching captured model", () => {
		const live = { provider: "anthropic", baseUrl: "https://live.example" };
		const captured = { provider: "anthropic", baseUrl: "https://captured.example" };
		expect(resolveLiveSessionApiKeyModel(live, captured, "anthropic")).toEqual(live);
		expect(resolveLiveSessionApiKeyModel({ provider: "openai" }, captured, "anthropic")).toEqual(captured);
		expect(resolveLiveSessionApiKeyModel(live, captured, "google")).toBeUndefined();
	});

	it("retries without sessionId when the scoped lookups miss (architect child vs --no-session)", async () => {
		const calls: string[] = [];
		const key = await lookupSessionApiKey(
			{
				async getApiKey(model, sessionId) {
					calls.push(`model:${model.provider}:${sessionId ?? "none"}`);
					return sessionId ? undefined : "broker-oauth-token";
				},
				async getApiKeyForProvider(provider, sessionId) {
					calls.push(`provider:${provider}:${sessionId ?? "none"}`);
					return undefined;
				},
			},
			"anthropic",
			"parent-sid",
			{ provider: "anthropic" },
		);
		expect(key.apiKey).toBe("broker-oauth-token");
		expect(key.credentialSessionId).toBeUndefined();
		expect(calls).toEqual(["model:anthropic:parent-sid", "provider:anthropic:parent-sid", "model:anthropic:none"]);
	});

	it("keeps a mismatched live model out of both scoped and unscoped provider lookups", async () => {
		const calls: string[] = [];
		const key = await lookupSessionApiKey(
			{
				async getApiKey(model) {
					calls.push(`model:${model.provider}`);
					return "wrong-provider-token";
				},
				async getApiKeyForProvider(provider, sessionId, baseUrl) {
					calls.push(`provider:${provider}:${sessionId ?? "none"}:${baseUrl ?? "default"}`);
					return sessionId ? undefined : "anthropic-token";
				},
			},
			"anthropic",
			"parent-sid",
			{ provider: "openai", baseUrl: "https://openai.example" },
		);
		expect(key.apiKey).toBe("anthropic-token");
		expect(calls).toEqual(["provider:anthropic:parent-sid:default", "provider:anthropic:none:default"]);
	});

	it("preserves model baseUrl and signal through the full unscoped fallback order", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const signals: Array<AbortSignal | undefined> = [];
		const key = await lookupSessionApiKey(
			{
				async getApiKey(model, sessionId, options) {
					calls.push(`model:${sessionId ?? "none"}:${model.baseUrl}`);
					signals.push(options?.signal);
					return undefined;
				},
				async getApiKeyForProvider(provider, sessionId, baseUrl, options) {
					calls.push(`provider:${provider}:${sessionId ?? "none"}:${baseUrl}`);
					signals.push(options?.signal);
					return sessionId ? undefined : "provider-token";
				},
			},
			"anthropic",
			"parent-sid",
			{ provider: "anthropic", baseUrl: "https://gateway.example" },
			true,
			controller.signal,
		);
		expect(key.apiKey).toBe("provider-token");
		expect(calls).toEqual([
			"model:parent-sid:https://gateway.example",
			"provider:anthropic:parent-sid:https://gateway.example",
			"model:none:https://gateway.example",
			"provider:anthropic:none:https://gateway.example",
		]);
		expect(signals).toEqual([controller.signal, controller.signal, controller.signal, controller.signal]);
	});

	it("settles a blocked replacement lookup on cancellation without starting a later lookup", async () => {
		const controller = new AbortController();
		const lookupStarted = Promise.withResolvers<AbortSignal>();
		const abortObserved = Promise.withResolvers<void>();
		const lookupStopped = Promise.withResolvers<void>();
		const abortReason = new DOMException("replacement lookup cancelled", "AbortError");
		const calls: string[] = [];
		const lookup = lookupSessionApiKey(
			{
				async getApiKey(_model, sessionId, options) {
					calls.push(`model:${sessionId ?? "none"}`);
					const signal = options?.signal;
					if (!signal) throw new Error("expected replacement lookup signal");
					lookupStarted.resolve(signal);
					const onAbort = (): void => abortObserved.resolve();
					signal.addEventListener("abort", onAbort, { once: true });
					try {
						if (!signal.aborted) await abortObserved.promise;
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
					try {
						signal.throwIfAborted();
						return undefined;
					} finally {
						lookupStopped.resolve();
					}
				},
				async getApiKeyForProvider(_provider, sessionId, _baseUrl, options) {
					calls.push(`provider:${sessionId ?? "none"}`);
					expect(options?.signal).toBe(controller.signal);
					return undefined;
				},
			},
			"anthropic",
			"parent-sid",
			{ provider: "anthropic" },
			true,
			controller.signal,
		);
		const settlement = lookup.then(
			() => "resolved" as const,
			error => error,
		);

		const forwardedSignal = await lookupStarted.promise;
		controller.abort(abortReason);
		await lookupStopped.promise;

		expect(forwardedSignal).toBe(controller.signal);
		expect(await settlement).toBe(abortReason);
		expect(calls).toEqual(["model:parent-sid"]);
	});

	it("does not widen credential authority after a scoped lookup error", async () => {
		const scopedError = Object.assign(new Error("pinned credential is unavailable"), {
			code: "credential_unavailable",
		});
		const calls: string[] = [];
		await expect(
			lookupSessionApiKey(
				{
					async getApiKey(_model, sessionId) {
						calls.push(`model:${sessionId ?? "none"}`);
						throw scopedError;
					},
					async getApiKeyForProvider(_provider, sessionId) {
						calls.push(`provider:${sessionId ?? "none"}`);
						return "broader-token";
					},
				},
				"anthropic",
				"parent-sid",
				{ provider: "anthropic" },
			),
		).rejects.toBe(scopedError);
		expect(calls).toEqual(["model:parent-sid"]);
	});

	it("does not retry unscoped when the session has explicit credential policy", async () => {
		const calls: string[] = [];
		await expect(
			lookupSessionApiKey(
				{
					async getApiKey(_model, sessionId) {
						calls.push(`model:${sessionId ?? "none"}`);
						return undefined;
					},
					async getApiKeyForProvider(_provider, sessionId) {
						calls.push(`provider:${sessionId ?? "none"}`);
						return sessionId ? undefined : "broader-token";
					},
				},
				"anthropic",
				"parent-sid",
				{ provider: "anthropic" },
				false,
			),
		).rejects.toMatchObject({ code: "provider_unavailable" });
		expect(calls).toEqual(["model:parent-sid", "provider:parent-sid"]);
	});

	it("fails closed when an authentication retry changes credential type", () => {
		expect(isStableSessionApiKeyCredentialType("api_key", "oauth")).toBe(false);
		expect(isStableSessionApiKeyCredentialType("oauth", "api_key")).toBe(false);
		expect(isStableSessionApiKeyCredentialType("oauth", "oauth")).toBe(true);
	});
});
