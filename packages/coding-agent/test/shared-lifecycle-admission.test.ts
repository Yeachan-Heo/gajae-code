import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedTreeRemovalError,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
} from "../src/session/internal/managed-session-storage";
import {
	SessionManager,
	SessionManagerTestHooks,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";
import { SessionDeleteVerificationError, type VerifiedSessionDeleteTarget } from "../src/session/session-storage";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	delete ManagedTreeRemovalTestHooks.afterNativeRemoval;
	SessionManagerTestHooks.afterForkSnapshot = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-lifecycle-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const a = SessionManager.create(cwd, destination);
	managers.push(a);
	return { root, cwd, destination, a, file: a.getSessionFile()! };
}

async function siblings() {
	const fixture = await fresh();
	const { a, file, destination } = fixture;
	const first = await a.appendMessageSharingSession(user("root"));
	if (first.kind !== "committed") throw new Error(first.kind);
	const b = await SessionManager.open(file, destination);
	managers.push(b);
	const sibling = await b.appendMessageSharingSession(user("B sibling"));
	if (sibling.kind !== "committed") throw new Error(sibling.kind);
	const own = await a.appendMessageSharingSession(user("A sibling"));
	if (own.kind !== "committed") throw new Error(own.kind);
	expect(a.getEntries().some(entry => entry.id === sibling.id)).toBe(false);
	return { ...fixture, b, first: first.id, sibling: sibling.id, own: own.id };
}

async function targetFor(file: string): Promise<VerifiedSessionDeleteTarget> {
	const bytes = Buffer.from(await Bun.file(file).arrayBuffer());
	const header = JSON.parse(bytes.toString("utf8").split("\n")[0]!);
	const stat = await fs.stat(file, { bigint: true });
	const directory = path.dirname(file);
	return {
		sessionsRoot: directory,
		transcriptPath: file,
		sessionId: header.id,
		cwd: header.cwd,
		transcriptIdentity: {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
		},
		plannedArtifactsPath: path.join(directory, `.gjc-delete-${crypto.randomUUID()}-artifacts`),
		plannedTranscriptPath: path.join(directory, `.gjc-delete-${crypto.randomUUID()}-transcript`),
	};
}

async function bytesAt(file: string): Promise<Buffer> {
	return Buffer.from(await Bun.file(file).arrayBuffer());
}

