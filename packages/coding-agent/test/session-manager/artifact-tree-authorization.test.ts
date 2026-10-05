import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionEntries, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";

// Runtime-level regression coverage for gajae-code#3302: the runtime never
// supplied `ToolSession.getAuthorizedArtifactsDirs`, so a same-tree detached
// subagent that adopted the parent's `ArtifactManager` still resolved zero
// authorized directories at the `ResolveContext` boundary. These tests exercise
// the actual `SessionManager`/`ArtifactManager` runtime pieces the fix depends
// on (adoption + shared directory identity), not just a hand-built
// `ResolveContext`.

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-tree-authorization-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SessionManager artifact tree adoption (runtime boundary)", () => {
	it("collapses getArtifactsDir() to null for an adopted subagent (documents the reported collapse)", () => {
		const parent = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentManager = parent.getArtifactManager();
		expect(parentManager).not.toBeNull();

		const child = SessionManager.inMemory(tempDir);
		child.adoptArtifactManager(parentManager!);

		// This is the exact collapse the issue reports: an adopted subagent's own
		// `getArtifactsDir()` intentionally returns null (see session-manager.ts).
		expect(child.getArtifactsDir()).toBeNull();
	});

	it("gives an adopted child the same authorized directory as its parent", () => {
		const parent = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentManager = parent.getArtifactManager();
		expect(parentManager).not.toBeNull();

		const child = SessionManager.inMemory(tempDir);
		child.adoptArtifactManager(parentManager!);

		// The fix derives authorized dirs from `getArtifactManager()?.dir`, not
		// `getArtifactsDir()`. Confirm that path is identical for parent and child.
		expect(child.getArtifactManager()?.dir).toBe(parentManager!.dir);
		expect(parent.isArtifactManagerAuthorized(parentManager!)).toBe(true);
		expect(child.isArtifactManagerAuthorized(parentManager!)).toBe(true);
	});

	it("gives sibling subagents (independent adoptions of the same manager) the same authorized directory", () => {
		const parent = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentManager = parent.getArtifactManager();
		expect(parentManager).not.toBeNull();

		const siblingA = SessionManager.inMemory(tempDir);
		siblingA.adoptArtifactManager(parentManager!);
		const siblingB = SessionManager.inMemory(tempDir);
		siblingB.adoptArtifactManager(parentManager!);

		expect(siblingA.getArtifactManager()?.dir).toBe(parentManager!.dir);
		expect(siblingB.getArtifactManager()?.dir).toBe(parentManager!.dir);
	});

	it("gives a freshly reconstructed 'resumed' child the same authorized directory as the original adoption", () => {
		const parent = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const parentManager = parent.getArtifactManager();
		expect(parentManager).not.toBeNull();

		const firstAdoption = SessionManager.inMemory(tempDir);
		firstAdoption.adoptArtifactManager(parentManager!);

		// A resumed detached child re-adopts the same retained manager instance
		// through a brand new `SessionManager` object (see task/index.ts, which
		// re-derives `parentArtifactManager` from `this.session.getArtifactManager()`
		// on every resume, not just the initial spawn).
		const resumedChild = SessionManager.inMemory(tempDir);
		resumedChild.adoptArtifactManager(parentManager!);

		expect(resumedChild.getArtifactManager()?.dir).toBe(firstAdoption.getArtifactManager()?.dir);
	});

	it("does not give an unrelated session's manager the same directory", () => {
		const treeRoot = SessionManager.create(tempDir, SessionManager.explicitDestination(tempDir));
		const unrelatedDir = path.join(tempDir, "unrelated");
		fs.mkdirSync(unrelatedDir, { recursive: true });
		const unrelated = SessionManager.create(tempDir, SessionManager.explicitDestination(unrelatedDir));

		expect(treeRoot.getArtifactManager()?.dir).not.toBe(unrelated.getArtifactManager()?.dir);
		expect(treeRoot.isArtifactManagerAuthorized(unrelated.getArtifactManager()!)).toBe(false);
		expect(unrelated.isArtifactManagerAuthorized(treeRoot.getArtifactManager()!)).toBe(false);
	});
});

