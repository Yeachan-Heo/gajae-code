import { describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

function oauth(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function createStorage(): Promise<AuthStorage> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	store.saveOAuth("anthropic", oauth("first"));
	store.saveOAuth("anthropic", oauth("second"));
	const storage = new AuthStorage(store);
	await storage.reload();
	return storage;
}

describe("AuthStorage session credential selectors", () => {
	test("isolates concurrent OAuth pins by credential scope", async () => {
		const storage = await createStorage();
		try {
			storage.acquireCredentialScope("session-a");
			storage.acquireCredentialScope("session-b");
			storage.setSessionCredentialSelector("session-a", "anthropic", { kind: "email", value: "first@example.com" });
			storage.setSessionCredentialSelector("session-b", "anthropic", { kind: "email", value: "second@example.com" });

			expect(storage.getOAuthCredential("anthropic", "session-a")?.accountId).toBe("account-first");
			expect(storage.getOAuthCredential("anthropic", "session-b")?.accountId).toBe("account-second");
			expect(storage.getOAuthAccountId("anthropic", "session-a")).toBe("account-first");
			expect(storage.getOAuthAccountId("anthropic", "session-b")).toBe("account-second");
			expect(storage.getEffectiveCredentialType("anthropic", "session-a")).toBe("oauth");
		} finally {
			storage.close();
		}
	});

	test("AUTO masks a process-global selector for one session only", async () => {
		const storage = await createStorage();
		try {
			storage.setRuntimeCredentialSelector("anthropic", { kind: "email", value: "second@example.com" });
			storage.acquireCredentialScope("auto-session");
			storage.setSessionCredentialAuto("anthropic", "auto-session");

			expect(storage.resolveEffectiveCredentialSelector("anthropic", "auto-session")).toBeUndefined();
			expect(storage.getOAuthCredential("anthropic")?.accountId).toBe("account-second");
			expect(storage.getOAuthCredential("anthropic", "auto-session")?.accountId).toBe("account-first");
		} finally {
			storage.close();
		}
	});

	test("discovery peeks honor scoped pins without changing unscoped or AUTO selection", async () => {
		const storage = await createStorage();
		try {
			storage.setRuntimeCredentialSelector("anthropic", { kind: "email", value: "first@example.com" });
			storage.acquireCredentialScope("pinned-discovery");
			storage.acquireCredentialScope("auto-discovery");
			storage.setSessionCredentialSelector("pinned-discovery", "anthropic", {
				kind: "email",
				value: "second@example.com",
			});
			storage.setSessionCredentialAuto("anthropic", "auto-discovery");

			expect(await storage.peekApiKey("anthropic")).toBe("access-first");
			expect(await storage.peekApiKey("anthropic", { sessionId: "pinned-discovery" })).toBe("access-second");
			expect(await storage.peekApiKey("anthropic", { sessionId: "auto-discovery" })).toBe("access-first");
		} finally {
			storage.close();
		}
	});

	test("discovery peeks select the pinned row independently of credential insertion order", async () => {
		for (const order of [
			["first", "second"],
			["second", "first"],
		] as const) {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			for (const suffix of order) store.saveOAuth("anthropic", oauth(suffix));
			const storage = new AuthStorage(store);
			await storage.reload();
			try {
				storage.acquireCredentialScope("ordered-discovery");
				storage.setSessionCredentialSelector("ordered-discovery", "anthropic", {
					kind: "email",
					value: "second@example.com",
				});
				expect(await storage.peekApiKey("anthropic", { sessionId: "ordered-discovery" })).toBe("access-second");
			} finally {
				storage.close();
			}
		}
	});

	test("an expired scoped OAuth pin never falls through to another account", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		store.saveOAuth("anthropic", oauth("usable"));
		store.saveOAuth("anthropic", { ...oauth("expired"), expires: Date.now() - 1 });
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			storage.acquireCredentialScope("expired-pin");
			storage.setSessionCredentialSelector("expired-pin", "anthropic", {
				kind: "email",
				value: "expired@example.com",
			});

			expect(await storage.peekApiKey("anthropic", { sessionId: "expired-pin" })).toBeUndefined();
			expect(await storage.peekApiKey("anthropic")).toBe("access-usable");
		} finally {
			storage.close();
		}
	});

	test("unavailable scoped pins fail loudly and final lease release clears only that scope", async () => {
		const storage = await createStorage();
		try {
			storage.acquireCredentialScope("leased");
			expect(() =>
				storage.setSessionCredentialSelector("leased", "anthropic", {
					kind: "email",
					value: "missing@example.com",
				}),
			).toThrow("No credential found");
			expect(await storage.peekApiKey("anthropic", { sessionId: "leased" })).toBe("access-first");
			storage.setSessionCredentialSelector("leased", "anthropic", { kind: "email", value: "first@example.com" });
			storage.releaseCredentialScope("leased");
			expect(storage.hasSessionCredentialSelector("leased", "anthropic")).toBe(false);
			expect(storage.getOAuthCredential("anthropic", "leased")?.accountId).toBe("account-first");
		} finally {
			storage.close();
		}
	});

	test("shared scope leases preserve parent selector until the final owner releases", async () => {
		const storage = await createStorage();
		try {
			expect(storage.hasCredentialScopeLease("shared")).toBe(false);
			storage.acquireCredentialScope("shared");
			storage.setSessionCredentialAuto("anthropic", "shared");
			storage.acquireCredentialScope("shared");
			expect(storage.hasCredentialScopeLease("shared")).toBe(true);
			storage.releaseCredentialScope("shared");
			expect(storage.resolveEffectiveCredentialSelector("anthropic", "shared")).toBeUndefined();
			expect(storage.hasCredentialScopeLease("shared")).toBe(true);
			storage.releaseCredentialScope("shared");
			expect(storage.hasCredentialScopeLease("shared")).toBe(false);
		} finally {
			storage.close();
		}
	});
	test("provider-scoped explicit checks do not probe unrelated rows", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		store.saveOAuth("anthropic", oauth("anthropic"));
		store.saveOAuth("openai-codex", oauth("codex"));
		const fetchUsage = vi.fn(async (params: { provider: string }) => ({
			provider: params.provider,
			fetchedAt: Date.now(),
			limits: [],
		}));
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => ({ id: "test", fetchUsage }),
		});
		await storage.reload();
		try {
			const results = await storage.checkCredentials({ provider: "anthropic" });
			expect(results).toHaveLength(1);
			expect(results[0]?.provider).toBe("anthropic");
			expect(fetchUsage).toHaveBeenCalledTimes(1);
			expect(fetchUsage.mock.calls[0]?.[0].provider).toBe("anthropic");
		} finally {
			storage.close();
		}
	});

	test("removing a selected account clears its session pin and sticky selection", async () => {
		const storage = await createStorage();
		try {
			storage.acquireCredentialScope("remove-session");
			storage.setSessionCredentialSelector("remove-session", "anthropic", {
				kind: "email",
				value: "first@example.com",
			});
			const id = storage.listCredentialInventory("anthropic").find(row => row.credentialKind === "oauth")!.id;
			expect(storage.disableCredentialById(id, "removed by test")).toBe(true);
			expect(storage.hasSessionCredentialSelector("anthropic", "remove-session")).toBe(false);
			expect(storage.getOAuthCredential("anthropic", "remove-session")?.email).toBe("second@example.com");
		} finally {
			storage.close();
		}
	});
});
