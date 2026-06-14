import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	EphemeralBlobStore,
	externalizeImageData,
	isBlobRef,
	ResidentBlobMissingError,
	resolveImageData,
	resolveImageDataUrl,
	resolveResidentImageDataSync,
	resolveResidentImageDataUrlSync,
	resolveTextBlobSync,
} from "@gajae-code/coding-agent/session/blob-store";
import {
	materializeResidentEntriesForPersistenceForTests,
	residentBlobSentinelForTests,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import { measureSessionMemory } from "../bench/session-memory.bench";

const tmpRoots: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
}

function makeStore(): EphemeralBlobStore {
	return new EphemeralBlobStore(path.join(tmpRoot("gjc-resident-"), "resident"));
}

/** A well-formed blob ref whose blob was never stored. */
const MISSING_REF = `blob:sha256:${"0".repeat(64)}`;

afterAll(() => {
	for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

describe("resident byte-sensitive TEXT materialization is fail-closed", () => {
	test("resolveTextBlobSync returns text when the resident blob exists and passes through non-blobs", () => {
		const store = makeStore();
		const { ref } = store.putSync(Buffer.from("resident provider text", "utf8"));
		expect(resolveTextBlobSync(store, ref)).toBe("resident provider text");
		expect(resolveTextBlobSync(store, "plain non-blob string")).toBe("plain non-blob string");
	});

	test("resolveTextBlobSync throws ResidentBlobMissingError when the resident blob is missing (never leaks a blob ref)", () => {
		const store = makeStore();
		expect(() => resolveTextBlobSync(store, MISSING_REF)).toThrow(ResidentBlobMissingError);
	});

	test("persistence materialization replaces a missing resident blob with a placeholder instead of throwing", () => {
		const store = makeStore();
		const entry = {
			type: "message",
			id: "missing-resident-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: residentBlobSentinelForTests("text", MISSING_REF) }],
				timestamp: 0,
			},
		};

		const [materialized] = materializeResidentEntriesForPersistenceForTests([entry], store);
		const serialized = JSON.stringify(materialized);
		expect(serialized).toContain("Session resident text blob missing");
		expect(serialized).toContain("original content unavailable");
		expect(serialized).not.toContain(MISSING_REF);
	});
});

describe("legacy persisted-image materialization warn-and-returns (documented compatibility boundary)", () => {
	test("resolveImageData round-trips base64 image data when the blob exists", async () => {
		const store = makeStore();
		const b64 = Buffer.from("fake image bytes \u0001\u0002\u0003").toString("base64");
		const ref = await externalizeImageData(store, b64);
		expect(isBlobRef(ref)).toBe(true);
		expect(await resolveImageData(store, ref)).toBe(b64);
	});

	test("resolveImageData returns the ref as-is (does NOT throw) on a missing blob", async () => {
		const store = makeStore();
		await expect(resolveImageData(store, MISSING_REF)).resolves.toBe(MISSING_REF);
	});

	test("resolveImageDataUrl returns the ref as-is (does NOT throw) on a missing blob", async () => {
		const store = makeStore();
		await expect(resolveImageDataUrl(store, MISSING_REF)).resolves.toBe(MISSING_REF);
	});
});

describe("resident byte-sensitive IMAGE/PROVIDER materialization is fail-closed", () => {
	test("resolveResidentImageDataUrlSync throws ResidentBlobMissingError ('imageUrl') on a missing resident blob", () => {
		const store = makeStore();
		try {
			resolveResidentImageDataUrlSync(store, MISSING_REF);
			throw new Error("expected ResidentBlobMissingError");
		} catch (err) {
			expect(err).toBeInstanceOf(ResidentBlobMissingError);
			expect((err as ResidentBlobMissingError).kind).toBe("imageUrl");
		}
	});

	test("resolveResidentImageDataSync throws ResidentBlobMissingError ('imageData') on a missing resident blob", () => {
		const store = makeStore();
		try {
			resolveResidentImageDataSync(store, MISSING_REF);
			throw new Error("expected ResidentBlobMissingError");
		} catch (err) {
			expect(err).toBeInstanceOf(ResidentBlobMissingError);
			expect((err as ResidentBlobMissingError).kind).toBe("imageData");
		}
	});

	test("resident image resolvers round-trip when the blob exists and pass through non-blobs", () => {
		const store = makeStore();
		const url = store.putSync(Buffer.from("data:image/png;base64,AAAA", "utf8")).ref;
		expect(resolveResidentImageDataUrlSync(store, url)).toBe("data:image/png;base64,AAAA");
		const imgRef = store.putSync(Buffer.from("rawimagebytes")).ref;
		expect(resolveResidentImageDataSync(store, imgRef)).toBe(Buffer.from("rawimagebytes").toString("base64"));
		expect(resolveResidentImageDataSync(store, "not-a-blob")).toBe("not-a-blob");
	});
});

describe("EphemeralBlobStore bounded cache + reset", () => {
	test("getSync round-trips and dispose() clears disk + buffer cache (blob missing afterwards)", () => {
		const store = makeStore();
		const { hash } = store.putSync(Buffer.from("blob bytes"));
		expect(store.getSync(hash)?.toString("utf8")).toBe("blob bytes");
		store.dispose();
		expect(store.getSync(hash)).toBeNull();
	});
});

describe("SessionManager retained-entry ownership and snapshot correctness", () => {
	function newManager(): SessionManager {
		const root = tmpRoot("gjc-session-resident-");
		return SessionManager.create(root, path.join(root, "sessions"));
	}

	test("getEntries() returns caller-owned clones (mutating the result does not leak into internal state)", () => {
		const mgr = newManager();
		mgr.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const a = mgr.getEntries();
		const b = mgr.getEntries();
		expect(a).not.toBe(b); // fresh array each call
		expect(a.length).toBeGreaterThan(0);
		(a[0] as unknown as { mutated?: string }).mutated = "tampered";
		const c = mgr.getEntries();
		expect((c[0] as unknown as { mutated?: string }).mutated).toBeUndefined();
	});

	test("captureState/restoreState restores the pre-append entry set", () => {
		const mgr = newManager();
		mgr.appendMessage({ role: "user", content: "one", timestamp: Date.now() });
		const preCount = mgr.getEntries().length;
		const snapshot = mgr.captureState();
		mgr.appendMessage({ role: "user", content: "two", timestamp: Date.now() });
		expect(mgr.getEntries().length).toBeGreaterThan(preCount);
		mgr.restoreState(snapshot);
		expect(mgr.getEntries().length).toBe(preCount);
	});
});

describe("session retained-memory bench", () => {
	test("measureSessionMemory reports finite, non-negative retained growth and materializes all entries", () => {
		const report = measureSessionMemory(400, 1_024);
		expect(report.warmGetEntriesCount).toBeGreaterThan(0);
		expect(Number.isFinite(report.rssMemory.growthBytes)).toBe(true);
		expect(report.rssMemory.baselineBytes).not.toBeNull();
		// returnBytes is non-null only when GC is exposed; when present it must be finite.
		if (report.rssMemory.returnBytes !== null) {
			expect(Number.isFinite(report.rssMemory.returnBytes)).toBe(true);
		}
	});
});
