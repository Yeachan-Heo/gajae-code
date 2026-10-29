import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareOwnerLifecycleRootSync } from "../../src/gjc-runtime/owner-lifecycle-root";
import * as storage from "../../src/session/internal/managed-session-storage";

const fixtures: string[] = [];

afterEach(() => {
	for (const directory of fixtures.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(parent = os.tmpdir()): string {
	const directory = fs.mkdtempSync(path.join(parent, "gjc-owner-lifecycle-root-"));
	fixtures.push(directory);
	return directory;
}

function mode(target: string): number {
	return fs.lstatSync(target).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("owner lifecycle root preparation", () => {
	it("creates missing components owner-only below a real directory", () => {
		const base = fs.realpathSync(fixture());
		const root = path.join(base, "state", "session", "owner-lifecycle");
		prepareOwnerLifecycleRootSync(root);
		for (const created of [path.join(base, "state"), path.join(base, "state", "session"), root]) {
			expect([created, mode(created)]).toEqual([created, 0o700]);
		}
	});

	it.skipIf(process.platform !== "darwin")("accepts the macOS /tmp system alias as the native walk does", () => {
		// Lexical `/tmp/...`, never resolved to `/private/tmp`.
		const base = fixture("/tmp");
		expect(base.startsWith("/tmp/")).toBe(true);
		const root = path.join(base, "session", "owner-lifecycle");
		prepareOwnerLifecycleRootSync(root);
		expect(mode(root)).toBe(0o700);
	});

	it.each([
		["the parent of the root", 1],
		["the session directory's parent", 2],
		["a higher ancestor", 3],
	] as const)("refuses a link at %s and writes nothing through it", (_label, depth) => {
		const base = fs.realpathSync(fixture());
		const outside = path.join(base, "outside");
		fs.mkdirSync(outside, { mode: 0o700 });
		const root = path.join(base, "a", "b", "c", "owner-lifecycle");
		let linked = root;
		for (let level = 0; level < depth; level++) linked = path.dirname(linked);
		fs.mkdirSync(path.dirname(linked), { recursive: true, mode: 0o700 });
		fs.symlinkSync(outside, linked);
		// Every directory below the link already exists through it, so only the root is missing.
		const below = path.relative(linked, path.dirname(root));
		if (below) fs.mkdirSync(path.join(outside, below), { recursive: true, mode: 0o700 });
		const before = fs.readdirSync(outside, { recursive: true }).sort();
		expect(() => prepareOwnerLifecycleRootSync(root)).toThrow("owner_lifecycle_root_unsafe");
		expect(fs.readdirSync(outside, { recursive: true }).sort()).toEqual(before);
	});

	it("refuses a regular file where a directory is expected", () => {
		const base = fs.realpathSync(fixture());
		fs.writeFileSync(path.join(base, "session"), "not a directory");
		expect(() => prepareOwnerLifecycleRootSync(path.join(base, "session", "owner-lifecycle"))).toThrow(
			"owner_lifecycle_root_unsafe",
		);
	});

	it("refuses an existing public root without repairing it", () => {
		const base = fs.realpathSync(fixture());
		const root = path.join(base, "owner-lifecycle");
		fs.mkdirSync(root);
		fs.chmodSync(root, 0o755);
		expect(() => prepareOwnerLifecycleRootSync(root)).toThrow("owner_lifecycle_root_unsafe");
		expect(mode(root)).toBe(0o755);
	});

	it("accepts an existing private root unchanged", () => {
		const base = fs.realpathSync(fixture());
		const root = path.join(base, "owner-lifecycle");
		fs.mkdirSync(root, { mode: 0o700 });
		fs.chmodSync(root, 0o700);
		fs.writeFileSync(path.join(root, "kept"), "kept");
		prepareOwnerLifecycleRootSync(root);
		expect(fs.readdirSync(root)).toEqual(["kept"]);
	});

	it("refuses a root that is no longer private after preparation", () => {
		const base = fs.realpathSync(fixture());
		const root = path.join(base, "owner-lifecycle");
		const prepare = storage.prepareManagedDirectoryRoot;
		// Another writer widens the root between preparation and the final check.
		const spy = spyOn(storage, "prepareManagedDirectoryRoot").mockImplementation((target, policy) => {
			const prepared = prepare(target, policy);
			fs.chmodSync(target, 0o755);
			return prepared;
		});
		try {
			expect(() => prepareOwnerLifecycleRootSync(root)).toThrow("owner_lifecycle_root_unsafe");
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});
});
