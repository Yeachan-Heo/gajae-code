import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyOwnerOnlyFdSecurity,
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	exactRemoveDirectoryTree,
	exactReplacePath,
	exactRestore,
	exactUnlink,
	renameNoReplacePath,
	repairOwnerOnlyPathSecurityExpected,
	snapshotDirectoryTree,
	verifyOwnerOnlyFdSecurity,
	verifyOwnerOnlyPathSecurity,
	verifyOwnerOnlyPathSecurityExpected,
} from "../native/index.js";
import { loadNative } from "../native/loader-state.js";

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

function treeQuarantineName(entry: { relativePath: string; dev: string; ino: string }): string {
	const material = Buffer.concat([
		Buffer.from(entry.relativePath),
		Buffer.from([0]),
		Buffer.from(entry.dev),
		Buffer.from([0]),
		Buffer.from(entry.ino),
	]);
	return `.pi-tree-detached-${createHash("sha256").update(material).digest("hex")}`;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-windows-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});
describe("native addon capability validation", () => {
	it("skips a same-version stale addon missing exactReplacePath", () => {
		const context = {
			isCompiledBinary: false,
			platformTag: "win32-x64",
			packageVersion: "current",
			versionSentinelExport: "__piNativesVCurrent",
			candidates: ["stale-exact.node", "fresh-exact.node"],
		};
		const compatible = {
			__piNativesVCurrent() {},
			__piNativesPublishOutcomeV1() {},
			renameNoReplacePath() {},
			probeWindowsJobMemory() {},
			exactReplacePath() {},
		};
		const loaded = loadNative({
			context,
			extractEmbeddedAddons: () => [],
			stageNodeModulesAddon: () => null,
			requireCandidate: candidate =>
				candidate === "stale-exact.node" ? { ...compatible, exactReplacePath: undefined } : compatible,
		});

		expect(loaded).toBe(compatible);
	});

	it("fails closed when every candidate lacks exactReplacePath", () => {
		const context = {
			isCompiledBinary: false,
			platformTag: "win32-x64",
			packageVersion: "current",
			versionSentinelExport: "__piNativesVCurrent",
			candidates: ["stale.node", "incomplete.node"],
		};
		const incomplete = {
			__piNativesVCurrent() {},
			__piNativesPublishOutcomeV1() {},
			renameNoReplacePath() {},
			probeWindowsJobMemory() {},
		};

		expect(() =>
			loadNative({
				context,
				extractEmbeddedAddons: () => [],
				stageNodeModulesAddon: () => null,
				requireCandidate: () => incomplete,
			}),
		).toThrow(/exactReplacePath/);
	});
});

