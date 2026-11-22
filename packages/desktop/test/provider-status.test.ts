import { describe, expect, test } from "bun:test";
import type { DesktopAuthProvider, DesktopAuthState, DesktopModel } from "@gajae-code/desktop-host/protocol";
import {
	type ConversationCatalog,
	filterProviders,
	flowOutcome,
	normalizeApiKeyDraft,
	type ProviderGroups,
	projectProviders,
	safeAuthorizationUrl,
	settledCatalogAnswer,
	shouldShowProviderOnboarding,
	visibleFlow,
} from "../src/provider-status";

function provider(id: string, overrides: Partial<DesktopAuthProvider> = {}): DesktopAuthProvider {
	return {
		id,
		name: id,
		configured: false,
		stored: false,
		credentialKinds: [],
		canSignIn: true,
		canStoreKey: true,
		...overrides,
	};
}

function model(provider: string, id: string): DesktopModel {
	return {
		id: `${provider}/${id}`,
		name: id,
		provider,
		contextWindow: 8192,
		reasoning: false,
		thinking: { options: [] },
	};
}

const flow = (overrides: Partial<DesktopAuthState> = {}): DesktopAuthState => ({
	id: "00000000-0000-4000-8000-000000000001",
	provider: "beta",
	status: "authorizing",
	...overrides,
});

const statuses = (groups: ProviderGroups) =>
	Object.fromEntries([...groups.connected, ...groups.available].map(row => [row.id, row.status]));
const order = (groups: ProviderGroups) => ({
	connected: groups.connected.map(row => row.id),
	available: groups.available.map(row => row.id),
});

describe("provider status projection", () => {
	const providers = [
		provider("none"),
		provider("ready", { configured: true, stored: true, credentialKinds: ["api_key"] }),
		provider("configured", { configured: true, stored: true, credentialKinds: ["oauth"] }),
		provider("external", { configured: true, stored: false }),
		// Models without effective auth (a keyless local endpoint) are still ready.
		provider("local"),
	];
	const models = [model("ready", "one"), model("ready", "two"), model("local", "only"), model("unlisted", "x")];

	test("derives ready, configured, external and none from auth state and model counts", () => {
		const groups = projectProviders(providers, models, null, new Set());
		expect(statuses(groups)).toEqual({
			none: "none",
			ready: "ready",
			configured: "configured",
			external: "external",
			local: "ready",
		});
		const counts = Object.fromEntries([...groups.connected, ...groups.available].map(row => [row.id, row.models]));
		expect(counts).toEqual({ none: 0, ready: 2, configured: 0, external: 0, local: 1 });
	});

	test("an active flow shows as connecting whoever started it; a failure only for an owned flow", () => {
		for (const status of ["authorizing", "waiting"] as const)
			expect(
				statuses(projectProviders(providers, models, flow({ provider: "ready", status }), new Set())).ready,
			).toBe("connecting");
		const failed = flow({ provider: "none", status: "error", error: "Authorization failed" });
		expect(statuses(projectProviders(providers, models, failed, new Set())).none).toBe("none");
		expect(statuses(projectProviders(providers, models, failed, new Set([failed.id]))).none).toBe("failed");
		// Saved credentials whose catalog refresh failed are not a failure of the provider row.
		const saved = { ...failed, provider: "configured", catalogRefreshed: false as const };
		expect(statuses(projectProviders(providers, models, saved, new Set([saved.id]))).configured).toBe("configured");
		// Cancelled and completed flows never override the provider's own state.
		for (const status of ["cancelled", "complete"] as const)
			expect(
				statuses(projectProviders(providers, models, flow({ provider: "none", status }), new Set([flow().id])))
					.none,
			).toBe("none");
	});

	test("groups connected providers first and sorts each group by display name", () => {
		const groups = projectProviders(
			[
				provider("z-id", { name: "Alpha" }),
				provider("b-id", { name: "beta" }),
				provider("a-id", { name: "Gamma", configured: true, stored: true }),
				provider("c-id", { name: "Delta" }),
			],
			[model("c-id", "m")],
			null,
			new Set(),
		);
		expect(order(groups)).toEqual({ connected: ["c-id", "a-id"], available: ["z-id", "b-id"] });
		expect(groups.connected.every(row => row.connected)).toBe(true);
	});

	test("searches names and ids case-insensitively, including Korean names", () => {
		const groups = projectProviders(
			[
				provider("design-korean-gateway", { name: "한국 게이트웨이" }),
				provider("openai", { configured: true, stored: true }),
				provider("minimax-code", { name: "MiniMax Coding Plan (International)" }),
			],
			[],
			null,
			new Set(),
		);
		expect(order(filterProviders(groups, "게이트"))).toEqual({ connected: [], available: ["design-korean-gateway"] });
		expect(order(filterProviders(groups, "  MINIMAX "))).toEqual({ connected: [], available: ["minimax-code"] });
		expect(order(filterProviders(groups, "OpenAI"))).toEqual({ connected: ["openai"], available: [] });
		expect(order(filterProviders(groups, "korean-gate"))).toEqual({
			connected: [],
			available: ["design-korean-gateway"],
		});
		expect(filterProviders(groups, "   ")).toBe(groups);
		expect(order(filterProviders(groups, "nothing-matches"))).toEqual({ connected: [], available: [] });
	});

	test("normalizes API key drafts with the SDK's storage rule", () => {
		expect(normalizeApiKeyDraft("  sk-live-key \n")).toEqual({ ok: true, key: "sk-live-key" });
		expect(normalizeApiKeyDraft("")).toEqual({ ok: false, reason: "empty" });
		expect(normalizeApiKeyDraft(" \t\n")).toEqual({ ok: false, reason: "empty" });
		expect(normalizeApiKeyDraft("!op read secret")).toEqual({ ok: false, reason: "command" });
		expect(normalizeApiKeyDraft("  !op read secret")).toEqual({ ok: false, reason: "command" });
		expect(normalizeApiKeyDraft("sk-!-inside")).toEqual({ ok: true, key: "sk-!-inside" });
	});

	test("shows an active flow to anyone, and a finished one only to its owner", () => {
		const active = flow({ status: "waiting" });
		expect(visibleFlow(active, new Set())).toBe(active);
		const done = flow({ status: "complete" });
		expect(visibleFlow(done, new Set())).toBeNull();
		expect(visibleFlow(done, new Set([done.id]))).toBe(done);
		expect(visibleFlow(null, new Set([done.id]))).toBeNull();
	});

	test("classifies a flow for the flow card", () => {
		expect(flowOutcome(flow({ status: "authorizing" }))).toBe("active");
		expect(flowOutcome(flow({ status: "waiting" }))).toBe("active");
		expect(flowOutcome(flow({ status: "complete" }))).toBe("connected");
		expect(flowOutcome(flow({ status: "cancelled" }))).toBe("cancelled");
		expect(flowOutcome(flow({ status: "error", error: "Authorization failed" }))).toBe("failed");
		expect(flowOutcome(flow({ status: "error", error: "saved", catalogRefreshed: false }))).toBe(
			"saved-refresh-failed",
		);
	});

	test("opens only HTTPS authorization URLs without embedded credentials", () => {
		expect(safeAuthorizationUrl("https://example.invalid/authorize?state=x")).toBe(
			"https://example.invalid/authorize?state=x",
		);
		for (const unsafe of [
			undefined,
			"",
			"http://example.invalid/authorize",
			"https://user:pass@example.invalid/",
			"file:///tmp/x",
			"not a url",
		])
			expect(safeAuthorizationUrl(unsafe)).toBeUndefined();
	});
});

