import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactManager } from "../src/session/artifacts";
import { SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";
import { createManagedTaskPersistence } from "../src/task/executor";
import { makeAssistantMessage } from "./session-manager/helpers";
import { injectManagedAppendPreCommit } from "./session-manager/managed-failure-injection";

async function fixture(): Promise<ReturnFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-storage-move-"));
	const cwdA = path.join(root, "workspace");
	const cwdB = path.join(cwdA, "child");
	await fs.mkdir(cwdB, { recursive: true });
	const parent = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, root));
	await parent.ensureOnDisk();
	const admittedOwner = parent.getSessionId();
	const admittedFile = parent.getSessionFile();
	const originalArtifacts = parent.getArtifactManager();
	if (!originalArtifacts || !admittedFile) throw new Error("Expected a managed parent");
	await originalArtifacts.save("parent allocation", "fixture");
	let retainedArtifacts: ArtifactManager = originalArtifacts;
	const persistence = createManagedTaskPersistence(originalArtifacts, "0-child", () => {
		const currentFile = parent.getSessionFile();
		if (
			parent.getSessionId() === admittedOwner &&
			currentFile &&
			path.basename(currentFile) === path.basename(admittedFile)
		) {
			const current = parent.getArtifactManager();
			if (!current) throw new Error("Expected the original owner's managed storage");
			retainedArtifacts = current;
		}
		return retainedArtifacts;
	});
	const child = await persistence.openSession(cwdA);
	child.adoptArtifactManager(originalArtifacts);
	child.appendMessage({ role: "user", content: "original child conversation", timestamp: 1 });
	child.appendMessage(makeAssistantMessage());
	await child.flush();
	const originalChildFile = child.getSessionFile();
	if (!originalChildFile) throw new Error("Expected a managed child transcript");
	return { root, cwdA, cwdB, parent, child, originalArtifacts, originalChildFile };
}

async function dispose(f: ReturnFixture, expectedChildError?: string): Promise<void> {
	try {
		if (expectedChildError) await expect(f.child.close()).rejects.toThrow(expectedChildError);
		else await f.child.close();
	} finally {
		try {
			await f.parent.close();
		} finally {
			await fs.rm(f.root, { recursive: true, force: true });
		}
	}
}

type ReturnFixture = {
	root: string;
	cwdA: string;
	cwdB: string;
	parent: SessionManager;
	child: SessionManager;
	originalArtifacts: ArtifactManager;
	originalChildFile: string;
};

async function appendAfterMove(child: SessionManager): Promise<void> {
	child.appendMessage({ role: "user", content: "continued original child", timestamp: 2 });
	await child.flush();
}

