import { describe, expect, test } from "bun:test";
import type { DecisionErrorCode, DecisionProbabilities, DecisionRequest } from "../src/task/decision-model";
import { JevDecisionProvider, KevDecisionProvider } from "../src/task/decision-providers";

const request: DecisionRequest = {
	role: "executor",
	assignment: "Inspect the repository",
	candidates: { fast: "small tasks", balanced: "normal tasks", strong: "complex tasks" },
};
const answer = (
	choice = "balanced",
	probabilities: DecisionProbabilities = { fast: 0.2, balanced: 0.6, strong: 0.2 },
) => ({
	answers: { route: { type: "choice", choice, probabilities, confidence: 0.7 } },
	model: "server-model",
});
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("task decision providers", () => {
	test("Kev sends only a bounded typed packet with the requested model and subset", async () => {
		let body: unknown;
		const provider = new KevDecisionProvider({
			model: "kev-custom",
			fetchFn: async (_url, init) => {
				body = JSON.parse(String(init.body));
				expect(init.redirect).toBe("error");
				return json(answer("balanced", { fast: 0.25, balanced: 0.75 }));
			},
		});
		const outcome = await provider.decide({ ...request, candidates: { fast: "small", balanced: "normal" } });
		expect(outcome.result?.choice).toBe("balanced");
		expect(body).toMatchObject({
			model: "kev-custom",
			state: { role: "executor", assignment: request.assignment },
			questions: { route: { criteria: { fast: "small", balanced: "normal" } } },
		});
		expect(Object.keys(body as object).sort()).toEqual(["model", "questions", "state"]);
		expect(outcome.result?.reportedModel).toBe("server-model");
	});

	test("Jev fixes its endpoint and model and resolves only typesafe credentials with a deadline signal", async () => {
		const lookups: string[] = [];
		let destination = "";
		const provider = new JevDecisionProvider({
			authStorage: {
				getApiKey: async (provider, sessionId, options) => {
					lookups.push(`${provider}:${sessionId}`);
					expect(options?.signal).toBeInstanceOf(AbortSignal);
					return "test-secret";
				},
			},
			credentialSessionId: "credential-session",
			endpoint: "http://untrusted.invalid",
			model: "untrusted-model",
			fetchFn: async (url, init) => {
				destination = url;
				expect(init.redirect).toBe("error");
				expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-secret");
				expect(JSON.parse(String(init.body)).model).toBe("jev-latest");
				return json(answer());
			},
		});
		expect((await provider.decide(request)).result?.choice).toBe("balanced");
		expect(lookups).toEqual(["typesafe:credential-session"]);
		expect(destination).toBe("https://api.typesafe.ai/v1/systemone");
	});

	test("Jev uses the exact route question name", async () => {
		let body: unknown;
		const provider = new JevDecisionProvider({
			authStorage: { getApiKey: async () => "key" },
			fetchFn: async (_url, init) => {
				body = JSON.parse(String(init.body));
				return json(answer("fast", { fast: 1 }));
			},
		});
		await provider.decide({ ...request, candidates: { fast: "small" } });
		expect(body).toHaveProperty("questions");
		expect(Object.keys((body as { questions: Record<string, unknown> }).questions)).toEqual(["route"]);
	});

	test("rejects the retired decision answer key", async () => {
		const provider = new KevDecisionProvider({
			fetchFn: async () => json({ answers: { decision: answer("fast", { fast: 1 }).answers.route } }),
		});
		expect((await provider.decide({ ...request, candidates: { fast: "small" } })).error?.code).toBe(
			"invalid_response",
		);
	});

	test("credentials that ignore cancellation cannot delay fallback or trigger a late request", async () => {
		const key = Promise.withResolvers<string>();
		let calls = 0;
		const provider = new JevDecisionProvider({
			authStorage: { getApiKey: () => key.promise },
			timeoutMs: 10,
			fetchFn: async () => {
				calls++;
				return json(answer());
			},
		});
		expect((await provider.decide(request)).error?.code).toBe("timeout");
		key.resolve("too-late");
		await Bun.sleep(1);
		expect(calls).toBe(0);
	});

	test("an already aborted parent skips credentials and HTTP", async () => {
		let calls = 0;
		const provider = new JevDecisionProvider({
			authStorage: {
				getApiKey: async () => {
					calls++;
					return "key";
				},
			},
		});
		expect((await provider.decide(request, { signal: AbortSignal.abort() })).error?.code).toBe("aborted");
		expect(calls).toBe(0);
	});

	test("strict envelopes distinguish invalid candidate and probability failures", async () => {
		const cases: Array<[unknown, DecisionErrorCode]> = [
			[{ model: "x" }, "invalid_response"],
			[answer("other"), "invalid_candidate"],
			[answer("fast", { fast: 2, balanced: 0, strong: -1 }), "invalid_probability"],
		];
		for (const [payload, code] of cases) {
			const provider = new KevDecisionProvider({ fetchFn: async () => json(payload) });
			expect((await provider.decide(request)).error?.code).toBe(code);
		}
	});

	test("stalled and oversized decoded streams are canceled", async () => {
		let canceled = 0;
		const stalled = new KevDecisionProvider({
			timeoutMs: 10,
			fetchFn: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull() {},
						cancel() {
							canceled++;
						},
					}),
				),
		});
		expect((await stalled.decide(request)).error?.code).toBe("timeout");
		expect(canceled).toBe(1);
		const oversized = new KevDecisionProvider({
			fetchFn: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(65537));
						},
						cancel() {
							canceled++;
						},
					}),
					{ headers: { "content-length": "1" } },
				),
		});
		expect((await oversized.decide(request)).error?.code).toBe("response_too_large");
		expect(canceled).toBe(2);
	});

	test("late fetch responses are canceled even when the fetch implementation ignores abort", async () => {
		const pending = Promise.withResolvers<Response>();
		let canceled = false;
		const provider = new KevDecisionProvider({ timeoutMs: 10, fetchFn: () => pending.promise });
		expect((await provider.decide(request)).error?.code).toBe("timeout");
		pending.resolve(
			new Response(
				new ReadableStream({
					cancel() {
						canceled = true;
					},
				}),
			),
		);
		await Bun.sleep(1);
		expect(canceled).toBe(true);
	});

	test("HTTP authentication failures expose codes rather than response secrets", async () => {
		for (const status of [401, 403] as const) {
			const provider = new KevDecisionProvider({ fetchFn: async () => new Response("secret-response", { status }) });
			expect(await provider.decide(request)).toEqual({ error: { code: `auth_${status}` } });
		}
	});

	test("rejects unsafe local URL forms before sending any request", () => {
		for (const endpoint of [
			"https://example.com/v1/systemone",
			"http://user:pass@127.0.0.1:8009/v1/systemone",
			"http://127.0.0.1:8009/v1/systemone?x=1",
			"http://127.0.0.1:8009/v1/systemone#fragment",
		]) {
			expect(() => new KevDecisionProvider({ endpoint })).toThrow();
		}
	});
});
