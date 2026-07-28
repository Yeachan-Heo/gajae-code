import { afterEach, describe, expect, it } from "bun:test";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";

const originalMaterializedCacheMaxBytesOverride = SessionManagerTestHooks.materializedCacheMaxBytesOverride;

afterEach(() => {
	SessionManagerTestHooks.materializedCacheMaxBytesOverride = originalMaterializedCacheMaxBytesOverride;
});

function createSession(text: string): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	return manager;
}

function readPair(manager: SessionManager, text: string): void {
	expect(JSON.stringify(manager.getEntries())).toContain(text);
	expect(JSON.stringify(manager.buildSessionContext())).toContain(text);
}

async function settleAndCollect(): Promise<void> {
	await Bun.sleep(0);
	Bun.gc(true);
	await Bun.sleep(0);
	Bun.gc(true);
}

describe("SessionManager materialized cache retention", () => {
	it("keeps below-cap materialized entries and context strongly cached", async () => {
		SessionManagerTestHooks.materializedCacheMaxBytesOverride = 1024 * 1024;
		const text = `below-cap ${"a".repeat(32 * 1024)}`;
		const manager = createSession(text);
		try {
			readPair(manager, text);
			const warmed = manager.getObservabilityStatsForTests();
			expect(warmed.materializedEntriesCachePopulateCount).toBe(1);
			expect(warmed.pathOnlyContextBuildCount).toBe(1);
			expect(warmed.materializedCacheDemotedCount).toBe(0);

			for (let cycle = 0; cycle < 5; cycle++) {
				await settleAndCollect();
				readPair(manager, text);
			}

			expect(manager.getObservabilityStatsForTests()).toMatchObject({
				materializedEntriesCachePopulateCount: warmed.materializedEntriesCachePopulateCount,
				pathOnlyContextBuildCount: warmed.pathOnlyContextBuildCount,
			});
		} finally {
			await manager.close();
		}
	});

	it("allows above-cap weak caches to rebuild after collection without losing content", async () => {
		SessionManagerTestHooks.materializedCacheMaxBytesOverride = 1024;
		const text = `above-cap ${"b".repeat(128 * 1024)}`;
		const manager = createSession(text);
		try {
			expect(JSON.stringify(manager.buildSessionContext())).toContain(text);
			expect(manager.getObservabilityStatsForTests().materializedCacheDemotedCount).toBe(1);
			readPair(manager, text);
			const warmed = manager.getObservabilityStatsForTests();

			let observedRebuild = false;
			for (let cycle = 0; cycle < 20; cycle++) {
				await settleAndCollect();
				readPair(manager, text);
				const current = manager.getObservabilityStatsForTests();
				if (
					current.materializedEntriesCachePopulateCount > warmed.materializedEntriesCachePopulateCount &&
					current.pathOnlyContextBuildCount > warmed.pathOnlyContextBuildCount
				) {
					observedRebuild = true;
					break;
				}
			}

			expect(observedRebuild).toBe(true);
		} finally {
			await manager.close();
		}
	});

	it("clears the context cache with materialized caches after an entry revision bump", async () => {
		SessionManagerTestHooks.materializedCacheMaxBytesOverride = 1024 * 1024;
		const manager = createSession("context before revision bump");
		try {
			manager.buildSessionContext();
			const warmed = manager.getObservabilityStatsForTests();
			expect(warmed.pathOnlyContextBuildCount).toBe(1);

			manager.appendMessage({ role: "user", content: "context after revision bump", timestamp: Date.now() });
			expect(JSON.stringify(manager.buildSessionContext())).toContain("context after revision bump");
			expect(manager.getObservabilityStatsForTests().pathOnlyContextBuildCount).toBe(
				warmed.pathOnlyContextBuildCount + 1,
			);
		} finally {
			await manager.close();
		}
	});
});
