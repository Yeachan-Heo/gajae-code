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
