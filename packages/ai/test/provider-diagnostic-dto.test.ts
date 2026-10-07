import { describe, expect, it } from "bun:test";
import { sanitizeProviderDiagnostic } from "../src/provider-diagnostic";

/**
 * The public validator is the only thing standing between a decoded wire/disk
 * record and a consumer that trusts the diagnostic. Closed vocabulary alone is
 * not enough: a record whose fields contradict the fixed mapping is forged or
 * corrupt evidence and must be dropped whole, never partially honoured.
 */

describe("sanitizeProviderDiagnostic", () => {
	it("accepts the exact diagnostics the adapter can mint", () => {
		expect(
			sanitizeProviderDiagnostic({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			}),
		).toEqual({ category: "auth", httpStatus: 401, code: "authentication_error", evidence: "structured_code" });

		expect(
			sanitizeProviderDiagnostic({ category: "unknown", httpStatus: 429, evidence: "structured_status" }),
		).toEqual({ category: "unknown", httpStatus: 429, evidence: "structured_status" });

		expect(
			sanitizeProviderDiagnostic({
				category: "provider_unavailable",
				code: "overloaded_error",
				evidence: "structured_code",
			}),
		).toEqual({ category: "provider_unavailable", code: "overloaded_error", evidence: "structured_code" });
	});

	it("rejects status evidence that carries no status or carries a code", () => {
		expect(sanitizeProviderDiagnostic({ category: "unknown", evidence: "structured_status" })).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_status",
			}),
		).toBeUndefined();
	});

	it("rejects a category that contradicts the code or the status", () => {
		expect(
			sanitizeProviderDiagnostic({
				category: "quota",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			}),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "quota",
				httpStatus: 402,
				code: "billing_error",
				evidence: "structured_code",
			}),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({ category: "auth", httpStatus: 403, evidence: "structured_status" }),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({ category: "rate_limit", httpStatus: 429, evidence: "structured_status" }),
		).toBeUndefined();
	});

	it("rejects a code that contradicts the status it arrived with", () => {
		expect(
			sanitizeProviderDiagnostic({
				category: "auth",
				httpStatus: 500,
				code: "authentication_error",
				evidence: "structured_code",
			}),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "rate_limit",
				httpStatus: 402,
				code: "rate_limit_error",
				evidence: "structured_code",
			}),
		).toBeUndefined();
	});

	it("rejects unsupported vocabulary, out-of-range status and non-record input", () => {
		for (const value of [
			undefined,
			null,
			"auth",
			42,
			[{ category: "auth", evidence: "structured_code", code: "authentication_error" }],
			{ category: "auth", code: "authentication_error", evidence: "message_text" },
			{ category: "sk-ant-secret", httpStatus: 401, evidence: "structured_status" },
			{ category: "auth", httpStatus: 401, code: "insufficient_quota", evidence: "structured_code" },
			{ category: "auth", httpStatus: "401", code: "authentication_error", evidence: "structured_code" },
			{ category: "unknown", httpStatus: 200, evidence: "structured_status" },
			{ category: "unknown", httpStatus: 429.5, evidence: "structured_status" },
			{ category: "unknown", httpStatus: Number.NaN, evidence: "structured_status" },
			{ category: "auth", evidence: "structured_code" },
		]) {
			expect(sanitizeProviderDiagnostic(value)).toBeUndefined();
		}
	});

	it("never re-emits foreign keys or provider text", () => {
		const sanitized = sanitizeProviderDiagnostic({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
			message: "invalid x-api-key sk-ant-secret-DO-NOT-LEAK",
			requestId: "req_leak",
		});

		expect(sanitized).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
		expect(JSON.stringify(sanitized)).not.toContain("sk-ant-secret");
		expect(JSON.stringify(sanitized)).not.toContain("req_leak");
	});

	it("survives hostile records whose reads and identity checks throw", () => {
		const throwingGetter = {
			get category() {
				throw new Error("hostile");
			},
			evidence: "structured_status",
			httpStatus: 401,
		};
		expect(sanitizeProviderDiagnostic(throwingGetter)).toBeUndefined();

		const { proxy, revoke } = Proxy.revocable(
			{ category: "auth", httpStatus: 401, code: "authentication_error", evidence: "structured_code" },
			{},
		);
		revoke();
		expect(sanitizeProviderDiagnostic(proxy)).toBeUndefined();

		const circular: Record<string, unknown> = {
			category: "auth",
			evidence: "structured_code",
			code: "authentication_error",
		};
		circular.self = circular;
		expect(sanitizeProviderDiagnostic(circular)).toEqual({
			category: "auth",
			code: "authentication_error",
			evidence: "structured_code",
		});

		const trapped = {
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
			toJSON() {
				throw new Error("hostile toJSON");
			},
		};
		expect(sanitizeProviderDiagnostic(trapped)).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
	});
});
