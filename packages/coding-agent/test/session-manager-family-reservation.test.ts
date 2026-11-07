import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as native from "@gajae-code/natives";
import {
	type ManagedFileIdentity,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import {
	isClosedManagedTranscriptProof,
	SessionManager,
	SessionManagerCleanupOwnershipError,
	SessionManagerTestHooks,
} from "../src/session/session-manager";
import { FileSessionStorage, SessionStorageWriterRetryableCloseError } from "../src/session/session-storage";

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(compacted = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-family-reservation-"));
	roots.push(root);
	const source = path.join(root, "source.jsonl");
	const timestamp = new Date(0).toISOString();
	const entries = [
		{ type: "session", version: 5, id: "source", timestamp, cwd: root },
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp,
			message: { role: "user", content: "history", timestamp: 0 },
		},
		...(compacted
			? [
					{
						type: "compaction",
						id: "compact",
						parentId: "user",
						timestamp,
						summary: "summary",
						firstKeptEntryId: "user",
						tokensBefore: 10,
					},
				]
			: []),
	];
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await Bun.write(source, bytes);
	return { root, source, bytes };
}

describe("complete committed snapshot inspection", () => {
	const timestamp = new Date(0).toISOString();
	const message = (id: string, parentId: string | null = null, content = id) => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content, timestamp: 0 },
	});
	async function capturedFixture(records: readonly unknown[], version = 5) {
		const { root, source } = await fixture(false);
		const header = { type: "session", version, id: "source", timestamp, cwd: root };
		const bytes = `${[header, ...records].map(record => JSON.stringify(record)).join("\n")}\n`;
		await Bun.write(source, bytes);
		const captured = SessionManager.captureTranscriptStrict(source);
		if (captured.kind !== "captured") throw new Error(`Capture failed: ${captured.reason}`);
		return { root, source, bytes, snapshot: captured.snapshot };
	}

	it.each([
		"off",
		"shadow",
		"enabled",
		"auto",
	] as const)("preserves sibling branches and supported patches through a closed managed fork (%s)", async memoryMode => {
		const { root, source, bytes, snapshot } = await capturedFixture([
			message("root"),
			message("left", "root"),
			message("right", "root"),
			{
				type: "entry_patch",
				entryId: "left",
				patch: { message: { role: "user", content: "patched", timestamp: 1 } },
			},
		]);
		const materialize = vi.spyOn(snapshot, "materialize").mockImplementation(() => {
			throw new Error("Unexpected full materialization");
		});
		try {
			expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, "right")).toEqual({
				kind: "complete",
				sessionId: "source",
				cwd: root,
				headEntryId: "right",
				capturedDigest: snapshot.identity.sha256,
				entryCount: 3,
			});
			const fork = await SessionManager.forkFromCaptured(
				snapshot,
				root,
				SessionManager.managedDestination(root, path.join(root, "child-agent")),
				"copy-retain",
				memoryMode,
				{ sessionId: "reserved-complete" },
			);
			if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
			managers.push(fork.manager);
			expect(fork.manager.getEntries().map(entry => [entry.id, entry.parentId])).toEqual([
				["root", null],
				["left", "root"],
				["right", "root"],
			]);
			expect(fork.manager.getEntry("left")).toMatchObject({ message: { content: "patched" } });
			expect(fork.manager.getLeafId()).toBe("right");
			expect(await fork.manager.closeStrict()).toEqual({ kind: "closed" });
			const proof = fork.manager.captureClosedManagedTranscriptProof();
			try {
				expect(proof.identity.sessionId).toBe("reserved-complete");
				expect(proof.revalidate()).toEqual({ kind: "valid" });
			} finally {
				proof.close();
			}
			expect(materialize).not.toHaveBeenCalled();
			expect(await Bun.file(source).text()).toBe(bytes);
		} finally {
			materialize.mockRestore();
			snapshot.close();
		}
	});

	it.each(["enabled", "auto"] as const)("retains closed publication proof on the bounded %s path", async mode => {
		const { root, source, bytes } = await fixture(true);
		const destination = SessionManager.managedDestination(root, path.join(root, "bounded-agent"));
		await fs.mkdir(destination.directory, { recursive: true });
		const captured = SessionManager.captureTranscriptStrict(source);
		if (captured.kind !== "captured") throw new Error("Missing capture");
		const priorEager = SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
		const priorAuto = SessionManagerTestHooks.autoModeMinTranscriptBytesOverride;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
		try {
			const fork = await SessionManager.forkFromCaptured(captured.snapshot, root, destination, "copy-retain", mode, {
				sessionId: "reserved-bounded",
			});
			if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
			managers.push(fork.manager);
			expect(fork.manager.getLeafId()).toBe("compact");
			expect(await fork.manager.closeStrict()).toEqual({ kind: "closed" });
			const proof = fork.manager.captureClosedManagedTranscriptProof();
			try {
				expect(proof.identity.sessionId).toBe("reserved-bounded");
				expect(proof.revalidate()).toEqual({ kind: "valid" });
			} finally {
				proof.close();
			}
			expect(await Bun.file(source).text()).toBe(bytes);
		} finally {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = priorEager;
			SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = priorAuto;
			captured.snapshot.close();
		}
	});

	it.each(["enabled", "auto"] as const)("rejects replacement during bounded %s initialization", async mode => {
		const { root, source } = await fixture(true);
		const destination = SessionManager.managedDestination(root, path.join(root, "bounded-agent"));
		await fs.mkdir(destination.directory, { recursive: true });
		const captured = SessionManager.captureTranscriptStrict(source);
		if (captured.kind !== "captured") throw new Error("Missing capture");
		const priorEager = SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
		const priorAuto = SessionManagerTestHooks.autoModeMinTranscriptBytesOverride;
		SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
		SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = 1;
		const read = ManagedSessionDescendantStore.prototype.readExpected;
		const remove = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpected");
		let replacement: string | undefined;
		const spy = vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relative,
		) {
			const observed = read.call(this, relative);
			if (observed && relative.endsWith("_reserved-bounded.jsonl") && replacement === undefined) {
				replacement = path.join(destination.directory, relative);
				queueMicrotask(() => {
					syncFs.renameSync(replacement!, `${replacement}.original`);
					syncFs.copyFileSync(`${replacement}.original`, replacement!);
				});
			}
			return observed;
		});
		try {
			let failure: unknown;
			try {
				const fork = await SessionManager.forkFromCaptured(
					captured.snapshot,
					root,
					destination,
					"copy-retain",
					mode,
					{
						sessionId: "reserved-bounded",
					},
				);
				if (fork.kind === "forked") managers.push(fork.manager);
			} catch (error) {
				failure = error;
			}
			expect(replacement).toBeDefined();
			expect(failure).toBeInstanceOf(SessionManagerCleanupOwnershipError);
			if (!(failure instanceof SessionManagerCleanupOwnershipError)) throw new Error("Missing cleanup owner");
			expect(await failure.getCleanup().join()).toMatchObject({ kind: "close_unknown" });
			expect(await failure.getCleanup().join()).toMatchObject({ kind: "close_unknown" });
			expect(remove.mock.calls.filter(([relative]) => relative.endsWith("_reserved-bounded.jsonl"))).toHaveLength(1);
			expect(await Bun.file(replacement!).text()).toBe(await Bun.file(`${replacement}.original`).text());
		} finally {
			remove.mockRestore();
			spy.mockRestore();
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = priorEager;
			SessionManagerTestHooks.autoModeMinTranscriptBytesOverride = priorAuto;
			captured.snapshot.close();
		}
	});

	it("rejects replacement between staged publication and managed identity adoption", async () => {
		const { root, snapshot } = await capturedFixture([message("head")]);
		const open = FileSessionStorage.prototype.openStagedWriter;
		let publishedPath: string | undefined;
		const spy = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
			this: FileSessionStorage,
			file,
			options,
		) {
			const writer = open.call(this, file, options);
			const publish = writer.publishNoReplace.bind(writer);
			writer.publishNoReplace = () => {
				const receipt = publish();
				syncFs.renameSync(file, `${file}.original`);
				syncFs.copyFileSync(`${file}.original`, file);
				publishedPath = file;
				return receipt;
			};
			return writer;
		});
		let failure: unknown;
		try {
			try {
				const fork = await SessionManager.forkFromCaptured(
					snapshot,
					root,
					SessionManager.managedDestination(root, path.join(root, "child-agent")),
					"copy-retain",
					"shadow",
					{ sessionId: "reserved-adoption" },
				);
				if (fork.kind === "forked") managers.push(fork.manager);
			} catch (error) {
				failure = error;
			}
			expect(publishedPath).toBeDefined();
			expect(failure).toBeInstanceOf(SessionManagerCleanupOwnershipError);
			if (!(failure instanceof SessionManagerCleanupOwnershipError)) throw new Error("Missing cleanup owner");
			expect(await failure.getCleanup().join()).toMatchObject({ kind: "close_unknown" });
			expect(await Bun.file(publishedPath!).text()).toBe(await Bun.file(`${publishedPath}.original`).text());
		} finally {
			spy.mockRestore();
			snapshot.close();
		}
	});

	it.each([
		"before-close",
		"after-close",
	] as const)("rejects an identical-byte replacement of the published child (%s)", async replacementPoint => {
		const { root, snapshot } = await capturedFixture([message("head")]);
		try {
			const fork = await SessionManager.forkFromCaptured(
				snapshot,
				root,
				SessionManager.managedDestination(root, path.join(root, "child-agent")),
				"copy-retain",
				"shadow",
				{ sessionId: "reserved-replacement" },
			);
			if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
			managers.push(fork.manager);
			const destination = fork.manager.getSessionFile()!;
			const publishedBytes = await Bun.file(destination).text();
			if (replacementPoint === "after-close") expect(await fork.manager.closeStrict()).toEqual({ kind: "closed" });
			await fs.rename(destination, `${destination}.original`);
			await Bun.write(destination, publishedBytes);
			if (replacementPoint === "before-close") expect(await fork.manager.closeStrict()).toEqual({ kind: "closed" });
			expect(() => fork.manager.captureClosedManagedTranscriptProof()).toThrow(
				"closed_managed_transcript_identity_mismatch",
			);
			expect(await Bun.file(destination).text()).toBe(publishedBytes);
			expect(await Bun.file(`${destination}.original`).text()).toBe(publishedBytes);
		} finally {
			snapshot.close();
		}
	});

	it.each([
		["duplicate IDs", [message("head"), message("head")]],
		["an orphaned sibling", [message("root"), message("orphan", "missing"), message("head", "root")]],
		["a self-cycle", [message("head", "head")]],
		["a multi-entry cycle", [message("first", "head"), message("head", "first")]],
		["an unknown entry", [{ ...message("head"), type: "unknown" }]],
		["a second header", [{ type: "session", version: 5, id: "other", timestamp, cwd: "/fixture" }]],
		["a missing patch target", [message("head"), { type: "entry_patch", entryId: "missing", patch: {} }]],
		[
			"an invalid replacement message",
			[message("head"), { type: "entry_patch", entryId: "head", patch: { message: {} } }],
		],
		["an unsupported header patch", [message("head"), { type: "header_patch", patch: { id: "changed" } }]],
		["an unapplied starred patch", [message("head"), { type: "header_patch", patch: { starred: true } }]],
	] as const)("rejects %s without rewriting the source", async (_name, records) => {
		const { source, bytes, snapshot } = await capturedFixture(records);
		try {
			expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, "head")).toEqual({
				kind: "error",
				reason: "malformed",
			});
			expect(await Bun.file(source).text()).toBe(bytes);
		} finally {
			snapshot.close();
		}
	});

	it("reports patched cwd from a read-only alias without changing the persisted head", async () => {
		const { root, source, snapshot } = await capturedFixture([
			message("head"),
			{ type: "header_patch", patch: { cwd: "/captured/project", title: "Retained title" } },
		]);
		snapshot.close();
		const alias = path.join(root, "alias.jsonl");
		await fs.link(source, alias);
		const captured = SessionManager.captureTranscriptReadOnly(alias);
		if (captured.kind !== "captured") throw new Error(`Capture failed: ${captured.reason}`);
		try {
			expect(SessionManager.inspectCompleteCommittedSnapshot(captured.snapshot, "head")).toMatchObject({
				kind: "complete",
				cwd: "/captured/project",
				headEntryId: "head",
				entryCount: 1,
			});
		} finally {
			captured.snapshot.close();
		}
	});

	it("accepts a complete forest with forward parent references", async () => {
		const { snapshot } = await capturedFixture([message("child", "parent"), message("parent"), message("head")]);
		try {
			expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, "head")).toMatchObject({
				kind: "complete",
				entryCount: 3,
				headEntryId: "head",
			});
		} finally {
			snapshot.close();
		}
	});

	it("rejects historical and null requested heads instead of substituting the persisted head", async () => {
		const { snapshot } = await capturedFixture([message("old"), message("head", "old")]);
		try {
			for (const requested of ["old", null]) {
				expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, requested)).toEqual({
					kind: "error",
					reason: "identity-mismatch",
				});
			}
		} finally {
			snapshot.close();
		}
	});

	it("distinguishes an empty committed tree from an older format", async () => {
		const empty = await capturedFixture([]);
		const legacy = await capturedFixture([message("head")], 4);
		try {
			expect(SessionManager.inspectCompleteCommittedSnapshot(empty.snapshot, null)).toMatchObject({
				kind: "complete",
				headEntryId: null,
				entryCount: 0,
			});
			expect(SessionManager.inspectCompleteCommittedSnapshot(legacy.snapshot, "head")).toEqual({
				kind: "error",
				reason: "migration-required",
			});
		} finally {
			empty.snapshot.close();
			legacy.snapshot.close();
		}
	});

	it("bounds retained metadata without materializing message bodies", async () => {
		const { snapshot } = await capturedFixture([message("head", null, "large body".repeat(4096))]);
		const prior = SessionManagerTestHooks.sessionContextBudgetBytesOverride;
		try {
			SessionManagerTestHooks.sessionContextBudgetBytesOverride = 1024;
			expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, "head")).toMatchObject({
				kind: "complete",
				entryCount: 1,
			});
			SessionManagerTestHooks.sessionContextBudgetBytesOverride = 1;
			expect(SessionManager.inspectCompleteCommittedSnapshot(snapshot, "head")).toEqual({
				kind: "error",
				reason: "context_too_large",
			});
		} finally {
			SessionManagerTestHooks.sessionContextBudgetBytesOverride = prior;
			snapshot.close();
		}
	});

	it("revalidates the source after the complete tree pass", async () => {
		const { source, snapshot } = await capturedFixture([message("head")]);
		try {
			const inspected = SessionManager.inspectCompleteCommittedSnapshot(
				{
					...snapshot,
					forEachLine(callback) {
						const complete = snapshot.forEachLine(callback);
						syncFs.renameSync(source, `${source}.moved`);
						return complete;
					},
				},
				"head",
			);
			expect(inspected).toEqual({ kind: "error", reason: "missing" });
		} finally {
			snapshot.close();
		}
	});

	it("preserves read and cleanup failures instead of labelling them malformed input", async () => {
		const { snapshot } = await capturedFixture([message("head")]);
		const failure = new Error("controlled retained read failure");
		let observed: unknown;
		try {
			SessionManager.inspectCompleteCommittedSnapshot(
				{
					...snapshot,
					forEachLine() {
						throw failure;
					},
				},
				"head",
			);
		} catch (error) {
			observed = error;
		} finally {
			snapshot.close();
		}
		expect(observed).toBe(failure);
	});
});

