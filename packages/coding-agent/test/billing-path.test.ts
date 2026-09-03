import { describe, expect, test } from "bun:test";
import { deriveBillingPath } from "@gajae-code/coding-agent/config/billing-path";

describe("billing-path disclosure (issue #5218)", () => {
	test("(a) metered vendor API key binding is labeled metered", () => {
		const p = deriveBillingPath("openai", "openai-responses", "key");
		expect(p?.kind).toBe("metered-api");
		expect(p?.label).toContain("metered");
		expect(JSON.stringify(p)).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
	});

	test("(b) Vertex/cloud-project binding is labeled as billing to that cloud project", () => {
		const p = deriveBillingPath("google-vertex", "google-vertex", "key");
		expect(p?.kind).toBe("cloud-project");
		expect(p?.label).toContain("cloud-project");
	});

	test("(c) bundled/plan/proxied binding is NOT labeled metered", () => {
		expect(deriveBillingPath("openai-codex", "openai-codex-responses", "oauth")).toBeUndefined();
		expect(deriveBillingPath("anthropic", "anthropic-messages", "oauth")).toBeUndefined();
		expect(deriveBillingPath("openai", "openai-responses", "unknown")).toBeUndefined();
		expect(deriveBillingPath("ollama", "ollama-chat", "keyless")).toBeUndefined();
	});

	test("(d) custom OpenAI-compatible with user-supplied API key is labeled metered without provider-name allowlist", () => {
		const p = deriveBillingPath("custom-mygateway", "openai-completions", "key");
		expect(p?.kind).toBe("metered-api");
		// same holds for an arbitrary new provider id
		const q = deriveBillingPath("acme-llm-proxy", "openai-responses", "key");
		expect(q?.kind).toBe("metered-api");
	});

	test("no credential material appears in label or dismissKey", () => {
		const p = deriveBillingPath("openai", "openai-responses", "key")!;
		const blob = JSON.stringify(p);
		// must not echo a (fake) key or project id — our derivation never accepts them
		expect(blob).not.toMatch(/sk-/);
		expect(blob).not.toMatch(/projects\//);
		expect(p.dismissKey).toBe("metered-api:openai");
	});

	test("dismissKey is stable per credential source (f below: store layer tested separately)", () => {
		const a = deriveBillingPath("openai", "openai-responses", "key")!;
		const b = deriveBillingPath("openai", "openai-responses", "key")!;
		expect(a.dismissKey).toBe(b.dismissKey);
		const c = deriveBillingPath("google-vertex", "google-vertex", "key")!;
		expect(c.dismissKey).not.toBe(a.dismissKey);
	});
});
