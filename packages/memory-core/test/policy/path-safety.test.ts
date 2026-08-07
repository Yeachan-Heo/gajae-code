import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	assertPathBinding,
	containPath,
	pinMemoryRoot,
	validateSafePathComponent,
	validateSafeRelativePath,
} from "../../src/policy/path-safety";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-path-")));
	temporaryRoots.push(root);
	await fs.chmod(root, 0o700);
	return root;
}

function requireRootPin(root: string) {
	const pinned = pinMemoryRoot(root);
	if (!pinned.ok) throw new Error(`test root could not be pinned: ${JSON.stringify(pinned.error)}`);
	return pinned.value;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("memory path safety policy", () => {
	it("admits contained relative files and normalizes safe Unicode paths", async () => {
		const root = await makeRoot();
		const nested = path.join(root, "nested");
		const file = path.join(nested, "café.md");
		await fs.mkdir(nested, { mode: 0o700 });
		await fs.writeFile(file, "payload", { mode: 0o600 });

		const pinned = requireRootPin(root);
		const contained = containPath(pinned, "nested/cafe\u0301.md");
		expect(contained.ok).toBe(true);
		if (!contained.ok) return;
		expect(contained.value.relativePath).toBe("nested/café.md");
		expect(contained.value.absolutePath).toBe(file);
		expect(contained.value.parentPath).toBe(nested);
		expect(contained.value.components.map(component => component.name)).toEqual(["nested"]);
		expect(contained.value.leafIdentity).not.toBeNull();
		if (contained.value.leafIdentity !== null) {
			expect(typeof contained.value.leafIdentity.dev).toBe("bigint");
			expect(typeof contained.value.leafIdentity.ino).toBe("bigint");
		}
		expect(validateSafeRelativePath("nested/cafe\u0301.md")).toEqual({ ok: true, value: "nested/café.md" });
		expect(validateSafePathComponent("cafe\u0301.md")).toEqual({ ok: true, value: "café.md" });
	});

	it("rejects absolute, drive, UNC, traversal, encoded traversal, NUL, and device-name paths", async () => {
		const root = await makeRoot();
		const pinned = requireRootPin(root);
		const rejected = [
			"/etc/passwd",
			"C:/memory/state.md",
			"C:\\memory\\state.md",
			"//server/share/state.md",
			"\\\\server\\share\\state.md",
			"../outside.md",
			"nested/../outside.md",
			"nested/./state.md",
			"nested//state.md",
			"%2e%2e/outside.md",
			"%252e%252e/outside.md",
			"nested/%2Fetc/passwd",
			"nested/%5Cetc/passwd",
			"nested/%ZZ/state.md",
			"nested/%2/state.md",
			"nested/unsafe\u0000name.md",
			"CON",
			"con.txt",
			"PRN",
			"aux.log",
			"NUL",
			"COM1",
			"LPT9.txt",
			"CONIN$",
			"CONOUT$",
			"COM12",
			"LPT12",
			"trailing.",
			"trailing ",
		];

		for (const candidate of rejected) {
			expect(validateSafeRelativePath(candidate).ok).toBe(false);
			expect(containPath(pinned, candidate).ok).toBe(false);
		}
		for (const deviceName of [
			"CON",
			"con.txt",
			"PRN",
			"aux.log",
			"NUL",
			"COM1",
			"LPT9.txt",
			"CONIN$",
			"CONOUT$",
			"COM12",
			"LPT12",
		]) {
			expect(validateSafePathComponent(deviceName).ok).toBe(false);
		}
	});

	it.skipIf(process.platform === "win32")(
		"rejects leaf and intermediate symlinks and multi-link files without touching their targets",
		async () => {
			const root = await makeRoot();
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-outside-"));
			temporaryRoots.push(outside);
			const outsideDir = path.join(outside, "directory");
			const outsideFile = path.join(outside, "outside.md");
			await fs.mkdir(outsideDir, { mode: 0o700 });
			await fs.writeFile(path.join(outsideDir, "nested.md"), "outside-nested");
			await fs.writeFile(outsideFile, "outside-leaf");

			const leafLink = path.join(root, "leaf-link.md");
			const intermediateLink = path.join(root, "intermediate");
			await fs.symlink(outsideFile, leafLink, "file");
			await fs.symlink(outsideDir, intermediateLink, "dir");

			const hardlinkSource = path.join(root, "source.md");
			const hardlink = path.join(root, "hardlink.md");
			await fs.writeFile(hardlinkSource, "one inode");
			await fs.link(hardlinkSource, hardlink);

			const pinned = requireRootPin(root);
			expect(containPath(pinned, "leaf-link.md").ok).toBe(false);
			expect(containPath(pinned, "intermediate/nested.md").ok).toBe(false);
			expect(containPath(pinned, "hardlink.md").ok).toBe(false);
			expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-leaf");
			expect(await fs.readFile(path.join(outsideDir, "nested.md"), "utf8")).toBe("outside-nested");
		},
	);

	it.skipIf(process.platform === "win32")("detects a moved parent replaced by a symlink after binding", async () => {
		const root = await makeRoot();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-memory-core-binding-outside-"));
		temporaryRoots.push(outside);
		const parent = path.join(root, "managed");
		const movedParent = path.join(outside, "managed");
		const target = path.join(parent, "state.md");
		await fs.mkdir(parent, { mode: 0o700 });
		await fs.writeFile(target, "authorized preimage");

		const pinned = requireRootPin(root);
		const contained = containPath(pinned, "managed/state.md");
		expect(contained.ok).toBe(true);
		if (!contained.ok || contained.value.leafIdentity === null) return;

		await fs.rename(parent, movedParent);
		await fs.symlink(movedParent, parent, "dir");
		const binding = assertPathBinding(pinned, contained.value, contained.value.leafIdentity);
		expect(binding.ok).toBe(false);
		if (binding.ok) return;
		expect(binding.error).toMatchObject({ code: "policy-denied", exitCode: 6 });
	});

	it("rejects a cross-device alias when a distinct temporary device is available", async () => {
		if (process.platform !== "linux") return;
		const root = await makeRoot();
		const alternateParent = "/dev/shm";
		let alternate: string;
		try {
			alternate = await fs.mkdtemp(path.join(alternateParent, "gajae-memory-core-cross-device-"));
		} catch {
			return;
		}
		temporaryRoots.push(alternate);
		const rootStat = await fs.stat(root, { bigint: true });
		const alternateStat = await fs.stat(alternate, { bigint: true });
		if (rootStat.dev === alternateStat.dev) return;

		const outsideFile = path.join(alternate, "outside.md");
		await fs.writeFile(outsideFile, "different device");
		await fs.symlink(outsideFile, path.join(root, "cross-device.md"), "file");
		expect(containPath(requireRootPin(root), "cross-device.md").ok).toBe(false);
	});
});
