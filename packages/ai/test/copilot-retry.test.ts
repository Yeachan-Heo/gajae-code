import { describe, expect, it } from "bun:test";
import { callWithCopilotModelRetry, isCopilotTransientModelError } from "@gajae-code/ai/utils/retry";
import { isRetryableError } from "@gajae-code/utils";

type ErrorShape = { status: number; code?: string; error?: { code?: string; message?: string }; message: string };

function copilotError({ status, code, error, message }: ErrorShape): Error {
	const err = new Error(message);
	(err as unknown as ErrorShape).status = status;
	if (code !== undefined) (err as unknown as ErrorShape).code = code;
	if (error !== undefined) (err as unknown as ErrorShape).error = error;
	return err;
}

describe("isCopilotTransientModelError", () => {
	it("matches 400 with top-level code=model_not_supported", () => {
		const err = copilotError({
			status: 400,
			code: "model_not_supported",
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("matches 400 with nested error.code=model_not_supported (OpenAI SDK shape)", () => {
		const err = copilotError({
			status: 400,
			error: { code: "model_not_supported", message: "The requested model is not supported." },
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("does not match other 400 codes", () => {
		const err = copilotError({
			status: 400,
			code: "invalid_request_body",
			message: "Unsupported value: 'minimal'",
		});
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	it("does not match 401/403/500 regardless of code", () => {
		for (const status of [401, 403, 500]) {
			const err = copilotError({
				status,
				code: "model_not_supported",
				message: `${status} error`,
			});
			expect(isCopilotTransientModelError(err)).toBe(false);
		}
	});

	it("does not match errors without a status", () => {
		expect(isCopilotTransientModelError(new Error("oops"))).toBe(false);
		expect(isCopilotTransientModelError("not an object")).toBe(false);
		expect(isCopilotTransientModelError(null)).toBe(false);
	});
});

describe("callWithCopilotModelRetry", () => {
	it("is a no-op for non-github-copilot providers", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "nope" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "openai" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("retries up to 3 attempts for Copilot transient errors and eventually throws the last error", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "transient" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(3);
	});

	it("does not replay a managed Copilot attempt", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "transient" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", fallbackManaged: true },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("succeeds on the second attempt when the first is transient", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not retry non-transient Copilot errors", async () => {
		let calls = 0;
		const err = copilotError({ status: 401, code: "unauthorized", message: "auth failed" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("stops retrying when the caller aborts during backoff", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				},
				{ provider: "github-copilot", signal: controller.signal, retryBaseDelayMs: 0 },
			),
		).rejects.toBeDefined();
		// fn runs once; scheduler.wait rejects before a second attempt.
		expect(calls).toBe(1);
	});
});

describe("isRetryableError transport failures", () => {
	it("retries Bun socket closure errors", () => {
		expect(
			isRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});
});

describe("isRetryableError does not treat 4xx as retryable", () => {
	// Regression guard: the new Copilot carveout must not leak into the generic predicate.
	it("returns false for Copilot transient model errors", () => {
		const err = copilotError({ status: 400, code: "model_not_supported", message: "x" });
		expect(isRetryableError(err)).toBe(false);
	});
});
