import { describe, expect, test } from "bun:test";
import type { OAuthLoginCallbacks } from "@gajae-code/ai/utils/oauth/types";
import { DesktopOAuthController } from "../src/oauth";
import type { DesktopAuthState } from "../src/protocol";

function harness(
	login: (callbacks: OAuthLoginCallbacks) => Promise<void>,
	deadlineMs = 300_000,
	onStored?: () => Promise<void>,
) {
	const events: DesktopAuthState[] = [];
	const secrets = new Set<string>(["stored-access", "stored-refresh"]);
	let stored = 0;
	const controller = new DesktopOAuthController({
		service: { login: (_provider, callbacks) => login(callbacks) },
		providers: () => [{ id: "test", name: "Test" }],
		emit: state => events.push(state),
		redact: text => {
			for (const secret of secrets) text = text.split(secret).join("[redacted]");
			return text;
		},
		onStored: async () => {
			stored++;
			await onStored?.();
		},
		deadlineMs,
		joinMs: 5,
	});
	return { controller, events, stored: () => stored };
}
const turn = async () => {
	await Bun.sleep(0);
};

describe("desktop account authorization", () => {
	test("preserves routing parameters after short answers and permits explicitly optional prompts", async () => {
		let optionalAnswer: string | undefined;
		const h = harness(async callbacks => {
			await callbacks.onPrompt({ message: "Select flow" });
			callbacks.onAuth({ url: "https://example.com/authorize?step=1" });
			optionalAnswer = await callbacks.onPrompt({ message: "Optional value", allowEmpty: true });
		});
		const admitted = h.controller.login("test");
		await turn();
		const first = h.controller.state()!.prompt!;
		expect(() => h.controller.answer(admitted.id, first.id, "")).toThrow("required");
		h.controller.answer(admitted.id, first.id, "1");
		await turn();
		const waiting = h.controller.state()!;
		expect(waiting.url).toBe("https://example.com/authorize?step=1");
		expect(waiting.prompt!.allowEmpty).toBe(true);
		h.controller.answer(admitted.id, waiting.prompt!.id, "");
		await turn();
		expect(optionalAnswer).toBe("");
		expect(h.controller.state()!.status).toBe("complete");
		await h.controller.close();
	});
	test("admits promptly, routes prompts once, and completes without serializing secrets", async () => {
		let answer = "";
		const h = harness(async callbacks => {
			callbacks.onAuth({ url: "https://example.com/authorize", instructions: "Use stored-access" });
			answer = await callbacks.onPrompt({ message: "Enter code", placeholder: "stored-refresh" });
			callbacks.onAuth({ url: "https://example.com/authorize", instructions: `Received ${answer}` });
		});
		expect(h.controller.state()).toBeNull();
		expect(() => h.controller.login("missing")).toThrow("Unknown authorization provider");
		const admitted = h.controller.login("test");
		expect(admitted.status).toBe("authorizing");
		expect(() => h.controller.login("test")).toThrow("already active");
		await turn();
		const prompt = h.controller.state()!.prompt!;
		expect(() => h.controller.answer("stale", prompt.id, "code-secret")).toThrow();
		expect(() => h.controller.answer(admitted.id, "stale", "code-secret")).toThrow();
		expect(h.controller.state()!.status).toBe("waiting");
		h.controller.answer(admitted.id, prompt.id, "code-secret");
		expect(() => h.controller.answer(admitted.id, prompt.id, "again")).toThrow();
		await turn();
		expect(answer).toBe("code-secret");
		expect(h.controller.state()!.status).toBe("complete");
		expect(h.stored()).toBe(1);
		expect(() => h.controller.cancel(admitted.id)).toThrow();
		for (const secret of ["code-secret", "stored-access", "stored-refresh"])
			expect(JSON.stringify(h.events)).not.toContain(secret);
		await h.controller.close();
	});

	for (const url of [
		"http://example.com",
		"https://user:password@example.com",
		"file:///tmp/code",
		"not a url",
		"https://example.com/\ncontrol",
		"https://example.com/?token=stored-access",
	]) {
		test(`rejects unsafe authorization URL ${url}`, async () => {
			const h = harness(async callbacks => {
				callbacks.onAuth({ url });
			});
			h.controller.login("test");
			await turn();
			expect(h.controller.state()!.status).toBe("error");
			expect(h.controller.state()!.url).toBeUndefined();
			expect(h.stored()).toBe(0);
			await h.controller.close();
		});
	}

	test("cancels manual input and rejects stale answers and duplicate cancellation", async () => {
		let signal: AbortSignal | undefined;
		const h = harness(async callbacks => {
			signal = callbacks.signal;
			await callbacks.onManualCodeInput!();
		});
		const flow = h.controller.login("test");
		await turn();
		const prompt = h.controller.state()!.prompt!;
		h.controller.cancel(flow.id);
		expect(signal!.aborted).toBe(true);
		expect(() => h.controller.answer(flow.id, prompt.id, "secret")).toThrow();
		expect(() => h.controller.cancel(flow.id)).toThrow();
		await turn();
		expect(h.controller.state()!.status).toBe("cancelled");
		expect(h.stored()).toBe(0);
		await h.controller.close();
	});

	test("timeout isolates late callbacks and success, retaining the admission lock until settled", async () => {
		const deferred = Promise.withResolvers<void>();
		let callbacks: OAuthLoginCallbacks | undefined;
		const h = harness(async value => {
			callbacks = value;
			await deferred.promise;
		}, 5);
		h.controller.login("test");
		await Bun.sleep(15);
		expect(h.controller.state()!.error).toBe("Authorization timed out");
		expect(callbacks!.signal!.aborted).toBe(true);
		callbacks!.onAuth({ url: "https://example.com/late" });
		await expect(callbacks!.onPrompt({ message: "late" })).rejects.toThrow();
		expect(h.controller.state()!.url).toBeUndefined();
		expect(() => h.controller.login("test")).toThrow("already active");
		deferred.resolve();
		await turn();
		expect(h.stored()).toBe(1);
		expect(h.controller.state()!.status).toBe("error");
		const next = h.controller.login("test");
		callbacks!.onAuth({ url: "https://example.com/stale-generation" });
		expect(h.controller.state()!.id).toBe(next.id);
		expect(h.controller.state()!.url).toBeUndefined();
		await h.controller.close();
	});

	test("immediate cancellation prevents service entry and releases admission", async () => {
		let calls = 0;
		const h = harness(async () => {
			calls++;
		});
		const flow = h.controller.login("test");
		h.controller.cancel(flow.id);
		await turn();
		expect(calls).toBe(0);
		h.controller.login("test");
		await turn();
		expect(calls).toBe(1);
		expect(h.controller.state()!.status).toBe("complete");
		await h.controller.close();
	});

	test("overlapping prompts abort rather than replacing a secret waiter", async () => {
		const h = harness(async callbacks => {
			const first = callbacks.onPrompt({ message: "First" });
			const second = callbacks.onPrompt({ message: "Second" });
			await Promise.all([first, second]);
		});
		h.controller.login("test");
		await turn();
		expect(h.controller.state()!.status).toBe("error");
		expect(h.controller.state()!.prompt).toBeUndefined();
		expect(h.stored()).toBe(0);
		await h.controller.close();
	});

	test("reports saved credentials separately from catalog refresh failure without disclosing secrets", async () => {
		let calls = 0;
		let signal: AbortSignal | undefined;
		const h = harness(
			async callbacks => {
				calls++;
				signal = callbacks.signal;
				callbacks.onAuth({ url: "https://example.com/authorize" });
				await callbacks.onPrompt({ message: "Enter code" });
			},
			300_000,
			async () => {
				throw new Error("raw-owner@example.invalid code-secret stored-access stored-refresh raw-token");
			},
		);
		const flow = h.controller.login("test");
		await turn();
		h.controller.answer(flow.id, h.controller.state()!.prompt!.id, "code-secret");
		await turn();
		const state = h.controller.state()!;
		expect(state.status).toBe("error");
		expect(state.error).toBe("Credentials were saved, but model catalog refresh failed");
		expect(state.instructions).toBe(
			"Authorization stopped. Credentials already saved by the provider are not removed.",
		);
		expect(state.url).toBeUndefined();
		expect(state.prompt).toBeUndefined();
		expect(signal!.aborted).toBe(true);
		expect(h.controller.isActive()).toBe(false);
		expect(calls).toBe(1);
		expect(h.stored()).toBe(1);
		for (const secret of ["raw-owner@example.invalid", "code-secret", "stored-access", "stored-refresh", "raw-token"])
			expect(JSON.stringify(h.events)).not.toContain(secret);
		await h.controller.close();
	});

	for (const stop of ["cancel", "timeout"] as const) {
		test(`late catalog refresh rejection cannot overwrite ${stop}`, async () => {
			const refresh = Promise.withResolvers<void>();
			let callbacks: OAuthLoginCallbacks | undefined;
			let calls = 0;
			const h = harness(
				async value => {
					calls++;
					callbacks = value;
				},
				stop === "timeout" ? 5 : 300_000,
				() => refresh.promise,
			);
			const flow = h.controller.login("test");
			await turn();
			expect(h.stored()).toBe(1);
			if (stop === "cancel") h.controller.cancel(flow.id);
			else await Bun.sleep(15);
			const stopped = h.controller.state()!;
			expect(stopped.status).toBe(stop === "cancel" ? "cancelled" : "error");
			expect(stopped.error).toBe(stop === "cancel" ? undefined : "Authorization timed out");
			expect(callbacks!.signal!.aborted).toBe(true);
			expect(() => h.controller.login("test")).toThrow("already active");
			const eventCount = h.events.length;
			callbacks!.onAuth({ url: "https://example.com/late" });
			await expect(callbacks!.onPrompt({ message: "late" })).rejects.toThrow("Authorization stopped");
			refresh.reject(new Error("raw-owner@example.invalid stored-access stored-refresh raw-token"));
			await turn();
			expect(h.controller.state()).toEqual(stopped);
			expect(h.events.length).toBe(eventCount);
			expect(h.controller.isActive()).toBe(false);
			expect(calls).toBe(1);
			expect(h.stored()).toBe(1);
			for (const secret of ["raw-owner@example.invalid", "stored-access", "stored-refresh", "raw-token"])
				expect(JSON.stringify(h.events)).not.toContain(secret);
			await h.controller.close();
		});
	}

	test("hides raw provider errors and bounds shutdown of an uncooperative provider", async () => {
		const failing = harness(async () => {
			throw new Error("code=unknown-secret&token=raw-token");
		});
		failing.controller.login("test");
		await turn();
		expect(failing.controller.state()!.status).toBe("error");
		expect(failing.controller.state()!.error).toBe("Authorization failed");
		expect(failing.stored()).toBe(0);
		expect(JSON.stringify(failing.events)).not.toContain("raw-token");
		await failing.controller.close();
		const deferred = Promise.withResolvers<void>();
		const h = harness(async () => {
			await deferred.promise;
		});
		h.controller.login("test");
		await turn();
		await expect(h.controller.close()).rejects.toThrow("did not stop");
		expect(h.controller.state()!.status).toBe("cancelled");
		deferred.resolve();
		await turn();
		expect(h.controller.state()!.status).toBe("cancelled");
		expect(h.stored()).toBe(1);
		expect(() => h.controller.login("test")).toThrow("closed");
	});
});
