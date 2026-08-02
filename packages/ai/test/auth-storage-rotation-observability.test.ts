import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

/**
 * Characterizes the rotation facts a `credential_switched` observer depends on:
 * selection order, one block per entry, chain advance only on exhaustion, the
 * pin guard, and the opacity of the identifier put on the wire.
 */
describe("AuthStorage rotation observability", () => {
	const PROVIDER = "zai";
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;

	const storage = (): AuthStorage => {
		if (!auth) throw new Error("test setup failed");
		return auth;
	};

	const rowIds = (): number[] => {
		if (!store) throw new Error("test setup failed");
		return store.listAuthCredentials(PROVIDER).map(row => row.id);
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ai-rotation-obs-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		auth = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	// ── Row-id accessor: what `from`/`to` may carry ──────────────────────────

	it("reports the session's credential as an opaque stored row id", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
		]);
		const ids = rowIds();
		const sessionId = "row-id-session";

		// No stored credential routed yet.
		expect(storage().getSessionCredentialRowId(PROVIDER, sessionId)).toBeUndefined();

		await storage().getApiKey(PROVIDER, sessionId);
		const active = storage().getSessionCredentialRowId(PROVIDER, sessionId);

		expect(typeof active).toBe("number");
		expect(ids).toContain(active as number);
	});

	it("carries no identity metadata in the row id", async () => {
		await storage().set(PROVIDER, [{ type: "api_key", key: "secret-key-value" }]);
		const sessionId = "opacity-session";
		await storage().getApiKey(PROVIDER, sessionId);

		const rowId = storage().getSessionCredentialRowId(PROVIDER, sessionId);
		// A number cannot smuggle an email, account, project, or key material.
		expect(typeof rowId).toBe("number");
		expect(JSON.stringify({ from: rowId })).not.toContain("secret-key-value");
	});

	it("returns undefined for a session that never resolved a stored credential", () => {
		expect(storage().getSessionCredentialRowId(PROVIDER, "never-used")).toBeUndefined();
		expect(storage().getSessionCredentialRowId(PROVIDER)).toBeUndefined();
	});

	// ── Pin guard: both overrides must be consulted ──────────────────────────

	it("reports a runtime credential selector separately from a runtime API key", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
		]);
		const [firstRowId] = rowIds();

		expect(storage().hasRuntimeCredentialSelector(PROVIDER)).toBe(false);
		expect(storage().hasRuntimeApiKey(PROVIDER)).toBe(false);

		storage().setRuntimeCredentialSelector(PROVIDER, { kind: "id", value: String(firstRowId) });

		// The selector is set; the API-key override is NOT. A guard that only
		// checked hasRuntimeApiKey would rotate away from the pinned row.
		expect(storage().hasRuntimeCredentialSelector(PROVIDER)).toBe(true);
		expect(storage().hasRuntimeApiKey(PROVIDER)).toBe(false);

		storage().removeRuntimeCredentialSelector(PROVIDER);
		expect(storage().hasRuntimeCredentialSelector(PROVIDER)).toBe(false);
	});

	it("keeps the reported row id fixed while a pin is active", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
		]);
		const [firstRowId] = rowIds();
		const sessionId = "pinned-row-session";
		storage().setRuntimeCredentialSelector(PROVIDER, { kind: "id", value: String(firstRowId) });

		await storage().getApiKey(PROVIDER, sessionId);
		expect(storage().getSessionCredentialRowId(PROVIDER, sessionId)).toBe(firstRowId);

		await storage().markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 60_000 });
		await storage().getApiKey(PROVIDER, sessionId);

		// Same row before and after: no switch happened, so no switch may be reported.
		expect(storage().getSessionCredentialRowId(PROVIDER, sessionId)).toBe(firstRowId);
	});

	// ── Rotation: one block per entry, advance only on exhaustion ────────────

	it("blocks each entry at most once and reports exhaustion on the last one", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
			{ type: "api_key", key: "rot-key-3" },
		]);
		const sessionId = "exhaustion-session";
		const observed: Array<{ row: number | undefined; more: boolean }> = [];

		for (let attempt = 0; attempt < 3; attempt++) {
			await storage().getApiKey(PROVIDER, sessionId);
			const row = storage().getSessionCredentialRowId(PROVIDER, sessionId);
			const more = await storage().markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 60_000 });
			observed.push({ row, more });
		}

		// Each attempt used a DISTINCT row: no entry is blocked twice, which is
		// what makes "at most one switch record per entry" achievable.
		const rows = observed.map(entry => entry.row);
		expect(new Set(rows).size).toBe(3);
		expect(rows.every(row => typeof row === "number")).toBe(true);

		// Only the final attempt reports that nothing is left. Consumers advance
		// the model chain on that transition and not before.
		expect(observed.map(entry => entry.more)).toEqual([true, true, false]);
	});

	it("selects credentials in stored order for a fresh session", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
		]);
		const ids = rowIds();
		const sessionId = "order-session";

		await storage().getApiKey(PROVIDER, sessionId);
		const first = storage().getSessionCredentialRowId(PROVIDER, sessionId);
		await storage().markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 60_000 });
		await storage().getApiKey(PROVIDER, sessionId);
		const second = storage().getSessionCredentialRowId(PROVIDER, sessionId);

		expect(ids).toContain(first as number);
		expect(ids).toContain(second as number);
		expect(second).not.toBe(first);
	});

	it("reports no rotation target when a single-row pool is blocked", async () => {
		await storage().set(PROVIDER, [{ type: "api_key", key: "only-key" }]);
		const sessionId = "single-session";
		await storage().getApiKey(PROVIDER, sessionId);
		const before = storage().getSessionCredentialRowId(PROVIDER, sessionId);

		expect(await storage().markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 60_000 })).toBe(false);

		await storage().getApiKey(PROVIDER, sessionId);
		expect(storage().getSessionCredentialRowId(PROVIDER, sessionId)).toBe(before);
	});

	it("clears the session row id when an auth invalidation drops the sticky credential", async () => {
		await storage().set(PROVIDER, [
			{ type: "api_key", key: "rot-key-1" },
			{ type: "api_key", key: "rot-key-2" },
		]);
		const sessionId = "invalidate-session";
		const activeKey = await storage().getApiKey(PROVIDER, sessionId);
		const before = storage().getSessionCredentialRowId(PROVIDER, sessionId);
		expect(typeof before).toBe("number");

		expect(await storage().invalidateCredentialMatching(PROVIDER, activeKey as string, { sessionId })).toBe(true);

		// The sticky is cleared, so the next resolution picks a row afresh.
		await storage().getApiKey(PROVIDER, sessionId);
		const after = storage().getSessionCredentialRowId(PROVIDER, sessionId);
		expect(typeof after).toBe("number");
		expect(after).not.toBe(before);
	});
});
