import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedTreeRemovalError,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
} from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	delete ManagedTreeRemovalTestHooks.afterNativeRemoval;
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

/** A source session persisted through the legacy route. */
async function persisted() {
	const fixture = await fresh();
	fixture.a.appendMessage(user("root"));
	await fixture.a.ensureOnDisk();
	await fixture.a.flush();
	return fixture;
}

async function bytesAt(file: string): Promise<Buffer> {
	return Buffer.from(await Bun.file(file).arrayBuffer());
}

describe("shared lifecycle admission", () => {
	it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"propagates populated successor cleanup_pending while retaining its transcript and retired namespace",
		async () => {
			const { a, file, root } = await persisted();
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

	it("keeps fresh successor persistence, cleanup and adoption off the source transcript", async () => {
		const { a, file } = await persisted();
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
