import { describe, expect, test } from "bun:test";
import {
	type CanonicalModelRecordInput,
	createCanonicalModelCatalog,
} from "@gajae-code/coding-agent/config/model-catalog";
import {
	createModelResolutionOverlay,
	ModelCatalogSessionStore,
	type ModelResolutionOverlayInput,
} from "@gajae-code/coding-agent/config/model-resolution-overlay";

const catalog = createCanonicalModelCatalog(
	[
		{
			canonicalId: "openai/primary",
			provider: "openai",
			modelId: "primary",
			displayName: "Primary",
			contextWindow: 1000,
			maxTokens: 100,
			source: "builtin",
			sourceVersion: "builtin",
		},
		{
			canonicalId: "anthropic/secondary",
			provider: "anthropic",
			modelId: "secondary",
			displayName: "Secondary",
			contextWindow: 1000,
			maxTokens: 100,
			source: "builtin",
			sourceVersion: "builtin",
		},
	] satisfies CanonicalModelRecordInput[],
	{ revision: 4 },
);

function input(sessionId: string, recordId: string, role: string): ModelResolutionOverlayInput {
	return {
		sessionId,
		catalogRevision: 4,
		sessionRevision: 1,
		catalogRecordId: recordId,
		requestedSelectors: [recordId],
		requestedRoles: [role],
		resolvedCanonicalIds: [recordId],
		resolvedEfforts: ["medium"],
		fallbackChain: [recordId],
		activeIndex: 0,
		receiptRefs: [`${sessionId}-receipt`],
	};
}

describe("SDK session overlay isolation", () => {
	test("keeps two session overlays independent over one immutable base", () => {
		const store = new ModelCatalogSessionStore(catalog);
		const baseBefore = JSON.stringify(store.getBaseSnapshot());
		store.putOverlay(createModelResolutionOverlay(input("session-a", "openai/primary", "default"), catalog), {
			catalogRevision: 4,
			sessionRevision: 0,
		});
		store.putOverlay(createModelResolutionOverlay(input("session-b", "anthropic/secondary", "executor"), catalog), {
			catalogRevision: 4,
			sessionRevision: 0,
		});

		expect(store.getOverlay("session-a")?.requestedRoles).toEqual(["default"]);
		expect(store.getOverlay("session-b")?.requestedRoles).toEqual(["executor"]);
		expect(store.getOverlay("session-a")?.catalogRecordId).toBe("openai/primary");
		expect(store.getOverlay("session-b")?.catalogRecordId).toBe("anthropic/secondary");
		expect(JSON.stringify(store.getBaseSnapshot())).toBe(baseBefore);
		expect(Object.isFrozen(store.getBaseSnapshot())).toBe(true);
	});

	test("clearing one SDK session does not clear another", () => {
		const store = new ModelCatalogSessionStore(catalog);
		store.putOverlay(createModelResolutionOverlay(input("session-a", "openai/primary", "default"), catalog), {
			catalogRevision: 4,
			sessionRevision: 0,
		});
		store.putOverlay(createModelResolutionOverlay(input("session-b", "anthropic/secondary", "executor"), catalog), {
			catalogRevision: 4,
			sessionRevision: 0,
		});

		store.clearOverlay("session-a", { catalogRevision: 4, sessionRevision: 1 });
		expect(store.getOverlay("session-a")).toBeUndefined();
		expect(store.getOverlay("session-b")?.sessionId).toBe("session-b");
		expect(store.getOverlay("session-b")?.requestedRoles).toEqual(["executor"]);
	});
});
