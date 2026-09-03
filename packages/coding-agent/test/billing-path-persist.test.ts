import { describe, expect, test } from "bun:test";
import { deriveBillingPath } from "@gajae-code/coding-agent/config/billing-path";

function blob(p: any): string {
	return JSON.stringify(p);
}

describe("billing dismiss + width contract (issue #5218 f/e)", () => {
	test("dismissKey is scoped per provider+billingKind (one-time per credential source)", () => {
		const a = deriveBillingPath("openai", "openai-responses", "key")!;
		const aa = deriveBillingPath("openai", "openai-responses", "key")!;
		const b = deriveBillingPath("google-vertex", "google-vertex", "key")!;
		expect(a.dismissKey).toBe(aa.dismissKey);
		expect(a.dismissKey).not.toBe(b.dismissKey);
		expect(a.dismissKey).toBe("metered-api:openai");
		expect(b.dismissKey).toBe("cloud-project:google-vertex");
	});
	test("no credential material in BillingPath (f)", () => {
		const p = deriveBillingPath("openai", "openai-responses", "key")!;
		const s = blob(p);
		expect(s).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
		expect(s).not.toMatch(/GOOGLE_CLOUD_API_KEY|AWS_BEARER_TOKEN|projectId/);
		expect(s).not.toMatch(/gcp-project-id-secre/);
		// dismissKey must be provider-normalized, not a raw selector that could leak a key tail
		expect(p.dismissKey).toMatch(/^(metered-api|cloud-project):[a-z0-9._-]+$/);
	});
});
