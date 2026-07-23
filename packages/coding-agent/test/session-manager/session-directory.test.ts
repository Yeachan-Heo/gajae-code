import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	deleteManagedSessionCandidate,
	listManagedCandidates,
	openManagedCandidateForWrite,
	prepareManagedSessionScopeForWrite,
	resolveManagedScope,
} from "../../src/session/internal/managed-session-scope";
import {
	publishManagedFileNoReplace,
	validateNativeSecurityResult,
} from "../../src/session/internal/managed-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function legacyDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

function encoded(value: string): string {
	return value.replace(/[/\\:]/g, "-");
}

function legacyAbsoluteDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

async function writeLegacyTranscript(directory: string, id: string, cwd: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, `${id}.jsonl`), transcript(id, cwd));
}

function transcript(id: string, cwd: string, detail = ""): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${JSON.stringify({ type: "message", detail })}\n`;
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-write-"));
	temporaryDirectories.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	expect(resolved.kind).toBe("resolved");
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return { cwd, sessionsRoot, scope: resolved.scope };
}

describe.skipIf(process.platform !== "linux")("managed session scope shared sticky ancestry", () => {
	async function sharedStickyFixture() {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-shared-sticky-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd);
		return { agentDir, cwd, sessionsRoot: path.join(agentDir, "sessions") };
	}

	it("prepares the managed chain directly below the shared sticky temp directory", async () => {
		expect((await fs.stat(os.tmpdir())).mode & 0o1000).toBe(0o1000);
		const stickyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-shared-sticky-root-"));
		await fs.rm(stickyRoot, { recursive: true, force: true });
		temporaryDirectories.push(stickyRoot);
		const cwdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-shared-sticky-workspace-"));
		temporaryDirectories.push(cwdRoot);
		const cwd = path.join(cwdRoot, "workspace");
		await fs.mkdir(cwd);
		const agentDir = stickyRoot;
		const sessionsRoot = path.join(agentDir, "sessions");
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") throw new Error(resolved.message);

		expect(SessionManager.getDefaultSessionDir(cwd, agentDir)).toBe(resolved.scope.directoryPath);
		expect((await prepareManagedSessionScopeForWrite(resolved.scope)).kind).toBe("resolved");
		expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
	});

	it("rejects symlinked managed intermediates and leaves their targets untouched", async () => {
		const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const external = path.join(path.dirname(agentDir), "external");
		await fs.mkdir(external);
		await fs.symlink(external, sessionsRoot);

		await expect(prepareManagedSessionScopeForWrite(resolved.scope)).resolves.toMatchObject({ kind: "error" });
		expect((await fs.lstat(sessionsRoot)).isSymbolicLink()).toBe(true);
		expect(await fs.readdir(external)).toEqual([]);
	});

	it("retains only bounded startup diagnostics when managed preparation rejects a symlink", async () => {
		const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const external = path.join(path.dirname(agentDir), "startup-diagnostic-external");
		await fs.mkdir(external);
		await fs.symlink(external, sessionsRoot);

		let failure: unknown;
		try {
			SessionManager.managedDestination(cwd, agentDir);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const startupError = failure as Error;
		expect(startupError.message).toBe("Could not resolve managed session scope.");
		expect(startupError.message).not.toContain(external);
		expect(JSON.stringify(startupError.cause)).not.toContain(external);
		expect(startupError.cause).toEqual({ classification: "sessions_root_unavailable" });
	});

	it("redacts startup scope failures from the default session-directory wrapper", async () => {
		const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const external = path.join(path.dirname(agentDir), "startup-default-diagnostic-external");
		await fs.mkdir(external);
		await fs.symlink(external, sessionsRoot);

		expect(() => SessionManager.getDefaultSessionDir(cwd, agentDir)).toThrow(
			"Could not resolve managed session scope.",
		);
		try {
			SessionManager.getDefaultSessionDir(cwd, agentDir);
		} catch (error) {
			const startupError = error as Error;
			expect(startupError.message).not.toContain(external);
			expect(JSON.stringify(startupError.cause)).not.toContain(external);
			expect(startupError.cause).toEqual({ classification: "sessions_root_unavailable" });
		}
	});

	it("rejects a symlinked managed scope leaf without following it", async () => {
		const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
		await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const external = path.join(path.dirname(agentDir), "external-leaf");
		await fs.mkdir(external);
		await fs.symlink(external, resolved.scope.directoryPath);

		await expect(prepareManagedSessionScopeForWrite(resolved.scope)).resolves.toMatchObject({ kind: "error" });
		expect((await fs.lstat(resolved.scope.directoryPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readdir(external)).toEqual([]);
	});

	it.skipIf(process.getuid?.() !== 0)(
		"fails closed for foreign-owned existing managed intermediates and leaves them unchanged",
		async () => {
			const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
			await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
			await fs.mkdir(sessionsRoot, { mode: 0o700 });
			const marker = path.join(sessionsRoot, "foreign-marker");
			await fs.writeFile(marker, "do-not-touch");
			await fs.chown(sessionsRoot, 65534, 65534);
			const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
			if (resolved.kind !== "resolved") throw new Error(resolved.message);

			await expect(prepareManagedSessionScopeForWrite(resolved.scope)).resolves.toMatchObject({ kind: "error" });
			expect(await fs.readFile(marker, "utf8")).toBe("do-not-touch");
		},
	);

	it.skipIf(process.getuid?.() !== 0)(
		"fails closed for a foreign-owned managed leaf without adopting it",
		async () => {
			const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
			await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
			const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
			if (resolved.kind !== "resolved") throw new Error(resolved.message);
			await fs.mkdir(resolved.scope.directoryPath, { mode: 0o700 });
			const marker = path.join(resolved.scope.directoryPath, "foreign-marker");
			await fs.writeFile(marker, "do-not-touch");
			await fs.chown(resolved.scope.directoryPath, 65534, 65534);

			await expect(prepareManagedSessionScopeForWrite(resolved.scope)).resolves.toMatchObject({ kind: "error" });
			expect(await fs.readFile(marker, "utf8")).toBe("do-not-touch");
		},
	);

	it("distinguishes ACL/default-ACL observation from repair failure evidence", () => {
		const observation = { ok: false, code: "acl_present", operation: "query", attribute: "access" } as const;
		const repair = { ok: false, code: "acl_denied", operation: "clear", attribute: "default" } as const;
		expect(validateNativeSecurityResult(observation, "verify", "directory")).toEqual(observation);
		expect(validateNativeSecurityResult(repair, "apply", "directory")).toEqual(repair);
		expect(() => validateNativeSecurityResult(repair, "verify", "directory")).toThrow(
			"Verify failure unexpectedly reports ACL mutation",
		);
	});

	it("does not re-adopt a replaced managed leaf or write into its external replacement", async () => {
		const { agentDir, cwd, sessionsRoot } = await sharedStickyFixture();
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		expect((await prepareManagedSessionScopeForWrite(resolved.scope)).kind).toBe("resolved");
		const external = path.join(path.dirname(agentDir), "external-replacement");
		await fs.rename(resolved.scope.directoryPath, external);
		await fs.mkdir(resolved.scope.directoryPath, { mode: 0o700 });
		const sentinel = path.join(resolved.scope.directoryPath, "external-sentinel");
		await fs.writeFile(sentinel, "do-not-touch");

		await expect(prepareManagedSessionScopeForWrite(resolved.scope)).resolves.toMatchObject({ kind: "error" });
		expect(await fs.readFile(sentinel, "utf8")).toBe("do-not-touch");
		expect(await fs.readdir(resolved.scope.directoryPath)).toEqual(["external-sentinel"]);
		expect((await fs.lstat(external)).isDirectory()).toBe(true);
	});
});

describe("managed session write protocol", () => {
	it("copy-retains a legacy candidate and coalesces it to its committed v2 transcript", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		const source = path.join(legacy, "2026-01-01_session-a.jsonl");
		await fs.writeFile(source, transcript("session-a", cwd));

		expect((await prepareManagedSessionScopeForWrite(scope)).kind).toBe("resolved");
		const listed = listManagedCandidates(scope);
		expect(listed.kind).toBe("complete");
		if (listed.kind !== "complete") return;
		const legacyCandidate = listed.owned.find(candidate => candidate.provenance === "legacy");
		expect(legacyCandidate).toBeDefined();
		if (!legacyCandidate) return;

		const first = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(first).toMatchObject({ kind: "opened", migrated: true });
		if (first.kind !== "opened") return;
		expect(first.path).toBe(path.join(scope.directoryPath, path.basename(source)));
		expect(await fs.readFile(source, "utf8")).toBe(transcript("session-a", cwd));

		const replay = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(replay).toMatchObject({ kind: "opened", path: first.path, migrated: true });
		const coalesced = listManagedCandidates(scope);
		expect(coalesced.kind).toBe("complete");
		if (coalesced.kind === "complete") {
			expect(coalesced.owned.filter(candidate => candidate.sessionId === "session-a")).toHaveLength(1);
			expect(coalesced.owned[0]?.provenance).toBe("v2");
			expect(coalesced.owned[0]?.migrationState).toBe("migrated_v2");
		}
		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const committedReceipt = path.join(
			receipts,
			(await fs.readdir(receipts)).find(
				name =>
					name.endsWith(".json") &&
					JSON.parse(syncFs.readFileSync(path.join(receipts, name), "utf8")).state === "committed",
			) ?? "",
		);
		const receipt = JSON.parse(await fs.readFile(committedReceipt, "utf8")) as Record<string, unknown>;
		expect(receipt).toMatchObject({
			state: "committed",
			policy: "copy-retain",
			source: { path: source, sessionId: "session-a" },
			destination: { path: first.path, sessionId: "session-a" },
			artifactManifest: [],
		});

		for (const receipt of await fs.readdir(receipts)) await fs.unlink(path.join(receipts, receipt));
		const interruptedReplay = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(interruptedReplay).toMatchObject({ kind: "opened", path: first.path, migrated: true });
		expect(await fs.readdir(receipts)).toHaveLength(1);
	});
	it("publishes a committed managed inode with exactly one link", async () => {
		const { scope } = await fixture();
		await prepareManagedSessionScopeForWrite(scope);
		const destination = path.join(scope.directoryPath, "single-link.jsonl");

		await publishManagedFileNoReplace(destination, Buffer.from("managed\n"));

		const stat = await fs.stat(destination, { bigint: true });
		expect(stat.nlink).toBe(1n);
		expect(await fs.readFile(destination, "utf8")).toBe("managed\n");
		expect((await fs.readdir(scope.directoryPath)).filter(name => name.endsWith(".staging"))).toEqual([]);
	});
	it("quarantines and restores the complete legacy artifact topology before committing migration authority", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "topology.jsonl");
		const sourceArtifacts = source.slice(0, -6);
		await fs.mkdir(path.join(sourceArtifacts, "nested", "empty"), { recursive: true });
		await fs.writeFile(source, transcript("topology", cwd));
		await fs.writeFile(path.join(sourceArtifacts, "payload.txt"), "root");
		await fs.writeFile(path.join(sourceArtifacts, "nested", "payload.txt"), "nested");
		await fs.chmod(sourceArtifacts, 0o700);
		await fs.chmod(path.join(sourceArtifacts, "nested"), 0o700);
		await fs.chmod(path.join(sourceArtifacts, "nested", "empty"), 0o700);
		await fs.chmod(path.join(sourceArtifacts, "payload.txt"), 0o600);
		await fs.chmod(path.join(sourceArtifacts, "nested", "payload.txt"), 0o600);
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		const opened = await openManagedCandidateForWrite(scope, listed.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);
		const destinationArtifacts = opened.path.slice(0, -6);
		expect(await fs.readFile(path.join(destinationArtifacts, "payload.txt"), "utf8")).toBe("root");
		expect(await fs.readFile(path.join(destinationArtifacts, "nested", "payload.txt"), "utf8")).toBe("nested");
		expect((await fs.stat(path.join(destinationArtifacts, "nested", "empty"))).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(sourceArtifacts, "payload.txt"), "utf8")).toBe("root");
		expect((await fs.stat(path.join(sourceArtifacts, "nested", "empty"))).isDirectory()).toBe(true);
		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const committedReceipt = path.join(
			receipts,
			(await fs.readdir(receipts)).find(
				name =>
					name.endsWith(".json") &&
					JSON.parse(syncFs.readFileSync(path.join(receipts, name), "utf8")).state === "committed",
			) ?? "",
		);
		const receipt = JSON.parse(await fs.readFile(committedReceipt, "utf8")) as { artifactManifest?: unknown[] };
		expect(receipt.artifactManifest).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "directory", path: "nested" }),
				expect.objectContaining({ kind: "directory", path: "nested/empty" }),
				expect.objectContaining({ kind: "file", path: "payload.txt" }),
				expect.objectContaining({ kind: "file", path: "nested/payload.txt" }),
			]),
		);
	});
	it("retains cleanup-pending placeholder authority in the committed migration receipt", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "committed-cleanup-pending.jsonl");
		const artifacts = source.slice(0, -6);

		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "payload.txt"), "payload");
		await fs.writeFile(source, transcript("committed-cleanup-pending", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
		await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({ kind: "opened" });

		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const committed = (await fs.readdir(receipts)).find(
			name => JSON.parse(syncFs.readFileSync(path.join(receipts, name), "utf8")).state === "committed",
		);
		if (!committed) throw new Error("Missing committed receipt");
		const record = JSON.parse(await fs.readFile(path.join(receipts, committed), "utf8")) as {
			sourceArtifactCleanup?: { retainedPath?: unknown };
		};
		expect(record).toMatchObject({
			sourceArtifactCleanup: {
				state: "cleanup_pending",
				role: "exchange_placeholder",
				retainedPath: expect.stringMatching(/\.gjc-exact-unlink-placeholder-/),
			},
		});
	});
	it("persists cleanup-pending placeholder authority and fails closed when it is replaced during replay", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "cleanup-pending-artifact.jsonl");
		const artifacts = source.slice(0, -6);

		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "payload.txt"), "authoritative");
		await fs.writeFile(source, transcript("cleanup-pending-artifact", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		const restore = vi.spyOn(native, "exactRestore").mockReturnValue({ ok: false, code: "io_error" });
		try {
			await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			restore.mockRestore();
		}

		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const detachedReceipt = (await fs.readdir(receipts)).find(name => name.endsWith(".detached.json"));
		if (!detachedReceipt) throw new Error("Missing detached receipt");
		const record = JSON.parse(await fs.readFile(path.join(receipts, detachedReceipt), "utf8")) as Record<
			string,
			unknown
		>;
		const cleanup = record.sourceArtifactCleanup as { retainedPath?: unknown } | undefined;
		if (!cleanup || typeof cleanup.retainedPath !== "string")
			throw new Error("Missing retained placeholder authority");
		const retainedPath = cleanup.retainedPath;
		expect(record).toMatchObject({
			state: "artifact_detached",
			sourceArtifactCleanup: {
				state: "cleanup_pending",
				role: "exchange_placeholder",
				retainedPath,
			},
		});
		await fs.rm(retainedPath, { recursive: true });
		await fs.mkdir(retainedPath);
		await fs.writeFile(path.join(retainedPath, "foreign.txt"), "foreign");

		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		const replay = await openManagedCandidateForWrite(restarted.scope, listed.owned[0]);
		expect(replay).toMatchObject({ kind: "error", code: "durability_failed" });
		expect(await fs.readFile(path.join(retainedPath, "foreign.txt"), "utf8")).toBe("foreign");
		const detached = (await fs.readdir(legacy)).find(
			name => name.startsWith(".gjc-migrate-") && name.endsWith("-artifacts"),
		);
		if (!detached) throw new Error("Missing retained detached artifact root");
		expect(await fs.readFile(path.join(legacy, detached, "payload.txt"), "utf8")).toBe("authoritative");
	});
	it("retains a detached legacy artifact root when exact restoration collides", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "restore-collision.jsonl");
		const sourceArtifacts = source.slice(0, -6);
		await fs.mkdir(sourceArtifacts, { recursive: true });
		await fs.writeFile(source, transcript("restore-collision", cwd));
		await fs.writeFile(path.join(sourceArtifacts, "payload.txt"), "authoritative");
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
		const exactRestore = native.exactRestore;
		const restore = vi.spyOn(native, "exactRestore").mockImplementation((detachedPath, originalPath, identity) => {
			syncFs.mkdirSync(originalPath);
			return exactRestore(detachedPath, originalPath, identity);
		});
		try {
			await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			restore.mockRestore();
		}
		expect((await fs.stat(sourceArtifacts)).isDirectory()).toBe(true);
		const detached = (await fs.readdir(legacy)).find(
			name => name.startsWith(".gjc-migrate-") && name.endsWith("-artifacts"),
		);
		expect(detached).toBeDefined();
		if (!detached) throw new Error("Missing retained detached artifact root");
		expect(await fs.readFile(path.join(legacy, detached, "payload.txt"), "utf8")).toBe("authoritative");
		expect(await fs.readFile(source, "utf8")).toBe(transcript("restore-collision", cwd));
	});
	it("lists disabled legacy candidates read-only, rejects mutation, then migrates safely when re-enabled", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "policy.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("policy", cwd));

		const before = listManagedCandidates(scope);
		expect(before.kind).toBe("complete");
		if (before.kind !== "complete" || !before.owned[0]) throw new Error("Missing readonly legacy candidate");
		expect(before.owned[0]).toMatchObject({ provenance: "legacy", migrationState: "legacy_unmigrated" });
		const disabled = await openManagedCandidateForWrite(scope, before.owned[0], "disabled");
		expect(disabled).toMatchObject({ kind: "error", code: "legacy_migration_disabled" });
		expect(await fs.readFile(source, "utf8")).toBe(transcript("policy", cwd));
		await expect(fs.access(path.join(scope.directoryPath, "policy.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

		const reenabled = await openManagedCandidateForWrite(scope, before.owned[0]);
		expect(reenabled).toMatchObject({ kind: "opened", migrated: true });
		if (reenabled.kind !== "opened") throw new Error(reenabled.message);
		expect(await fs.readFile(source, "utf8")).toBe(transcript("policy", cwd));
		expect(await fs.readFile(reenabled.path, "utf8")).toBe(transcript("policy", cwd));
	});

	it("does not reuse a committed migration receipt for a same-path same-bytes replacement", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "same-bytes-migration.jsonl");
		const content = transcript("same-bytes-migration", cwd);
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, content);
		const firstListing = listManagedCandidates(scope);
		if (firstListing.kind !== "complete") throw new Error(firstListing.message);
		const first = firstListing.owned.find(candidate => candidate.path === source);
		if (!first) throw new Error("Missing first legacy candidate");
		expect(await openManagedCandidateForWrite(scope, first)).toMatchObject({ kind: "opened" });

		await fs.unlink(source);
		await fs.writeFile(source, content);
		await fs.utimes(source, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));
		const secondListing = listManagedCandidates(scope);
		if (secondListing.kind !== "complete") throw new Error(secondListing.message);
		const replacement = secondListing.owned.find(candidate => candidate.path === source);
		if (!replacement) throw new Error("Missing replacement legacy candidate");
		expect(replacement.identity.mtimeNs).not.toBe(first.identity.mtimeNs);
		expect(await openManagedCandidateForWrite(scope, replacement)).toMatchObject({ kind: "opened" });

		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		expect(
			(await fs.readdir(receipts)).filter(
				name => name.endsWith(".json") && !name.endsWith(".prepared.json") && !name.endsWith(".published.json"),
			),
		).toHaveLength(2);
	});

	it("does not let a stale tombstone authorize deletion of a same-path same-bytes replacement", async () => {
		const { cwd, scope } = await fixture();
		await prepareManagedSessionScopeForWrite(scope);
		const targetPath = path.join(scope.directoryPath, "same-bytes-delete.jsonl");
		const content = transcript("same-bytes-delete", cwd);
		await fs.writeFile(targetPath, content);
		const firstListing = listManagedCandidates(scope);
		if (firstListing.kind !== "complete") throw new Error(firstListing.message);
		const first = firstListing.owned.find(candidate => candidate.path === targetPath);
		if (!first) throw new Error("Missing first v2 candidate");
		const firstDelete = await deleteManagedSessionCandidate(scope, first);
		expect(firstDelete).toMatchObject({ kind: "deleted" });
		if (firstDelete.kind !== "deleted") throw new Error("Expected deleted");

		await fs.writeFile(targetPath, content);
		await fs.utimes(targetPath, new Date("2031-01-01T00:00:00.000Z"), new Date("2031-01-01T00:00:00.000Z"));
		const secondListing = listManagedCandidates(scope);
		if (secondListing.kind !== "complete") throw new Error(secondListing.message);
		const replacement = secondListing.owned.find(candidate => candidate.path === targetPath);
		if (!replacement) throw new Error("Missing replacement v2 candidate");
		expect(replacement.identity.mtimeNs).not.toBe(first.identity.mtimeNs);
		const secondDelete = await deleteManagedSessionCandidate(scope, replacement);
		expect(secondDelete).toMatchObject({ kind: "deleted" });
		if (secondDelete.kind !== "deleted") throw new Error("Expected deleted");
		expect(secondDelete.tombstonePath).not.toBe(firstDelete.tombstonePath);
		await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		expect(
			(await fs.readdir(tombstones)).filter(name => name.endsWith(".json") && !name.includes(".cleanup-")),
		).toHaveLength(2);
	});
	it("keeps a migrated session singular after legitimate resumed appends", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "append-list.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("append-list", cwd));
		const initial = listManagedCandidates(scope);
		if (initial.kind !== "complete") throw new Error(initial.message);
		const legacyCandidate = initial.owned.find(candidate => candidate.path === source);
		if (!legacyCandidate) throw new Error("Missing append-list legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, legacyCandidate);
		if (opened.kind !== "opened") throw new Error(opened.message);
		await fs.appendFile(opened.path, `${JSON.stringify({ type: "message", detail: "resumed append" })}\n`);
		const artifactRoot = opened.path.slice(0, -6);
		await fs.mkdir(artifactRoot, { recursive: true });
		await fs.writeFile(path.join(artifactRoot, "new-spill.txt"), "post-migration artifact");

		const listed = listManagedCandidates(scope);
		expect(listed).toMatchObject({ kind: "complete" });
		if (listed.kind !== "complete") return;
		expect(listed.owned.filter(candidate => candidate.sessionId === "append-list")).toEqual([
			expect.objectContaining({ provenance: "v2", path: opened.path }),
		]);
	});

	it("tombstones the retained legacy source when an appended migrated session is deleted", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "append-delete.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("append-delete", cwd));
		const initial = listManagedCandidates(scope);
		if (initial.kind !== "complete") throw new Error(initial.message);
		const legacyCandidate = initial.owned.find(candidate => candidate.path === source);
		if (!legacyCandidate) throw new Error("Missing append-delete legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, legacyCandidate);
		if (opened.kind !== "opened") throw new Error(opened.message);
		await fs.appendFile(opened.path, `${JSON.stringify({ type: "message", detail: "resumed append" })}\n`);
		const artifactRoot = opened.path.slice(0, -6);
		await fs.mkdir(artifactRoot, { recursive: true });
		await fs.writeFile(path.join(artifactRoot, "new-spill.txt"), "post-migration artifact");
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const active = listed.owned.find(candidate => candidate.path === opened.path);
		if (!active) throw new Error("Missing appended v2 candidate");

		expect(await deleteManagedSessionCandidate(scope, active)).toMatchObject({
			kind: "deleted",
			tombstonePath: expect.stringContaining(".json"),
		});
		await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.access(opened.path)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.access(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a replaced migration destination even when bytes and session lineage match", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "destination-replacement.jsonl");
		const content = transcript("destination-replacement", cwd);
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, content);
		const initial = listManagedCandidates(scope);
		if (initial.kind !== "complete") throw new Error(initial.message);
		const legacyCandidate = initial.owned.find(candidate => candidate.path === source);
		if (!legacyCandidate) throw new Error("Missing replacement legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, legacyCandidate);
		if (opened.kind !== "opened") throw new Error(opened.message);
		const replacementPath = `${opened.path}.replacement`;
		await fs.writeFile(replacementPath, content);
		await fs.rename(replacementPath, opened.path);

		const listed = listManagedCandidates(scope);
		expect(listed).toMatchObject({ kind: "complete" });
		if (listed.kind !== "complete") return;
		expect(
			listed.owned
				.filter(candidate => candidate.sessionId === "destination-replacement")
				.map(candidate => candidate.provenance)
				.sort(),
		).toEqual(["legacy", "v2"]);
	});
	it("a fresh scope resumes a tombstoned exact-target cleanup without resurrecting either migration copy", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, listed.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);

		const exactUnlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			const interrupted = await deleteManagedSessionCandidate(scope, opened.candidate);
			expect(interrupted).toMatchObject({ kind: "error", code: "durability_failed" });
		} finally {
			exactUnlink.mockRestore();
		}
		const fresh = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		expect(fresh.kind).toBe("resolved");
		if (fresh.kind !== "resolved") throw new Error(fresh.message);
		const recovered = await deleteManagedSessionCandidate(fresh.scope, opened.candidate);
		expect(recovered).toMatchObject({ kind: "deleted", tombstonePath: expect.stringContaining(".json") });
		expect(
			await fs.access(source).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(opened.path).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(listManagedCandidates(fresh.scope)).toMatchObject({ kind: "complete", owned: [] });
	});

	it("treats a symlinked committed receipt as untrusted and keeps the retained legacy transcript visible", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "receipt-link.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("receipt-link", cwd));
		const initial = listManagedCandidates(scope);
		if (initial.kind !== "complete" || !initial.owned[0]) throw new Error("Missing legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, initial.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);
		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const [receipt] = await fs.readdir(receipts);
		if (!receipt) throw new Error("Missing committed receipt");
		const receiptPath = path.join(receipts, receipt);
		const externalReceipt = path.join(path.dirname(scope.directoryPath), "external-receipt.json");
		await fs.writeFile(externalReceipt, await fs.readFile(receiptPath));
		await fs.unlink(receiptPath);
		await fs.symlink(externalReceipt, receiptPath);

		const listed = listManagedCandidates(scope);
		expect(listed.kind).toBe("complete");
		if (listed.kind !== "complete") return;
		expect(
			listed.owned
				.filter(candidate => candidate.sessionId === "receipt-link")
				.map(candidate => candidate.provenance)
				.sort(),
		).toEqual(["legacy", "v2"]);
		expect(await fs.readFile(source, "utf8")).toBe(transcript("receipt-link", cwd));
	});

	it("rejects a preexisting symlink at the v2 destination without following or replacing it", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "destination-link.jsonl");
		const foreign = path.join(path.dirname(scope.directoryPath), "foreign-transcript.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("destination-link", cwd));
		await prepareManagedSessionScopeForWrite(scope);
		await fs.writeFile(foreign, "foreign transcript\n");
		const destination = path.join(scope.directoryPath, path.basename(source));
		await fs.symlink(foreign, destination);
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
			kind: "error",
			code: "destination_conflict",
		});
		expect(await fs.readFile(foreign, "utf8")).toBe("foreign transcript\n");
		expect(await fs.readFile(source, "utf8")).toBe(transcript("destination-link", cwd));
		expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
	});
	it.skipIf(process.platform !== "win32")(
		"accepts a detached Windows artifact root when native tree size diverges from Bun lstat and identity checks pass",
		async () => {
			const { cwd, sessionsRoot, scope } = await fixture();
			const legacy = legacyDirectory(sessionsRoot, cwd);
			const source = path.join(legacy, "volume-detach.jsonl");
			const artifacts = source.slice(0, -6);
			await fs.mkdir(artifacts, { recursive: true });
			await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
			await fs.writeFile(source, transcript("volume-detach", cwd));
			const listed = listManagedCandidates(scope);
			if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
			const tree = native.snapshotDirectoryTree(artifacts);
			const root = tree.snapshot?.entries.find(entry => entry.relativePath === "" && entry.kind === "directory");
			expect(tree.ok).toBe(true);
			expect(root).toBeDefined();
			expect(BigInt(root!.size)).not.toBe(syncFs.lstatSync(artifacts, { bigint: true }).size);
			const unlink = native.exactUnlink;
			const aliased = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
				const result = unlink(pathname, identity);
				if (!identity.directory || !identity.detachOnly || !result.ok || !result.detachedPath) return result;
				return { ...result, detachedPath: result.detachedPath.toUpperCase() };
			});
			try {
				await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
					kind: "opened",
					migrated: true,
				});
			} finally {
				aliased.mockRestore();
			}
		},
	);
	it("refreshes the source snapshot after an authorized artifact detach advances only transcript ctime", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "ctime-refresh.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("ctime-refresh", cwd));
		const sourceCtimeNs = syncFs.lstatSync(source, { bigint: true }).ctimeNs;
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const unlink = native.exactUnlink;
		const detached = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			const result = unlink(pathname, identity);
			if (pathname === artifacts && identity.directory && identity.detachOnly) {
				const mode = syncFs.lstatSync(source).mode & 0o777;
				syncFs.chmodSync(source, mode);
			}
			return result;
		});
		try {
			await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "opened",
				migrated: true,
			});
		} finally {
			detached.mockRestore();
		}
		expect(await fs.readFile(source, "utf8")).toBe(transcript("ctime-refresh", cwd));
		expect(syncFs.lstatSync(source, { bigint: true }).ctimeNs).not.toBe(sourceCtimeNs);
		expect(await fs.readFile(path.join(scope.directoryPath, path.basename(source)), "utf8")).toBe(
			transcript("ctime-refresh", cwd),
		);
	});

	it("rejects a substituted legacy source after candidate capture and preserves the replacement", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "substitution.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("substitution", cwd, "original"));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		await fs.unlink(source);
		const replacement = transcript("substitution", cwd, "replacement");
		await fs.writeFile(source, replacement);

		await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
			kind: "error",
			code: "source_changed",
		});
		expect(await fs.readFile(source, "utf8")).toBe(replacement);
		await expect(fs.access(path.join(scope.directoryPath, path.basename(source)))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("preserves corrupt legacy entries and refuses mutation from invalid authority", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		const corrupt = path.join(legacy, "corrupt.jsonl");
		await fs.writeFile(corrupt, "not-json\n");
		const listed = listManagedCandidates(scope);
		expect(listed).toMatchObject({ kind: "complete", invalid: [{ code: "unreadable_candidate" }] });
		expect(await fs.readFile(corrupt, "utf8")).toBe("not-json\n");
	});

	it("serializes concurrent migration and makes tombstoned deletion idempotent", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(path.join(legacy, "session.jsonl"), transcript("session-delete", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned[0];
		if (!candidate) throw new Error("Missing legacy candidate");

		const concurrent = await Promise.all([
			openManagedCandidateForWrite(scope, candidate),
			openManagedCandidateForWrite(scope, candidate),
		]);
		const openedResults = concurrent.filter(
			(result): result is Extract<typeof result, { kind: "opened" }> => result.kind === "opened",
		);
		expect(openedResults).toHaveLength(2);
		expect(new Set(openedResults.map(result => result.path)).size).toBe(1);
		expect(openedResults.every(result => result.migrated)).toBe(true);
		const opened = concurrent.find(
			(result): result is Extract<typeof result, { kind: "opened" }> => result.kind === "opened",
		);
		if (!opened) return;
		const deleted = await deleteManagedSessionCandidate(scope, opened.candidate);
		expect(deleted.kind).toBe("deleted");
		if (deleted.kind !== "deleted") throw new Error("Expected deleted");

		const replay = await deleteManagedSessionCandidate(scope, opened.candidate);
		expect(replay.kind).toBe("already_deleted");
		if (replay.kind !== "already_deleted") throw new Error("Expected already_deleted");
		expect(replay.tombstonePath).toBe(deleted.tombstonePath);
		expect(await fs.stat(deleted.tombstonePath)).toBeDefined();
	});
	it.skipIf(process.platform !== "linux")(
		"does not publish cleanup completion when the deleted transcript parent cannot be fsynced",
		async () => {
			const { cwd, sessionsRoot, scope } = await fixture();
			const legacy = legacyDirectory(sessionsRoot, cwd);
			const source = path.join(legacy, "parent-fsync.jsonl");
			await fs.mkdir(legacy, { recursive: true });
			await fs.writeFile(source, transcript("parent-fsync", cwd));
			const listed = listManagedCandidates(scope);
			if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
			const parent = syncFs.realpathSync(legacy);
			const fsync = syncFs.fsyncSync;
			const failParentFsync = vi.spyOn(syncFs, "fsyncSync").mockImplementation(descriptor => {
				if (syncFs.readlinkSync(`/proc/self/fd/${descriptor}`) === parent) throw new Error("fsync failed");
				return fsync(descriptor);
			});
			try {
				await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
					kind: "error",
					code: "durability_failed",
				});
			} finally {
				failParentFsync.mockRestore();
			}
			const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
			expect((await fs.readdir(tombstones)).some(name => name.includes("cleanup-completed"))).toBe(false);
		},
	);
	it("enumerates the actual historical temp-relative root and child directory names", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const tempRoot = os.tmpdir();
		const tempScope = resolveManagedScope({ cwd: tempRoot, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		expect(tempScope.kind).toBe("resolved");
		if (tempScope.kind !== "resolved") return;
		const tempRelative = path.relative(tempRoot, cwd);
		await writeLegacyTranscript(path.join(sessionsRoot, "-tmp"), "temp-root", tempRoot);
		await writeLegacyTranscript(path.join(sessionsRoot, `-tmp-${encoded(tempRelative)}`), "temp-relative", cwd);

		const childListed = listManagedCandidates(scope);
		const rootListed = listManagedCandidates(tempScope.scope);
		expect(childListed).toMatchObject({ kind: "complete" });
		expect(rootListed).toMatchObject({ kind: "complete" });
		if (childListed.kind === "complete")
			expect(childListed.owned.map(candidate => candidate.sessionId)).toEqual(["temp-relative"]);
		if (rootListed.kind === "complete")
			expect(rootListed.owned.map(candidate => candidate.sessionId)).toEqual(["temp-root"]);
	});
	it("enumerates actual historical home-relative root and child directory names", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-home-"));
		temporaryDirectories.push(root);
		const sessionsRoot = path.join(root, "agent", "sessions");
		const home = os.homedir();
		const child = await fs.mkdtemp(path.join(home, ".gjc-managed-session-child-"));
		temporaryDirectories.push(child);
		const encodedHome = encoded(home);
		const relative = path.relative(home, child);
		const rootScope = resolveManagedScope({ cwd: home, agentDir: path.join(root, "agent"), sessionsRoot });
		const childScope = resolveManagedScope({ cwd: child, agentDir: path.join(root, "agent"), sessionsRoot });
		expect(rootScope.kind).toBe("resolved");
		expect(childScope.kind).toBe("resolved");
		if (rootScope.kind !== "resolved" || childScope.kind !== "resolved") return;

		await writeLegacyTranscript(path.join(sessionsRoot, "-"), "home-relative-root", home);
		await writeLegacyTranscript(path.join(sessionsRoot, `-${encoded(relative)}`), "home-relative", child);
		await writeLegacyTranscript(path.join(sessionsRoot, `--${encodedHome}--`), "old-home-root", home);
		await writeLegacyTranscript(
			path.join(sessionsRoot, `--${encodedHome}-${encoded(relative)}--`),
			"old-home-child",
			child,
		);

		const rootListed = listManagedCandidates(rootScope.scope);
		const childListed = listManagedCandidates(childScope.scope);
		expect(rootListed).toMatchObject({ kind: "complete" });
		expect(childListed).toMatchObject({ kind: "complete" });
		if (rootListed.kind === "complete")
			expect(rootListed.owned.map(candidate => candidate.sessionId).sort()).toEqual([
				"home-relative-root",
				"old-home-root",
			]);
		if (childListed.kind === "complete")
			expect(childListed.owned.map(candidate => candidate.sessionId).sort()).toEqual([
				"home-relative",
				"old-home-child",
			]);
	});
	it("lists an absent sessions root as empty without weakening invalid candidate handling", async () => {
		const { cwd, sessionsRoot } = await fixture();
		const resolved = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		expect(listManagedCandidates(resolved.scope)).toEqual({
			kind: "complete",
			scope: resolved.scope,
			owned: [],
			foreignCount: 0,
			invalid: [],
		});
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const foreignCwd = path.join(path.dirname(cwd), "foreign-workspace");
		await fs.mkdir(foreignCwd);
		await writeLegacyTranscript(legacy, "invalid-after-root-create", cwd);
		await fs.writeFile(path.join(legacy, "foreign.jsonl"), transcript("foreign", foreignCwd));
		await fs.writeFile(path.join(legacy, "corrupt.jsonl"), "not-json\n");
		expect(listManagedCandidates(resolved.scope)).toMatchObject({
			kind: "complete",
			owned: [expect.objectContaining({ sessionId: "invalid-after-root-create" })],
			foreignCount: 1,
			invalid: [{ code: "unreadable_candidate" }],
		});
	});

	it("enumerates a lexical absolute legacy spelling when canonical identity resolves through an alias", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-lexical-"));
		temporaryDirectories.push(root);
		const canonical = path.join(root, "workspace");
		const lexical = path.join(root, "workspace-alias");
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		await fs.mkdir(canonical);
		await fs.symlink(canonical, lexical);
		const resolved = resolveManagedScope({ cwd: lexical, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		await writeLegacyTranscript(legacyAbsoluteDirectory(sessionsRoot, lexical), "lexical", lexical);

		const listed = listManagedCandidates(resolved.scope);
		expect(listed).toMatchObject({ kind: "complete" });
		if (listed.kind === "complete") expect(listed.owned.map(candidate => candidate.sessionId)).toEqual(["lexical"]);
	});
	it("discovers a legacy alias directory only for matching canonical workspace identities", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-legacy-alias-"));
		temporaryDirectories.push(root);
		const canonical = path.join(root, "workspace");
		const aliasA = path.join(root, "workspace-alias-a");
		const aliasB = path.join(root, "workspace-alias-b");
		const foreign = path.join(root, "foreign-workspace");
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		await Promise.all([fs.mkdir(canonical), fs.mkdir(foreign)]);
		await Promise.all([fs.symlink(canonical, aliasA), fs.symlink(canonical, aliasB)]);
		await writeLegacyTranscript(legacyAbsoluteDirectory(sessionsRoot, aliasA), "alias-a", aliasA);
		await writeLegacyTranscript(path.join(sessionsRoot, "--foreign-alias--"), "foreign", foreign);

		const canonicalScope = resolveManagedScope({ cwd: canonical, agentDir, sessionsRoot });
		const aliasBScope = resolveManagedScope({ cwd: aliasB, agentDir, sessionsRoot });
		expect(canonicalScope.kind).toBe("resolved");
		expect(aliasBScope.kind).toBe("resolved");
		if (canonicalScope.kind !== "resolved" || aliasBScope.kind !== "resolved") return;

		const canonicalListed = listManagedCandidates(canonicalScope.scope);
		const aliasBListed = listManagedCandidates(aliasBScope.scope);
		expect(canonicalListed).toMatchObject({ kind: "complete", foreignCount: 1 });
		expect(aliasBListed).toMatchObject({ kind: "complete", foreignCount: 1 });
		if (canonicalListed.kind !== "complete" || aliasBListed.kind !== "complete") return;
		expect(canonicalListed.owned.map(candidate => candidate.sessionId)).toEqual(["alias-a"]);
		expect(aliasBListed.owned.map(candidate => candidate.sessionId)).toEqual(["alias-a"]);

		const legacy = canonicalListed.owned[0];
		if (!legacy) throw new Error("Missing alias legacy candidate");
		expect(await openManagedCandidateForWrite(canonicalScope.scope, legacy)).toMatchObject({
			kind: "opened",
			migrated: true,
		});
	});
	it("bounds foreign transcript capture while fully recapturing owned candidates", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const foreignCwd = path.join(path.dirname(cwd), "foreign-workspace");
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await Promise.all([fs.mkdir(foreignCwd), fs.mkdir(legacy, { recursive: true })]);
		const headerCaptureBytes = 64 * 1024;
		const foreignContent = transcript("large-foreign", foreignCwd, "f".repeat(4 * 1024 * 1024));
		const ownedContent = transcript("large-owned", cwd, "o".repeat(2 * 1024 * 1024));
		const foreignPath = path.join(legacy, "large-foreign.jsonl");
		const ownedPath = path.join(legacy, "large-owned.jsonl");
		await Promise.all([fs.writeFile(foreignPath, foreignContent), fs.writeFile(ownedPath, ownedContent)]);
		const foreignSize = Buffer.byteLength(foreignContent);
		const ownedSize = Buffer.byteLength(ownedContent);
		const capturedBySize = new Map<number, number>([
			[foreignSize, 0],
			[ownedSize, 0],
		]);
		const readSync = syncFs.readSync;
		function trackedReadSync(
			descriptor: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: syncFs.ReadPosition | null,
		): number;
		function trackedReadSync(
			descriptor: number,
			buffer: NodeJS.ArrayBufferView,
			options?: syncFs.ReadOptions,
		): number;
		function trackedReadSync(
			descriptor: number,
			buffer: NodeJS.ArrayBufferView,
			offsetOrOptions?: number | syncFs.ReadOptions,
			length?: number,
			position?: syncFs.ReadPosition | null,
		): number {
			const count =
				typeof offsetOrOptions === "number"
					? readSync(
							descriptor,
							buffer,
							offsetOrOptions,
							length ?? buffer.byteLength - offsetOrOptions,
							position ?? null,
						)
					: readSync(descriptor, buffer, offsetOrOptions);
			const size = syncFs.fstatSync(descriptor).size;
			if (capturedBySize.has(size)) capturedBySize.set(size, (capturedBySize.get(size) ?? 0) + count);
			return count;
		}
		const captureReads = vi.spyOn(syncFs, "readSync").mockImplementation(trackedReadSync);
		const listed = (() => {
			try {
				return listManagedCandidates(scope);
			} finally {
				captureReads.mockRestore();
			}
		})();

		expect(listed).toMatchObject({
			kind: "complete",
			foreignCount: 1,
			owned: [expect.objectContaining({ sessionId: "large-owned" })],
		});
		expect(capturedBySize.get(foreignSize)).toBe(headerCaptureBytes);
		expect(capturedBySize.get(ownedSize)).toBe(headerCaptureBytes + ownedSize);
	});
	it("filters colliding legacy absolute directory entries by their transcript workspace identity", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-collision-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		const first = path.join(root, "a-b", "c");
		const second = path.join(root, "a", "b-c");
		await Promise.all([fs.mkdir(first, { recursive: true }), fs.mkdir(second, { recursive: true })]);
		const firstScope = resolveManagedScope({ cwd: first, agentDir, sessionsRoot });
		const secondScope = resolveManagedScope({ cwd: second, agentDir, sessionsRoot });
		expect(firstScope.kind).toBe("resolved");
		expect(secondScope.kind).toBe("resolved");
		if (firstScope.kind !== "resolved" || secondScope.kind !== "resolved") return;
		const collisionDirectory = legacyAbsoluteDirectory(sessionsRoot, first);
		expect(collisionDirectory).toBe(legacyAbsoluteDirectory(sessionsRoot, second));
		await writeLegacyTranscript(collisionDirectory, "first", first);
		await writeLegacyTranscript(collisionDirectory, "second", second);

		const firstListed = listManagedCandidates(firstScope.scope);
		const secondListed = listManagedCandidates(secondScope.scope);
		if (firstListed.kind === "complete")
			expect(firstListed.owned.map(candidate => candidate.sessionId)).toEqual(["first"]);
		if (secondListed.kind === "complete")
			expect(secondListed.owned.map(candidate => candidate.sessionId)).toEqual(["second"]);
	});
	it("reconciles a crash-after-tombstone on a fresh scope without resurrecting the candidate", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "crash-restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("crash-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		const unlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();

		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		const afterRestart = listManagedCandidates(restarted.scope);
		expect(afterRestart).toMatchObject({ kind: "complete" });
		if (afterRestart.kind === "complete")
			expect(afterRestart.owned.some(candidate => candidate.sessionId === "crash-restart")).toBe(false);
	});
	it("reconciles detached artifact cleanup from an append-only sidecar on a fresh scope", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "detached-artifact-restart.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("detached-artifact-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "deleted",
				tombstonePath: expect.stringContaining(".json"),
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();

		expect(listManagedCandidates(restarted.scope)).toMatchObject({ kind: "complete", owned: [] });
	});

	it("recovers a crash after artifact detach but before the native result is persisted", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "crash-after-detach.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("crash-after-detach", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			throw new Error("crash_after_detach");
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();
		expect(await fs.stat(artifacts).catch(() => undefined)).toBeUndefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source)).toBeDefined();
	});
	it("replays an unchanged retained deterministic .removing root from its artifact receipt", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "retained-root-replay.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("retained-root-replay", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
			const retainedPath = `${pathname}.removing`;
			syncFs.renameSync(pathname, retainedPath);
			return { ok: false, code: "io_error", detachedPath: retainedPath };
		});

		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect(await prepareManagedSessionScopeForWrite(restarted.scope)).toMatchObject({ kind: "resolved" });
		expect(await fs.stat(source)).toBeDefined();
	});
	it("rejects a replacement retained deterministic .removing root during replay", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "retained-root-replacement.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("retained-root-replacement", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
			const retainedPath = `${pathname}.removing`;
			syncFs.renameSync(pathname, retainedPath);
			return { ok: false, code: "io_error", detachedPath: retainedPath };
		});

		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}
		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const receiptName = (await fs.readdir(tombstones))
			.filter(name => name.includes(".cleanup-pending-"))
			.sort()
			.at(-1);
		if (!receiptName) throw new Error("Missing cleanup-pending receipt");
		const receiptPath = path.join(tombstones, receiptName);
		const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as {
			detachedArtifactsPath?: unknown;
			expectedArtifactsIdentity?: { sha256?: unknown };
			expectedArtifactsTree?: unknown;
		};
		if (
			typeof receipt.detachedArtifactsPath !== "string" ||
			typeof receipt.expectedArtifactsIdentity?.sha256 !== "string" ||
			receipt.expectedArtifactsTree === undefined
		)
			throw new Error("Missing retained artifact identity or tree evidence");

		await fs.rm(receipt.detachedArtifactsPath, { recursive: true });

		await fs.mkdir(receipt.detachedArtifactsPath);

		await fs.writeFile(path.join(receipt.detachedArtifactsPath, "replacement.txt"), "replacement");

		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		await expect(prepareManagedSessionScopeForWrite(restarted.scope)).resolves.toMatchObject({
			kind: "error",
			code: "binding_invalid",
		});
		expect(await fs.readFile(path.join(receipt.detachedArtifactsPath, "replacement.txt"), "utf8")).toBe(
			"replacement",
		);
	});
	it("reconciles partial tree removal from the deterministic .removing root after restart", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "partial-tree-removing.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("partial-tree-removing", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
			const removing = `${pathname}.removing`;
			syncFs.renameSync(pathname, removing);
			return { ok: false, code: "io_error", detachedPath: removing };
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "deleted",
				tombstonePath: expect.stringContaining(".json"),
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}
		expect(await fs.stat(artifacts).catch(() => undefined)).toBeUndefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
	});

	it("rejects a forged cleanup chain whose detached pathname was not planned by its predecessor", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "forged-cleanup-chain.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("forged-cleanup-chain", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
		} finally {
			remove.mockRestore();
		}
		try {
			const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
			const firstName = (await fs.readdir(tombstones)).find(name => name.includes(".cleanup-pending-1"));
			if (!firstName) throw new Error("Missing initial cleanup receipt");
			const firstPath = path.join(tombstones, firstName);
			const first = JSON.parse(await fs.readFile(firstPath, "utf8")) as Record<string, unknown>;
			const forged = {
				...first,
				attempt: 2,
				detachedArtifactsPath: path.join(path.dirname(source), ".gjc-delete-forged-artifacts"),
				plannedArtifactsPath: path.join(path.dirname(source), ".gjc-delete-forged-next-artifacts"),
				plannedTranscriptPath: path.join(path.dirname(source), ".gjc-delete-forged-next-transcript"),
			};
			await fs.writeFile(firstPath.replace("cleanup-pending-1", "cleanup-pending-2"), JSON.stringify(forged));
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
			expect(await fs.stat(source)).toBeDefined();
		} finally {
			unlink.mockRestore();
		}
	});

	it("reconciles transcript post-quarantine cleanup from a sidecar on a fresh scope", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "detached-transcript-restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("detached-transcript-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const unlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		expect(listManagedCandidates(restarted.scope)).toMatchObject({ kind: "complete", owned: [] });
	});
	it("publishes a contiguous append-only quarantine chain before every repeated cleanup detach", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "repeat-detach.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("repeat-detach", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValue({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
			const firstReceipts = await Promise.all(
				(await fs.readdir(tombstones))
					.filter(name => name.includes(".cleanup-pending-"))
					.map(async name => [name, await fs.readFile(path.join(tombstones, name), "utf8")] as const),
			);
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
			for (const [name, content] of firstReceipts)
				expect(await fs.readFile(path.join(tombstones, name), "utf8")).toBe(content);
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}
		const pending = (await fs.readdir(tombstones)).filter(name => name.includes(".cleanup-pending-"));
		expect(pending.length).toBeGreaterThanOrEqual(3);
		const records = await Promise.all(
			pending.map(
				async name => JSON.parse(await fs.readFile(path.join(tombstones, name), "utf8")) as Record<string, unknown>,
			),
		);
		const attempts = records.map(record => record.attempt as number).sort((left, right) => left - right);
		expect(attempts).toEqual(Array.from({ length: attempts.length }, (_, index) => index + 1));
		const plannedArtifacts = records.map(record => record.plannedArtifactsPath);
		expect(new Set(plannedArtifacts).size).toBe(plannedArtifacts.length);
		const latestAttempt = attempts.at(-1)!;
		const latest = records.find(record => record.attempt === latestAttempt);
		expect(latest).toMatchObject({
			detachedArtifactsPath: expect.stringMatching(/-artifacts-1$/),
			plannedArtifactsPath: expect.stringMatching(new RegExp(`-artifacts-${latestAttempt}$`)),
		});
		expect(await fs.stat(source)).toBeDefined();
	});
	it("replays a real crash after transcript detach through a fresh Q2 plan", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "crash-transcript-q1.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("crash-transcript-q1", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		let detachedQ1: string | undefined;
		let transcriptCrashInjected = false;
		const crash = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname !== source) return exactUnlink(pathname, identity);
			detachedQ1 = path.join(path.dirname(source), identity.quarantineName!);
			syncFs.renameSync(source, detachedQ1);
			transcriptCrashInjected = true;
			throw new Error("crash_after_transcript_detach");
		});
		try {
			let crashed = false;
			for (let attempt = 0; attempt < 4; attempt++) {
				const outcome = await deleteManagedSessionCandidate(scope, listed.owned[0]);
				if (outcome.kind === "cleanup_pending" && outcome.phase === "artifacts") continue;
				expect(outcome).toMatchObject({ kind: "error" });
				crashed = true;
				break;
			}
			if (!crashed)
				throw new Error("Transcript crash injection was not reached after bounded artifact cleanup retries");
			expect(transcriptCrashInjected).toBe(true);
		} finally {
			crash.mockRestore();
		}
		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const pendingNames = (await fs.readdir(tombstones)).filter(name => name.includes(".cleanup-pending-"));
		const pendingRecords = await Promise.all(
			pendingNames.map(
				async name => JSON.parse(await fs.readFile(path.join(tombstones, name), "utf8")) as Record<string, unknown>,
			),
		);
		const first = pendingRecords.find(record => record.plannedTranscriptPath === detachedQ1);
		if (!first) throw new Error("Missing transcript crash cleanup receipt");
		const q1 = first.plannedTranscriptPath;
		if (typeof q1 !== "string") throw new Error("Missing persisted Q1 transcript path");
		expect(detachedQ1).toBe(q1);
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(q1)).toBeDefined();
		let q2: string | undefined;

		const deleteSessionVerified = FileSessionStorage.prototype.deleteSessionVerified;
		const deleteReplay = vi.spyOn(FileSessionStorage.prototype, "deleteSessionVerified").mockImplementation(function (
			this: FileSessionStorage,
			target,
		) {
			expect(target.detachedTranscriptPath).toBe(q1);
			expect(target.plannedTranscriptPath).not.toBe(q1);
			return deleteSessionVerified.call(this, target);
		});
		const replay = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === q1) {
				const names = syncFs.readdirSync(tombstones).filter(name => name.includes(".cleanup-pending-"));
				const records = names.map(
					name => JSON.parse(syncFs.readFileSync(path.join(tombstones, name), "utf8")) as Record<string, unknown>,
				);
				const latest = records.sort((left, right) => Number(right.attempt) - Number(left.attempt))[0];
				q2 = latest?.plannedTranscriptPath as string | undefined;
				expect(latest?.attempt).toBe(Number(first.attempt) + 1);
				expect(q2).toEqual(expect.any(String));
				expect(q2).not.toBe(q1);
				expect(latest?.detachedTranscriptPath).toBe(q1);
				expect((identity as { quarantineName?: string }).quarantineName).toBe(path.basename(q2!));
			}
			return exactUnlink(pathname, identity);
		});
		try {
			const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
			if (restarted.kind !== "resolved") throw new Error(restarted.message);
			const prepared = await prepareManagedSessionScopeForWrite(restarted.scope);
			if (prepared.kind !== "resolved") throw new Error(prepared.message);
		} finally {
			deleteReplay.mockRestore();
			replay.mockRestore();
		}
		expect(q2).toEqual(expect.any(String));
		expect(await fs.stat(q1).catch(() => undefined)).toBeUndefined();
		expect(await fs.stat(q2!)).toBeDefined();
		expect(listManagedCandidates(scope)).toMatchObject({ kind: "complete", owned: [] });
	});

	it("retains artifacts-phase cleanup authority across a fresh-process replay", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "phase-receipt-crash.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("phase-receipt-crash", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");

		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValue({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}

		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const pendingReceipts = await Promise.all(
			(await fs.readdir(tombstones))
				.filter(name => name.includes(".cleanup-pending-"))
				.map(async name => [name, await fs.readFile(path.join(tombstones, name), "utf8")] as const),
		);
		if (pendingReceipts.length === 0) throw new Error("Missing cleanup-pending receipt");
		const latest = pendingReceipts
			.map(
				([, content]) =>
					JSON.parse(content) as {
						detachedArtifactsPath?: unknown;
						retainedArtifactsSuccessorPath?: unknown;
						retainedArtifactsPlaceholderPath?: unknown;
						retainedArtifactsUnknownPath?: unknown;
					},
			)
			.reverse()
			.find(receipt =>
				[
					receipt.detachedArtifactsPath,
					receipt.retainedArtifactsSuccessorPath,
					receipt.retainedArtifactsPlaceholderPath,
					receipt.retainedArtifactsUnknownPath,
				].some(pathname => typeof pathname === "string"),
			);
		if (!latest) throw new Error("Missing retained artifact authority receipt");
		const retainedArtifactAuthority = [
			latest.detachedArtifactsPath,
			latest.retainedArtifactsSuccessorPath,
			latest.retainedArtifactsPlaceholderPath,
			latest.retainedArtifactsUnknownPath,
		].find((pathname): pathname is string => typeof pathname === "string");
		if (!retainedArtifactAuthority) throw new Error("Missing retained artifact authority path");
		expect(await fs.lstat(retainedArtifactAuthority)).toBeDefined();

		const modulePath = path.resolve(import.meta.dir, "../../src/session/internal/managed-session-scope.ts");
		const replayScript = `
			const { prepareManagedSessionScopeForWrite, resolveManagedScope } = await import(${JSON.stringify(modulePath)});
			const resolved = resolveManagedScope(${JSON.stringify({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot })});
			const outcome = resolved.kind === "resolved"
				? await prepareManagedSessionScopeForWrite(resolved.scope)
				: resolved;
			console.log(JSON.stringify({ kind: outcome.kind, message: outcome.kind === "error" ? outcome.message : null }));
		`;
		const replay = Bun.spawn([process.execPath, "--eval", replayScript], {
			cwd: path.resolve(import.meta.dir, "../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(replay.stdout).text(),
			new Response(replay.stderr).text(),
			replay.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ kind: "resolved", message: null });
		for (const [name, content] of pendingReceipts)
			expect(await fs.readFile(path.join(tombstones, name), "utf8")).toBe(content);
		expect(await fs.lstat(retainedArtifactAuthority).catch(() => undefined)).toBeUndefined();
		expect((await fs.readdir(tombstones)).some(name => name.includes(".cleanup-completed-"))).toBe(false);
	});
	it("rejects a dangling replacement at retained artifact authority during fresh replay", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "phase-receipt-replacement.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("phase-receipt-replacement", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");

		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === source) return { ok: false, code: "io_error" };
			if (pathname !== artifacts) return exactUnlink(pathname, identity);
			if (!identity.directory || !identity.quarantineName) throw new Error("Missing artifact quarantine identity");
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			syncFs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValue({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "cleanup_pending",
				phase: "transcript",
				tombstonePath: expect.stringContaining(".json"),
				message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
			});
		} finally {
			remove.mockRestore();
			unlink.mockRestore();
		}

		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const receiptName = (await fs.readdir(tombstones))
			.filter(name => name.includes(".cleanup-pending-"))
			.sort()
			.at(-1);
		if (!receiptName) throw new Error("Missing cleanup-pending receipt");
		const receiptPath = path.join(tombstones, receiptName);
		const receipt = await fs.readFile(receiptPath, "utf8");
		const pending = JSON.parse(receipt) as { detachedArtifactsPath?: unknown };
		if (typeof pending.detachedArtifactsPath !== "string")
			throw new Error("Missing retained artifact authority path");
		await fs.rm(pending.detachedArtifactsPath, { recursive: true });
		const replacementTarget = path.join(path.dirname(source), "replacement-target-does-not-exist");
		await fs.symlink(replacementTarget, pending.detachedArtifactsPath);

		const modulePath = path.resolve(import.meta.dir, "../../src/session/internal/managed-session-scope.ts");
		const replayScript = `
			const { prepareManagedSessionScopeForWrite, resolveManagedScope } = await import(${JSON.stringify(modulePath)});
			const resolved = resolveManagedScope(${JSON.stringify({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot })});
			const outcome = resolved.kind === "resolved"
				? await prepareManagedSessionScopeForWrite(resolved.scope)
				: resolved;
			console.log(JSON.stringify({ kind: outcome.kind, code: outcome.kind === "error" ? outcome.code : null }));
		`;
		const replay = Bun.spawn([process.execPath, "--eval", replayScript], {
			cwd: path.resolve(import.meta.dir, "../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(replay.stdout).text(),
			new Response(replay.stderr).text(),
			replay.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ kind: "error", code: "binding_invalid" });
		expect(await fs.readFile(receiptPath, "utf8")).toBe(receipt);
		expect((await fs.readdir(tombstones)).some(name => name.includes(".cleanup-completed-"))).toBe(false);
		const replacement = await fs.lstat(pending.detachedArtifactsPath);
		expect(replacement.isSymbolicLink()).toBe(true);
		expect(await fs.readlink(pending.detachedArtifactsPath)).toBe(replacementTarget);
	});
});
