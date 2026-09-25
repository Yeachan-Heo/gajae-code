import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { auditPath, transactionJournalPath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	appendAuditEntry,
	appendJsonl,
	appendJsonlIdempotent,
	appendText,
	beginWorkflowTransactionJournal,
	createJsonNoClobber,
	updateWorkflowTransactionJournal,
	withWorkflowStateLock,
	writeArtifact,
	writeJsonAtomic,
} from "@gajae-code/coding-agent/gjc-runtime/state-writer";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-writer-permissions-"));
	tempRoots.push(dir);
	return dir;
}

async function modeOf(filePath: string): Promise<number> {
	return (await fs.stat(filePath)).mode & 0o777;
}

async function preparePrivateParent(root: string, directory: string): Promise<void> {
	const gjcRoot = path.join(root, ".gjc");
	await fs.mkdir(gjcRoot, { recursive: true });
	let current = gjcRoot;
	await fs.chmod(current, 0o700);
	for (const segment of path.relative(gjcRoot, directory).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		await fs.mkdir(current, { recursive: true });
		await fs.chmod(current, 0o700);
	}
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("state-writer private permissions", () => {
	it("creates owner-only directories and files under a permissive umask", async () => {
		const previousUmask = process.umask(0o002);
		try {
			const root = await tempDir();
			const target = ".gjc/_session-permissions/state/deep/nested.json";
			await writeJsonAtomic(target, { secret: true }, { cwd: root });

			expect(await modeOf(path.join(root, ".gjc"))).toBe(0o700);
			expect(await modeOf(path.join(root, ".gjc", "_session-permissions"))).toBe(0o700);
			expect(await modeOf(path.join(root, ".gjc", "_session-permissions", "state"))).toBe(0o700);
			expect(await modeOf(path.join(root, ".gjc", "_session-permissions", "state", "deep"))).toBe(0o700);
			expect(await modeOf(path.join(root, target))).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("tightens an existing loose file when it is atomically replaced", async () => {
		const root = await tempDir();
		const target = ".gjc/_session-permissions/state.json";
		const filePath = path.join(root, target);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.chmod(path.dirname(filePath), 0o775);
		await fs.writeFile(filePath, "old", "utf8");
		await fs.chmod(filePath, 0o664);

		const previousUmask = process.umask(0o002);
		try {
			await writeJsonAtomic(target, { secret: "new" }, { cwd: root });
			expect(await modeOf(path.dirname(filePath))).toBe(0o700);
			expect(await modeOf(filePath)).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("keeps append, no-clobber, audit, and journal paths owner-only", async () => {
		const previousUmask = process.umask(0o002);
		try {
			const root = await tempDir();

			const appendTarget = ".gjc/_session-permissions/logs/events.jsonl";
			const appendPath = path.join(root, appendTarget);
			await appendJsonl(appendTarget, { event: "first" }, { cwd: root });
			expect(await modeOf(path.dirname(appendPath))).toBe(0o700);
			expect(await modeOf(appendPath)).toBe(0o600);
			await fs.chmod(appendPath, 0o664);
			await appendText(appendTarget, "text\n", { cwd: root });
			expect(await modeOf(appendPath)).toBe(0o600);

			const idempotentTarget = ".gjc/_session-permissions/ledger/events.jsonl";
			const idempotentPath = path.join(root, idempotentTarget);
			await appendJsonlIdempotent(
				idempotentTarget,
				{ id: "one" },
				{ cwd: root, key: entry => (entry as { id?: string }).id },
			);
			expect(await modeOf(idempotentPath)).toBe(0o600);
			await fs.chmod(idempotentPath, 0o664);
			await appendJsonlIdempotent(
				idempotentTarget,
				{ id: "two" },
				{ cwd: root, key: entry => (entry as { id?: string }).id },
			);
			expect(await modeOf(idempotentPath)).toBe(0o600);

			const noClobberTarget = ".gjc/_session-permissions/claims/claim.json";
			const noClobberPath = await createJsonNoClobber(noClobberTarget, { claim: true }, { cwd: root });
			expect(await modeOf(path.dirname(noClobberPath))).toBe(0o700);
			expect(await modeOf(noClobberPath)).toBe(0o600);

			await appendAuditEntry(root, "permissions", {
				ts: new Date("2026-09-19T00:00:00.000Z").toISOString(),
				category: "state",
				verb: "write",
				owner: "gjc-runtime",
				mutation_id: "permissions-audit",
				forced: false,
				paths: [appendPath],
			});
			const auditFile = auditPath(root, "permissions");
			expect(await modeOf(path.dirname(auditFile))).toBe(0o700);
			expect(await modeOf(auditFile)).toBe(0o600);

			const journalPath = await beginWorkflowTransactionJournal({
				cwd: root,
				sessionId: "permissions",
				mutationId: "mutation-1",
				paths: [appendPath],
			});
			expect(journalPath).toBe(transactionJournalPath(root, "permissions", "mutation-1"));
			expect(await modeOf(path.dirname(journalPath))).toBe(0o700);
			expect(await modeOf(journalPath)).toBe(0o600);
			await updateWorkflowTransactionJournal(root, "permissions", "mutation-1", { status: "committed" });
			expect(await modeOf(journalPath)).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});
});

describe("state-writer hard-link append confinement", () => {
	it("rejects hard-linked JSONL targets without changing the external inode", async () => {
		const root = await tempDir();
		const externalPath = path.join(root, "external-ledger.jsonl");
		const targetPath = path.join(root, ".gjc", "_session-hardlink", "logs", "events.jsonl");
		await preparePrivateParent(root, path.dirname(targetPath));
		await fs.writeFile(externalPath, "outside\n", { mode: 0o644 });
		await fs.link(externalPath, targetPath);

		await expect(
			appendJsonl(".gjc/_session-hardlink/logs/events.jsonl", { event: "inside" }, { cwd: root }),
		).rejects.toThrow("single-linked");
		expect(await fs.readFile(externalPath, "utf8")).toBe("outside\n");
		expect((await fs.stat(externalPath)).nlink).toBe(2);
		if (process.platform !== "win32") expect(await modeOf(externalPath)).toBe(0o644);
	});

	it("rejects a hard-linked audit file before chmod or append", async () => {
		const root = await tempDir();
		const sessionId = "hardlink-audit";
		const externalPath = path.join(root, "external-audit.jsonl");
		const targetPath = auditPath(root, sessionId);
		await preparePrivateParent(root, path.dirname(targetPath));
		await fs.writeFile(externalPath, "outside audit\n", { mode: 0o644 });
		await fs.link(externalPath, targetPath);

		await expect(
			appendAuditEntry(root, sessionId, {
				ts: new Date().toISOString(),
				category: "state",
				verb: "write",
				owner: "gjc-runtime",
				mutation_id: "hardlink-audit",
				forced: false,
				paths: [targetPath],
			}),
		).rejects.toThrow("single-linked");
		expect(await fs.readFile(externalPath, "utf8")).toBe("outside audit\n");
		expect((await fs.stat(externalPath)).nlink).toBe(2);
		if (process.platform !== "win32") expect(await modeOf(externalPath)).toBe(0o644);
	});
});

describe("state-writer symlink-parent confinement", () => {
	it("refuses artifact, JSON, append, no-clobber, and lock operations through linked .gjc parents", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside");
		const linkedState = path.join(root, ".gjc", "_session-link", "state");
		const linkedSpecs = path.join(root, ".gjc", "_session-link", "specs");
		await fs.mkdir(outside);
		await fs.mkdir(path.dirname(linkedState), { recursive: true });
		await fs.chmod(path.join(root, ".gjc"), 0o700);
		await fs.chmod(path.dirname(linkedState), 0o700);
		await fs.symlink(outside, linkedState, process.platform === "win32" ? "junction" : "dir");
		await fs.symlink(outside, linkedSpecs, process.platform === "win32" ? "junction" : "dir");

		await expect(
			writeArtifact(".gjc/_session-link/specs/crystal.md", "private Crystal\n", {
				cwd: root,
				audit: { category: "artifact", verb: "write", owner: "gjc-runtime", sessionId: "writer-link" },
			}),
		).rejects.toThrow();
		await expect(
			writeJsonAtomic(".gjc/_session-link/state/state.json", { private: true }, { cwd: root }),
		).rejects.toThrow();
		await expect(
			appendJsonl(".gjc/_session-link/state/events.jsonl", { event: "private" }, { cwd: root }),
		).rejects.toThrow();
		await expect(
			createJsonNoClobber(".gjc/_session-link/state/claim.json", { private: true }, { cwd: root }),
		).rejects.toThrow();
		await expect(
			withWorkflowStateLock(".gjc/_session-link/state/locked.json", async () => {}, { cwd: root }),
		).rejects.toThrow();
		expect(await fs.readdir(outside)).toEqual([]);
	});
});