async function managedProofFixture() {
	const { root } = await fixture();
	const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
	managers.push(manager);
	manager.appendMessage({ role: "user", content: "owned history", timestamp: 1 });
	await manager.ensureOnDisk();
	return { manager, file: manager.getSessionFile()! };
}

describe("closed managed transcript proof", () => {
	for (const operation of ["create", "rewrite"] as const) {
		it(`rejects identical-byte substitution between ${operation} publication and identity adoption`, async () => {
			const { root } = await fixture();
			const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
			manager.appendMessage({ role: "user", content: "original owned bytes", timestamp: 1 });
			if (operation === "rewrite") await manager.ensureOnDisk();
			const file = manager.getSessionFile()!;
			let substituted = false;
			const substitute = (relative: string) => {
				if (substituted || relative !== path.basename(file)) return;
				substituted = true;
				syncFs.renameSync(file, `${file}.original`);
				syncFs.copyFileSync(`${file}.original`, file);
			};
			const create = ManagedSessionDescendantStore.prototype.replaceSync;
			const rewrite = ManagedSessionDescendantStore.prototype.replaceExpectedIdentitySync;
			const spy =
				operation === "create"
					? vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceSync").mockImplementation(function (
							this: ManagedSessionDescendantStore,
							relative: string,
							bytes: Uint8Array,
						) {
							const receipt = create.call(this, relative, bytes);
							substitute(relative);
							return receipt;
						})
					: vi
							.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync")
							.mockImplementation(function (
								this: ManagedSessionDescendantStore,
								relative: string,
								bytes: Uint8Array,
								expected: ManagedFileIdentity,
							) {
								const receipt = rewrite.call(this, relative, bytes, expected);
								substitute(relative);
								return receipt;
							});
			try {
				await expect(operation === "create" ? manager.ensureOnDisk() : manager.rewriteEntries()).rejects.toThrow(
					"managed_replace_committed_outcome_uncertain",
				);
				expect(substituted).toBe(true);
				expect(await Bun.file(file).text()).toBe(await Bun.file(`${file}.original`).text());
				expect((await fs.stat(file)).ino).not.toBe((await fs.stat(`${file}.original`)).ino);
				expect((await manager.closeStrict()).kind).toBe("close_unknown");
				expect(() => manager.captureClosedManagedTranscriptProof()).toThrow(
					"closed_managed_transcript_not_confirmed",
				);
			} finally {
				spy.mockRestore();
				await manager.closeStrict();
			}
		});
	}

	it("rejects a same-content direct fork replacement before manager acceptance", async () => {
		const { manager, file } = await managedProofFixture();
		const prior = SessionManagerTestHooks.afterForkTranscriptPublished;
		let replacement: string | undefined;
		SessionManagerTestHooks.afterForkTranscriptPublished = async () => {
			const files = await fs.readdir(path.dirname(file));
			const child = files.find(name => name.endsWith(".jsonl") && name !== path.basename(file));
			if (!child) throw new Error("Missing published child");
			replacement = path.join(path.dirname(file), child);
			await fs.rename(replacement, `${replacement}.original`);
			await fs.copyFile(`${replacement}.original`, replacement);
		};
		try {
			await expect(manager.fork()).rejects.toThrow("Failed to clean up");
			expect(replacement).toBeDefined();
			expect(manager.getSessionFile()).toBe(file);
			expect((await manager.closeStrict()).kind).toBe("close_unknown");
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
			expect(await Bun.file(replacement!).text()).toBe(await Bun.file(`${replacement}.original`).text());
		} finally {
			SessionManagerTestHooks.afterForkTranscriptPublished = prior;
			managers.splice(managers.indexOf(manager), 1);
		}
	});

	for (const fault of ["after-mkdir", "first-snapshot", "preflight"] as const) {
		it(`retains explicit artifact creation attempt (${fault})`, async () => {
			const { root } = await fixture(false);
			const manager = SessionManager.create(root, path.join(root, "sessions"));
			manager.appendMessage({ role: "user", content: "source", timestamp: 1 });
			await manager.ensureOnDisk();
			const source = manager.getSessionFile()!;
			await fs.mkdir(source.slice(0, -6), { recursive: true });
			const natives = require("@gajae-code/natives") as typeof native;
			const capture = natives.snapshotDirectoryTree;
			let created: string | undefined;
			const snapshotSpy = vi.spyOn(natives, "snapshotDirectoryTree").mockImplementation(directory => {
				if (fault === "preflight" && directory === source.slice(0, -6)) throw new Error("preflight rejected");
				if (directory.endsWith(".fork-staging")) {
					created = directory;
					if (fault === "first-snapshot") throw new Error("first snapshot rejected");
				}
				return capture(directory);
			});
			const mkdir = syncFs.mkdirSync;
			const mkdirSpy = vi.spyOn(syncFs, "mkdirSync").mockImplementation((directory, options) => {
				const result = mkdir(directory, options);
				if (String(directory).endsWith(".fork-staging")) {
					created = String(directory);
					if (fault === "after-mkdir") throw new Error("created then rejected");
				}
				return result;
			});
			const remove = vi.spyOn(natives, "exactRemoveDirectoryTree");
			try {
				await expect(
					manager.copyArtifactsForFork(source, path.join(path.dirname(source), "target.jsonl")),
				).rejects.toThrow("rejected");
				expect(remove).not.toHaveBeenCalled();
			} finally {
				remove.mockRestore();
				mkdirSpy.mockRestore();
				snapshotSpy.mockRestore();
			}
			if (fault === "preflight") {
				expect(created).toBeUndefined();
				expect((await manager.closeStrict()).kind).toBe("closed");
			} else {
				if (!created) throw new Error("Missing actual created root");
				expect((await fs.stat(created)).isDirectory()).toBe(true);
				expect((await manager.closeStrict()).kind).toBe("close_unknown");
				await expect(manager.close()).rejects.toThrow("Fork rollback cleanup is unconfirmed");
			}
		});
	}

	it("closes retained prepared persistence despite independent unknown staged debt", async () => {
		const { root } = await fixture(false);
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(root, path.join(root, "sessions"), storage);
		manager.appendMessage({ role: "user", content: "predecessor", timestamp: 1 });
		await manager.ensureOnDisk();
		const source = manager.getSessionFile()!;
		const sourceBytes = await Bun.file(source).text();
		const openStaged = storage.openStagedWriter.bind(storage);
		let unknownDispatches = 0;
		const stagedSpy = vi.spyOn(storage, "openStagedWriter").mockImplementation((file, options) =>
			openStaged(file, {
				...options,
				closeAdapter: {
					close(fd) {
						unknownDispatches++;
						syncFs.closeSync(fd);
						throw new Error("staged close dispatched without confirmation");
					},
				},
			}),
		);
		try {
			await expect(manager.fork()).rejects.toBeInstanceOf(SessionManagerCleanupOwnershipError);
		} finally {
			stagedSpy.mockRestore();
		}
		const prepared = await manager.prepareNewSession();
		const openWriter = storage.openWriter.bind(storage);
		let allowClose = false;
		let closeAttempts = 0;
		let descriptor: number | undefined;
		let tempPath: string | undefined;
		const writerSpy = vi.spyOn(storage, "openWriter").mockImplementation((file, options) => {
			tempPath = file;
			return openWriter(file, {
				...options,
				closeAdapter: {
					close(fd) {
						descriptor = fd;
						closeAttempts++;
						if (!allowClose) throw new SessionStorageWriterRetryableCloseError();
						syncFs.closeSync(fd);
					},
				},
			});
		});
		try {
			await expect(manager.ensurePreparedNewSessionOnDisk(prepared)).rejects.toThrow(
				"Prepared session persistence and temporary-file cleanup both failed",
			);
			if (descriptor === undefined || !tempPath) throw new Error("Missing real retained prepared writer");
			expect(syncFs.fstatSync(descriptor).isFile()).toBe(true);
			const tempBytes = await Bun.file(tempPath).text();
			const attemptsBefore = closeAttempts;
			const writesBefore = writerSpy.mock.calls.length;
			const namesBefore = await fs.readdir(path.dirname(source));
			expect((await manager.closeStrict()).kind).toBe("close_unknown");
			expect(closeAttempts).toBe(attemptsBefore + 1);
			expect(syncFs.fstatSync(descriptor).isFile()).toBe(true);
			allowClose = true;
			expect((await manager.closeStrict()).kind).toBe("close_unknown");
			expect(closeAttempts).toBe(attemptsBefore + 2);
			expect(() => syncFs.fstatSync(descriptor!)).toThrow();
			expect((await manager.closeStrict()).kind).toBe("close_unknown");
			expect(closeAttempts).toBe(attemptsBefore + 2);
			expect(unknownDispatches).toBe(1);
			expect(writerSpy.mock.calls.length).toBe(writesBefore);
			expect(await fs.readdir(path.dirname(source))).toEqual(namesBefore);
			expect(await Bun.file(tempPath).text()).toBe(tempBytes);
			expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
			expect(await Bun.file(source).text()).toBe(sourceBytes);
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		} finally {
			allowClose = true;
			await manager.closeStrict();
			writerSpy.mockRestore();
		}
	});

	it("drains a second staged endpoint despite an earlier unknown close", async () => {
		const { manager } = await managedProofFixture();
		const open = FileSessionStorage.prototype.openStagedWriter;
		let index = 0;
		let secondCloses = 0;
		let retry = false;
		const spy = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
			this: FileSessionStorage,
			file,
			options,
		) {
			const ordinal = index++;
			return open.call(this, file, {
				...options,
				closeAdapter: {
					close(fd) {
						if (ordinal === 0) {
							syncFs.closeSync(fd);
							throw new Error("unknown first close");
						}
						secondCloses++;
						if (!retry) throw new SessionStorageWriterRetryableCloseError();
						syncFs.closeSync(fd);
					},
				},
			});
		});
		try {
			await expect(manager.fork()).rejects.toBeInstanceOf(SessionManagerCleanupOwnershipError);
			await expect(manager.fork()).rejects.toBeInstanceOf(SessionManagerCleanupOwnershipError);
		} finally {
			spy.mockRestore();
		}
		const before = secondCloses;
		retry = true;
		expect((await manager.closeStrict()).kind).toBe("close_unknown");
		expect(secondCloses).toBe(before + 1);
		expect((await manager.closeStrict()).kind).toBe("close_unknown");
		expect(secondCloses).toBe(before + 1);
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		managers.splice(managers.indexOf(manager), 1);
	});

	for (const fault of ["cleanup", "terminal"] as const) {
		it(`retains explicit artifact publication debt (${fault})`, async () => {
			const { root } = await fixture(false);
			const manager = SessionManager.create(root, path.join(root, "sessions"));
			manager.appendMessage({ role: "user", content: "source", timestamp: 1 });
			await manager.ensureOnDisk();
			const source = manager.getSessionFile()!;
			await fs.mkdir(source.slice(0, -6), { recursive: true });
			await Bun.write(path.join(source.slice(0, -6), "payload"), "owned");
			const destination = path.join(path.dirname(source), "copy.jsonl");
			const natives = require("@gajae-code/natives") as typeof native;
			const capture = natives.snapshotDirectoryTree;
			const snapshotSpy = vi.spyOn(natives, "snapshotDirectoryTree").mockImplementation(directory => {
				if (fault === "terminal" && directory === destination.slice(0, -6)) throw new Error("terminal rejected");
				return capture(directory);
			});
			const cp =
				fault === "cleanup"
					? vi.spyOn(syncFs.promises, "cp").mockRejectedValue(new Error("copy rejected"))
					: undefined;
			const remove =
				fault === "cleanup"
					? vi.spyOn(natives, "exactRemoveDirectoryTree").mockReturnValue({ ok: false, code: "source_changed" })
					: undefined;
			try {
				await expect(manager.copyArtifactsForFork(source, destination)).rejects.toThrow();
			} finally {
				cp?.mockRestore();
				remove?.mockRestore();
				snapshotSpy.mockRestore();
			}
			expect((await manager.closeStrict()).kind).toBe("close_unknown");
			await expect(manager.close()).rejects.toThrow("Fork rollback cleanup is unconfirmed");
		});
	}

	for (const target of ["managed", "existing-explicit", "published-private"] as const) {
		it(`retains factory publication after post-ack source rejection (${target})`, async () => {
			const { root, source } = await fixture(false);
			const destination =
				target === "managed"
					? SessionManager.managedDestination(root, path.join(root, "agent"))
					: path.join(root, "fork-target");
			if (target === "existing-explicit") await fs.mkdir(path.join(root, "fork-target"));
			const captured = SessionManager.captureTranscriptStrict(source);
			if (captured.kind !== "captured") throw new Error("Missing capture");
			let publishedPath: string | undefined;
			const open = FileSessionStorage.prototype.openStagedWriter;
			const openSpy = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
				this: FileSessionStorage,
				destinationPath,
				options,
			) {
				const writer = open.call(this, destinationPath, options);
				const publish = writer.publishNoReplace.bind(writer);
				writer.publishNoReplace = () => {
					const receipt = publish();
					publishedPath = destinationPath;
					return receipt;
				};
				return writer;
			});
			const revalidate = captured.snapshot.revalidate.bind(captured.snapshot);
			const validation = vi.spyOn(captured.snapshot, "revalidate").mockImplementation(() => {
				const finalRootExists = syncFs.existsSync(path.join(root, "fork-target"));
				if (publishedPath && (target !== "published-private" || finalRootExists))
					return { kind: "error", reason: "identity-mismatch" };
				return revalidate();
			});
			try {
				let failure: unknown;
				try {
					await SessionManager.forkFromCaptured(captured.snapshot, root, destination, "copy-retain", "off");
				} catch (error) {
					failure = error;
				}
				expect(failure).toBeInstanceOf(SessionManagerCleanupOwnershipError);
				if (!(failure instanceof SessionManagerCleanupOwnershipError))
					throw new Error("Lost published factory owner");
				expect(failure.cause).toBeInstanceOf(Error);
				if (!publishedPath) throw new Error("Missing actual publication");
				const finalPath =
					target === "published-private"
						? path.join(root, "fork-target", path.basename(publishedPath))
						: publishedPath;
				expect(await Bun.file(finalPath).exists()).toBe(true);
				expect((await failure.getCleanup().join()).kind).toBe("close_unknown");
				expect((await failure.getCleanup().join()).kind).toBe("close_unknown");
				expect(await Bun.file(finalPath).exists()).toBe(true);
			} finally {
				validation.mockRestore();
				openSpy.mockRestore();
				captured.snapshot.close();
			}
		});
	}

	for (const fault of ["snapshot", "constructor", "cleanup_pending"] as const) {
		it(`retains explicit factory root uncertainty (${fault})`, async () => {
			const { root, source } = await fixture(false);
			const captured = SessionManager.captureTranscriptStrict(source);
			if (captured.kind !== "captured") throw new Error("Missing capture");
			const natives = require("@gajae-code/natives") as typeof native;
			const snapshotTree = natives.snapshotDirectoryTree;
			const ensure = FileSessionStorage.prototype.ensureDirSync;
			let ownedRoot: string | undefined;
			const snapshotSpy = vi.spyOn(natives, "snapshotDirectoryTree").mockImplementation(directory => {
				if (directory.includes(".fork-staging-")) {
					ownedRoot = directory;
					if (fault === "snapshot") throw new Error("initial snapshot rejected");
				}
				return snapshotTree(directory);
			});
			const ensureSpy = vi.spyOn(FileSessionStorage.prototype, "ensureDirSync").mockImplementation(function (
				this: FileSessionStorage,
				directory,
			) {
				if (fault === "constructor" && directory.includes(".fork-staging-")) {
					ownedRoot = directory;
					throw new Error("constructor rejected");
				}
				return ensure.call(this, directory);
			});
			const receipt = { ok: false, code: "cleanup_pending", recoveryPath: path.join(root, "retained-quarantine") };
			const remove = vi.spyOn(natives, "exactRemoveDirectoryTree").mockReturnValue(receipt);
			const open =
				fault === "cleanup_pending"
					? vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(() => {
							throw new Error("publication preflight rejected");
						})
					: undefined;
			try {
				let failure: unknown;
				try {
					await SessionManager.forkFromCaptured(
						captured.snapshot,
						root,
						path.join(root, "missing-destination"),
						"copy-retain",
						"off",
					);
				} catch (error) {
					failure = error;
				}
				expect(failure).toBeInstanceOf(SessionManagerCleanupOwnershipError);
				if (!(failure instanceof SessionManagerCleanupOwnershipError)) throw new Error("Lost root ownership");
				if (!ownedRoot) throw new Error("Missing actual created root");
				expect((await fs.stat(ownedRoot)).isDirectory()).toBe(true);
				const result = await failure.getCleanup().join();
				expect(result.kind).toBe("close_unknown");
				if (fault === "cleanup_pending" && result.kind === "close_unknown")
					expect(result.error.cause).toBe(receipt);
				const calls = remove.mock.calls.length;
				expect((await failure.getCleanup().join()).kind).toBe("close_unknown");
				expect(remove.mock.calls.length).toBe(calls);
			} finally {
				open?.mockRestore();
				remove.mockRestore();
				ensureSpy.mockRestore();
				snapshotSpy.mockRestore();
				captured.snapshot.close();
			}
		});
	}

	for (const failure of ["retryable", "unknown", "fsync"] as const) {
		it(`retains exact staged writer cleanup after ${failure}`, async () => {
			const { manager, file } = await managedProofFixture();
			const before = await Bun.file(file).text();
			const open = FileSessionStorage.prototype.openStagedWriter;
			let dispatches = 0;
			let allowClose = false;
			const stagedOpen = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
				this: FileSessionStorage,
				destination,
				options,
			) {
				const writer = open.call(this, destination, {
					...options,
					closeAdapter: {
						close(fd) {
							dispatches++;
							if (failure === "retryable" && !allowClose) throw new SessionStorageWriterRetryableCloseError();
							syncFs.closeSync(fd);
							if (failure === "unknown") throw new Error("dispatched staged close uncertain");
						},
					},
				});
				if (failure === "fsync") {
					const fsync = writer.fsync.bind(writer);
					writer.fsync = () => {
						const sync = vi.spyOn(syncFs, "fsyncSync").mockImplementationOnce(() => {
							throw new Error("staged fsync failed");
						});
						try {
							fsync();
						} finally {
							sync.mockRestore();
						}
					};
				}
				return writer;
			});
			let failureError: unknown;
			try {
				await manager.fork();
			} catch (error) {
				failureError = error;
			} finally {
				stagedOpen.mockRestore();
			}
			expect(failureError).toBeInstanceOf(SessionManagerCleanupOwnershipError);
			if (!(failureError instanceof SessionManagerCleanupOwnershipError))
				throw new Error("Missing retained cleanup capability");
			expect(manager.getSessionFile()).toBe(file);
			expect(await Bun.file(file).text()).toBe(before);
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
			if (failure === "retryable") {
				expect((await failureError.getCleanup().join()).kind).toBe("close_failed_retryable");
				allowClose = true;
			}
			const outcome = await failureError.getCleanup().join();
			if (failure === "unknown") {
				expect(outcome.kind).toBe("close_unknown");
				const attempted = dispatches;
				expect((await failureError.getCleanup().join()).kind).toBe("close_unknown");
				expect(dispatches).toBe(attempted);
				expect(() => manager.captureClosedManagedTranscriptProof()).toThrow(
					"closed_managed_transcript_not_confirmed",
				);
				managers.splice(managers.indexOf(manager), 1);
			} else {
				expect(outcome.kind).toBe("closed");
				expect((await fs.readdir(path.dirname(file))).some(name => name.endsWith(".staged"))).toBe(false);
				const proof = manager.captureClosedManagedTranscriptProof();
				expect(proof.revalidate()).toEqual({ kind: "valid" });
				proof.close();
			}
		});
	}

	it("static captured fork failure exposes only retained cleanup capability", async () => {
		const { root, source } = await fixture(false);
		const captured = SessionManager.captureTranscriptStrict(source);
		if (captured.kind !== "captured") throw new Error("Missing source capture");
		const open = FileSessionStorage.prototype.openStagedWriter;
		let allowClose = false;
		const stagedOpen = vi.spyOn(FileSessionStorage.prototype, "openStagedWriter").mockImplementation(function (
			this: FileSessionStorage,
			destination,
			options,
		) {
			return open.call(this, destination, {
				...options,
				closeAdapter: {
					close(fd) {
						if (!allowClose) throw new SessionStorageWriterRetryableCloseError();
						syncFs.closeSync(fd);
					},
				},
			});
		});
		let failure: unknown;
		try {
			await SessionManager.forkFromCaptured(
				captured.snapshot,
				root,
				SessionManager.managedDestination(root, path.join(root, "agent")),
				"copy-retain",
				"off",
			);
		} catch (error) {
			failure = error;
		} finally {
			stagedOpen.mockRestore();
			captured.snapshot.close();
		}
		expect(failure).toBeInstanceOf(SessionManagerCleanupOwnershipError);
		if (!(failure instanceof SessionManagerCleanupOwnershipError)) throw new Error("Missing factory cleanup owner");
		const cleanup = failure.getCleanup();
		expect(Object.keys(cleanup)).toEqual(["join"]);
		expect(Object.isFrozen(cleanup)).toBe(true);
		expect((await cleanup.join()).kind).toBe("close_failed_retryable");
		allowClose = true;
		expect((await cleanup.join()).kind).toBe("closed");
		expect(await Bun.file(source).exists()).toBe(true);
	});

	for (const failCleanup of [false, true]) {
		it(`retains failed managed transcript rollback without poisoning proven rollback (${failCleanup})`, async () => {
			const { manager, file } = await managedProofFixture();
			const prior = SessionManagerTestHooks.afterForkTranscriptPublished;
			SessionManagerTestHooks.afterForkTranscriptPublished = () => {
				throw new Error("publication rejected");
			};
			const remove = failCleanup
				? vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpected").mockImplementation(() => {
						throw new Error("remove blocked");
					})
				: undefined;
			try {
				await expect(manager.fork()).rejects.toThrow(
					failCleanup ? "Failed to clean up fork publication" : "publication rejected",
				);
				expect(manager.getSessionFile()).toBe(file);
			} finally {
				remove?.mockRestore();
				SessionManagerTestHooks.afterForkTranscriptPublished = prior;
			}
			if (failCleanup) {
				managers.splice(managers.indexOf(manager), 1);
				expect((await manager.closeStrict()).kind).toBe("close_unknown");
				expect(() => manager.captureClosedManagedTranscriptProof()).toThrow(
					"closed_managed_transcript_not_confirmed",
				);
				expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith(".jsonl")).length).toBe(2);
				await expect(manager.close()).rejects.toThrow("Fork rollback cleanup is unconfirmed");
			} else {
				expect((await manager.closeStrict()).kind).toBe("closed");
				const proof = manager.captureClosedManagedTranscriptProof();
				expect(proof.revalidate()).toEqual({ kind: "valid" });
				proof.close();
			}
		});
	}

	for (const failure of ["source-capture", "staging-capture", "post-creation"] as const) {
		it(`retains only mutating staging uncertainty (${failure})`, async () => {
			const { manager, file } = await managedProofFixture();
			const sourceName = path.basename(file.slice(0, -6));
			await fs.mkdir(file.slice(0, -6), { recursive: true, mode: 0o700 });
			const capture = ManagedSessionDescendantStore.prototype.captureTree;
			const ensure = ManagedSessionDescendantStore.prototype.ensureDirectory;
			let sourceCaptured = false;
			let attemptedStage: string | undefined;
			const captureSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "captureTree")
				.mockImplementation(function (this: ManagedSessionDescendantStore, relativePath) {
					if (relativePath === sourceName) {
						if (failure === "source-capture") throw new Error("source capture rejected");
						const snapshot = capture.call(this, relativePath);
						sourceCaptured = true;
						return snapshot;
					}
					if (relativePath.endsWith(".fork-staging") && failure === "staging-capture")
						throw new Error("staging capture rejected");
					return capture.call(this, relativePath);
				});
			const ensureSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "ensureDirectory")
				.mockImplementation(function (this: ManagedSessionDescendantStore, relativePath = "") {
					const identity = ensure.call(this, relativePath);
					if (relativePath.endsWith(".fork-staging")) {
						attemptedStage = relativePath;
						if (failure === "post-creation") throw new Error("post creation rejected");
					}
					return identity;
				});
			const removeSpy = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
			try {
				await expect(manager.fork()).rejects.toThrow("rejected");
				expect(removeSpy).not.toHaveBeenCalled();
			} finally {
				captureSpy.mockRestore();
				ensureSpy.mockRestore();
				removeSpy.mockRestore();
				if (attemptedStage) managers.splice(managers.indexOf(manager), 1);
			}
			if (failure === "source-capture") {
				expect(attemptedStage).toBeUndefined();
				expect((await manager.closeStrict()).kind).toBe("closed");
				const proof = manager.captureClosedManagedTranscriptProof();
				expect(proof.revalidate()).toEqual({ kind: "valid" });
				proof.close();
			} else {
				expect(sourceCaptured).toBe(true);
				if (!attemptedStage) throw new Error("Missing actual staging creation");
				expect((await fs.stat(path.join(path.dirname(file), attemptedStage))).isDirectory()).toBe(true);
				expect((await manager.closeStrict()).kind).toBe("close_unknown");
				expect(() => manager.captureClosedManagedTranscriptProof()).toThrow(
					"closed_managed_transcript_not_confirmed",
				);
				await expect(manager.close()).rejects.toThrow("Fork rollback cleanup is unconfirmed");
			}
		});
	}

	it("retains managed artifact staging cleanup failure", async () => {
		const { manager, file } = await managedProofFixture();
		const artifactDir = file.slice(0, -6);
		await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
		await Bun.write(path.join(artifactDir, "payload"), "artifact bytes");
		await fs.chmod(path.join(artifactDir, "payload"), 0o600);
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockRejectedValue(new Error("artifact publication rejected"));
		const remove = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected").mockImplementation(() => {
			throw new Error("staging removal blocked");
		});
		try {
			await expect(manager.fork()).rejects.toThrow("Failed to clean up managed fork artifacts");
		} finally {
			publish.mockRestore();
			remove.mockRestore();
		}
		managers.splice(managers.indexOf(manager), 1);
		expect((await fs.readdir(path.dirname(file))).some(name => name.endsWith(".fork-staging"))).toBe(true);
		expect((await manager.closeStrict()).kind).toBe("close_unknown");
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		await expect(manager.close()).rejects.toThrow("Fork rollback cleanup is unconfirmed");
	});
	it("refuses live managers and legacy closure without strict evidence", async () => {
		const { manager } = await managedProofFixture();
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		await manager.close();
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
	});

	it("refuses non-persistent, explicit-storage, and unpublished managers", async () => {
		const { root } = await fixture();
		const memory = SessionManager.inMemory(root);
		const explicit = SessionManager.create(root, path.join(root, "explicit"), new FileSessionStorage());
		const unpublished = SessionManager.create(
			root,
			SessionManager.managedDestination(root, path.join(root, "agent")),
		);
		explicit.appendMessage({ role: "user", content: "explicit", timestamp: 1 });
		await explicit.ensureOnDisk();
		for (const manager of [memory, explicit, unpublished]) {
			managers.push(manager);
			expect((await manager.closeStrict()).kind).toBe("closed");
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_unavailable");
		}
	});

	it("issues only immutable authentic proofs and invalidates them on idempotent close", async () => {
		const { manager, file } = await managedProofFixture();
		expect((await manager.closeStrict()).kind).toBe("closed");
		await expect(manager.prepareFork()).rejects.toThrow("Session manager is closing.");
		const proof = manager.captureClosedManagedTranscriptProof();
		try {
			expect(isClosedManagedTranscriptProof(proof)).toBe(true);
			expect(Object.isFrozen(proof)).toBe(true);
			expect(Object.isFrozen(proof.identity)).toBe(true);
			expect(Object.keys(proof).sort()).toEqual(["close", "identity", "revalidate"]);
			expect(proof.identity.sessionId).toBe(manager.getSessionId());
			expect(proof.identity.canonicalPath).toBe(await fs.realpath(file));
			expect(proof.revalidate()).toEqual({ kind: "valid" });
			const serialized = JSON.parse(
				JSON.stringify(proof, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
			);
			for (const spoof of [null, {}, { ...proof }, serialized, Object.create(proof), new Proxy(proof, {})])
				expect(isClosedManagedTranscriptProof(spoof)).toBe(false);
		} finally {
			proof.close();
		}
		proof.close();
		expect(isClosedManagedTranscriptProof(proof)).toBe(false);
		expect(proof.revalidate()).toEqual({ kind: "error", reason: "identity-mismatch" });
	});

	for (const operation of ["append", "rewrite"] as const) {
		it(`certifies the final synchronized physical identity after an owned ${operation}`, async () => {
			const { manager, file } = await managedProofFixture();
			const before = await fs.stat(file, { bigint: true });
			if (operation === "append") {
				manager.appendMessage({ role: "user", content: "owned append", timestamp: 2 });
			} else {
				const id = manager.appendCustomMessageEntry("proof", "before rewrite", true);
				const entry = manager.getBranch().find(candidate => candidate.id === id);
				if (entry?.type !== "custom_message") throw new Error("Missing custom message");
				manager.applyCustomMessageEntryUpdates([{ ...entry, content: "after rewrite" }]);
			}
			expect((await manager.closeStrict()).kind).toBe("closed");
			const after = await fs.stat(file, { bigint: true });
			const proof = manager.captureClosedManagedTranscriptProof();
			try {
				expect(proof.identity).toMatchObject({
					dev: after.dev,
					ino: after.ino,
					nlink: after.nlink,
					size: Number(after.size),
					mtimeNs: after.mtimeNs,
					ctimeNs: after.ctimeNs,
				});
				expect(after.size).toBeGreaterThan(before.size);
				if (operation === "rewrite") {
					expect(after.ino).not.toBe(before.ino);
					expect(await Bun.file(file).text()).toContain("after rewrite");
				}
				expect(proof.revalidate()).toEqual({ kind: "valid" });
			} finally {
				proof.close();
			}
		});
	}

	for (const operation of ["replacement", "mutation"] as const) {
		it(`rejects ${operation} after closure both at capture and retained-descriptor revalidation`, async () => {
			const { manager, file } = await managedProofFixture();
			expect((await manager.closeStrict()).kind).toBe("closed");
			const proof = manager.captureClosedManagedTranscriptProof();
			try {
				const bytes = await Bun.file(file).text();
				if (operation === "replacement") {
					const replacement = `${file}.replacement`;
					await Bun.write(replacement, bytes);
					await fs.rename(replacement, file);
				} else {
					const handle = await fs.open(file, "r+");
					try {
						const offset = bytes.indexOf("owned history");
						expect(offset).toBeGreaterThan(0);
						await handle.write("other history", offset, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
				}
				expect(() => manager.captureClosedManagedTranscriptProof()).toThrow(
					"closed_managed_transcript_identity_mismatch",
				);
				expect(proof.revalidate()).toEqual({ kind: "error", reason: "identity-mismatch" });
			} finally {
				proof.close();
			}
		});
	}

	it("joins in-flight fork preparation before issuing terminal proof", async () => {
		const { manager } = await managedProofFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const copy = manager.copyArtifactsForFork.bind(manager);
		const blockedCopy = vi.spyOn(manager, "copyArtifactsForFork").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return copy(...args);
		});
		const preparation = manager.prepareFork();
		await entered.promise;
		let closed = false;
		const closing = manager.closeStrict().then(outcome => {
			closed = true;
			return outcome;
		});
		try {
			await Bun.sleep(30);
			expect(closed).toBe(false);
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
			release.resolve();
			const prepared = await preparation;
			if (!prepared) throw new Error("Missing prepared fork");
			expect(await closing).toEqual({ kind: "closed" });
			expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
			const proof = manager.captureClosedManagedTranscriptProof();
			proof.close();
		} finally {
			release.resolve();
			await preparation.catch(() => {});
			await closing.catch(() => {});
			blockedCopy.mockRestore();
		}
	});

	it("joins already-running staged cleanup before terminal closure", async () => {
		const { manager } = await managedProofFixture();
		const prepared = await manager.prepareFork();
		if (!prepared) throw new Error("Missing prepared fork");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const discard = manager.discardUncommittedSession.bind(manager);
		let calls = 0;
		const blockedDiscard = vi.spyOn(manager, "discardUncommittedSession").mockImplementation(async file => {
			if (++calls === 1) {
				entered.resolve();
				await release.promise;
			}
			await discard(file);
		});
		const discarding = manager.discardPreparedNewSession(prepared);
		await entered.promise;
		let closed = false;
		const closing = manager.closeStrict().then(outcome => {
			closed = true;
			return outcome;
		});
		try {
			await Bun.sleep(30);
			expect(closed).toBe(false);
			release.resolve();
			await discarding;
			expect(await closing).toEqual({ kind: "closed" });
			expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
		} finally {
			release.resolve();
			await discarding.catch(() => {});
			await closing.catch(() => {});
			blockedDiscard.mockRestore();
		}
	});

	it("cleanup authority cannot admit publication or commit during strict close", async () => {
		const { manager } = await managedProofFixture();
		const prepared = await manager.prepareFork();
		if (!prepared) throw new Error("Missing prepared fork");
		const discard = manager.discardUncommittedSession.bind(manager);
		let checked = false;
		const guarded = vi.spyOn(manager, "discardUncommittedSession").mockImplementation(async file => {
			await expect(manager.prepareNewSession()).rejects.toThrow("Session manager is closing.");
			await expect(manager.newSession()).rejects.toThrow("Session manager is closing.");
			await expect(manager.ensurePreparedNewSessionOnDisk(prepared)).rejects.toThrow("Session manager is closing.");
			expect(() => manager.commitPreparedNewSession(prepared)).toThrow("Session manager is closing.");
			checked = true;
			await discard(file);
		});
		try {
			expect(await manager.closeStrict()).toEqual({ kind: "closed" });
			expect(checked).toBe(true);
			expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
		} finally {
			guarded.mockRestore();
		}
	});

	it("rejects cleanup self-join without manufacturing terminal proof", async () => {
		const { manager } = await managedProofFixture();
		const prepared = await manager.prepareFork();
		if (!prepared) throw new Error("Missing prepared fork");
		const discard = manager.discardUncommittedSession.bind(manager);
		const guarded = vi.spyOn(manager, "discardUncommittedSession").mockImplementation(async file => {
			await expect(manager.closeStrict()).rejects.toThrow("session_preparation_close_self_join");
			await discard(file);
		});
		try {
			await manager.discardPreparedNewSession(prepared);
		} finally {
			guarded.mockRestore();
		}
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
		expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
	});

	it("retains newSession through commit after its admitted preparation returns", async () => {
		const { manager } = await managedProofFixture();
		const prepare = manager.prepareNewSession.bind(manager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocked = vi.spyOn(manager, "prepareNewSession").mockImplementation(async options => {
			const prepared = await prepare(options);
			entered.resolve();
			await release.promise;
			return prepared;
		});
		const switching = manager.newSession({ identityAllocation: { sessionId: "admitted.switch" } });
		await entered.promise;
		const closing = manager.closeStrict();
		try {
			release.resolve();
			await switching;
			expect(await closing).toEqual({ kind: "closed" });
			expect(manager.getSessionId()).toBe("admitted.switch");
		} finally {
			release.resolve();
			await switching.catch(() => {});
			await closing.catch(() => {});
			blocked.mockRestore();
		}
	});

	it("rejects every fresh preparation entrypoint after strict close", async () => {
		const { manager, file } = await managedProofFixture();
		const prepared = await manager.prepareNewSession();
		const before = await Bun.file(file).text();
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
		for (const operation of [
			() => manager.prepareNewSession(),
			() => manager.prepareFork(),
			() => manager.prepareBranchedSession("missing"),
			() => manager.ensurePreparedNewSessionOnDisk(prepared),
			() => manager.fork(),
			() => manager.copyArtifactsForFork(file, `${file}.copy.jsonl`),
		])
			await expect(operation()).rejects.toThrow("Session manager is closing.");
		expect(await Bun.file(file).text()).toBe(before);
		const proof = manager.captureClosedManagedTranscriptProof();
		expect(proof.revalidate()).toEqual({ kind: "valid" });
		proof.close();
	});

	it("joins direct fork publication before certifying its adopted identity", async () => {
		const { manager, file } = await managedProofFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prior = SessionManagerTestHooks.afterForkTranscriptPublished;
		SessionManagerTestHooks.afterForkTranscriptPublished = async () => {
			entered.resolve();
			await release.promise;
		};
		const forking = manager.fork();
		await entered.promise;
		let closed = false;
		const closing = manager.closeStrict().then(outcome => {
			closed = true;
			return outcome;
		});
		try {
			await Bun.sleep(30);
			expect(closed).toBe(false);
			await expect(manager.prepareNewSession()).rejects.toThrow("Session manager is closing.");
			release.resolve();
			const forked = await forking;
			if (!forked) throw new Error("Missing direct fork");
			expect(await closing).toEqual({ kind: "closed" });
			expect(forked.oldSessionFile).toBe(file);
			expect(await Bun.file(forked.newSessionFile).exists()).toBe(true);
			const proof = manager.captureClosedManagedTranscriptProof();
			expect(proof.identity.canonicalPath).toBe(await fs.realpath(forked.newSessionFile));
			expect(proof.revalidate()).toEqual({ kind: "valid" });
			proof.close();
		} finally {
			release.resolve();
			await forking.catch(() => {});
			await closing.catch(() => {});
			SessionManagerTestHooks.afterForkTranscriptPublished = prior;
		}
	});

	it("retains an unawaited nested preparation after its direct fork parent returns", async () => {
		const { manager } = await managedProofFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const copy = manager.copyArtifactsForFork.bind(manager);
		let copies = 0;
		const blockedCopy = vi.spyOn(manager, "copyArtifactsForFork").mockImplementation(async (...args) => {
			if (++copies === 2) {
				entered.resolve();
				await release.promise;
			}
			return copy(...args);
		});
		const prior = SessionManagerTestHooks.afterForkTranscriptPublished;
		let descendant: Promise<unknown> | undefined;
		SessionManagerTestHooks.afterForkTranscriptPublished = () => {
			descendant = manager.prepareFork({ sessionId: "nested.retained" });
		};
		try {
			const forked = await manager.fork();
			if (!forked) throw new Error("Missing parent fork");
			await entered.promise;
			let closed = false;
			const closing = manager.closeStrict().then(outcome => {
				closed = true;
				return outcome;
			});
			try {
				await Bun.sleep(30);
				expect(closed).toBe(false);
				release.resolve();
				await descendant;
				expect(await closing).toEqual({ kind: "closed" });
				expect(
					(await fs.readdir(path.dirname(forked.newSessionFile))).some(name =>
						name.endsWith("_nested.retained.jsonl"),
					),
				).toBe(false);
			} finally {
				release.resolve();
				await descendant?.catch(() => {});
				await closing.catch(() => {});
			}
		} finally {
			release.resolve();
			await descendant?.catch(() => {});
			blockedCopy.mockRestore();
			SessionManagerTestHooks.afterForkTranscriptPublished = prior;
		}
	});

	it("joins prepared transcript publication admitted immediately before close", async () => {
		const { manager } = await managedProofFixture();
		const prepared = await manager.prepareNewSession({ identityAllocation: { sessionId: "publication.pending" } });
		manager.appendPreparedCustomMessageEntry(prepared, "publication", "retained content", true);
		const publishing = manager.ensurePreparedNewSessionOnDisk(prepared);
		const closing = manager.closeStrict();
		await publishing;
		expect(await closing).toEqual({ kind: "closed" });
		expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
		const proof = manager.captureClosedManagedTranscriptProof();
		expect(proof.revalidate()).toEqual({ kind: "valid" });
		proof.close();
	});

	it("reads reserved identity once before asynchronous preparation effects", async () => {
		const { manager } = await managedProofFixture();
		let reads = 0;
		const prepared = await manager.prepareNewSession({
			identityAllocation: {
				get sessionId() {
					return ++reads === 1 ? "reserved.once" : "../changed";
				},
			},
		});
		expect(reads).toBe(1);
		expect(prepared.sessionId).toBe("reserved.once");
		await manager.ensurePreparedNewSessionOnDisk(prepared);
		expect(JSON.parse((await Bun.file(prepared.sessionFile!).text()).split("\n")[0]).id).toBe("reserved.once");
		await manager.discardPreparedNewSession(prepared);
	});

	it("refuses retryable prepared cleanup until a real successful retry", async () => {
		const { manager } = await managedProofFixture();
		const prepared = await manager.prepareFork();
		if (!prepared) throw new Error("Missing prepared fork");
		const discard = vi
			.spyOn(manager, "discardUncommittedSession")
			.mockRejectedValueOnce(new Error("cleanup unavailable"));
		try {
			expect((await manager.closeStrict()).kind).toBe("close_failed_retryable");
			expect(await Bun.file(prepared.sessionFile!).exists()).toBe(true);
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		} finally {
			discard.mockRestore();
		}
		expect((await manager.closeStrict()).kind).toBe("closed");
		expect(await Bun.file(prepared.sessionFile!).exists()).toBe(false);
		const proof = manager.captureClosedManagedTranscriptProof();
		expect(proof.revalidate()).toEqual({ kind: "valid" });
		proof.close();
	});

	it("never certifies a thrown strict close even after a later successful close", async () => {
		const { manager } = await managedProofFixture();
		const join = vi.spyOn(manager, "joinCwdTransition").mockRejectedValueOnce(new Error("transition failed"));
		try {
			await expect(manager.closeStrict()).rejects.toThrow("transition failed");
			expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
		} finally {
			join.mockRestore();
		}
		expect((await manager.closeStrict()).kind).toBe("closed");
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
	});

	it("retains historical uncertainty after a flush failure even when a later strict close succeeds", async () => {
		const { manager } = await managedProofFixture();
		const flush = vi.spyOn(manager, "flush").mockRejectedValueOnce(new Error("flush unavailable"));
		try {
			expect((await manager.flushAndCloseStrict()).kind).toBe("close_unknown");
		} finally {
			flush.mockRestore();
		}
		expect((await manager.closeStrict()).kind).toBe("closed");
		expect(() => manager.captureClosedManagedTranscriptProof()).toThrow("closed_managed_transcript_not_confirmed");
	});
});

