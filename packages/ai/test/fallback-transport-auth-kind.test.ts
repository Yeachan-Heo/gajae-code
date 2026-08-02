import { describe, expect, it } from "bun:test";

import { classifyFallbackTrigger, isForbiddenAuthFailure } from "../src/utils/fallback-transport";

/**
 * The transport collapses 401 and 403 into a single `auth` class. These cases
 * pin the refinement that tells them apart without adding a new trigger class,
 * including the precedence rule for facts that disagree.
 */
describe("fallback transport — auth disposition", () => {
	const facts = (status?: number, providerCode?: string) => ({
		kind: "transport" as const,
		...(status === undefined ? {} : { status }),
		...(providerCode === undefined ? {} : { providerCode }),
	});

	it("keeps the auth class unchanged so existing consumers still compile and match", () => {
		expect(classifyFallbackTrigger(facts(401)).class).toBe("auth");
		expect(classifyFallbackTrigger(facts(403)).class).toBe("auth");
		expect(classifyFallbackTrigger(facts(undefined, "invalid_api_key")).class).toBe("auth");
		expect(classifyFallbackTrigger(facts(undefined, "forbidden")).class).toBe("auth");
	});

	it("treats a bare 401 as a credential problem", () => {
		expect(classifyFallbackTrigger(facts(401)).authDisposition).toBe("credential");
		expect(isForbiddenAuthFailure(facts(401))).toBe(false);
	});

	it("treats a bare 403 as terminal", () => {
		expect(classifyFallbackTrigger(facts(403)).authDisposition).toBe("forbidden");
		expect(isForbiddenAuthFailure(facts(403))).toBe(true);
	});

	it("lets a typed provider code win over the HTTP status", () => {
		// The conflicting-fact case the plan calls out explicitly.
		expect(classifyFallbackTrigger(facts(401, "forbidden")).authDisposition).toBe("forbidden");
		expect(isForbiddenAuthFailure(facts(401, "forbidden"))).toBe(true);

		expect(classifyFallbackTrigger(facts(403, "invalid_api_key")).authDisposition).toBe("credential");
		expect(isForbiddenAuthFailure(facts(403, "invalid_api_key"))).toBe(false);
	});

	it("resolves mixed typed codes by specificity, not by field order", () => {
		// `classifyFallbackTrigger` selects a single code for the trigger class
		// (`openaiErrorCode ?? anthropicErrorType ?? providerCode`), so facts that
		// carry both a first-party typed code and a provider code would otherwise
		// have their disposition decided by which field happened to win.
		const credentialFirst = {
			kind: "transport" as const,
			status: 401,
			providerCode: "forbidden",
			openaiErrorCode: "invalid_api_key",
		};
		expect(classifyFallbackTrigger(credentialFirst).class).toBe("auth");
		expect(classifyFallbackTrigger(credentialFirst).authDisposition).toBe("credential");
		expect(isForbiddenAuthFailure(credentialFirst)).toBe(false);

		const forbiddenFirst = {
			kind: "transport" as const,
			status: 401,
			providerCode: "invalid_api_key",
			openaiErrorCode: "forbidden",
		};
		expect(classifyFallbackTrigger(forbiddenFirst).class).toBe("auth");
		expect(classifyFallbackTrigger(forbiddenFirst).authDisposition).toBe("credential");
		expect(isForbiddenAuthFailure(forbiddenFirst)).toBe(false);

		// A concrete credential fault in the Anthropic field also outranks a
		// generic `forbidden` arriving from the provider.
		const anthropicCredential = {
			kind: "transport" as const,
			status: 403,
			providerCode: "forbidden",
			anthropicErrorType: "authentication_error",
		};
		expect(classifyFallbackTrigger(anthropicCredential).authDisposition).toBe("credential");
		expect(isForbiddenAuthFailure(anthropicCredential)).toBe(false);

		// With no concrete credential fault anywhere, a `forbidden` in any single
		// field stays terminal regardless of which field carries it.
		const forbiddenOnly = {
			kind: "transport" as const,
			status: 401,
			providerCode: "forbidden",
			openaiErrorCode: "server_error",
		};
		expect(classifyFallbackTrigger(forbiddenOnly).authDisposition).toBe("forbidden");
		expect(isForbiddenAuthFailure(forbiddenOnly)).toBe(true);
	});

	it("classifies every credential-recoverable auth code as credential", () => {
		for (const code of [
			"authentication_error",
			"invalid_api_key",
			"invalid_token",
			"token_expired",
			"unauthorized",
		]) {
			expect(classifyFallbackTrigger(facts(undefined, code)).authDisposition).toBe("credential");
			expect(isForbiddenAuthFailure(facts(undefined, code))).toBe(false);
		}
	});

	it("never attaches a disposition to a non-auth trigger", () => {
		expect(classifyFallbackTrigger(facts(429)).authDisposition).toBeUndefined();
		expect(classifyFallbackTrigger(facts(500)).authDisposition).toBeUndefined();
		expect(classifyFallbackTrigger(facts(undefined, "rate_limit")).authDisposition).toBeUndefined();
		expect(isForbiddenAuthFailure(facts(429))).toBe(false);
	});

	it("reports no forbidden failure for input carrying no transport facts", () => {
		expect(isForbiddenAuthFailure(new Error("plain"))).toBe(false);
		expect(isForbiddenAuthFailure(undefined)).toBe(false);
	});

	it("preserves retry-after alongside the disposition", () => {
		const trigger = classifyFallbackTrigger({
			kind: "transport",
			status: 401,
			headers: { "retry-after": "2" },
		});
		expect(trigger.class).toBe("auth");
		expect(trigger.authDisposition).toBe("credential");
		expect(trigger.retryAfterMs).toBe(2000);
	});
});
