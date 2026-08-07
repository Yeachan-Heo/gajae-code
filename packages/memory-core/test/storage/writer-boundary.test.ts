import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryResult } from "../../src/errors";
import * as publicIndex from "../../src/index";
import {
	type AccessGrant,
	authorizeAccess,
	authorizeSessionAccess,
	verifyAccessGrant,
} from "../../src/policy/access-policy";
import { appendJsonl } from "../../src/storage/append-jsonl";
import { atomicWrite } from "../../src/storage/atomic-write";
import { createJournal, getJournalPath } from "../../src/storage/journal";
import { acquirePathLock } from "../../src/storage/locks";
import { VerifiedStorageError } from "../../src/storage/verified-open";

const temporaryParents: string[] = [];
const SOURCE_ROOT = path.join(import.meta.dir, "../../src");
const CANONICAL_WRITERS = new Set(["storage/atomic-write.ts", "storage/append-jsonl.ts", "storage/bootstrap-init.ts"]);
const INFRASTRUCTURE_WRITERS = new Set(["storage/verified-open.ts", "storage/locks.ts", "storage/journal.ts"]);
// D-11 requires every transaction stage and rename to be a verified publish, so
// the journal is a sanctioned verified-open consumer as well as a writer. The
// write lifecycle reads its own staged artifacts through the verified reader and
// publishes only through the canonical writers. `writes/internal-document-reader.ts`
// is the read-only lifecycle reader that lets propose/forget inspect private
// canonical documents without the public disclosure API; it never writes.
const TRANSACTION_VERIFIED_CONSUMERS = new Set([
	"storage/journal.ts",
	"writes/proposal.ts",
	"writes/internal-document-reader.ts",
]);
const ALLOWED_WRITE_MODULES = new Set([...CANONICAL_WRITERS, ...INFRASTRUCTURE_WRITERS]);
const READ_ONLY_VERIFIED_CONSUMERS = new Set([
	"resources/resolve-readable-resource.ts",
	"resources/read-control-resource.ts",
	"resources/list-readable-directory.ts",
	"resources/audit-admission.ts",
]);
// Imports the typed failure class only, so recovery/doctor evidence keeps its
// deterministic reason. It performs no verified I/O of its own.
const VERIFIED_ERROR_ONLY_CONSUMERS = new Set(["ledger/retrieval-ledger.ts"]);
const VERIFIED_OPEN_IMPORTERS = new Set([
	...READ_ONLY_VERIFIED_CONSUMERS,
	...TRANSACTION_VERIFIED_CONSUMERS,
	...VERIFIED_ERROR_ONLY_CONSUMERS,
	"storage/atomic-write.ts",
	"storage/append-jsonl.ts",
]);
const CANONICAL_WRITER_IMPORT = /from\s+["'][^"']*(?:atomic-write|append-jsonl|bootstrap-init)["']/;
const WRITE_OPERATION =
	/\b(?:appendFile|appendFileSync|chmod|chmodSync|fchmod|fchmodSync|mkdir|mkdirSync|open|openSync|rename|renameSync|rm|rmSync|truncate|truncateSync|unlink|unlinkSync|write|writeFile|writeFileSync|writeSync)\s*\(/;
const DIRECT_READ_OPERATION = /\b(?:readFile|readFileSync|readSync|Bun\.file|Bun\.read)\s*\(/;

function environment(memoryRoot: string, sessionId: string | null = null): object {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: false,
		asOf: null,
	};
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-writer-boundary-"));
	temporaryParents.push(parent);
	const root = path.join(parent, "memory-root");
	await fs.mkdir(root, { mode: 0o700 });
	await fs.chmod(root, 0o700);
	return root;
}

async function sourceFiles(): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: SOURCE_ROOT, onlyFiles: true })) {
		const normalized = String(relative).split(path.sep).join("/");
		files.set(normalized, await Bun.file(path.join(SOURCE_ROOT, relative)).text());
	}
	return files;
}

function requireGrant(result: MemoryResult<AccessGrant>): AccessGrant {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`authorization failed: ${JSON.stringify(result.error)}`);
	return result.value;
}

async function rejected(task: () => Promise<unknown>): Promise<unknown> {
	return task().then(
		() => undefined,
		error => error,
	);
}