describe("reserved session identity", () => {
	for (const variant of ["fork", "branch"] as const) {
		for (const managed of [false, true]) {
			it(`preserves source and publishes reserved prepared ${variant} identity (managed=${managed})`, async () => {
				const { root } = await fixture();
				const destination = managed
					? SessionManager.managedDestination(root, path.join(root, "agent"))
					: path.join(root, "sessions");
				const manager = SessionManager.create(root, destination, undefined, { sessionId: "prepared.source" });
				managers.push(manager);
				const leafId = manager.appendMessage({ role: "user", content: "preserved history", timestamp: 1 });
				await manager.ensureOnDisk();
				const sourceFile = manager.getSessionFile()!;
				const sourceBytes = await Bun.file(sourceFile).text();
				const sourceHeader = structuredClone(manager.getHeader());
				const prepare = (sessionId?: string) => {
					const allocation = sessionId === undefined ? undefined : { sessionId };
					return variant === "fork"
						? manager.prepareFork(allocation)
						: manager.prepareBranchedSession(leafId, allocation);
				};
				const reserved = `reserved.${variant}`;
				const staged = await prepare(reserved);
				if (!staged) throw new Error("Missing prepared successor");
				expect(staged.sessionId).toBe(reserved);
				expect(staged.sessionFile).toEndWith(`_${reserved}.jsonl`);
				expect(JSON.parse((await Bun.file(staged.sessionFile!).text()).split("\n")[0]).id).toBe(reserved);
				expect(manager.getHeader()).toEqual(sourceHeader);
				expect(manager.getSessionFile()).toBe(sourceFile);
				expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
				await manager.discardPreparedNewSession(staged);
				expect(await Bun.file(staged.sessionFile!).exists()).toBe(false);
				expect(manager.getHeader()).toEqual(sourceHeader);
				expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
				const freshIds = new Set<string>();
				for (let attempt = 0; attempt < 2; attempt++) {
					const fresh = await prepare();
					if (!fresh) throw new Error("Missing fresh successor");
					freshIds.add(fresh.sessionId);
					await manager.discardPreparedNewSession(fresh);
				}
				expect(freshIds.size).toBe(2);
				expect(freshIds.has(reserved)).toBe(false);
				expect(freshIds.has("prepared.source")).toBe(false);
				const committed = await prepare(reserved);
				if (!committed) throw new Error("Missing commit successor");
				manager.commitPreparedNewSession(committed);
				expect(manager.getSessionId()).toBe(reserved);
				expect(manager.getHeader()?.id).toBe(reserved);
				expect(manager.getSessionFile()).toBe(committed.sessionFile);
				expect(await Bun.file(sourceFile).text()).toBe(sourceBytes);
			});
		}

		it(`rejects invalid and source allocations before touching the prepared ${variant} source writer`, async () => {
			const { root } = await fixture();
			const storage = new FileSessionStorage();
			const open = vi.spyOn(storage, "openWriter");
			try {
				const manager = SessionManager.create(root, path.join(root, "sessions"), storage, {
					sessionId: "prepared.source",
				});
				managers.push(manager);
				const leafId = manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
				await manager.ensureOnDisk();
				manager.appendMessage({ role: "user", content: "keep writer open", timestamp: 2 });
				const writers = open.mock.results.filter(result => result.type === "return").map(result => result.value);
				expect(writers.length).toBeGreaterThan(0);
				const closes = writers.map(writer => vi.spyOn(writer, "close"));
				const openCount = open.mock.calls.length;
				const sourceFile = manager.getSessionFile()!;
				const bytes = await Bun.file(sourceFile).text();
				const header = structuredClone(manager.getHeader());
				try {
					for (const sessionId of ["", "../escape", "bad\n", "prepared.source"]) {
						const pending =
							variant === "fork"
								? manager.prepareFork({ sessionId })
								: manager.prepareBranchedSession(leafId, { sessionId });
						await expect(pending).rejects.toThrow(
							sessionId === "prepared.source"
								? "Reserved session id must differ from source session id"
								: "Invalid reserved session id",
						);
						expect(open.mock.calls.length).toBe(openCount);
						for (const close of closes) expect(close).not.toHaveBeenCalled();
						expect(manager.getHeader()).toEqual(header);
						expect(manager.getSessionFile()).toBe(sourceFile);
						expect(await Bun.file(sourceFile).text()).toBe(bytes);
					}
				} finally {
					for (const close of closes) close.mockRestore();
				}
			} finally {
				open.mockRestore();
			}
		});
	}

	it("uses explicit identity for creation, memory, and prepared successors", async () => {
		const { root } = await fixture();
		const manager = SessionManager.create(root, path.join(root, "sessions"), undefined, {
			sessionId: "reserved.create",
		});
		managers.push(manager);
		expect(manager.getSessionId()).toBe("reserved.create");
		const memory = SessionManager.inMemory(root, undefined, { sessionId: "reserved.memory" });
		managers.push(memory);
		expect(memory.getSessionId()).toBe("reserved.memory");
		const prepared = await manager.prepareNewSession({
			parentSession: "reserved.create",
			identityAllocation: { sessionId: "reserved.next" },
		});
		expect(manager.getSessionId()).toBe("reserved.create");
		expect(prepared.sessionId).toBe("reserved.next");
		manager.commitPreparedNewSession(prepared);
		expect(manager.getHeader()).toMatchObject({ id: "reserved.next", parentSession: "reserved.create" });
		await memory.newSession({ identityAllocation: { sessionId: "reserved.new" } });
		expect(memory.getSessionId()).toBe("reserved.new");
	});

	it("uses the reserved identity for an unpublished staged task", async () => {
		const { root } = await fixture();
		const finalFile = path.join(root, "task.jsonl");
		const staged = await SessionManager.openStaged(finalFile, undefined, "attempt", { sessionId: "reserved.task" });
		try {
			expect(staged.getSessionId()).toBe("reserved.task");
			expect(await Bun.file(finalFile).exists()).toBe(false);
		} finally {
			await staged.discardStaged();
			await staged.close();
		}
	});

	for (const mode of ["off", "enabled"] as const) {
		for (const compacted of [true, false]) {
			it(`preserves reserved fork identity and source (${mode}, compacted=${compacted})`, async () => {
				const { root, source, bytes } = await fixture(compacted);
				const destination = path.join(root, "forks");
				await fs.mkdir(destination);
				const capture = SessionManager.captureTranscriptStrict(source);
				if (capture.kind !== "captured") throw new Error(`Capture failed: ${capture.reason}`);
				const result = await SessionManager.forkFromCaptured(
					capture.snapshot,
					root,
					destination,
					"copy-retain",
					mode,
					{ sessionId: "reserved.fork" },
				);
				if (result.kind !== "forked") throw new Error(`Fork failed: ${result.reason}`);
				managers.push(result.manager);
				expect(result.manager.getHeader()).toMatchObject({ id: "reserved.fork", parentSession: "source" });
				const file = result.manager.getSessionFile()!;
				await result.manager.close();
				const inspection = await SessionManager.inspectSessionTailReadOnly(file);
				if (inspection.kind === "error") throw new Error(`Inspection failed: ${inspection.reason}`);
				const reopened = await SessionManager.openExistingStrict(inspection.identity, destination);
				if (reopened.kind !== "opened") throw new Error(`Reopen failed: ${reopened.reason}`);
				managers.push(reopened.manager);
				expect(reopened.manager.getHeader()).toMatchObject({ id: "reserved.fork", parentSession: "source" });
				const ids = new Set<string>();
				for (let attempt = 0; attempt < 2; attempt++) {
					const fork = await SessionManager.forkFromCaptured(
						capture.snapshot,
						root,
						destination,
						"copy-retain",
						mode,
					);
					if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
					managers.push(fork.manager);
					ids.add(fork.manager.getSessionId());
				}
				expect(ids.size).toBe(2);
				expect(ids.has("reserved.fork")).toBe(false);
				expect(await Bun.file(source).text()).toBe(bytes);
			});
		}
	}

	it("rejects invalid allocations before creating destinations or writing breadcrumbs", async () => {
		const { root, source } = await fixture();
		const capture = SessionManager.captureTranscriptStrict(source);
		if (capture.kind !== "captured") throw new Error(`Capture failed: ${capture.reason}`);
		const storage = new FileSessionStorage();
		for (const sessionId of ["", "../escape", "a/b", " white ", "x".repeat(129), "bad\n"]) {
			const destination = path.join(root, "never-created");
			const allocation = { sessionId };
			expect(() => SessionManager.create(root, destination, storage, allocation)).toThrow(
				"Invalid reserved session id",
			);
			expect(() => SessionManager.inMemory(root, undefined, allocation)).toThrow("Invalid reserved session id");
			await expect(
				SessionManager.openStaged(path.join(destination, "task.jsonl"), storage, "attempt", allocation),
			).rejects.toThrow("Invalid reserved session id");
			await expect(
				SessionManager.forkFromCaptured(capture.snapshot, root, destination, "copy-retain", "enabled", allocation),
			).rejects.toThrow("Invalid reserved session id");
			expect(await fs.readdir(root)).toEqual(["source.jsonl"]);
		}
	});

	it("keeps lifecycle adoption consume-once and independent of explicit allocations", async () => {
		const { root } = await fixture();
		const modulePath = path.resolve(import.meta.dir, "../src/session/session-manager.ts");
		const script = `import { SessionManager } from ${JSON.stringify(modulePath)};
const explicit = SessionManager.inMemory(${JSON.stringify(root)}, undefined, { sessionId: "explicit" });
if (explicit.getSessionId() !== "explicit") throw Error("explicit ignored");
await explicit.newSession({ identityAllocation: { sessionId: "lifecycle-child" } });
await explicit.newSession();
if (explicit.getSessionId() !== "lifecycle-child") throw Error("explicit consumed lifecycle adoption");
await explicit.newSession();
if (explicit.getSessionId() === "lifecycle-child") throw Error("lifecycle adopted twice");
const ordinary = SessionManager.inMemory(${JSON.stringify(root)});
if (ordinary.getSessionId() !== "lifecycle-child") throw Error("default adoption changed");
await ordinary.close(); await explicit.close();`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			env: { ...process.env, GJC_LIFECYCLE_REQUEST_ID: "reservation-test", GJC_SESSION_ID: "lifecycle-child" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
	});
});
