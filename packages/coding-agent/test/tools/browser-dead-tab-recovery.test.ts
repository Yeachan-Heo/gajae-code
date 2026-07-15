import { describe, expect, it } from "bun:test";
import { DeadTabRecoveryDescriptorRegistry } from "../../src/tools/browser/dead-tab-recovery";
import type { BrowserHandle } from "../../src/tools/browser/registry";
import { resolveDeadTabRecoveryTargetIdForTest } from "../../src/tools/browser/tab-supervisor";

function fakeBrowserHandle(): BrowserHandle {
	return {
		key: "headless:true",
		kind: { kind: "headless", headless: true },
		browser: { targets: () => [], wsEndpoint: () => "ws://browser" } as never,
		refCount: 1,
		stealth: { browserSession: null, override: null },
	};
}

function fakeTarget(targetId: string, url: string, title = "Example") {
	return {
		url: () => url,
		page: async () => ({ url: () => url, title: async () => title }),
		createCDPSession: async () => ({
			send: async () => ({ targetInfo: { targetId } }),
			detach: async () => {},
		}),
	};
}

function fakeBrowserHandleWithTargets(targets: unknown[]): BrowserHandle {
	return {
		...fakeBrowserHandle(),
		browser: { targets: () => targets, wsEndpoint: () => "ws://browser" } as never,
	};
}

describe("dead tab recovery descriptor registry", () => {
	it("consumes descriptors once and binds them to the owning session", () => {
		const registry = new DeadTabRecoveryDescriptorRegistry(1_000);
		const descriptor = registry.register(
			{
				name: "main",
				ownerId: "session-a",
				browser: fakeBrowserHandle(),
				kindTag: "headless",
				targetId: "target-1",
				info: { url: "https://example.test", targetId: "target-1", viewport: { width: 800, height: 600 } },
			},
			100,
		);

		expect(Object.isFrozen(descriptor)).toBe(true);
		expect(Object.isFrozen(descriptor.info)).toBe(true);
		expect(registry.consume(descriptor.token, "session-b", 101)).toBeUndefined();
		expect(registry.consume(descriptor.token, "session-a", 101)).toBeUndefined();
	});

	it("allows the owning session to consume exactly once", () => {
		const registry = new DeadTabRecoveryDescriptorRegistry(1_000);
		const descriptor = registry.register(
			{
				name: "main",
				ownerId: "session-a",
				browser: fakeBrowserHandle(),
				kindTag: "headless",
				targetId: "target-1",
				info: { url: "https://example.test", targetId: "target-1", viewport: { width: 800, height: 600 } },
			},
			100,
		);

		expect(registry.consume(descriptor.token, "session-a", 101)?.targetId).toBe("target-1");
		expect(registry.consume(descriptor.token, "session-a", 102)).toBeUndefined();
	});

	it("expires descriptors and invalidates owner-scoped recovery", () => {
		const registry = new DeadTabRecoveryDescriptorRegistry(50);
		const descriptor = registry.register(
			{
				name: "main",
				ownerId: "session-a",
				browser: fakeBrowserHandle(),
				kindTag: "headless",
				targetId: "target-1",
				info: { url: "https://example.test", targetId: "target-1", viewport: { width: 800, height: 600 } },
			},
			100,
		);

		expect(registry.peekByName("main", 149)?.token).toBe(descriptor.token);
		expect(registry.peekByName("main", 150)).toBeUndefined();

		const fresh = registry.register(
			{
				name: "main",
				ownerId: "session-a",
				browser: fakeBrowserHandle(),
				kindTag: "headless",
				targetId: "target-2",
				info: { url: "https://example.test", targetId: "target-2", viewport: { width: 800, height: 600 } },
			},
			200,
		);
		registry.invalidateOwner("session-a");
		expect(registry.consume(fresh.token, "session-a", 201)).toBeUndefined();
	});
});

describe("dead tab recovery target matching", () => {
	it("prefers exact target identity over fallback matching", async () => {
		const browser = fakeBrowserHandleWithTargets([
			fakeTarget("fallback", "https://example.test", "Example"),
			fakeTarget("target-1", "https://other.test", "Other"),
		]);

		await expect(
			resolveDeadTabRecoveryTargetIdForTest({
				token: "token",
				name: "main",
				ownerId: "session-a",
				browser,
				kindTag: "headless",
				targetId: "target-1",
				info: {
					url: "https://example.test",
					title: "Example",
					targetId: "target-1",
					viewport: { width: 800, height: 600 },
				},
				createdAt: 0,
				expiresAt: 1_000,
			}),
		).resolves.toBe("target-1");
	});

	it("allows only a unique verified fallback target", async () => {
		const unique = fakeBrowserHandleWithTargets([fakeTarget("target-2", "https://example.test", "Example")]);
		await expect(
			resolveDeadTabRecoveryTargetIdForTest({
				token: "token",
				name: "main",
				ownerId: "session-a",
				browser: unique,
				kindTag: "headless",
				targetId: "missing",
				info: {
					url: "https://example.test",
					title: "Example",
					targetId: "missing",
					viewport: { width: 800, height: 600 },
				},
				createdAt: 0,
				expiresAt: 1_000,
			}),
		).resolves.toBe("target-2");

		const ambiguous = fakeBrowserHandleWithTargets([
			fakeTarget("target-2", "https://example.test", "Example"),
			fakeTarget("target-3", "https://example.test", "Example"),
		]);
		await expect(
			resolveDeadTabRecoveryTargetIdForTest({
				token: "token",
				name: "main",
				ownerId: "session-a",
				browser: ambiguous,
				kindTag: "headless",
				targetId: "missing",
				info: {
					url: "https://example.test",
					title: "Example",
					targetId: "missing",
					viewport: { width: 800, height: 600 },
				},
				createdAt: 0,
				expiresAt: 1_000,
			}),
		).resolves.toBeUndefined();
	});
});