function sha256(content: string): string {
	return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

afterEach(async () => {
	await Promise.all(temporaryParents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
});

describe("memory writer boundary", () => {
	it("keeps canonical content writes behind the three allowed writer modules", async () => {
		const sources = await sourceFiles();
		const writeModules = [...sources.entries()]
			.filter(
				([, source]) => WRITE_OPERATION.test(source) || source.includes("Bun.write") || source.includes(".writer("),
			)
			.map(([relative]) => relative)
			.sort();

		expect(writeModules.filter(relative => !ALLOWED_WRITE_MODULES.has(relative))).toEqual([]);
		for (const writer of CANONICAL_WRITERS) expect(sources.has(writer)).toBe(true);
		for (const infrastructure of INFRASTRUCTURE_WRITERS) expect(sources.has(infrastructure)).toBe(true);

		const verifiedImporters = [...sources.entries()]
			.filter(([, source]) => /from\s+["'][^"']*verified-open["']/.test(source))
			.map(([relative]) => relative)
			.sort();
		expect(verifiedImporters.every(relative => VERIFIED_OPEN_IMPORTERS.has(relative))).toBe(true);
		for (const relative of READ_ONLY_VERIFIED_CONSUMERS) {
			const source = sources.get(relative);
			expect(source).toBeDefined();
			if (source === undefined) continue;
			expect(source).not.toMatch(WRITE_OPERATION);
			expect(source).not.toContain("Bun.write");
			expect(source).not.toContain(".writer(");
			expect(source).not.toMatch(CANONICAL_WRITER_IMPORT);
			expect(source).not.toMatch(DIRECT_READ_OPERATION);
			expect(source).toMatch(/\bopenVerified(?:File|Dir)\s*\(/);
		}
		for (const relative of VERIFIED_ERROR_ONLY_CONSUMERS) {
			const source = sources.get(relative);
			expect(source).toBeDefined();
			if (source === undefined) continue;
			expect(source).toMatch(/import\s*\{\s*VerifiedStorageError\s*\}\s*from\s+["'][^"']*verified-open["']/);
			expect(source).not.toMatch(/\bopenVerified(?:File|Dir)\s*\(/);
			expect(source).not.toMatch(/\bpublishVerified\s*\(/);
			expect(source).not.toMatch(DIRECT_READ_OPERATION);
		}
		expect(sources.get("storage/verified-open.ts")).not.toContain("export *");
		expect(sources.get("storage/atomic-write.ts")).not.toContain("beforeRename");

		const atomicSource = sources.get("storage/atomic-write.ts");
		expect(atomicSource).toBeDefined();
		if (atomicSource !== undefined) {
			expect(atomicSource).not.toContain("recursive: true");
			expect(atomicSource).toMatch(/mkdirSync\(authorization\.parentPath/);
		}

		const lockSource = sources.get("storage/locks.ts");
		const journalSource = sources.get("storage/journal.ts");
		expect(lockSource).toBeDefined();
		expect(journalSource).toBeDefined();
		expect(lockSource).toContain('".locks"');
		expect(journalSource).toContain('".journal"');
	});

	it("confines lock and journal output to infrastructure directories", async () => {
		const root = await makeRoot();
		const lock = await acquirePathLock(root, "MEMORY.md", { retries: 1, retryDelayMs: 0 });
		try {
			expect(lock.lockPath.startsWith(path.join(root, ".locks") + path.sep)).toBe(true);
		} finally {
			await lock.release();
		}

		const journal = await createJournal(root, "mutation-1", [
			{
				relPath: "MEMORY.md",
				expectedDigest: null,
				postDigest: "post-digest",
				// Temps must live in the journal namespace so recovery cleanup can never
				// unlink a canonical document named by a tampered plan.
				tempPath: ".journal/mutation-1.stage.tmp",
			},
		]);
		expect(getJournalPath(root, journal.mutationId).startsWith(path.join(root, ".journal") + path.sep)).toBe(true);
		expect(await fs.readFile(getJournalPath(root, journal.mutationId), "utf8")).toContain('"relPath":"MEMORY.md"');
		await expect(fs.lstat(path.join(root, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes authorized atomic and JSONL bytes, and denies changed content", async () => {
		const root = await makeRoot();
		await fs.mkdir(path.join(root, "global"), { mode: 0o700 });
		await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });

		const atomicContent = "authorized atomic bytes\n";
		const atomicGrant = requireGrant(
			authorizeAccess({
				environment: environment(root),
				destination: "global-canonical",
				sensitivity: "public-safe",
				relPath: "global/state.md",
				content: atomicContent,
			}),
		);
		const atomicReceipt = await atomicWrite({
			grant: atomicGrant,
			relPath: "global/state.md",
			content: atomicContent,
		});
		expect(await fs.readFile(path.join(root, "global/state.md"), "utf8")).toBe(atomicContent);
		expect(atomicReceipt.digest).toBe(sha256(atomicContent));

		const record = { event: "append", sequence: 1 };
		const canonicalJsonl = `${JSON.stringify(record)}\n`;
		const jsonlGrant = requireGrant(
			authorizeAccess({
				environment: environment(root),
				destination: "ledger",
				sensitivity: "public-safe",
				relPath: "sessions/events.jsonl",
				content: canonicalJsonl,
			}),
		);
		const jsonlReceipt = await appendJsonl({ grant: jsonlGrant, relPath: "sessions/events.jsonl", record });
		expect(await fs.readFile(path.join(root, "sessions/events.jsonl"), "utf8")).toBe(canonicalJsonl);
		expect(jsonlReceipt.digest).toBe(sha256(canonicalJsonl));

		const changedJsonl = await rejected(() =>
			appendJsonl({
				grant: jsonlGrant,
				relPath: "sessions/events.jsonl",
				record: { event: "changed", sequence: 2 },
			}),
		);
		expect(changedJsonl).toBeInstanceOf(VerifiedStorageError);
		expect((changedJsonl as VerifiedStorageError).reason).toContain("content binding");

		const changed = await rejected(() => atomicWrite({ grant: atomicGrant, content: "changed bytes\n" }));
		expect(changed).toBeInstanceOf(VerifiedStorageError);
		expect((changed as VerifiedStorageError).reason).toContain("content binding");
	});

	it("creates a lazy checkpoint parent only through session authorization and atomic write", async () => {
		const root = await makeRoot();
		const sessionId = "lazy-checkpoint-writer";
		await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });
		const content = "checkpoint bytes\n";
		const grant = requireGrant(
			authorizeSessionAccess({
				environment: environment(root, sessionId),
				destination: "checkpoint",
				content,
			}),
		);
		await atomicWrite({ grant, content });
		const sessionStat = await fs.lstat(path.join(root, "sessions", sessionId));
		expect(sessionStat.isDirectory()).toBe(true);
		expect(sessionStat.isSymbolicLink()).toBe(false);
		expect(sessionStat.mode & 0o777).toBe(0o700);
		const checkpointStat = await fs.stat(path.join(root, "sessions", sessionId, "checkpoint.md"));
		expect(checkpointStat.mode & 0o777).toBe(0o600);
	});
	it("does not let generic authorization mint a parent-creation bypass", async () => {
		const root = await makeRoot();
		await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });
		const relPath = "sessions/lazy-generic-session/retrieval-ledger.jsonl";
		const grant = authorizeAccess({
			environment: environment(root),
			destination: "ledger",
			sensitivity: "public-safe",
			relPath,
			content: '{"event":"generic"}\n',
			parentCreation: true,
		});
		expect(grant.ok).toBe(false);
		expect(
			await fs.lstat(path.join(root, "sessions", "lazy-generic-session")).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("denies secrets, target mismatches, destination mismatches, and exposes no public grant", async () => {
		const root = await makeRoot();
		await fs.mkdir(path.join(root, "global"), { mode: 0o700 });
		const secret = authorizeAccess({
			environment: environment(root),
			destination: "global-canonical",
			sensitivity: "public-safe",
			relPath: "global/secret.md",
			content: "password-123456789012",
		});
		expect(secret.ok).toBe(false);
		if (!secret.ok) expect(secret.error.code).toBe("sensitivity-violation");

		const content = "bound bytes";
		const grant = requireGrant(
			authorizeAccess({
				environment: environment(root),
				destination: "global-canonical",
				sensitivity: "public-safe",
				relPath: "global/bound.md",
				content,
			}),
		);
		const digest = sha256(content);
		const targetMismatch = verifyAccessGrant(grant, path.join(root, "global/other.md"), grant.destination, digest);
		expect(targetMismatch.ok).toBe(false);
		const destinationMismatch = verifyAccessGrant(grant, grant.target, "project-canonical", digest);
		expect(destinationMismatch.ok).toBe(false);

		const digestMismatch = verifyAccessGrant(grant, grant.target, grant.destination, sha256("other bytes"));
		expect(digestMismatch.ok).toBe(false);

		const replacementRoot = `${root}-replacement`;
		await fs.rename(root, replacementRoot);
		await fs.mkdir(root, { mode: 0o700 });
		await fs.chmod(root, 0o700);
		const rootMismatch = verifyAccessGrant(grant, grant.target, grant.destination, digest);
		expect(rootMismatch.ok).toBe(false);
		expect(Object.hasOwn(publicIndex, "AccessGrant")).toBe(false);
	});
});