describe.skipIf(process.platform !== "win32")("Windows native path identity", () => {
	it("rejects final and ancestor reparse points for every owner-only ACL operation", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "{}");
		await fs.symlink(target, alias, "junction");

		const rejected = { ok: false, code: "reparse_point" } as const;
		expect(repairOwnerOnlyPathSecurityExpected(alias, "directory", 0n, 0n)).toEqual(rejected);
		expect(repairOwnerOnlyPathSecurityExpected(path.join(alias, "state.json"), "file", 0n, 0n)).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurityExpected(alias, "directory", 0n, 0n)).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurityExpected(path.join(alias, "state.json"), "file", 0n, 0n)).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
	});
	it("rejects an ancestor junction inserted after exact identity capture without touching its target", async () => {
		const root = await temporaryDirectory();
		const managed = path.join(root, "managed");
		const relocated = path.join(root, "relocated");
		const file = path.join(managed, "state.jsonl");
		await fs.mkdir(managed);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(managed, relocated);
		await fs.symlink(relocated, managed, "junction");

		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
		};
		expect(exactUnlink(file, identity)).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(relocated, "state.jsonl"), "utf8")).toBe("authorized");
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "reparse_point" });
	});
	it("rejects a replaced ancestor junction during exact restore and retains detached content", async () => {
		const root = await temporaryDirectory();
		const managed = path.join(root, "managed");
		const relocated = path.join(root, "relocated");
		const original = path.join(managed, "state.jsonl");
		const detached = path.join(managed, ".gjc-delete-state");
		await fs.mkdir(managed);
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};
		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		await fs.rename(managed, relocated);
		await fs.symlink(relocated, managed, "junction");

		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(relocated, ".gjc-delete-state"), "utf8")).toBe("authorized");
	});

	it("replaces inherited ACLs with a protected owner-only DACL without changing content", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "managed");
		const file = path.join(directory, "state.json");
		const contents = '{"preserve":"payload"}';
		await fs.mkdir(directory);
		await fs.writeFile(file, contents);

		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: false, code: "owner_mismatch" });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "owner_mismatch" });
		expect(applyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});
	it("exactly replaces the expected Windows regular destination", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-exact.json");
		const destination = path.join(root, "current-exact.json");
		await fs.writeFile(source, "new-exact");
		await fs.writeFile(destination, "old-exact");
		const stat = await fs.stat(destination, { bigint: true });

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("old-exact"),
			}),
		).toEqual({ ok: true });
		expect(await fs.readFile(destination, "utf8")).toBe("new-exact");
		expect(
			await fs.stat(source).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
	it("preserves both files when exact replacement identity validation fails", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-mismatch.json");
		const destination = path.join(root, "current-mismatch.json");
		await fs.writeFile(source, "new-mismatch");
		await fs.writeFile(destination, "old-mismatch");
		const stat = await fs.stat(destination, { bigint: true });

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size + 1n,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("old-mismatch"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(source, "utf8")).toBe("new-mismatch");
		expect(await fs.readFile(destination, "utf8")).toBe("old-mismatch");
	});
	it("preserves a same-size destination successor swapped after identity capture", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-swap.json");
		const destination = path.join(root, "current-swap.json");
		const retired = path.join(root, "retired-swap.json");
		await fs.writeFile(source, "new-content");
		await fs.writeFile(destination, "authorized!");
		const stat = await fs.stat(destination, { bigint: true });
		await fs.rename(destination, retired);
		await fs.writeFile(destination, "successor!!");

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized!"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(source, "utf8")).toBe("new-content");
		expect(await fs.readFile(destination, "utf8")).toBe("successor!!");
		expect(await fs.readFile(retired, "utf8")).toBe("authorized!");
	});
	it("rejects cross-parent exact replacement without touching either file", async () => {
		const root = await temporaryDirectory();
		const other = path.join(root, "other");
		await fs.mkdir(other);
		const source = path.join(root, "staged-parent.json");
		const destination = path.join(other, "current-parent.json");
		await fs.writeFile(source, "new-parent");
		await fs.writeFile(destination, "old-parent");
		const stat = await fs.stat(destination, { bigint: true });

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("old-parent"),
			}),
		).toEqual({ ok: false, code: "parent_mismatch" });
		expect(await fs.readFile(source, "utf8")).toBe("new-parent");
		expect(await fs.readFile(destination, "utf8")).toBe("old-parent");
	});
	it("rejects a destination junction before regular-file identity validation", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-reparse.json");
		const target = path.join(root, "reparse-target");
		const destination = path.join(root, "current-reparse.json");
		await fs.writeFile(source, "new-reparse");
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "preserved.txt"), "preserved");
		await fs.symlink(target, destination, "junction");
		const stat = await fs.stat(destination, { bigint: true });

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("not-read"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(source, "utf8")).toBe("new-reparse");
		expect(await fs.readFile(path.join(target, "preserved.txt"), "utf8")).toBe("preserved");
	});
	it("fails closed while another handle retains destination write access", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-writer.json");
		const destination = path.join(root, "current-writer.json");
		await fs.writeFile(source, "new-writer");
		await fs.writeFile(destination, "old-writer");
		const stat = await fs.stat(destination, { bigint: true });
		const writer = await fs.open(destination, "r+");
		try {
			expect(
				exactReplacePath(source, destination, {
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeNs: stat.mtimeNs,
					sha256: sha256("old-writer"),
				}),
			).toEqual({ ok: false, code: "io_error" });
		} finally {
			await writer.close();
		}
		expect(await fs.readFile(source, "utf8")).toBe("new-writer");
		expect(await fs.readFile(destination, "utf8")).toBe("old-writer");
	});
	it("rejects exact replacement for the same path and hard-link aliases", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-alias.json");
		const destination = path.join(root, "current-alias.json");
		await fs.writeFile(source, "same-object");
		const sourceStat = await fs.stat(source, { bigint: true });
		expect(
			exactReplacePath(source, source, {
				dev: sourceStat.dev,
				ino: sourceStat.ino,
				size: sourceStat.size,
				mtimeNs: sourceStat.mtimeNs,
				sha256: sha256("same-object"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		await fs.link(source, destination);
		const stat = await fs.stat(destination, { bigint: true });

		expect(
			exactReplacePath(source, destination, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("same-object"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(source, "utf8")).toBe("same-object");
		expect(await fs.readFile(destination, "utf8")).toBe("same-object");
	});
	it("rejects directory and detach-only identities for exact replacement", async () => {
		const root = await temporaryDirectory();
		const source = path.join(root, "staged-kind.json");
		const destination = path.join(root, "current-kind.json");
		await fs.writeFile(source, "new-kind");
		await fs.writeFile(destination, "old-kind");
		const stat = await fs.stat(destination, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("old-kind"),
		};

		expect(exactReplacePath(source, destination, { ...identity, directory: true })).toEqual({
			ok: false,
			code: "invalid_request",
		});
		expect(exactReplacePath(source, destination, { ...identity, detachOnly: true })).toEqual({
			ok: false,
			code: "invalid_request",
		});
		expect(await fs.readFile(source, "utf8")).toBe("new-kind");
		expect(await fs.readFile(destination, "utf8")).toBe("old-kind");
	});
	it("smokes caller-fd security with fs.openSync and rejects arbitrary fds without terminating", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "caller-fd.json");
		await fs.writeFile(file, "preserve");
		const fd = openSync(file, "r+");
		try {
			expect(applyOwnerOnlyFdSecurity(file, "file", fd)).toEqual({ ok: true });
			expect(verifyOwnerOnlyFdSecurity(file, "file", fd)).toEqual({ ok: true });
			expect(fstatSync(fd).isFile()).toBe(true);
			expect(await fs.readFile(file, "utf8")).toBe("preserve");
			expect(applyOwnerOnlyFdSecurity(file, "file", 2_147_483_647)).toEqual({
				ok: false,
				code: "identity_unavailable",
			});
			expect(verifyOwnerOnlyFdSecurity(file, "file", 2_147_483_647)).toEqual({
				ok: false,
				code: "identity_unavailable",
			});
			expect(await fs.readFile(file, "utf8")).toBe("preserve");
			expect(verifyOwnerOnlyFdSecurity(file, "file", fd)).toEqual({ ok: true });
		} finally {
			closeSync(fd);
		}
	});

	it("fails closed when the pathname is replaced after opening the caller fd", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "caller-fd.json");
		const retained = path.join(root, "retained.json");
		await fs.writeFile(file, "authorized");
		const fd = openSync(file, "r+");
		try {
			await fs.rename(file, retained);
			await fs.writeFile(file, "replacement");
			expect(applyOwnerOnlyFdSecurity(file, "file", fd)).toEqual({
				ok: false,
				code: "identity_mismatch",
			});
			expect(verifyOwnerOnlyFdSecurity(file, "file", fd)).toEqual({
				ok: false,
				code: "identity_mismatch",
			});
			expect(await fs.readFile(file, "utf8")).toBe("replacement");
			expect(await fs.readFile(retained, "utf8")).toBe("authorized");
		} finally {
			closeSync(fd);
		}
	});

	it("rejects mismatched and reused caller fds without mutating pathname security", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "caller-fd.json");
		const other = path.join(root, "other.json");
		await fs.writeFile(file, "authorized");
		await fs.writeFile(other, "other");
		const target = openSync(file, "r+");
		const mismatch = openSync(other, "r+");
		try {
			expect(applyOwnerOnlyFdSecurity(file, "file", target)).toEqual({ ok: true });
			expect(applyOwnerOnlyFdSecurity(other, "file", mismatch)).toEqual({ ok: true });
			expect(applyOwnerOnlyFdSecurity(file, "file", mismatch)).toEqual({
				ok: false,
				code: "identity_mismatch",
			});
			expect(verifyOwnerOnlyFdSecurity(file, "file", target)).toEqual({ ok: true });
			expect(verifyOwnerOnlyFdSecurity(other, "file", mismatch)).toEqual({ ok: true });
		} finally {
			closeSync(target);
			closeSync(mismatch);
		}

		const stale = openSync(file, "r+");
		closeSync(stale);
		const reused = openSync(other, "r+");
		expect(reused).toBe(stale);
		const targetAfterReuse = openSync(file, "r+");
		try {
			expect(applyOwnerOnlyFdSecurity(file, "file", stale)).toEqual({
				ok: false,
				code: "identity_mismatch",
			});
			expect(verifyOwnerOnlyFdSecurity(file, "file", stale)).toEqual({
				ok: false,
				code: "identity_mismatch",
			});
			expect(verifyOwnerOnlyFdSecurity(file, "file", targetAfterReuse)).toEqual({ ok: true });
			expect(verifyOwnerOnlyFdSecurity(other, "file", reused)).toEqual({ ok: true });
			expect(await fs.readFile(file, "utf8")).toBe("authorized");
		} finally {
			closeSync(targetAfterReuse);
			closeSync(reused);
		}
	});
	it("repairs a legacy inherited ACL only for the captured directory and file identities", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "legacy-managed");
		const file = path.join(directory, "state.json");
		const contents = '{"legacy":true}';
		await fs.mkdir(directory);
		await fs.writeFile(file, contents);
		const directoryStat = await fs.stat(directory, { bigint: true });
		const fileStat = await fs.stat(file, { bigint: true });

		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: false, code: "owner_mismatch" });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "owner_mismatch" });
		expect(repairOwnerOnlyPathSecurityExpected(file, "directory", fileStat.dev, fileStat.ino)).toMatchObject({
			ok: false,
		});
		expect(await fs.readFile(file, "utf8")).toBe(contents);
		expect(repairOwnerOnlyPathSecurityExpected(directory, "directory", directoryStat.dev, directoryStat.ino)).toEqual(
			{ ok: true },
		);
		expect(repairOwnerOnlyPathSecurityExpected(file, "file", fileStat.dev, fileStat.ino)).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});
	it("verifies only the captured identity without mutating a swapped replacement", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target.json");
		const retained = path.join(root, "retained.json");
		await fs.writeFile(target, "authorized");
		expect(applyOwnerOnlyPathSecurity(target, "file")).toEqual({ ok: true });
		const identity = await fs.stat(target, { bigint: true });
		expect(verifyOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({ ok: true });
		await fs.rename(target, retained);
		await fs.writeFile(target, "replacement");

		expect(verifyOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expect(verifyOwnerOnlyPathSecurity(target, "file")).toEqual({ ok: false, code: "owner_mismatch" });
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readFile(retained, "utf8")).toBe("authorized");
	});
	it("rejects a swapped replacement before any expected-identity ACL repair", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target.json");
		const retained = path.join(root, "retained.json");
		await fs.writeFile(target, "authorized");
		const identity = await fs.stat(target, { bigint: true });
		await fs.rename(target, retained);
		await fs.writeFile(target, "replacement");

		expect(repairOwnerOnlyPathSecurityExpected(target, "file", identity.dev, identity.ino)).toEqual({
			ok: false,
			code: "identity_mismatch",
		});
		expect(await fs.readFile(target, "utf8")).toBe("replacement");
		expect(await fs.readFile(retained, "utf8")).toBe("authorized");
	});
	it("rejects a contended cross-parent destination without replacing its committed bytes", async () => {
		const root = await temporaryDirectory();
		const staging = path.join(root, "staging");
		const published = path.join(root, "published");
		const source = path.join(staging, "candidate.json");
		const destination = path.join(published, "candidate.json");
		await fs.mkdir(staging);
		await fs.mkdir(published);
		await fs.writeFile(source, "candidate-bytes");
		await fs.writeFile(destination, "committed-bytes");

		expect(renameNoReplacePath(source, destination)).toEqual({
			ok: false,
			code: "quarantine_collision",
			mutationState: "not_committed",
			durabilityState: "not_attempted",
			reason: "destination_exists",
			primitive: "windows_rename_noreplace",
			phase: "rename",
			diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
		});
		expect(await fs.readFile(destination, "utf8")).toBe("committed-bytes");
		expect(await fs.readFile(source, "utf8")).toBe("candidate-bytes");
	});

	it("does not delete a replacement when exact handle identity differs", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "replacement.jsonl");
		await fs.writeFile(file, "replacement");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size + 1n,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("replacement"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("replacement");
	});

	it("retains a same-object content mutation when its authorized digest is stale", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "state.jsonl");
		await fs.writeFile(file, "original");
		const authorizedDigest = sha256("original");
		await fs.writeFile(file, "mutated!");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: authorizedDigest,
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("mutated!");
	});

	it("atomically detaches only the identified directory to its preauthorized destination", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "artifact");
		const child = path.join(directory, "state.json");
		const quarantineName = ".gjc-delete-preauthorized";
		await fs.mkdir(directory);
		await fs.writeFile(child, "preserve");
		const stat = await fs.stat(directory, { bigint: true });

		const result = exactUnlink(directory, {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			directory: true,
			quarantineName,
		});
		expect(result).toEqual({ ok: true, detachedPath: path.join(root, quarantineName) });
		expect(
			await fs.stat(directory).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(await fs.readFile(path.join(result.detachedPath!, "state.json"), "utf8")).toBe("preserve");
	});
	it("detaches through the exact FILE_RENAME_INFO trailing-name offset", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "artifact-long-name");
		const quarantineName = `.gjc-${"q".repeat(190)}`;
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, "state.json"), "preserve");
		const stat = await fs.stat(directory, { bigint: true });

		expect(
			exactUnlink(directory, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName,
			}),
		).toEqual({ ok: true, detachedPath: path.join(root, quarantineName) });
		expect(await fs.readFile(path.join(root, quarantineName, "state.json"), "utf8")).toBe("preserve");
	});
	it("keeps the detached authority when post-detach full-file digest verification succeeds", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		const contents = "x".repeat(128 * 1024);
		await fs.writeFile(original, contents);
		const stat = await fs.stat(original, { bigint: true });

		expect(
			exactUnlink(original, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256(contents),
				quarantineName: path.basename(detached),
				detachOnly: true,
			}),
		).toEqual({ ok: true, detachedPath: detached });
		expect(await fs.readFile(detached, "utf8")).toBe(contents);
	});

	it("restores a handle-bound detached regular file only when the full identity remains authorized", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		expect(exactRestore(detached, original, identity)).toEqual({ ok: true });
		expect(await fs.readFile(original, "utf8")).toBe("authorized");
	});

	it("refuses a Windows exact-restore collision without clobbering either object", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		await fs.writeFile(original, "replacement");
		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "collision" });
		expect(await fs.readFile(original, "utf8")).toBe("replacement");
		expect(await fs.readFile(detached, "utf8")).toBe("authorized");
	});

	it("refuses a detached Windows replacement whose digest no longer matches", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		await fs.writeFile(detached, "replacement");
		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(detached, "utf8")).toBe("replacement");
		expect(
			await fs.stat(original).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects ancestor junction exact deletes without touching their targets", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(path.join(junction, "state.json"), {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("preserve"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(file, "utf8")).toBe("preserve");
	});

	it("rejects an ancestor replaced by a junction after authorization", async () => {
		const root = await temporaryDirectory();
		const parent = path.join(root, "managed");
		const target = path.join(root, "target");
		const file = path.join(parent, "state.jsonl");
		await fs.mkdir(parent);
		await fs.mkdir(target);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(parent, path.join(root, "managed-retained"));
		await fs.symlink(target, parent, "junction");

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(root, "managed-retained", "state.jsonl"), "utf8")).toBe("authorized");
	});

	it("rejects final junction directory detach without touching its target", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "state.json"), "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(target, { bigint: true });

		expect(
			exactUnlink(junction, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName: ".gjc-delete-preauthorized",
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(target, "state.json"), "utf8")).toBe("preserve");
	});

	it("keeps local case aliases classified as the same volume identity", async () => {
		const root = await temporaryDirectory();
		const mixedCase = path.join(root, "MixedCase");
		await fs.mkdir(mixedCase);

		const direct = canonicalExistingDirectoryIdentity(mixedCase);
		const caseAlias = canonicalExistingDirectoryIdentity(path.join(root, "mixedcase"));
		expect(direct.ok).toBe(true);
		expect(caseAlias).toEqual(direct);
	});

	it("classifies UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
		expect(repairOwnerOnlyPathSecurityExpected(String.raw`\\server\share\workspace`, "directory", 0n, 0n)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it("classifies extended UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\?\UNC\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it.skipIf(!process.env.GJC_TEST_SUBST_WORKSPACE)(
		"resolves a configured subst workspace through the local volume",
		() => {
			const substWorkspace = process.env.GJC_TEST_SUBST_WORKSPACE;
			if (!substWorkspace) throw new Error("Missing subst workspace");

			const resolved = canonicalExistingDirectoryIdentity(substWorkspace);
			expect(resolved.ok).toBe(true);
			if (resolved.ok) expect(resolved.canonicalPath).toStartWith("\\\\?\\Volume{");
		},
	);
	it("snapshots and removes nested files and empty directories through retained NT handles", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		await fs.mkdir(path.join(detached, "nested", "empty"), { recursive: true });
		await fs.writeFile(path.join(detached, "nested", "state.jsonl"), "authorized");
		await fs.writeFile(path.join(detached, "root.json"), "root");

		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		expect(snapshot.snapshot.entries.map(entry => entry.relativePath)).toEqual([
			"",
			"nested",
			"nested/empty",
			"nested/state.jsonl",
			"root.json",
		]);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects a descendant substitution after snapshot without deleting the replacement", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		const state = path.join(detached, "state.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(state, "authorized");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		await fs.rm(state);
		await fs.writeFile(state, "replacement");

		const result = exactRemoveDirectoryTree(detached, snapshot.snapshot);
		expect(result).toEqual({ ok: false, code: "identity_mismatch", detachedPath: detached });
		expect(await fs.readFile(state, "utf8")).toBe("replacement");
	});

	it("returns retained root evidence after a partial failure and allows a fresh retry", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached");
		const later = path.join(detached, "z-later.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(path.join(detached, "a-first.jsonl"), "first");
		await fs.writeFile(later, "later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		await fs.rm(later);
		await fs.writeFile(later, "replacement");

		const failed = exactRemoveDirectoryTree(detached, snapshot.snapshot);
		expect(failed).toEqual({ ok: false, code: "identity_mismatch", detachedPath: detached });
		expect(await fs.readFile(later, "utf8")).toBe("replacement");
		const retry = snapshotDirectoryTree(detached);
		expect(retry.ok).toBe(true);
		if (!retry.ok || !retry.snapshot) throw new Error(`retry snapshot failed: ${retry.code}`);
		expect(exactRemoveDirectoryTree(detached, retry.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
	it("validates all nested siblings before quarantining an earlier sibling", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-prevalidation");
		const earlier = path.join(detached, "a-earlier.jsonl");
		const later = path.join(detached, "nested", "z-later.jsonl");
		await fs.mkdir(path.dirname(later), { recursive: true });
		await fs.writeFile(earlier, "authorized-earlier");
		await fs.writeFile(later, "authorized-later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);

		await fs.rm(later);
		await fs.writeFile(later, "substituted-later");

		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({
			ok: false,
			code: "identity_mismatch",
			detachedPath: detached,
		});
		expect(await fs.readFile(earlier, "utf8")).toBe("authorized-earlier");
		expect(await fs.readFile(later, "utf8")).toBe("substituted-later");
	});
	it("replays a previous child-removal prefix from the original snapshot", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-prefix");
		const first = path.join(detached, "a-first.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(first, "first");
		await fs.writeFile(path.join(detached, "z-later.jsonl"), "later");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);

		await fs.rm(first);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
	});
	it.skipIf(!process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY)(
		"preserves case-distinct direct children in a configured case-sensitive directory",
		async () => {
			const detached = process.env.GJC_TEST_CASE_SENSITIVE_DIRECTORY!;
			await fs.writeFile(path.join(detached, "State.jsonl"), "upper");
			await fs.writeFile(path.join(detached, "state.jsonl"), "lower");
			const snapshot = snapshotDirectoryTree(detached);
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
			expect(snapshot.snapshot.entries.map(entry => entry.relativePath)).toEqual(["", "State.jsonl", "state.jsonl"]);
			expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		},
	);
	it("removes nested read-only artifacts through their verified handles", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-readonly");
		const nested = path.join(detached, "nested");
		const readonly = path.join(nested, "state.jsonl");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(readonly, "authorized");
		await fs.chmod(readonly, 0o444);
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
	});
	it("replays a crash after deterministic child quarantine before delete", async () => {
		const root = await temporaryDirectory();
		const detached = path.join(root, ".gjc-detached-child-crash");
		const state = path.join(detached, "state.jsonl");
		await fs.mkdir(detached);
		await fs.writeFile(state, "authorized");
		const snapshot = snapshotDirectoryTree(detached);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error(`snapshot failed: ${snapshot.code}`);
		const stateEntry = snapshot.snapshot.entries.find(entry => entry.relativePath === "state.jsonl");
		if (!stateEntry) throw new Error("missing state entry");

		await fs.rename(state, path.join(detached, treeQuarantineName(stateEntry)));
		expect(exactRemoveDirectoryTree(detached, snapshot.snapshot)).toEqual({ ok: true });
		expect(
			await fs.stat(detached).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
});
