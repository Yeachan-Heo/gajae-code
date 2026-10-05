import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

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