function managedFixture() {
	const agentDir = path.join(tempDir, "managed-agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const destination = SessionManager.managedDestination(tempDir, agentDir);
	if (destination.kind !== "managed") throw new Error("Expected a managed session destination");
	return { agentDir, destination };
}

describe("SessionManager durable task artifact owner", () => {
	it("publishes the durable locator before returning a manager and restores its artifacts on reopen", async () => {
		const { agentDir, destination } = managedFixture();
		const session = SessionManager.create(tempDir, destination);
		let reopened: SessionManager | undefined;
		try {
			const manager = await session.ensureArtifactManager();
			expect(manager).not.toBeNull();
			if (!manager) return;
			const sessionFile = session.getSessionFile();
			expect(sessionFile).not.toBeNull();
			if (!sessionFile) return;

			const transcript = fs.readFileSync(sessionFile, "utf8");
			const header = parseSessionEntries(transcript).find(entry => entry.type === "session");
			if (header?.type !== "session" || !header.taskArtifactOwner)
				throw new Error("Durable owner locator was not applied to the session header");
			expect(transcript).toContain(`"taskArtifactOwner":${JSON.stringify(header.taskArtifactOwner)}`);
			expect(manager.dir).toBe(
				path.join(
					destination.securityContext.sessionsRoot,
					".task-artifact-owners",
					header.taskArtifactOwner.ownerId,
				),
			);
			expect(path.resolve(manager.dir)).not.toBe(path.resolve(sessionFile.slice(0, -6)));
			expect(fs.existsSync(path.join(manager.dir, ".gjc-task-artifact-owner-v1.json"))).toBe(true);

			const artifactId = await session.saveArtifact("durable owner payload", "owner-test");
			expect(artifactId).toBeDefined();
			if (!artifactId) return;
			const artifactPath = await manager.getPath(artifactId);
			expect(artifactPath).not.toBeNull();
			expect(path.dirname(artifactPath!)).toBe(manager.dir);
			expect(fs.readFileSync(artifactPath!, "utf8")).toBe("durable owner payload");
			await session.close();

			reopened = await SessionManager.open(sessionFile, SessionManager.managedDestination(tempDir, agentDir));
			const restored = await reopened.ensureArtifactManager();
			expect(restored).not.toBeNull();
			expect(restored?.dir).toBe(manager.dir);
			expect(await reopened.getArtifactPath(artifactId)).toBe(artifactPath);
			expect(await restored?.readRange(artifactId)).toBe("durable owner payload");
		} finally {
			await session.close().catch(() => {});
			await reopened?.close().catch(() => {});
		}
	});

	it("refuses malformed owner metadata without deriving the legacy artifact directory", async () => {
		const { agentDir, destination } = managedFixture();
		const session = SessionManager.create(tempDir, destination);
		try {
			await session.ensureOnDisk();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persistent transcript");
			await session.close();

			const legacyDirectory = sessionFile.slice(0, -6);
			fs.mkdirSync(legacyDirectory, { recursive: true });
			const legacyArtifact = path.join(legacyDirectory, "0.legacy.log");
			fs.writeFileSync(legacyArtifact, "legacy payload");
			const lines = fs.readFileSync(sessionFile, "utf8").trimEnd().split(/\r?\n/u);
			const header = JSON.parse(lines[0]!) as Record<string, unknown>;
			header.taskArtifactOwner = null;
			lines[0] = JSON.stringify(header);
			fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);

			expect(() => parseSessionEntries(fs.readFileSync(sessionFile, "utf8"))).toThrow(
				"task_artifact_owner_locator_invalid",
			);
			await expect(
				SessionManager.open(sessionFile, SessionManager.managedDestination(tempDir, agentDir)),
			).rejects.toThrow();
			expect(fs.existsSync(path.join(destination.securityContext.sessionsRoot, ".task-artifact-owners"))).toBe(
				false,
			);
			expect(fs.readFileSync(legacyArtifact, "utf8")).toBe("legacy payload");
		} finally {
			await session.close().catch(() => {});
		}
	});

	it("retains a prior owner across reset while provisioning a distinct successor", async () => {
		const { destination } = managedFixture();
		const session = SessionManager.create(tempDir, destination);
		try {
			const prior = await session.ensureArtifactManager();
			expect(prior).not.toBeNull();
			if (!prior) return;
			const priorId = await prior.save("retained prior owner", "prior");

			await session.newSession();
			const successor = await session.ensureArtifactManager();
			expect(successor).not.toBeNull();
			expect(successor).not.toBe(prior);
			expect(successor?.dir).not.toBe(prior.dir);
			expect(await prior.readRange(priorId)).toBe("retained prior owner");
			const successorId = await session.saveArtifact("successor owner", "successor");
			expect(successorId).toBeDefined();
			expect(await successor?.readRange(successorId!)).toBe("successor owner");
		} finally {
			await session.close().catch(() => {});
		}
	});

	it("authenticates a cached owner again when the same logical session is freshly reopened", async () => {
		const { destination } = managedFixture();
		const session = SessionManager.create(tempDir, destination);
		try {
			const prior = await session.ensureArtifactManager();
			if (!prior) throw new Error("Expected a managed owner");
			const artifactId = await prior.save("retained capability", "retained");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persistent transcript");
			const manifestPath = path.join(prior.dir, ".gjc-task-artifact-owner-v1.json");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

			await session.newSession();
			await session.setSessionFile(sessionFile);
			fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sessionId: "different-logical-session" }));

			expect(() => session.getArtifactManager()).toThrow("task_artifact_owner_session_mismatch");
			await expect(session.ensureArtifactManager()).rejects.toThrow("task_artifact_owner_session_mismatch");
			expect(await prior.readRange(artifactId)).toBe("retained capability");
		} finally {
			await session.close().catch(() => {});
		}
	});

	it("does not replace an adopted staged manager with a managed owner", async () => {
		const { destination } = managedFixture();
		const parentStore = new ManagedSessionDescendantStore(
			destination.securityContext.rootAuthority,
			destination.directory,
			undefined,
			undefined,
			destination.securityContext.profileAgentDir,
		);
		let staged: SessionManager | undefined;
		try {
			staged = await SessionManager.stagedNestedManaged(
				path.join(destination.directory, "adopted-final.jsonl"),
				destination,
				parentStore,
				undefined,
				"adopted-owner-attempt",
			);
			const adopted = staged.getArtifactManager();
			expect(adopted).not.toBeNull();
			expect(adopted?.getAttemptId()).toBe("adopted-owner-attempt");
			expect(await staged.ensureArtifactManager()).toBe(adopted);
			const stagedFile = staged.getSessionFile();
			if (!stagedFile) throw new Error("Expected a staged transcript");
			const header = parseSessionEntries(fs.readFileSync(stagedFile, "utf8")).find(
				entry => entry.type === "session",
			);
			expect(header?.type === "session" ? header.taskArtifactOwner : undefined).toBeUndefined();
			expect(fs.existsSync(path.join(destination.securityContext.sessionsRoot, ".task-artifact-owners"))).toBe(
				false,
			);
			await staged.discardStaged();
		} finally {
			await staged?.close().catch(() => {});
			parentStore.close();
		}
	});

	it("rejects malformed owner locators in header patches instead of ignoring them", () => {
		const header = {
			type: "session",
			version: 5,
			id: "malformed-patch-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const patch = { type: "header_patch", patch: { taskArtifactOwner: null } };
		expect(() => parseSessionEntries(`${JSON.stringify(header)}\n${JSON.stringify(patch)}\n`)).toThrow(
			"task_artifact_owner_patch_invalid",
		);
	});
});