describe("shared lifecycle admission", () => {
	it("refuses relocation before cwd ownership and preserves local navigation and clean close", async () => {
		const { a, file, cwd, root, first, own } = await siblings();
		const nextCwd = path.join(root, "other-workspace");
		await fs.mkdir(nextCwd);
		const bytes = await bytesAt(file);
		const directory = a.getSessionDir();
		const transition = vi.spyOn(a, "runExclusiveCwdMoveTransition");
		await expect(a.moveTo(nextCwd)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect(transition).not.toHaveBeenCalled();
		expect(a.getCwd()).toBe(cwd);
		expect(a.getSessionDir()).toBe(directory);
		expect(a.getSessionFile()).toBe(file);
		expect(await fs.readdir(nextCwd)).toEqual([]);
		expect(await bytesAt(file)).toEqual(bytes);
		expect(await a.runExclusiveCwdMoveTransition(async () => "usable")).toBe("usable");
		a.branch(first);
		expect(a.getLeafId()).toBe(first);
		a.resetLeaf();
		expect(a.getLeafId()).toBe(null);
		a.branch(own);
		expect(a.getLeafId()).toBe(own);
		expect((await a.closeStrict()).kind).toBe("closed");
		expect(await bytesAt(file)).toEqual(bytes);
	});

	it("refuses active deletion before detachment and refuses aliases without touching artifacts", async () => {
		const { a, file } = await siblings();
		const id = a.getSessionId();
		const artifacts = file.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(path.join(artifacts, "sentinel"), "keep");
		const bytes = await bytesAt(file);
		const detach = vi.spyOn(a, "newSession");
		await expect(a.dropSession(file)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.discardUncommittedSession(file)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect(detach).not.toHaveBeenCalled();
		const alias = path.join(path.dirname(file), "alias.jsonl");
		await fs.symlink(file, alias);
		await expect(a.dropSession(alias)).rejects.toThrow();
		await expect(a.discardUncommittedSession(alias)).rejects.toThrow();
		const target = await targetFor(file);
		await expect(a.deleteSessionVerified({ ...target, transcriptPath: alias })).rejects.toBeInstanceOf(
			SharedSessionMutationUnsupportedError,
		);
		await expect(
			a.deleteSessionVerified({ ...target, transcriptPath: alias, sessionId: "forged" }),
		).rejects.toBeInstanceOf(SessionDeleteVerificationError);
		expect(a.getSessionId()).toBe(id);
		expect(a.getSessionFile()).toBe(file);
		expect(await bytesAt(file)).toEqual(bytes);
		expect(await Bun.file(path.join(artifacts, "sentinel")).text()).toBe("keep");
		expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
	});

	it("targets the old shared transcript after switching, not the active unrelated session", async () => {
		const { a, file } = await siblings();
		const bytes = await bytesAt(file);
		const oldTarget = await targetFor(file);
		await a.newSession();
		const ordinaryFile = a.getSessionFile()!;
		const ordinaryId = a.getSessionId();
		a.appendMessage(user("ordinary new session"));
		await a.ensureOnDisk();
		await expect(a.dropSession(file)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.discardUncommittedSession(file)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.deleteSessionVerified(oldTarget)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		// A forged logical ID must fail storage's header verification, not bypass admission.
		await expect(a.deleteSessionVerified({ ...oldTarget, sessionId: ordinaryId })).rejects.toBeInstanceOf(
			SessionDeleteVerificationError,
		);
		expect(a.getSessionFile()).toBe(ordinaryFile);
		expect(await bytesAt(file)).toEqual(bytes);
		const ordinaryTarget = await targetFor(ordinaryFile);
		await a.setSessionFile(file);
		// An active shared session does not poison deletion of a verified unrelated target.
		const artifacts = await a.deleteSessionVerified(ordinaryTarget);
		expect(artifacts.kind).toBe("artifacts_removed");
		const deleted = await a.deleteSessionVerified({ ...ordinaryTarget, artifactsRemoved: true });
		expect(deleted.kind).toBe("deleted");
		expect(await Bun.file(ordinaryFile).exists()).toBe(false);
		expect(a.getSessionFile()).toBe(file);
		expect(() => a.appendCustomEntry("revisit", {})).toThrow(SharedSessionMutationUnsupportedError);
		expect(await bytesAt(file)).toEqual(bytes);
	});

	it("refuses resident graph successors before artifacts or public identity change", async () => {
		const { a, file, first } = await siblings();
		const bytes = await bytesAt(file);
		const before = (await fs.readdir(a.getSessionDir())).sort();
		const id = a.getSessionId();
		const copy = vi.spyOn(a, "copyArtifactsForFork");
		await expect(a.prepareFork()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.fork()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.prepareBranchedSession(first)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect(() => a.createBranchedSession(first)).toThrow(SharedSessionMutationUnsupportedError);
		expect(copy).not.toHaveBeenCalled();
		expect(a.getSessionId()).toBe(id);
		expect(a.getSessionFile()).toBe(file);
		expect((await fs.readdir(a.getSessionDir())).sort()).toEqual(before);
		expect(await bytesAt(file)).toEqual(bytes);
	});

	for (const kind of ["fork", "branch"] as const) {
		it(`does not adopt a ${kind} prepared before shared admission, but can discard it`, async () => {
			const { a, file, destination } = await fresh();
			const first = a.appendMessage(user("ordinary root"));
			await a.ensureOnDisk();
			const stage = kind === "fork" ? await a.prepareFork() : await a.prepareBranchedSession(first);
			if (!stage?.sessionFile) throw new Error("missing prepared transcript");
			expect(await Bun.file(stage.sessionFile).exists()).toBe(true);
			const b = await SessionManager.open(file, destination);
			managers.push(b);
			expect((await b.appendMessageSharingSession(user("sibling"))).kind).toBe("committed");
			expect((await a.appendMessageSharingSession(user("shared admission"))).kind).toBe("committed");
			const bytes = await bytesAt(file);
			const stageBytes = await bytesAt(stage.sessionFile);
			await expect(a.ensurePreparedNewSessionOnDisk(stage)).rejects.toBeInstanceOf(
				SharedSessionMutationUnsupportedError,
			);
			expect(() => a.commitPreparedNewSession(stage)).toThrow(SharedSessionMutationUnsupportedError);
			expect(a.getSessionFile()).toBe(file);
			expect(await bytesAt(stage.sessionFile)).toEqual(stageBytes);
			await a.discardPreparedNewSession(stage);
			expect(await Bun.file(stage.sessionFile).exists()).toBe(false);
			expect(await bytesAt(file)).toEqual(bytes);
		});
	}

	it("rechecks fork admission after an awaited snapshot hook before copying artifacts", async () => {
		const { a, file } = await fresh();
		a.appendMessage(user("ordinary root"));
		await a.ensureOnDisk();
		const copy = vi.spyOn(a, "copyArtifactsForFork");
		SessionManagerTestHooks.afterForkSnapshot = async () => {
			expect((await a.appendMessageSharingSession(user("admitted during fork"))).kind).toBe("committed");
		};
		await expect(a.fork()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect(copy).not.toHaveBeenCalled();
		expect(a.getSessionFile()).toBe(file);
		expect(await Bun.file(file).text()).toContain("admitted during fork");
	});

	it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"propagates populated successor cleanup_pending while retaining its transcript and retired namespace",
		async () => {
			const { a, file, root } = await siblings();
			const bytes = await bytesAt(file);
			const discarded = await a.prepareNewSession();
			if (!discarded.sessionFile || !discarded.artifactsDir) throw new Error("missing successor paths");
			a.appendPreparedCustomMessageEntry(discarded, "fresh", "ordinary", true);
			await a.ensurePreparedNewSessionOnDisk(discarded);
			await fs.mkdir(discarded.artifactsDir, { recursive: true, mode: 0o700 });
			await Bun.write(path.join(discarded.artifactsDir, "sentinel"), "uncommitted");
			await fs.chmod(path.join(discarded.artifactsDir, "sentinel"), 0o600);
			const sourceDirectory = await fs.lstat(discarded.artifactsDir, { bigint: true });
			const sentinelPath = path.join(discarded.artifactsDir, "sentinel");
			const sourceSentinel = await fs.lstat(sentinelPath, { bigint: true });
			expect(sourceDirectory.isDirectory()).toBe(true);
			expect(sourceSentinel.isFile()).toBe(true);
			expect(sourceSentinel.size).toBeGreaterThan(0n);
			expect(sourceDirectory.mode & 0o777n).toBe(0o700n);
			expect(sourceSentinel.mode & 0o777n).toBe(0o600n);
			const successorBytes = await bytesAt(discarded.sessionFile);
			// The store returns exact native failures; the prepared-manager boundary
			// must propagate that same evidence as a typed error, not plain text.
			let observed: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterNativeRemoval = (target, outcome) => {
				expect(target).toBe(discarded.artifactsDir!);
				observed = outcome;
			};
			const error = await a.discardPreparedNewSession(discarded).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(ManagedTreeRemovalError);
			if (!(error instanceof ManagedTreeRemovalError)) throw error;
			expect(error.phase).toBe("native_returned");
			expect(error.message).toBe("cleanup_pending");
			expect(error.targetPath).toBe(discarded.artifactsDir);
			expect(error.outcome?.route).toBe("exact");
			expect(observed?.route).toBe("exact");
			expect(error.outcome?.result).toBe(observed?.result);
			expect(error.outcome?.result.ok).toBe(false);
			expect(error.outcome?.result.code).toBe("cleanup_pending");
			expect(await bytesAt(discarded.sessionFile)).toEqual(successorBytes);
			await expect(fs.stat(discarded.artifactsDir)).rejects.toMatchObject({ code: "ENOENT" });
			// Retirement names and their ancestor differ across native backends.
			// Discover only inside this isolated fixture, without traversing symlinks;
			// require the renamed directory itself, not a copied sentinel lookalike.
			const pending = [root];
			const retained: string[] = [];
			let inspected = 0;
			while (pending.length > 0) {
				const candidate = pending.pop()!;
				if (++inspected > 4096) throw new Error("Retired namespace fixture scan exceeded 4096 entries");
				const stat = await fs.lstat(candidate, { bigint: true });
				if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
				if (stat.dev === sourceDirectory.dev && stat.ino === sourceDirectory.ino) retained.push(candidate);
				for (const name of await fs.readdir(candidate)) pending.push(path.join(candidate, name));
			}
			expect(retained).toHaveLength(1);
			const retiredDirectory = retained[0]!;
			expect(retiredDirectory).not.toBe(discarded.artifactsDir);
			const retiredStat = await fs.lstat(retiredDirectory, { bigint: true });
			expect([retiredStat.dev, retiredStat.ino]).toEqual([sourceDirectory.dev, sourceDirectory.ino]);
			const retainedSentinel = path.join(retiredDirectory, "sentinel");
			const sentinelStat = await fs.lstat(retainedSentinel, { bigint: true });
			expect(sentinelStat.isFile()).toBe(true);
			expect([sentinelStat.dev, sentinelStat.ino]).toEqual([sourceSentinel.dev, sourceSentinel.ino]);
			// Parent-identity-bound exact removal scrubs the retained payload on
			// both supported Unix backends; retained namespace is not reclamation.
			expect(await bytesAt(retainedSentinel)).toEqual(Buffer.alloc(0));
			expect(a.getSessionFile()).toBe(file);
			expect(await bytesAt(file)).toEqual(bytes);
		},
	);

	it("keeps fresh successor persistence, cleanup and adoption independent of shared ancestry", async () => {
		const { a, file } = await siblings();
		const bytes = await bytesAt(file);
		const discarded = await a.prepareNewSession();
		if (!discarded.sessionFile || !discarded.artifactsDir) throw new Error("missing successor paths");
		a.appendPreparedCustomMessageEntry(discarded, "fresh", "ordinary", true);
		await a.ensurePreparedNewSessionOnDisk(discarded);
		await a.discardPreparedNewSession(discarded);
		expect(await Bun.file(discarded.sessionFile).exists()).toBe(false);
		await expect(fs.stat(discarded.artifactsDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(a.getSessionFile()).toBe(file);
		const successor = await a.prepareNewSession();
		a.appendPreparedCustomMessageEntry(successor, "fresh", "adopted", true);
		await a.ensurePreparedNewSessionOnDisk(successor);
		a.commitPreparedNewSession(successor);
		expect(a.getSessionId()).toBe(successor.sessionId);
		const entry = a.appendCustomEntry("ordinary", { value: 1 });
		await a.flush();
		expect(await Bun.file(successor.sessionFile!).text()).toContain(entry);
		await a.setSessionFile(file);
		expect(() => a.createBranchedSession(a.getLeafId()!)).toThrow(SharedSessionMutationUnsupportedError);
		expect(await bytesAt(file)).toEqual(bytes);
	});

	it("still deletes an ordinary active transcript after safely switching resources", async () => {
		const { a, file } = await fresh();
		a.appendMessage(user("ordinary root"));
		await a.ensureOnDisk();
		const previousId = a.getSessionId();
		await a.dropSession(file);
		expect(a.getSessionId()).not.toBe(previousId);
		expect(a.getSessionFile()).not.toBe(file);
		expect(await Bun.file(file).exists()).toBe(false);
		const entry = a.appendCustomEntry("still usable", {});
		expect(a.getLeafId()).toBe(entry);
	});

	it("still prepares and adopts an ordinary non-shared branch", async () => {
		const { a, file } = await fresh();
		const first = a.appendMessage(user("ordinary root"));
		await a.ensureOnDisk();
		const bytes = await bytesAt(file);
		const stage = await a.prepareBranchedSession(first);
		a.commitPreparedNewSession(stage);
		expect(a.getSessionFile()).toBe(stage.sessionFile);
		expect(a.getLeafId()).toBe(first);
		expect(await Bun.file(stage.sessionFile!).text()).toContain(first);
		expect(await bytesAt(file)).toEqual(bytes);
	});
});
