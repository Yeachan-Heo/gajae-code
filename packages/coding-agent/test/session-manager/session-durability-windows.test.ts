import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	canonicalBindingOpenFlags,
	fsyncCanonicalBinding,
	listManagedCandidates,
	matchesMigrationArtifactRoot,
	openManagedCandidateForWrite,
	resolveManagedScope,
	restorePreparedArtifactRoot,
} from "../../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function temporaryDirectory(prefix: string): string {
	return syncFs.mkdtempSync(path.join(syncFs.realpathSync(os.tmpdir()), prefix));
}

function legacyDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

function transcript(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
}

async function fixture() {
	const root = temporaryDirectory("gjc-session-durability-");
	temporaryDirectories.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return { cwd, agentDir, sessionsRoot, scope: resolved.scope };
}

async function interruptedArtifactMigration(id: string) {
	const { cwd, agentDir, sessionsRoot, scope } = await fixture();
	const legacy = legacyDirectory(sessionsRoot, cwd);
	const source = path.join(legacy, `${id}.jsonl`);
	const artifacts = source.slice(0, -6);
	await fs.mkdir(artifacts, { recursive: true });
	await fs.writeFile(path.join(artifacts, "payload.txt"), "authoritative");
	await fs.writeFile(source, transcript(id, cwd));
	const listed = listManagedCandidates(scope);
	if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
	vi.spyOn(native, "exactRestore").mockReturnValue({ ok: false, code: "io_error" });
	expect(await openManagedCandidateForWrite(scope, listed.owned[0])).toMatchObject({
		kind: "error",
		code: "durability_failed",
	});
	const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
	const name = (await fs.readdir(receipts)).find(entry => entry.endsWith(".detached.json"));
	if (!name) throw new Error("Missing detached receipt");
	return {
		cwd,
		agentDir,
		sessionsRoot,
		source,
		artifacts,
		candidate: listed.owned[0],
		receipt: path.join(receipts, name),
	};
}

