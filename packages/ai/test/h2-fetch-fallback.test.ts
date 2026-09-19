import { afterEach, describe, expect, it } from "bun:test";
import { installH2Fetch } from "../src/utils/h2-fetch";

/**
 * Issue #5178 regression coverage: the gjc login flow fetches the GLM ZCode
 * OAuth broker through the h2-fetch wrapper. Bun's h2 client reports an
 * ALPN-refusing host's TLS abort as UNKNOWN_CERTIFICATE_VERIFICATION_ERROR
 * even though the same request verifies fine over h1, which surfaced as
 * "Login failed: unknown certificate verification error" during token
 * exchange. The wrapper must fall back to h1 for that code while genuine
 * certificate failures keep failing closed with their real codes.
 *
 * The tests drive a mock base fetch so they assert the wrapper's fallback
 * contract only — no network, no secrets.
 */

interface RecordedCall {
	input: string | URL | Request;
	init: RequestInit | undefined;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

function withPatchedFetch(impl: FetchLike): { calls: RecordedCall[]; restore: () => void } {
	const original = globalThis.fetch;
	const calls: RecordedCall[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ input, init });
		return impl(input, init);
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

const BROKER_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";

/** The exact request shape exchangeGlmZcodeCode() sends (no real credentials). */
function brokerBody(): Record<string, string> {
	return { provider: "zai", code: "test-code", redirect_uri: "zcode://oauth/callback", state: "s" };
}

function brokerExchangeInit(): RequestInit {
	return {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify(brokerBody()),
	};
}

describe("h2-fetch wrapper (issue #5178)", () => {
	afterEach(() => {
		const patchedFetch = globalThis.fetch as unknown as { [key: symbol]: unknown };
		delete patchedFetch[Symbol.for("gajae-code.h2fetch.installed")];
	});

	it("falls back to h1 when the h2 attempt fails with UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", async () => {
		const verificationFailure = Object.assign(new TypeError("unknown certificate verification error"), {
			code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
		});

		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				throw verificationFailure;
			}
			return Promise.resolve(new Response("ok-h1", { status: 200 }));
		});
		installH2Fetch();

		const response = await fetch(BROKER_TOKEN_URL, brokerExchangeInit());
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok-h1");

		const h2Attempts = patched.calls.filter(c => (c.init as { protocol?: string } | undefined)?.protocol === "http2");
		const h1Attempts = patched.calls.filter(
			c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
		);
		expect(h2Attempts).toHaveLength(1);
		expect(h1Attempts).toHaveLength(1);
		expect(h1Attempts[0]?.init?.method).toBe("POST");
		patched.restore();
	});

	it("retries the identical request on h1 without the protocol hint", async () => {
		const verificationFailure = Object.assign(new TypeError("unknown certificate verification error"), {
			code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
		});

		const seenInits: Array<Record<string, unknown>> = [];
		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				throw verificationFailure;
			}
			seenInits.push({ ...(init ?? {}) });
			return Promise.resolve(
				new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
			);
		});
		installH2Fetch();

		const response = await fetch(BROKER_TOKEN_URL, brokerExchangeInit());
		expect(await response.json()).toEqual({ ok: true });

		expect(seenInits).toHaveLength(1);
		const h1Init = seenInits[0] as {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
			protocol?: string;
		};
		expect(h1Init.method).toBe("POST");
		expect(h1Init.body).toBe(JSON.stringify(brokerBody()));
		expect(h1Init.headers?.["Content-Type"]).toBe("application/json");
		expect(h1Init.protocol).toBeUndefined();
		patched.restore();
	});

	it("still fails closed on genuine certificate verification errors on h1", async () => {
		const genuineFailure = Object.assign(new TypeError("self signed certificate"), {
			code: "DEPTH_ZERO_SELF_SIGNED_CERT",
		});

		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				return Promise.reject(
					Object.assign(new TypeError("unknown certificate verification error"), {
						code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
					}),
				);
			}
			return Promise.reject(genuineFailure);
		});
		installH2Fetch();

		let caught: unknown;
		try {
			await fetch(BROKER_TOKEN_URL, brokerExchangeInit());
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string }).code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
		expect((caught as Error).message).not.toContain("unknown certificate");
		patched.restore();
	});

	it("does not replay a consumed POST after an h2 stream reset", async () => {
		const streamReset = Object.assign(
			new Error(
				'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
			),
			{ code: "HTTP2StreamReset" },
		);

		let serverProcessed = 0;
		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				// Model the request body reaching the peer before the server resets the
				// stream. A wrapper-level reset is not proof that the request was unseen.
				serverProcessed++;
				throw streamReset;
			}
			serverProcessed++;
			return Promise.resolve(new Response("ok-h1", { status: 200 }));
		});
		installH2Fetch();

		let caught: unknown;
		try {
			await fetch("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ stream: true }),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(streamReset);
		expect(serverProcessed).toBe(1);

		const h1Attempts = patched.calls.filter(
			c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
		);
		expect(h1Attempts).toHaveLength(0);
		patched.restore();
	});

	it("falls back to h1 for an idempotent GET after an h2 stream reset", async () => {
		const streamReset = Object.assign(new Error("HTTP/2 stream reset"), { code: "HTTP2StreamReset" });

		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") throw streamReset;
			return Promise.resolve(new Response("ok-h1", { status: 200 }));
		});
		installH2Fetch();

		const response = await fetch("https://chatgpt.com/backend-api/codex/responses");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok-h1");

		const h1Attempts = patched.calls.filter(
			c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
		);
		expect(h1Attempts).toHaveLength(1);
		expect(h1Attempts[0]?.init?.method).toBeUndefined();
		patched.restore();
	});

	it("does not replay a consumed OPTIONS stream body after an h2 stream reset", async () => {
		const streamReset = Object.assign(new Error("HTTP/2 stream reset"), { code: "HTTP2StreamReset" });
		const requestBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("one-shot"));
				controller.close();
			},
		});
		let bodyConsumed = false;

		const patched = withPatchedFetch(async (_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				const body = init?.body;
				if (!(body instanceof ReadableStream)) throw new Error("test body was not a stream");
				await body.getReader().read();
				bodyConsumed = true;
				throw streamReset;
			}
			if (bodyConsumed) throw new TypeError("Body is unusable");
			throw new Error("unexpected h1 retry");
		});
		installH2Fetch();

		let caught: unknown;
		try {
			await fetch("https://chatgpt.com/backend-api/codex/responses", {
				method: "OPTIONS",
				body: requestBody,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(streamReset);
		expect(bodyConsumed).toBe(true);

		const h1Attempts = patched.calls.filter(
			c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
		);
		expect(h1Attempts).toHaveLength(0);
		patched.restore();
	});

	it("does not fall back for application-level failures", async () => {
		const patched = withPatchedFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
		installH2Fetch();

		const response = await fetch(BROKER_TOKEN_URL, brokerExchangeInit());
		expect(response.status).toBe(500);
		expect(patched.calls).toHaveLength(1);
		patched.restore();
	});

	/**
	 * Issue #5649: a reset or a close can arrive after the peer already consumed
	 * the request body, so replaying a non-idempotent method on h1 duplicates the
	 * side effect. Those two codes must fall back only for replay-safe methods.
	 */
	for (const code of ["ConnectionReset", "ConnectionClosed"] as const) {
		it(`does not replay a POST on h1 after ${code}`, async () => {
			const transportFailure = Object.assign(new TypeError(`connection ${code}`), { code });

			let processed = 0;
			const patched = withPatchedFetch((_input, init) => {
				// Model the peer consuming the body before the connection dies: the
				// side effect has already landed by the time we see the failure.
				processed += 1;
				if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
					throw transportFailure;
				}
				return Promise.resolve(new Response("ok-h1", { status: 200 }));
			});
			installH2Fetch();

			let caught: unknown;
			try {
				await fetch(BROKER_TOKEN_URL, brokerExchangeInit());
			} catch (error) {
				caught = error;
			}

			expect(caught).toBe(transportFailure);
			expect(processed).toBe(1);
			const h1Attempts = patched.calls.filter(
				c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
			);
			expect(h1Attempts).toHaveLength(0);
			patched.restore();
		});
	}

	it("still falls back to h1 for a replay-safe GET after ConnectionReset", async () => {
		const transportFailure = Object.assign(new TypeError("connection reset"), { code: "ConnectionReset" });

		const patched = withPatchedFetch((_input, init) => {
			if ((init as { protocol?: string } | undefined)?.protocol === "http2") {
				throw transportFailure;
			}
			return Promise.resolve(new Response("ok-h1", { status: 200 }));
		});
		installH2Fetch();

		const response = await fetch(BROKER_TOKEN_URL, { method: "GET" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok-h1");

		const h1Attempts = patched.calls.filter(
			c => (c.init as { protocol?: string } | undefined)?.protocol === undefined,
		);
		expect(h1Attempts).toHaveLength(1);
		patched.restore();
	});

	it("passes non-https requests through without the h2 hint", async () => {
		const patched = withPatchedFetch(() => Promise.resolve(new Response("local", { status: 200 })));
		installH2Fetch();

		const response = await fetch("http://127.0.0.1:9/callback");
		expect(response.status).toBe(200);
		expect(patched.calls).toHaveLength(1);
		expect((patched.calls[0]?.init as { protocol?: string } | undefined)?.protocol).toBeUndefined();
		patched.restore();
	});
});