describe("managed Task storage follows only the original logical owner's relocation", () => {
	it("retains the live manager, execution cwd and conversation while adopting the identical copied transcript", async () => {
		const f = await fixture();
		try {
			const childId = f.child.getSessionId();
			await f.parent.moveTo(f.cwdB);
			await appendAfterMove(f.child);
			const relocated = path.join(f.parent.getArtifactManager()!.dir, path.basename(f.originalChildFile));
			expect(f.child.getSessionFile()).toBe(relocated);
			expect(f.child.getSessionId()).toBe(childId);
			expect(f.child.getCwd()).toBe(f.cwdA);
			const bytes = await Bun.file(relocated).text();
			expect(bytes).toContain("original child conversation");
			expect(bytes).toContain("continued original child");
			expect(JSON.parse(bytes.split("\n")[0]).cwd).toBe(f.cwdA);
			expect(await Bun.file(f.originalChildFile).exists()).toBe(false);
		} finally {
			await dispose(f);
		}
	});

	it("refuses changed copied transcript bytes instead of recapturing their identity", async () => {
		const f = await fixture();
		try {
			await f.parent.moveTo(f.cwdB);
			const artifacts = f.parent.getArtifactManager()!;
			const filename = path.basename(f.originalChildFile);
			const copied = await Bun.file(path.join(artifacts.dir, filename)).text();
			const changed = copied.replace("original child conversation", "modified child conversation");
			expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(copied));
			await artifacts.replaceNamed(filename, changed);
			await expect(appendAfterMove(f.child)).rejects.toThrow(
				"managed_transcript_relocation_destination_identity_mismatch",
			);
			expect(f.child.getSessionFile()).toBe(f.originalChildFile);
			expect(await Bun.file(path.join(artifacts.dir, filename)).text()).toBe(changed);
		} finally {
			await dispose(f, "managed_transcript_relocation_destination_identity_mismatch");
		}
	});

	it("re-prepares an async patch when its scoped authority installs an identical copy after preparation", async () => {
		const f = await fixture();
		const target = SessionManager.create(f.cwdB, SessionManager.managedDestination(f.cwdB, f.root));
		const previousHook = SessionManagerTestHooks.beforePersistPatchFence;
		try {
			await target.ensureOnDisk();
			const targetArtifacts = target.getArtifactManager()!;
			await targetArtifacts.save("copy destination", "fixture");
			const filename = path.basename(f.originalChildFile);
			await targetArtifacts.replaceNamed(filename, await Bun.file(f.originalChildFile).text());
			let installed = false;
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				if (!installed) {
					installed = true;
					// A scoped SDK authority may explicitly delegate an already verified copied store.
					f.parent.adoptArtifactManager(targetArtifacts);
				}
			};
			await f.child.setSessionName("continued original conversation", "user");
			expect(installed).toBe(true);
			expect(f.child.getCwd()).toBe(f.cwdA);
			expect(f.child.getSessionFile()).toBe(path.join(targetArtifacts.dir, filename));
			expect(await Bun.file(f.child.getSessionFile()!).text()).toContain("continued original conversation");
			expect(await Bun.file(f.originalChildFile).text()).not.toContain("continued original conversation");
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = previousHook;
			try {
				await target.close();
			} finally {
				await dispose(f);
			}
		}
	});

	it("keeps the child writable when a failed physical parent move restores its source namespace", async () => {
		const f = await fixture();
		let injected = false;
		const injection = injectManagedAppendPreCommit((_file, data) => {
			if (!injected && Buffer.from(data).toString("utf8").includes(f.cwdB)) {
				injected = true;
				return { ok: false, code: "io_error" };
			}
			return "passthrough";
		});
		try {
			await expect(f.parent.moveTo(f.cwdB)).rejects.toThrow("io_error");
			injection.assertHit();
			injection.restore();
			expect(f.parent.getCwd()).toBe(f.cwdA);
			await appendAfterMove(f.child);
			expect(f.child.getCwd()).toBe(f.cwdA);
			expect(f.child.getSessionFile()).toBe(f.originalChildFile);
			expect(await Bun.file(f.originalChildFile).text()).toContain("continued original child");
		} finally {
			injection.restore();
			await dispose(f);
		}
	});

	it("keeps the original namespace after a logical session switch instead of selecting successor storage", async () => {
		const f = await fixture();
		try {
			const originalId = f.parent.getSessionId();
			await f.parent.newSession();
			await f.parent.ensureOnDisk();
			const successor = f.parent.getArtifactManager()!;
			await successor.save("successor sentinel", "fixture");
			expect(f.parent.getSessionId()).not.toBe(originalId);
			await appendAfterMove(f.child);
			expect(f.child.getSessionFile()).toBe(f.originalChildFile);
			expect(await Bun.file(f.originalChildFile).text()).toContain("continued original child");
			expect(await Bun.file(path.join(successor.dir, path.basename(f.originalChildFile))).exists()).toBe(false);
		} finally {
			await dispose(f);
		}
	});

	it("retains the already authorized relocated namespace when a later logical successor is created", async () => {
		const f = await fixture();
		try {
			await f.parent.moveTo(f.cwdB);
			await appendAfterMove(f.child);
			const originalRelocatedFile = f.child.getSessionFile();
			await f.parent.newSession();
			await f.parent.ensureOnDisk();
			const successor = f.parent.getArtifactManager()!;
			await successor.save("successor sentinel", "fixture");
			f.child.appendMessage({ role: "user", content: "still original namespace", timestamp: 3 });
			await f.child.flush();
			expect(f.child.getSessionFile()).toBe(originalRelocatedFile);
			expect(await Bun.file(originalRelocatedFile!).text()).toContain("still original namespace");
			expect(await Bun.file(path.join(successor.dir, path.basename(f.originalChildFile))).exists()).toBe(false);
		} finally {
			await dispose(f);
		}
	});

	for (const replacement of ["reset", "adopt", "branch"] as const) {
		it(`drops the predecessor relocation capability when the relocated child performs ${replacement}`, async () => {
			const f = await fixture();
			try {
				await f.parent.moveTo(f.cwdB);
				await appendAfterMove(f.child);
				const predecessorId = f.child.getSessionId();
				if (replacement === "reset") {
					await f.child.newSession();
					await f.child.ensureOnDisk();
				} else if (replacement === "adopt") {
					const successor = await createManagedTaskPersistence(
						f.parent.getArtifactManager()!,
						"1-successor",
					).openSession(f.cwdA);
					successor.appendMessage({ role: "user", content: "separate successor", timestamp: 3 });
					successor.appendMessage(makeAssistantMessage());
					await successor.flush();
					const successorFile = successor.getSessionFile()!;
					await successor.close();
					await f.child.setSessionFile(successorFile);
				} else {
					const leaf = f.child.getLeafId();
					if (!leaf) throw new Error("Expected a branchable conversation");
					f.child.createBranchedSession(leaf);
				}
				const successorId = f.child.getSessionId();
				const successorFile = f.child.getSessionFile()!;
				expect(successorId).not.toBe(predecessorId);
				const cwdC = path.join(f.cwdB, "next");
				await fs.mkdir(cwdC);
				await f.parent.moveTo(cwdC);
				const copiedFile = path.join(f.parent.getArtifactManager()!.dir, path.basename(successorFile));
				const copied = await Bun.file(copiedFile).text();
				const appendSuccessor = async () => {
					f.child.appendMessage({ role: "user", content: "must not retarget successor", timestamp: 4 });
					await f.child.flush();
				};
				await expect(appendSuccessor()).rejects.toThrow("ENOENT");
				expect(f.child.getSessionFile()).toBe(successorFile);
				expect(f.child.getSessionId()).toBe(successorId);
				expect(await Bun.file(copiedFile).text()).toBe(copied);
			} finally {
				await dispose(f, "ENOENT");
			}
		});
	}

	it("aborts predecessor prepared metadata when that relocated child branches into a new logical session", async () => {
		const f = await fixture();
		const previousHook = SessionManagerTestHooks.beforePersistPatchFence;
		try {
			await f.parent.moveTo(f.cwdB);
			await appendAfterMove(f.child);
			const predecessorId = f.child.getSessionId();
			const leaf = f.child.getLeafId();
			if (!leaf) throw new Error("Expected a branchable conversation");
			let branched = false;
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				if (!branched) {
					branched = true;
					f.child.createBranchedSession(leaf);
				}
			};
			await expect(f.child.setSessionName("predecessor prepared metadata", "user")).rejects.toThrow(
				"session_persistence_lifecycle_changed",
			);
			expect(branched).toBe(true);
			expect(f.child.getSessionId()).not.toBe(predecessorId);
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = previousHook;
			await dispose(f, "session_persistence_lifecycle_changed");
		}
	});
});