describe("managed session Windows durability", () => {
	it("selects writable no-follow binding flags only on win32", () => {
		expect(canonicalBindingOpenFlags("win32")).toBe(syncFs.constants.O_RDWR | syncFs.constants.O_NOFOLLOW);
		for (const platform of ["darwin", "linux", "freebsd"] as const)
			expect(canonicalBindingOpenFlags(platform)).toBe(syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
	});

	it("fsyncs a Windows canonical binding through a writable handle without changing its bytes", async () => {
		const root = temporaryDirectory("gjc-binding-fsync-");
		temporaryDirectories.push(root);
		const binding = path.join(root, "binding.json");
		const expected = '{"version":2}\n';
		await fs.writeFile(binding, expected);
		const openSync = syncFs.openSync.bind(syncFs);
		const fsyncSync = syncFs.fsyncSync.bind(syncFs);
		const flags: number[] = [];
		vi.spyOn(syncFs, "openSync").mockImplementation((pathname, flag, mode) => {
			flags.push(flag as number);
			return openSync(pathname, flag, mode);
		});
		vi.spyOn(syncFs, "fsyncSync").mockImplementation(descriptor => {
			if (flags.at(-1) === (syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW)) {
				const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
				throw error;
			}
			return fsyncSync(descriptor);
		});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			expect(() => fsyncCanonicalBinding(binding, expected)).not.toThrow();
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(flags).toContain(syncFs.constants.O_RDWR | syncFs.constants.O_NOFOLLOW);
		expect(await fs.readFile(binding, "utf8")).toBe(expected);
	});

	it("uses native Windows root metadata for prepared receipt validation while rejecting file-content drift", async () => {
		const root = temporaryDirectory("gjc-native-root-authority-");
		temporaryDirectories.push(root);
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(artifacts);
		const payload = path.join(artifacts, "payload.txt");
		await fs.writeFile(payload, "original");
		const stat = syncFs.lstatSync(artifacts, { bigint: true });
		const snapshot = native.snapshotDirectoryTree(artifacts);
		if (!snapshot.ok || !snapshot.snapshot) throw new Error("Native snapshot unavailable");
		const nativeRoot = snapshot.snapshot.entries.find(
			entry => entry.relativePath === "" && entry.kind === "directory",
		);
		if (!nativeRoot) throw new Error("Native root missing");
		const authoritativeSize = (BigInt(nativeRoot.size) + 1n).toString();
		const expectedTree = {
			...snapshot.snapshot,
			entries: snapshot.snapshot.entries.map(entry =>
				entry.relativePath === "" ? { ...entry, size: authoritativeSize } : entry,
			),
		};
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname => {
			const observed = snapshotDirectoryTree(pathname);
			if (!observed.ok || !observed.snapshot) return observed;
			return {
				...observed,
				snapshot: {
					...observed.snapshot,
					entries: observed.snapshot.entries.map(entry =>
						entry.relativePath === ""
							? { ...entry, size: authoritativeSize, mtimeNs: nativeRoot.mtimeNs }
							: entry,
					),
				},
			};
		});
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: BigInt(authoritativeSize),
			mtimeNs: BigInt(nativeRoot.mtimeNs),
		};
		expect(matchesMigrationArtifactRoot(artifacts, identity, expectedTree, "win32")).toBe(true);
		await fs.writeFile(payload, "drifted");
		expect(matchesMigrationArtifactRoot(artifacts, identity, expectedTree, "win32")).toBe(false);
	});

	it("replays a clean detached receipt that omits sourceArtifactCleanup", async () => {
		const interrupted = await interruptedArtifactMigration("clean-detached");
		const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as {
			sourceArtifactQuarantine?: { detachedPath?: string; tree?: unknown };
			sourceArtifactCleanup?: unknown;
		};
		delete record.sourceArtifactCleanup;
		await fs.writeFile(interrupted.receipt, `${JSON.stringify(record)}\n`);
		vi.restoreAllMocks();
		const detachedPath = record.sourceArtifactQuarantine?.detachedPath;
		const tree = record.sourceArtifactQuarantine?.tree;
		if (!detachedPath || !tree) throw new Error("Missing detached artifact authority");
		const snapshotDirectoryTree = native.snapshotDirectoryTree;
		vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(pathname =>
			pathname === detachedPath ? { ok: true, snapshot: tree } : snapshotDirectoryTree(pathname),
		);
		const resolved = resolveManagedScope({
			cwd: interrupted.cwd,
			agentDir: interrupted.agentDir,
			sessionsRoot: interrupted.sessionsRoot,
		});
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const restarted = listManagedCandidates(resolved.scope);
		if (restarted.kind !== "complete") throw new Error("Could not list restarted candidates");
		const legacy = restarted.owned.find(candidate => candidate.provenance === "legacy");
		if (!legacy) throw new Error("Missing restarted legacy candidate");
		expect(() => restorePreparedArtifactRoot(resolved.scope, legacy)).not.toThrow();
		expect((await fs.stat(interrupted.artifacts)).isDirectory()).toBe(true);
	});

	it("fails closed for a detached receipt with partial cleanup-pending authority", async () => {
		const interrupted = await interruptedArtifactMigration("partial-cleanup");
		const record = JSON.parse(await fs.readFile(interrupted.receipt, "utf8")) as Record<string, unknown>;
		record.sourceArtifactCleanup = { state: "cleanup_pending", role: "exchange_placeholder" };
		await fs.writeFile(interrupted.receipt, `${JSON.stringify(record)}\n`);
		vi.restoreAllMocks();
		const resolved = resolveManagedScope({
			cwd: interrupted.cwd,
			agentDir: interrupted.agentDir,
			sessionsRoot: interrupted.sessionsRoot,
		});
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const restarted = listManagedCandidates(resolved.scope);
		if (restarted.kind !== "complete") throw new Error("Could not list restarted candidates");
		const legacy = restarted.owned.find(candidate => candidate.provenance === "legacy");
		if (!legacy) throw new Error("Missing restarted legacy candidate");
		expect(() => restorePreparedArtifactRoot(resolved.scope, legacy)).toThrow("durability_failed");
	});
});
