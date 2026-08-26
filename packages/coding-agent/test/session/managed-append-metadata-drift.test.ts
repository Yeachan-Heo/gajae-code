/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/4892.
 *
 * A managed transcript append verifies the predecessor against the identity the
 * session last committed. AV/indexing/backup agents advance `mtime`/`ctime`
 * without writing to the file, which made an ordinary prompt submission fail
 * with `managed_append_identity_mismatch`. Metadata-only drift is now accepted
 * when the same file object still holds byte-identical content, and every real
 * divergence (new object, new length, different content, unknown digest) still
 * fails closed without appending the request.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ManagedFileIdentity,
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })),
	);
});

const SEED = `${JSON.stringify({ type: "session", id: "seed" })}\n`;

async function createStore(): Promise<{
	store: ManagedSessionDescendantStore;
	filePath: string;
	relativePath: string;
}> {
	const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "gjc-append-drift-"));
	temporaryDirectories.push(root);
	await fsp.chmod(root, 0o700);
	const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	const relativePath = "transcript.jsonl";
	store.publishNoReplaceSync(relativePath, Buffer.from(SEED, "utf8"));
	return { store, filePath: path.join(root, relativePath), relativePath };
}

function record(id: string): Buffer {
	return Buffer.from(`${JSON.stringify({ type: "message", id })}\n`, "utf8");
}

/** Advance mtime (and, as a side effect, ctime) without touching content. */
function touchTimestampsOnly(filePath: string): void {
	const before = fs.lstatSync(filePath, { bigint: true });
	const shifted = new Date(Number(before.mtimeMs) + 5_000);
	fs.utimesSync(filePath, shifted, shifted);
	const after = fs.lstatSync(filePath, { bigint: true });
	if (after.mtimeNs === before.mtimeNs) throw new Error("expected the touch to advance mtime");
}

/** Commit one append so the retained expectation carries a proven content digest. */
function committedIdentity(
	store: ManagedSessionDescendantStore,
	relativePath: string,
	id: string,
): ManagedFileIdentity {
	return store.appendSync(relativePath, record(id)).identity;
}

function fileDigest(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("ManagedSessionDescendantStore.appendExpectedIdentitySync metadata drift (#4892)", () => {
	it("carries a content digest on the append receipt that matches the published transcript", async () => {
		const { store, filePath, relativePath } = await createStore();

		const receipt = store.appendExpectedIdentitySync(
			relativePath,
			record("m1"),
			committedIdentity(store, relativePath, "m0"),
		);

		expect(receipt.identity.sha256).toBe(fileDigest(filePath));
		expect(receipt.identity.size).toBe(fs.statSync(filePath).size);
	});

	it("appends after a timestamp-only touch of a byte-identical transcript", async () => {
		const { store, filePath, relativePath } = await createStore();
		const expected = committedIdentity(store, relativePath, "m0");
		const before = fs.readFileSync(filePath);

		touchTimestampsOnly(filePath);
		const receipt = store.appendExpectedIdentitySync(relativePath, record("m1"), expected);

		const after = fs.readFileSync(filePath);
		expect(after.equals(Buffer.concat([before, record("m1")]))).toBe(true);
		expect(receipt.identity.sha256).toBe(fileDigest(filePath));
	});

	it("keeps accepting successive touches because each append recommits its digest", async () => {
		const { store, filePath, relativePath } = await createStore();
		let expected = committedIdentity(store, relativePath, "m0");

		for (const id of ["m1", "m2", "m3"]) {
			touchTimestampsOnly(filePath);
			expected = store.appendExpectedIdentitySync(relativePath, record(id), expected).identity;
		}

		const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(5);
		expect(lines[4]).toContain('"id":"m3"');
	});

	it("fails closed when a same-length successor replaced the content in place", async () => {
		const { store, filePath, relativePath } = await createStore();
		const expected = committedIdentity(store, relativePath, "m0");
		const before = fs.readFileSync(filePath);
		const successor = Buffer.from(before.toString("utf8").replaceAll("seed", "othr"), "utf8");
		expect(successor.byteLength).toBe(before.byteLength);

		fs.writeFileSync(filePath, successor);

		expect(() => store.appendExpectedIdentitySync(relativePath, record("m-race"), expected)).toThrow(
			"managed_append_identity_mismatch",
		);
		expect(fs.readFileSync(filePath).equals(successor)).toBe(true);
	});

	it("fails closed when a concurrent writer appended to the transcript", async () => {
		const { store, filePath, relativePath } = await createStore();
		const expected = committedIdentity(store, relativePath, "m0");

		fs.appendFileSync(filePath, "concurrent\n");
		const afterConcurrent = fs.readFileSync(filePath);

		expect(() => store.appendExpectedIdentitySync(relativePath, record("m-race"), expected)).toThrow(
			"managed_append_identity_mismatch",
		);
		expect(fs.readFileSync(filePath).equals(afterConcurrent)).toBe(true);
	});

	it("fails closed on metadata drift when no committed digest can authenticate the content", async () => {
		const { store, filePath, relativePath } = await createStore();
		const { sha256: _committedDigest, ...digestless } = committedIdentity(store, relativePath, "m0");
		const before = fs.readFileSync(filePath);

		touchTimestampsOnly(filePath);

		expect(() => store.appendExpectedIdentitySync(relativePath, record("m1"), digestless)).toThrow(
			"managed_append_identity_mismatch",
		);
		expect(fs.readFileSync(filePath).equals(before)).toBe(true);
	});

	it("fails closed when the transcript was replaced by a different file object", async () => {
		const { store, filePath, relativePath } = await createStore();
		const expected = committedIdentity(store, relativePath, "m0");
		const bytes = fs.readFileSync(filePath);
		const replacement = `${filePath}.successor`;
		fs.writeFileSync(replacement, bytes, { mode: 0o600 });
		fs.renameSync(replacement, filePath);
		expect(fs.lstatSync(filePath, { bigint: true }).ino).not.toBe(expected.ino);

		expect(() => store.appendExpectedIdentitySync(relativePath, record("m1"), expected)).toThrow(
			"managed_append_identity_mismatch",
		);
		expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
	});

	it("fails closed when the transcript is gone", async () => {
		const { store, filePath, relativePath } = await createStore();
		const expected = committedIdentity(store, relativePath, "m0");
		fs.rmSync(filePath);

		expect(() => store.appendExpectedIdentitySync(relativePath, record("m1"), expected)).toThrow(
			"managed_append_identity_mismatch",
		);
	});
});
