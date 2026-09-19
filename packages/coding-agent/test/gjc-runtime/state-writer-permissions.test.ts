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
