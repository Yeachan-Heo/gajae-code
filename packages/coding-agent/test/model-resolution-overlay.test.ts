import { describe, expect, test } from "bun:test";
import {
	type CanonicalModelRecordInput,
	createCanonicalModelCatalog,
	ModelCatalogError,
} from "@gajae-code/coding-agent/config/model-catalog";
import {
	createModelResolutionOverlay,
	ModelCatalogSessionStore,
	type ModelResolutionOverlayInput,
} from "@gajae-code/coding-agent/config/model-resolution-overlay";

const records: CanonicalModelRecordInput[] = [
	{
		canonicalId: "openai/primary",
		provider: "openai",
		modelId: "primary",
		displayName: "Primary",
		inputModalities: ["text"],
		capabilities: ["reasoning"],
		reasoning: true,
		contextWindow: 1000,
		maxTokens: 100,
		source: "builtin",
		sourceVersion: "builtin",
		revision: 1,
		freshness: { status: "fresh" },
	},
	{
		canonicalId: "anthropic/fallback",
		provider: "anthropic",
		modelId: "fallback",
		displayName: "Fallback",
		inputModalities: ["text"],
		capabilities: [],
		reasoning: false,
		contextWindow: 2000,
		maxTokens: 200,
		source: "builtin",
		sourceVersion: "builtin",
		revision: 1,
		freshness: { status: "fresh" },
	},
];
const catalog = createCanonicalModelCatalog(records, { revision: 9 });

function overlay(sessionId: string, sessionRevision = 1): ModelResolutionOverlayInput {
	return {
		sessionId,
		catalogRevision: 9,
		sessionRevision,
		catalogRecordId: "openai/primary",
		requestedSelectors: ["openai/primary:high"],
		requestedRoles: ["default"],
		resolvedCanonicalIds: ["openai/primary"],
		resolvedEfforts: ["high"],
		fallbackChain: ["openai/primary", "anthropic/fallback"],
		activeIndex: 0,
		skips: [{ catalogRecordId: "anthropic/fallback", reason: "not_needed" }],
		scope: "session",
		timing: { requestedAt: 1, appliedAt: 2 },
		confirmation: { status: "confirmed", timestamp: 3 },
		usability: { status: "usable" },
		receiptRefs: ["receipt-1"],
		workMode: { id: "review", fingerprint: "sha256:abc" },
	};
}

describe("model resolution overlay", () => {
	test("constructs a deeply frozen catalog-reference-only overlay", () => {
		const value = createModelResolutionOverlay(overlay("session-a"), catalog);

		expect(value.sessionId).toBe("session-a");
		expect(value.catalogRevision).toBe(9);
		expect(value.sessionRevision).toBe(1);
		expect(value.fallbackChain).toEqual(["openai/primary", "anthropic/fallback"]);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.fallbackChain)).toBe(true);
		expect(Object.isFrozen(value.skips)).toBe(true);
		expect(Object.isFrozen(value.skips[0])).toBe(true);
		expect(Object.isFrozen(value.timing)).toBe(true);
		expect(Object.isFrozen(value.confirmation)).toBe(true);
		expect(Object.isFrozen(value.workMode)).toBe(true);
	});

	test("rejects unknown references and stale catalog revisions", () => {
		const unknown: ModelResolutionOverlayInput = { ...overlay("session-a"), catalogRecordId: "missing/model" };
		expect(() => createModelResolutionOverlay(unknown, catalog)).toThrow("unknown");
		const stale: ModelResolutionOverlayInput = { ...overlay("session-a"), catalogRevision: 8 };
		expect(() => createModelResolutionOverlay(stale, catalog)).toThrow("stale");
	});

	test("updates one session with CAS and rejects stale writes", () => {
		const store = new ModelCatalogSessionStore(catalog);
		const first = createModelResolutionOverlay(overlay("session-a"), catalog);
		store.putOverlay(first, { catalogRevision: 9, sessionRevision: 0 });
		const alias = { ...first, sessionId: " session-a " };
		expect(() => store.putOverlay(alias, { catalogRevision: 9, sessionRevision: 0 })).toThrow(ModelCatalogError);
		expect(store.getSessionRevision("session-a")).toBe(1);

		const next = createModelResolutionOverlay(overlay("session-a", 2), catalog);
		store.putOverlay(next, { catalogRevision: 9, sessionRevision: 1 });
		expect(store.getOverlay("session-a")?.sessionRevision).toBe(2);
		expect(() => store.putOverlay(next, { catalogRevision: 9, sessionRevision: 1 })).toThrow("changed");
	});

	test("clear uses the same CAS boundary", () => {
		const store = new ModelCatalogSessionStore(catalog);
		store.putOverlay(createModelResolutionOverlay(overlay("session-a"), catalog), {
			catalogRevision: 9,
			sessionRevision: 0,
		});
		store.putOverlay(createModelResolutionOverlay(overlay("session-b"), catalog), {
			catalogRevision: 9,
			sessionRevision: 0,
		});

		store.clearOverlay("session-a", { catalogRevision: 9, sessionRevision: 1 });
		expect(store.getOverlay("session-a")).toBeUndefined();
		expect(store.getSessionRevision("session-a")).toBe(2);
		const staleAfterClear = createModelResolutionOverlay(overlay("session-a", 2), catalog);
		expect(() => store.putOverlay(staleAfterClear, { catalogRevision: 9, sessionRevision: 1 })).toThrow(
			ModelCatalogError,
		);
		store.putOverlay(createModelResolutionOverlay(overlay("session-a", 3), catalog), {
			catalogRevision: 9,
			sessionRevision: 2,
		});
		expect(store.getOverlay("session-a")?.sessionRevision).toBe(3);
		expect(store.getOverlay("session-b")?.sessionId).toBe("session-b");
		expect(() => store.clearOverlay("session-b", { catalogRevision: 9, sessionRevision: 0 })).toThrow("changed");
	});
	test("rejects unsafe selector, reason, and receipt presentation values", () => {
		const expectInvalid = (input: ModelResolutionOverlayInput): void => {
			let error: unknown;
			try {
				createModelResolutionOverlay(input, catalog);
			} catch (caught: unknown) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ModelCatalogError);
			if (error instanceof ModelCatalogError) expect(error.code).toBe("invalid_overlay");
		};

		expectInvalid({ ...overlay("session-a"), requestedSelectors: ["https://provider.invalid/model?api_key=secret"] });
		expectInvalid({
			...overlay("session-a"),
			skips: [{ catalogRecordId: "anthropic/fallback", reason: "api_key=secret" }],
		});
		expectInvalid({
			...overlay("session-a"),
			skips: [{ catalogRecordId: "anthropic/fallback", reason: "unsafe", selector: "openai/model?token=secret" }],
		});
		expectInvalid({ ...overlay("session-a"), usability: { status: "unknown", reason: "https://secret.invalid" } });
		expectInvalid({ ...overlay("session-a"), receiptRefs: ["https://secret.invalid/receipt"] });
	});
});
