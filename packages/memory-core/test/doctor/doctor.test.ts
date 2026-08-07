import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type DoctorInput, doctor } from "../../src";
import { checkLifecycle } from "../../src/doctor/lifecycle";
import { runDoctor } from "../../src/doctor/report";
import { checkRetrieval } from "../../src/doctor/retrieval";
import { checkStructural } from "../../src/doctor/structural";
import type { MemoryEnvironment } from "../../src/env";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";

const parents: string[] = [];

function environment(memoryRoot: string, sessionId: string | null = null): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-doctor-"));
	parents.push(parent);
	const root = path.join(parent, "memory");
	await createMemoryRootScaffold(root);
	return root;
}

async function writeFixture(root: string, relPath: string, content: string | Uint8Array, mode: number): Promise<void> {
	const target = path.join(root, ...relPath.split("/"));
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await fs.writeFile(target, content, { mode });
	await fs.chmod(target, mode);
}

function documentFixture(id: string, sensitivity: string, status: string): string {
	return [
		"---",
		"schemaVersion: gajae.memory.document.v1",
		`id: ${id}`,
		"type: note",
		"scope: global",
		"authority: repository-reviewed",
		"volatility: stable",
		`sensitivity: ${sensitivity}`,
		`status: ${status}`,
		"created: 2026-07-29T00:00:00.000Z",
		"updated: 2026-07-29T00:00:00.000Z",
		"aliases: []",
		"supersedes: []",
		"---",
		`# ${id}`,
		"sanitized audit fixture",
		"",
	].join("\n");
}

function digest(value: string): string {
	return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
	const output: string[] = [];
	async function visit(current: string, prefix: string): Promise<void> {
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries.sort((left, right) =>
			Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
		)) {
			const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			const absolutePath = path.join(current, entry.name);
			const stats = await fs.lstat(absolutePath);
			let payload = "";
			if (entry.isFile()) payload = (await fs.readFile(absolutePath)).toString("base64");
			else if (entry.isSymbolicLink()) payload = await fs.readlink(absolutePath);
			output.push(`${relPath}|${(stats.mode & 0o7777).toString(8)}|${payload}`);
			if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolutePath, relPath);
		}
	}
	const rootStats = await fs.lstat(root);
	output.push(`.|${(rootStats.mode & 0o7777).toString(8)}|`);
	await visit(root, "");
	return output;
}

afterEach(async () => {
	await Promise.all(parents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true })));
});

