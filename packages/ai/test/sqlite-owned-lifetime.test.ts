import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { closeModelCache, readModelCache, writeModelCache } from "../src/model-cache";

async function unlinkIfPresent(file: string): Promise<void> {
	try {
		await fs.unlink(file);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

describe("owned SQLite connection lifetime", () => {
	it("finalizes uncached statements immediately and keeps credential-store close idempotent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-owned-auth-close-"));
		const file = path.join(root, "auth.db");
		const db = new Database(file);
		const store = new SqliteAuthCredentialStore(db);
		const retained = db.prepare<{ value: number }, []>("SELECT 1 AS value");
		try {
			expect(retained.get()?.value).toBe(1);
			store.close();
			store.close();
			expect(() => retained.get()).toThrow("Database has closed");
			// Windows refuses this while any prepare() statement retains the handle.
			await fs.unlink(file);
			expect(await fs.readdir(root)).toEqual([]);
		} finally {
			store.close();
			retained.finalize();
			await unlinkIfPresent(file);
			await fs.rmdir(root);
		}
	});

	it("closes only its own auth connection while a sibling connection remains usable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-sibling-auth-close-"));
		const file = path.join(root, "auth.db");
		const first = await AuthStorage.create(file);
		const sibling = await AuthStorage.create(file);
		try {
			first.close();
			first.close();
			sibling.setCache("offline-lifetime-fixture", "usable", Math.floor(Date.now() / 1000) + 60);
			expect(sibling.getCache("offline-lifetime-fixture")).toBe("usable");
			sibling.close();
			sibling.close();
			await fs.unlink(file);
			expect(await fs.readdir(root)).toEqual([]);
		} finally {
			first.close();
			sibling.close();
			await unlinkIfPresent(file);
			await fs.rmdir(root);
		}
	});

	it("releases replaced model-cache handles and preserves exact-path close authority", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-model-cache-close-"));
		const first = path.join(root, "first.db");
		const second = path.join(root, "second.db");
		try {
			writeModelCache("offline-fixture", Date.now(), [], true, "fixture", first);
			expect(readModelCache("offline-fixture", 60_000, Date.now, first)?.authoritative).toBe(true);
			expect(closeModelCache(second)).toBe(false);
			writeModelCache("offline-fixture", Date.now(), [], true, "fixture", second);
			await fs.unlink(first);
			expect(closeModelCache(first)).toBe(false);
			expect(readModelCache("offline-fixture", 60_000, Date.now, second)?.authoritative).toBe(true);
			expect(closeModelCache(second)).toBe(true);
			expect(closeModelCache(second)).toBe(false);
			await fs.unlink(second);
			expect(await fs.readdir(root)).toEqual([]);
		} finally {
			closeModelCache(first);
			closeModelCache(second);
			await unlinkIfPresent(first);
			await unlinkIfPresent(second);
			await fs.rmdir(root);
		}
	});
});
