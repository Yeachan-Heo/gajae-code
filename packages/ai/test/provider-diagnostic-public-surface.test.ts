import { describe, expect, it } from "bun:test";
import { attachProviderDiagnostic } from "../src/adapter-internals/provider-diagnostic-carrier";
import * as aiCore from "../src/core";
import * as aiIndex from "../src/index";
import { readProviderDiagnostic, sanitizeProviderDiagnostic } from "../src/provider-diagnostic";

/**
 * The public surface must be able to READ and VALIDATE a diagnostic and nothing
 * else. A consumer that can reach the code mapping, the builder or the
 * classifier can mint one — and worse, can widen the closed allowlist the
 * validator depends on, which turns the DTO into an arbitrary string channel.
 */

const MARKER = "SYNTHETIC-SECRET-MARKER-ai-public";

const MINT_SURFACE = [
	"PROVIDER_CODE_CATEGORIES",
	"buildProviderDiagnostic",
	"classifyProviderFacts",
	"categoryForStatus",
	"isCodeStatusCompatible",
	"isValidDiagnosticStatus",
	"isPlainRecord",
	"attachProviderDiagnostic",
];

describe("public provider-diagnostic surface", () => {
	it("exports only DTO validation and reading from the package barrels", () => {
		for (const name of MINT_SURFACE) {
			expect((aiIndex as Record<string, unknown>)[name], `@gajae-code/ai must not export ${name}`).toBeUndefined();
			expect(
				(aiCore as Record<string, unknown>)[name],
				`@gajae-code/ai/core must not export ${name}`,
			).toBeUndefined();
		}
		expect(typeof aiCore.sanitizeProviderDiagnostic).toBe("function");
		expect(typeof aiCore.readProviderDiagnostic).toBe("function");
		expect(typeof aiCore.PROVIDER_DIAGNOSTIC_MAX_BYTES).toBe("number");
	});

	it("keeps the code allowlist closed against any mutation reachable from the barrel", () => {
		// Whatever a consumer can reach, it must not be able to teach the
		// validator a new code.
		for (const surface of [aiIndex, aiCore] as Array<Record<string, unknown>>) {
			for (const value of Object.values(surface)) {
				if (value instanceof Map) {
					try {
						(value as Map<string, string>).set(MARKER, "auth");
					} catch {
						// frozen or proxied: equally acceptable
					}
				}
				if (value && typeof value === "object" && !(value instanceof Map)) {
					try {
						(value as Record<string, unknown>)[MARKER] = "auth";
					} catch {
						// non-extensible: acceptable
					}
				}
			}
		}

		expect(
			sanitizeProviderDiagnostic({ category: "auth", code: MARKER, evidence: "structured_code" }),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({ category: "auth", httpStatus: 401, code: MARKER, evidence: "structured_code" }),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "unknown",
				code: MARKER,
				evidence: "structured_status",
				httpStatus: 429,
			}),
		).toBeUndefined();
	});

	it("returns a fresh validated snapshot from the carrier reader", () => {
		const error = attachProviderDiagnostic(new Error("provider failed"), {
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});

		const first = readProviderDiagnostic(error);
		expect(first).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
		(first as unknown as Record<string, unknown>).category = "quota";
		(first as unknown as Record<string, unknown>).detail = MARKER;

		const second = readProviderDiagnostic(error);
		expect(second).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
		expect(second).not.toBe(first);
		expect(JSON.stringify(second)).not.toContain(MARKER);
	});
});