describe("memory doctor", () => {
	it("reports a freshly initialized root as healthy", async () => {
		const root = await makeRoot();
		const result = await runDoctor(environment(root));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ schemaVersion: "gajae.memory.audit.v1", healthy: true, findings: [] });
	});

	it("keeps valid private, restricted, and non-active documents healthy", async () => {
		const root = await makeRoot();
		await writeFixture(root, "global/private.md", documentFixture("private", "private", "active"), 0o600);
		await writeFixture(root, "global/restricted.md", documentFixture("restricted", "restricted", "active"), 0o600);
		await writeFixture(root, "global/proposed.md", documentFixture("proposed", "public-safe", "proposed"), 0o600);
		await writeFixture(root, "global/archived.md", documentFixture("archived", "public-safe", "archived"), 0o600);
		const result = await runDoctor(environment(root));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.healthy).toBe(true);
		expect(result.value.findings.map(finding => finding.code)).not.toContain("admission.resource-denied");
	});

	it("reports a superseded document selected by a real MAP route", async () => {
		const root = await makeRoot();
		await writeFixture(root, "global/old.md", documentFixture("old", "public-safe", "superseded"), 0o600);
		await writeFixture(
			root,
			"MEMORY.md",
			[
				"# Memory Map",
				"",
				"<!-- AUTO:PROJECTS START -->",
				"<!-- AUTO:PROJECTS END -->",
				"",
				"<!-- AUTO:INDEX-HEALTH START -->",
				"[Old](memory://global/old.md)",
				"<!-- AUTO:INDEX-HEALTH END -->",
				"",
			].join("\n"),
			0o600,
		);
		const result = await runDoctor(environment(root));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.findings.map(finding => finding.code)).toContain("lifecycle.superseded-active-route");
		expect(result.value.findings.map(finding => finding.code)).not.toContain("admission.resource-denied");
	});

	it("reports real security and journal evidence without disclosing bytes or writing", async () => {
		const root = await makeRoot();
		const secret = "sk-test-secret-never-report-this";
		await writeFixture(root, "sessions/demo/secret.md", `token=${secret}\n`, 0o600);
		await writeFixture(root, "sessions/demo/private.md", "private\n", 0o644);
		await writeFixture(root, "sessions/demo/binary.bin", Buffer.from([0, 1, 2, 3]), 0o600);
		await writeFixture(root, "sessions/demo/oversized.txt", Buffer.alloc(1_048_577, 0x61), 0o600);
		await writeFixture(
			root,
			"sessions/demo/checkpoint.md",
			[
				"---",
				"schemaVersion: gajae.memory.document.v1",
				"id: demo-checkpoint",
				"type: checkpoint",
				"scope: session",
				"authority: session-observed",
				"volatility: volatile",
				"sensitivity: public-safe",
				"status: active",
				"created: 2026-07-29T00:00:00.000Z",
				"updated: 2026-07-29T00:00:00.000Z",
				"aliases: []",
				"supersedes: []",
				"---",
				"# Checkpoint",
				"healthy session fixture",
				"",
			].join("\n"),
			0o600,
		);
		await writeFixture(
			root,
			".journal/mutation.json",
			`${JSON.stringify({
				schemaVersion: "gajae.memory.journal.v1",
				mutationId: "mutation",
				entries: [
					{
						relPath: "sessions/demo/private.md",
						expectedDigest: null,
						postDigest: "post-digest",
						tempPath: ".journal/mutation.tmp",
					},
				],
			})}\n`,
			0o600,
		);
		await writeFixture(root, ".journal/mutation.progress", "stage 0\n", 0o600);
		const before = await treeSnapshot(root);
		const first = await runDoctor(environment(root, "demo"));
		const second = await runDoctor(environment(root, "demo"));
		const after = await treeSnapshot(root);
		expect(first).toEqual(second);
		expect(after).toEqual(before);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const serialized = JSON.stringify(first.value);
		const codes = first.value.findings.map(finding => finding.code);
		expect(serialized).not.toContain(secret);
		expect(codes).toContain("security.secret");
		expect(codes).toContain("security.world-readable");
		expect(codes).toContain("security.binary");
		expect(codes).toContain("security.oversized");
		expect(codes).toContain("journal.tampered");
		expect(codes).not.toContain("lifecycle.checkpoint-no-session");
	});

	it("reports an oversized sparse entry without reading its body", async () => {
		const root = await makeRoot();
		const target = path.join(root, "global", "oversized.bin");
		const handle = await fs.open(target, "w", 0o600);
		await handle.truncate(4_294_967_296);
		await handle.close();
		const before = await fs.lstat(target);
		const result = await runDoctor(environment(root), { maxBytes: 1_024 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const oversized = result.value.findings.find(
			finding => finding.code === "security.oversized" && finding.relPath === "global/oversized.bin",
		);
		expect(oversized).toBeDefined();
		expect(result.value.findings.map(finding => finding.code)).not.toContain("security.secret");
		const after = await fs.lstat(target);
		expect(after.size).toBe(before.size);
		expect(after.mode).toBe(before.mode);
	});

	it("rejects synthetic context fields through the public doctor operation", async () => {
		const root = await makeRoot();
		await fs.rm(path.join(root, "MEMORY.md"));
		const synthetic = {
			files: [],
			documents: [],
			journals: [],
			mapContent: "# synthetic map",
		} as unknown as DoctorInput;
		const result = await doctor(environment(root), synthetic);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("invalid-input");
	});

	it("reports a denied control resource without disclosing or writing", async () => {
		const root = await makeRoot();
		const control = path.join(root, "MEMORY.md");
		await fs.rm(control);
		await fs.symlink("routes.yaml", control);
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const finding = result.value.findings.find(
			candidate => candidate.code === "admission.control-denied" && candidate.relPath === "MEMORY.md",
		);
		expect(finding).toBeDefined();
		expect(JSON.stringify(finding)).not.toContain(control);
	});

	it("reports a denied scope admission without disclosing or writing", async () => {
		const root = await makeRoot();
		await fs.rm(path.join(root, "global"), { recursive: true });
		await fs.symlink("projects", path.join(root, "global"));
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const admissions = result.value.findings.filter(candidate => candidate.code.startsWith("admission."));
		// Pin the exact taxonomy: a symlinked scope root is a scope denial, not a
		// per-resource denial, so the two codes stay distinguishable.
		expect(admissions.map(candidate => candidate.code)).toEqual(["admission.scope-denied"]);
		expect(admissions[0]?.severity).toBe("error");
		expect(admissions[0]?.relPath).toBe("global");
	});

	it("does not report a pending finding for a valid terminal journal pair", async () => {
		const root = await makeRoot();
		await writeFixture(
			root,
			".journal/terminal.json",
			`${JSON.stringify({ schemaVersion: "gajae.memory.journal.v1", mutationId: "terminal", entries: [] })}\n`,
			0o600,
		);
		await writeFixture(root, ".journal/terminal.progress", "commit\n", 0o600);
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.findings.map(finding => finding.code)).not.toContain("journal.pending");
	});

	it("reports a pending journal with its affected path set without recovery", async () => {
		const root = await makeRoot();
		await writeFixture(
			root,
			".journal/pending.json",
			`${JSON.stringify({
				schemaVersion: "gajae.memory.journal.v1",
				mutationId: "pending",
				entries: [
					{
						relPath: "global/pending.md",
						expectedDigest: null,
						postDigest: digest("pending-after\n"),
						tempPath: ".journal/pending.tmp",
					},
				],
			})}\n`,
			0o600,
		);
		await writeFixture(root, ".journal/pending.progress", "commit", 0o600);
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.findings).toContainEqual({
			code: "journal.pending",
			severity: "error",
			relPath: "global/pending.md",
			detail: "recovery journal and progress pair is incomplete",
		});
	});

	it("reports a recoverable journal with its affected path set", async () => {
		const root = await makeRoot();
		await writeFixture(root, "global/recoverable.txt", "recoverable-before\n", 0o600);
		await writeFixture(root, ".journal/recoverable.tmp", "recoverable-after\n", 0o600);
		await writeFixture(
			root,
			".journal/recoverable.json",
			`${JSON.stringify({
				schemaVersion: "gajae.memory.journal.v1",
				mutationId: "recoverable",
				entries: [
					{
						relPath: "global/recoverable.txt",
						expectedDigest: digest("recoverable-before\n"),
						postDigest: digest("recoverable-after\n"),
						tempPath: ".journal/recoverable.tmp",
					},
				],
			})}\n`,
			0o600,
		);
		await writeFixture(root, ".journal/recoverable.progress", "stage 0\npublish-begin 0\n", 0o600);
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.healthy).toBe(true);
		expect(result.value.findings).toContainEqual({
			code: "journal.recoverable",
			severity: "warning",
			relPath: "global/recoverable.txt",
			detail: "recovery journal can be safely recovered",
		});
	});

	it("reports a tampered journal with its affected path set and marks the audit unhealthy", async () => {
		const root = await makeRoot();
		await writeFixture(root, "global/tampered.md", "tampered-by-other\n", 0o600);
		await writeFixture(root, ".journal/tampered.tmp", "tampered-after\n", 0o600);
		await writeFixture(
			root,
			".journal/tampered.json",
			`${JSON.stringify({
				schemaVersion: "gajae.memory.journal.v1",
				mutationId: "tampered",
				entries: [
					{
						relPath: "global/tampered.md",
						expectedDigest: digest("tampered-before\n"),
						postDigest: digest("tampered-after\n"),
						tempPath: ".journal/tampered.tmp",
					},
				],
			})}\n`,
			0o600,
		);
		await writeFixture(root, ".journal/tampered.progress", "stage 0\npublish-begin 0\n", 0o600);
		const before = await treeSnapshot(root);
		const result = await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.healthy).toBe(false);
		expect(result.value.findings).toContainEqual({
			code: "journal.tampered",
			severity: "error",
			relPath: "global/tampered.md",
			detail: "recovery journal failed closed after transaction state changed",
		});
	});
	it("reports one stable code from each doctor family", async () => {
		const root = await makeRoot();
		const structural = await checkStructural(environment(root), { mapContent: "<!-- AUTO:PROJECTS START -->" });
		expect(structural.ok).toBe(true);
		if (!structural.ok) return;
		expect(structural.value.map(finding => finding.code)).toContain("structural.generated-markers");

		const lifecycle = await checkLifecycle(environment(root), {
			documents: [
				{
					relPath: "sessions/demo/checkpoint.md",
					uri: "session://demo/checkpoint.md",
					metadata: { type: "checkpoint", status: "active", scope: "session" },
				},
			],
			directories: [],
		});
		expect(lifecycle.ok).toBe(true);
		if (!lifecycle.ok) return;
		expect(lifecycle.value.map(finding => finding.code)).toContain("lifecycle.checkpoint-no-session");

		const retrieval = await checkRetrieval(environment(root), {
			mapRoutes: [{ uri: "global://missing.md", aliases: ["missing"] }],
		});
		expect(retrieval.ok).toBe(true);
		if (!retrieval.ok) return;
		expect(retrieval.value.map(finding => finding.code)).toContain("retrieval.missing-route");
	});

	it("does not mutate the store", async () => {
		const root = await makeRoot();
		const before = await treeSnapshot(root);
		await runDoctor(environment(root));
		const after = await treeSnapshot(root);
		expect(after).toEqual(before);
	});
});
