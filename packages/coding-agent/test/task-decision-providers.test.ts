import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { KevControlReply } from "../src/setup/kev-supervisor";
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

const SOCKET = "/tmp/gjc-kev-fixture.sock";
const TOKEN = "t".repeat(64);
type ControlCall = { socket: string; request: Record<string, unknown> };

/** A Kev provider whose owned channel is stubbed, so no socket or port is touched. */
function kevThroughControl(
	respond: (body: string) => KevControlReply | undefined,
	options: { model?: string; timeoutMs?: number; calls?: ControlCall[] } = {},
) {
	return new KevDecisionProvider({
		model: options.model,
		timeoutMs: options.timeoutMs,
		resolveChannel: async () => ({ socket: SOCKET, token: TOKEN, port: 8009 }),
		control: async (socket, message) => {
			const parsed = JSON.parse(message.trim()) as Record<string, unknown>;
			options.calls?.push({ socket, request: parsed });
			return respond(String(parsed.body));
		},
	});
}

const okReply = (value: unknown): KevControlReply => ({ ok: true, status: 200, body: JSON.stringify(value) });

/** Shared-checkout isolation: these tests bind only inside this window. */
function reservedLoopbackPort(): number {
	const base = Number(process.env.PORT_BASE ?? 42040);
	for (let port = base; port < base + 20; port++) {
		try {
			const probe = Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: {
					data() {},
					open(socket) {
						socket.end();
					},
				},
			});
			probe.stop(true);
			return port;
		} catch {
			// Taken by another task in this shared checkout; try the next one.
		}
	}
	throw new Error("no free loopback port in the reserved window");
}

describe("task decision providers", () => {
	test("Kev sends only a bounded typed packet through its owned control channel", async () => {
		const calls: ControlCall[] = [];
		const provider = kevThroughControl(() => okReply(answer("balanced", { fast: 0.25, balanced: 0.75 })), {
			model: "kev-custom",
			calls,
		});
		const outcome = await provider.decide({ ...request, candidates: { fast: "small", balanced: "normal" } });
		expect(outcome.result?.choice).toBe("balanced");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.socket).toBe(SOCKET);
		expect(calls[0]?.request.op).toBe("infer");
		expect(calls[0]?.request.token).toBe(TOKEN);
		const body = JSON.parse(String(calls[0]?.request.body)) as Record<string, unknown>;
		expect(body).toMatchObject({
			model: "kev-custom",
			state: { role: "executor", assignment: request.assignment },
			questions: { route: { criteria: { fast: "small", balanced: "normal" } } },
		});
		expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
		expect(outcome.result?.reportedModel).toBe("server-model");
	});

	test("a local decision sends nothing to an unrelated listener holding the loopback port", async () => {
		const received: string[] = [];
		const port = reservedLoopbackPort();
		const intruder = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch(incoming) {
				received.push(new URL(incoming.url).pathname);
				return new Response("{}", { headers: { "content-type": "application/json" } });
			},
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-unowned-"));
		try {
			// Real resolution against a root with no owned service: there is no
			// destination at all, so the task text is never put on the wire.
			const outcome = await new KevDecisionProvider({ root, timeoutMs: 1000 }).decide(request);
			expect(outcome.result).toBeUndefined();
			expect(outcome.error?.code).toBe("unavailable");
			expect(received).toEqual([]);
		} finally {
			intruder.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("a supervisor that refuses or has lost its child yields no tier", async () => {
		for (const reply of [{ ok: false, error: "refused" }, { ok: false, error: "exited" }, undefined] as const) {
			const outcome = await kevThroughControl(() => reply).decide(request);
			expect(outcome.result).toBeUndefined();
			expect(["unavailable", "transport_error"]).toContain(outcome.error?.code ?? "");
		}
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
		const provider = kevThroughControl(() =>
			okReply({ answers: { decision: answer("fast", { fast: 1 }).answers.route } }),
		);
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
			expect((await kevThroughControl(() => okReply(payload)).decide(request)).error?.code).toBe(code);
		}
	});

	test("stalled and oversized decoded streams are canceled", async () => {
		let canceled = 0;
		const stalled = new JevDecisionProvider({
			authStorage: { getApiKey: async () => "key" },
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
		const oversized = new JevDecisionProvider({
			authStorage: { getApiKey: async () => "key" },
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
		const provider = new JevDecisionProvider({
			authStorage: { getApiKey: async () => "key" },
			timeoutMs: 10,
			fetchFn: () => pending.promise,
		});
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

	test("authentication failures expose codes rather than response secrets", async () => {
		for (const status of [401, 403] as const) {
			const remote = new JevDecisionProvider({
				authStorage: { getApiKey: async () => "key" },
				fetchFn: async () => new Response("secret-response", { status }),
			});
			expect(await remote.decide(request)).toEqual({ error: { code: `auth_${status}` } });
			const local = kevThroughControl(() => ({ ok: true, status, body: "secret-response" }));
			expect(await local.decide(request)).toEqual({ error: { code: `auth_${status}` } });
		}
	});

	test("an oversized inference reply is refused by the supervisor, not decoded here", async () => {
		const provider = kevThroughControl(() => ({ ok: false, error: "response_too_large" }));
		expect((await provider.decide(request)).error?.code).toBe("response_too_large");
	});
});