describe("zero-model onboarding predicate", () => {
	const session = { id: "s", controlGeneration: 3 };
	const catalog = (overrides: Partial<ConversationCatalog> = {}): ConversationCatalog => ({
		sessionId: "s",
		generation: 3,
		models: [],
		loading: false,
		...overrides,
	});
	const none = [] as DesktopModel[];

	test("needs a connected app whose snapshot has no available model", () => {
		expect(shouldShowProviderOnboarding({ connected: true, models: undefined, conversation: null })).toBe(false);
		expect(shouldShowProviderOnboarding({ connected: false, models: none, conversation: null })).toBe(false);
		expect(shouldShowProviderOnboarding({ connected: true, models: [model("p", "m")], conversation: null })).toBe(
			false,
		);
		expect(shouldShowProviderOnboarding({ connected: true, models: none, conversation: null })).toBe(true);
	});

	test("with a conversation open, follows that conversation's settled catalog", () => {
		const show = (answer: "models" | "empty" | "error" | undefined) =>
			shouldShowProviderOnboarding({ connected: true, models: none, conversation: { answer } });
		expect(show("empty")).toBe(true);
		// A runtime-registered provider can serve this conversation even when the snapshot has none.
		expect(show("models")).toBe(false);
		// An error neither shows nor hides it: the snapshot decides.
		expect(show("error")).toBe(true);
		// Unknown until the catalog settles once, so it cannot blink in and out while it loads.
		expect(show(undefined)).toBe(false);
		expect(
			shouldShowProviderOnboarding({
				connected: true,
				models: [model("p", "m")],
				conversation: { answer: "empty" },
			}),
		).toBe(false);
	});

	test("reads a catalog only when it settled for the conversation's current generation", () => {
		expect(settledCatalogAnswer(catalog(), session)).toBe("empty");
		expect(settledCatalogAnswer(catalog({ models: [model("p", "m")] }), session)).toBe("models");
		expect(settledCatalogAnswer(catalog({ error: "Model list refresh failed" }), session)).toBe("error");
		expect(settledCatalogAnswer(catalog({ loading: true }), session)).toBeUndefined();
		expect(settledCatalogAnswer(catalog({ generation: 2, models: [model("p", "m")] }), session)).toBeUndefined();
		expect(settledCatalogAnswer(catalog({ sessionId: "other" }), session)).toBeUndefined();
		expect(settledCatalogAnswer(catalog({ generation: null }), { id: "s", controlGeneration: null })).toBeUndefined();
	});
});
