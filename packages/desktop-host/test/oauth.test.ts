import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as sdk from "@gajae-code/coding-agent/sdk";
import { getAgentDir, hookFetch, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type {
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopCredentialSaveResult,
	DesktopFrame,
	DesktopRequest,
	DesktopSnapshot,
} from "../src/protocol";

const createEmbeddedSession = sdk.createEmbeddedAgentSession;
const executeAuthorization = sdk.AuthorizationControls.prototype.execute;
const deviceEndpoint = "https://api.kilo.ai/api/device-auth/codes";
const json = (value: unknown) => Response.json(value);

async function observe<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = await read();
		if (predicate(value)) return value;
		await Bun.sleep(5);
	}
	throw new Error("Authorization did not reach the expected state");
}

function promptId(state: DesktopAuthState): string {
	if (!state.prompt) throw new Error("Expected authorization prompt");
	return state.prompt.id;
}

describe("desktop authorization through the public SDK", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	let respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
	let fetchHook: Disposable;
	let authorization: sdk.AuthorizationControls | undefined;
	const owners: sdk.EmbeddedAgentSessionResult[] = [];
	const factoryInputs: sdk.EmbeddedAgentSessionOptions[] = [];
	const authorizationCalls: Array<{ operation: sdk.AuthorizationControlOperation; input: Record<string, unknown> }> =
		[];
	const hosts: DesktopHost[] = [];
	const directories: string[] = [];
	const restores: Array<() => void> = [];
	const releases: Array<() => void> = [];

	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		authorization = undefined;
		respond = url => {
			throw new Error(`Unexpected fixture request: ${url}`);
		};
		fetchHook = hookFetch((input, init) => respond(input instanceof Request ? input.url : String(input), init));
		const factory = vi.spyOn(sdk, "createEmbeddedAgentSession").mockImplementation(async options => {
			factoryInputs.push(options);
			const result = await createEmbeddedSession(options);
			owners.push(result);
			// Keep real SDK/session/auth ownership; only model-catalog networking is outside this fixture.
			const refresh = vi.spyOn(result.session.modelRegistry, "refresh").mockResolvedValue(undefined);
			restores.push(() => refresh.mockRestore());
			return result;
		});
		const execute = vi.spyOn(sdk.AuthorizationControls.prototype, "execute").mockImplementation(function (
			this: sdk.AuthorizationControls,
			operation,
			input,
		) {
			authorization = this;
			authorizationCalls.push({ operation, input: structuredClone(input) });
			return executeAuthorization.call(this, operation, input);
		});
		restores.push(
			() => factory.mockRestore(),
			() => execute.mockRestore(),
		);
	});

	afterEach(async () => {
		const failures: unknown[] = [];
		try {
			while (releases.length) releases.pop()!();
			while (hosts.length) {
				try {
					await hosts.pop()!.close();
				} catch (error) {
					failures.push(error);
				}
			}
			for (const owner of owners.splice(0)) {
				try {
					await owner.session.awaitDisposeCompletion();
				} catch (error) {
					failures.push(error);
				}
			}
			if (!failures.length) {
				while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true });
			}
		} finally {
			while (restores.length) restores.pop()!();
			fetchHook[Symbol.dispose]();
			factoryInputs.length = 0;
			authorizationCalls.length = 0;
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
		if (failures.length) throw new AggregateError(failures, "Authorization fixture cleanup failed");
	});

	async function launch() {
		const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-sdk-auth-")));
		directories.push(dataDir);
		const frames: DesktopFrame[] = [];
		const visibleSessionFactory = vi.fn(async (): Promise<sdk.CreateAgentSessionResult> => {
			throw new Error("Authorization must use its hidden SDK owner, not a conversation factory");
		});
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: visibleSessionFactory,
		});
		hosts.push(host);
		let sequence = 0;
		async function call<T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> {
			const id = `authorization-${++sequence}`;
			await host.handle({ id, method, params });
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error("Missing desktop response");
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		}
		await call("bootstrap");
		const owner = owners.at(-1);
		if (!owner) throw new Error("Expected actual embedded SDK owner");
		return {
			host,
			owner,
			frames,
			call,
			visibleSessionFactory,
			state: () => call<DesktopAuthState>("auth.state"),
			controls: () => {
				if (!authorization) throw new Error("Expected public SDK authorization controls");
				return authorization;
			},
		};
	}

	function minimaxValidation() {
		respond = (url, init) => {
			if (url !== "https://api.minimax.io/v1/chat/completions") throw new Error("Unexpected validation endpoint");
			expect(init?.method).toBe("POST");
			return json({});
		};
	}

	test("starts without credentials using an in-memory hidden SDK owner", async () => {
		const h = await launch();
		expect(factoryInputs).toHaveLength(1);
		expect(factoryInputs[0]).toMatchObject({ controlOnly: true, storage: { persist: false } });
		expect(h.owner.session.sessionManager.getSessionFile()).toBeUndefined();
		expect(h.visibleSessionFactory).not.toHaveBeenCalled();
		expect(await h.call("auth.state")).toBeNull();
		const snapshot = await h.call<DesktopSnapshot>("bootstrap");
		expect(snapshot.sessions).toEqual([]);
		const providers = await h.call<DesktopAuthProvider[]>("auth.providers");
		expect(providers.find(provider => provider.id === "minimax-code")).toMatchObject({ configured: false });
		expect(await h.call<string[]>("auth.keyProviders")).toContain("minimax-code");
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toBeUndefined();
	});

	test("routes exact flow/prompt identities to native login and waits for catalog settlement before completion", async () => {
		minimaxValidation();
		const h = await launch();
		const refresh = Promise.withResolvers<void>();
		releases.push(() => refresh.resolve());
		const refreshSpy = vi.spyOn(h.owner.session.modelRegistry, "refresh").mockImplementation(() => refresh.promise);
		restores.push(() => refreshSpy.mockRestore());
		const admitted = await h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" });
		const waiting = await observe(h.state, state => state.status === "waiting");
		expect(waiting.id).toBe(admitted.id);
		expect(waiting.url).toBe("https://platform.minimax.io/subscribe/coding-plan");
		const prompt = promptId(waiting);
		await expect(h.call("auth.login", { provider: "kilo" })).rejects.toThrow();
		for (const params of [
			{ flowId: crypto.randomUUID(), promptId: prompt, value: "sk-wrong-flow" },
			{ flowId: admitted.id, promptId: crypto.randomUUID(), value: "sk-wrong-prompt" },
			{ flowId: admitted.id, promptId: prompt, value: "" },
		]) {
			await expect(h.call("auth.answer", params)).rejects.toThrow();
		}
		const key = "sk-native-minimax-private-answer";
		const answered = await h.call<DesktopAuthState>("auth.answer", {
			flowId: admitted.id,
			promptId: prompt,
			value: key,
		});
		expect(answered).toMatchObject({ id: admitted.id, provider: "minimax-code", status: "authorizing" });
		expect(answered.prompt).toBeUndefined();
		expect(answered.url).toBeUndefined();
		await expect(h.call("auth.answer", { flowId: admitted.id, promptId: prompt, value: key })).rejects.toThrow();
		await observe(
			async () => h.owner.session.modelRegistry.authStorage.get("minimax-code"),
			value => value?.type === "api_key",
		);
		expect((await h.state()).status).toBe("authorizing");
		expect(h.frames.some(frame => frame.type === "auth" && ["complete", "error"].includes(frame.auth.status))).toBe(
			false,
		);
		refresh.resolve();
		const complete = await observe(h.state, state => state.status === "complete");
		expect(authorizationCalls).toContainEqual({ operation: "auth.start", input: { provider: "minimax-code" } });
		expect(authorizationCalls).toContainEqual({ operation: "auth.read", input: { flowId: admitted.id } });
		expect(authorizationCalls).toContainEqual({
			operation: "auth.answer",
			input: { flowId: admitted.id, promptId: prompt, value: key },
		});
		expect(complete).toEqual({ id: admitted.id, provider: "minimax-code", status: "complete" });
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toEqual({ type: "api_key", key });
		await expect(h.call("auth.cancel", { flowId: admitted.id })).rejects.toThrow();
		const replacementFrameIndex = h.frames.length;
		const next = await h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" });
		expect(next.id).not.toBe(admitted.id);
		// Wait for an unsolicited update: a retained timer must not read/publish the retired flow.
		await observe(
			async () =>
				h.frames
					.slice(replacementFrameIndex)
					.flatMap(frame => (frame.type === "auth" ? [frame.auth] : []))
					.find(state => state.id === next.id && state.status === "waiting"),
			state => state !== undefined,
		);
		expect(
			h.frames
				.slice(replacementFrameIndex)
				.flatMap(frame => (frame.type === "auth" ? [frame.auth.id] : []))
				.every(id => id === next.id),
		).toBe(true);
		await expect(h.call("auth.cancel", { flowId: admitted.id })).rejects.toThrow();
		expect((await h.state()).id).toBe(next.id);
		await h.call("auth.cancel", { flowId: next.id });
		for (const secret of [key, "sk-wrong-flow", "sk-wrong-prompt"])
			expect(JSON.stringify(h.frames)).not.toContain(secret);
	});

	test("reports saved credentials separately from a failed SDK catalog refresh", async () => {
		minimaxValidation();
		const h = await launch();
		const key = "sk-saved-with-refresh-failure";
		const refresh = vi
			.spyOn(h.owner.session.modelRegistry, "refresh")
			.mockRejectedValue(new Error(`private-owner ${key}`));
		restores.push(() => refresh.mockRestore());
		const flow = await h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" });
		const waiting = await observe(h.state, state => state.status === "waiting");
		await h.call("auth.answer", { flowId: flow.id, promptId: promptId(waiting), value: key });
		const failed = await observe(h.state, state => state.status === "error");
		expect(failed).toMatchObject({ id: flow.id, error: "Credentials were saved, but model catalog refresh failed" });
		expect(failed.url).toBeUndefined();
		expect(failed.prompt).toBeUndefined();
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toEqual({ type: "api_key", key });
		expect(JSON.stringify(h.frames)).not.toContain(key);
		expect(JSON.stringify(h.frames)).not.toContain("private-owner");
	});

	test("stores API keys through the SDK and returns refresh outcome without serializing credentials", async () => {
		const h = await launch();
		const key = "sk-direct-sdk-storage-private";
		const saved = await h.call<DesktopCredentialSaveResult>("auth.setKey", { provider: "minimax-code", key });
		expect(saved).toEqual({ provider: "minimax-code", saved: true, catalogRefreshed: true });
		expect(authorizationCalls).toContainEqual({
			operation: "auth.apiKey.store",
			input: { provider: "minimax-code", key },
		});
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toEqual({ type: "api_key", key });
		const providers = await h.call<DesktopAuthProvider[]>("auth.providers");
		expect(providers.find(provider => provider.id === "minimax-code")?.configured).toBe(true);
		const refresh = vi
			.spyOn(h.owner.session.modelRegistry, "refresh")
			.mockRejectedValue(new Error("private-catalog-detail"));
		restores.push(() => refresh.mockRestore());
		const replacement = "sk-replacement-survives-refresh-failure";
		expect(await h.call<{ provider: string; saved: boolean; catalogRefreshed: boolean }>("auth.setKey", { provider: "minimax-code", key: replacement })).toEqual({
			provider: "minimax-code",
			saved: true,
			catalogRefreshed: false,
		});
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toEqual({
			type: "api_key",
			key: replacement,
		});
		await expect(h.call("auth.setKey", { provider: "unknown-provider", key })).rejects.toThrow();
		for (const secret of [key, replacement, "private-catalog-detail"])
			expect(JSON.stringify(h.frames)).not.toContain(secret);
	});

	for (const unsafeUrl of [
		"http://example.invalid/authorize",
		"https://user:password@example.invalid/authorize",
		"file:///tmp/private-authorization",
		"https://example.invalid/%0aauthorize",
		"https://example.invalid/authorize?access_token=private-token",
	]) {
		test(`does not expose unsafe native provider URL ${unsafeUrl}`, async () => {
			respond = url => {
				if (url !== deviceEndpoint) throw new Error("Unsafe URL must not reach provider polling");
				return json({ code: "ABCD-EFGH", verificationUrl: unsafeUrl, expiresIn: 60 });
			};
			const h = await launch();
			const flow = await h.call<DesktopAuthState>("auth.login", { provider: "kilo" });
			const failed = await observe(h.state, state => state.status === "error");
			expect(failed).toMatchObject({ id: flow.id, error: "Provider supplied an unsafe authorization URL" });
			expect(failed.url).toBeUndefined();
			expect(h.owner.session.modelRegistry.authStorage.get("kilo")).toBeUndefined();
			expect(JSON.stringify(h.frames)).not.toContain(unsafeUrl);
			expect(JSON.stringify(h.frames)).not.toContain("private-token");
		});
	}

	test("concurrent starts preserve the first admitted flow and its unsolicited polling", async () => {
		const h = await launch();
		const [first, second] = await Promise.allSettled([
			h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" }),
			h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" }),
		]);
		if (first.status !== "fulfilled") throw first.reason;
		expect(second.status).toBe("rejected");
		const flow = first.value;
		await observe(async () => h.frames.filter(frame => frame.type === "auth" && frame.auth.id === flow.id && frame.auth.status === "waiting").length, value => value > 0);
		expect((await h.state()).id).toBe(flow.id);
		expect(authorizationCalls.filter(call => call.operation === "auth.start")).toHaveLength(1);
		await h.call("auth.cancel", { flowId: flow.id });
	});

	test("cancels a native prompt without accepting stale answers or duplicate cancellation", async () => {
		const h = await launch();
		const flow = await h.call<DesktopAuthState>("auth.login", { provider: "minimax-code" });
		const waiting = await observe(h.state, state => state.status === "waiting");
		const cancelled = await h.call<DesktopAuthState>("auth.cancel", { flowId: flow.id });
		expect(cancelled).toEqual({ id: flow.id, provider: "minimax-code", status: "cancelled" });
		expect(authorizationCalls).toContainEqual({ operation: "auth.cancel", input: { flowId: flow.id } });
		await expect(
			h.call("auth.answer", { flowId: flow.id, promptId: promptId(waiting), value: "private-stale-answer" }),
		).rejects.toThrow();
		await expect(h.call("auth.cancel", { flowId: flow.id })).rejects.toThrow();
		expect(h.owner.session.modelRegistry.authStorage.get("minimax-code")).toBeUndefined();
		expect(JSON.stringify(h.frames)).not.toContain("private-stale-answer");
	});

	test("does not mistake cancellation for provider settlement and joins late storage before owner shutdown", async () => {
		let providerPolled = false;
		const approval = Promise.withResolvers<Response>();
		const token = "private-late-provider-access-token";
		releases.push(() => approval.resolve(json({ status: "approved", token })));
		respond = url => {
			if (url === deviceEndpoint) {
				return json({ code: "ABCD-EFGH", verificationUrl: "https://example.invalid/device", expiresIn: 60 });
			}
			if (url === `${deviceEndpoint}/ABCD-EFGH`) {
				providerPolled = true;
				return approval.promise;
			}
			throw new Error("Unexpected device endpoint");
		};
		const h = await launch();
		const flow = await h.call<DesktopAuthState>("auth.login", { provider: "kilo" });
		await observe(
			async () => providerPolled,
			value => value,
		);
		const display = await h.state();
		expect(display.instructions).toBe("Verification code: ABCD-EFGH");
		expect(display.url).toBe("https://example.invalid/device");
		await expect(h.call("auth.cancel", { flowId: crypto.randomUUID() })).rejects.toThrow();
		expect((await h.state()).id).toBe(flow.id);
		expect((await h.call<DesktopAuthState>("auth.cancel", { flowId: flow.id })).status).toBe("cancelled");
		const status = await h.controls().execute("auth.status", { provider: "kilo" });
		expect(status).toMatchObject({ flow: { flowId: flow.id, status: "cancelled", providerSettled: false } });
		await expect(h.call("auth.login", { provider: "minimax-code" })).rejects.toThrow();
		await expect(h.call("auth.setKey", { provider: "minimax-code", key: "private-contended-key" })).rejects.toThrow();
		expect((await h.state()).status).toBe("cancelled");
		const originalDispose = h.owner.session.dispose.bind(h.owner.session);
		let storedAtDispose: unknown;
		const dispose = vi.spyOn(h.owner.session, "dispose").mockImplementation(async () => {
			storedAtDispose = h.owner.session.modelRegistry.authStorage.get("kilo");
			await originalDispose();
		});
		restores.push(() => dispose.mockRestore());
		const closing = h.call("shutdown");
		await Bun.sleep(0);
		expect(dispose).not.toHaveBeenCalled();
		approval.resolve(json({ status: "approved", token }));
		await closing;
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(storedAtDispose).toMatchObject({ type: "oauth", access: token });
		expect(h.owner.session.isDisposed).toBe(true);
		expect(h.frames.some(frame => frame.type === "auth" && frame.auth.status === "complete")).toBe(false);
		for (const secret of [token, "private-contended-key"]) expect(JSON.stringify(h.frames)).not.toContain(secret);
	});
});
