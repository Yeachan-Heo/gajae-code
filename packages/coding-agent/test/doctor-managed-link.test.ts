import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeManagedLink, repairManagedLink } from "../src/cli/doctor/managed-link";

function receiptDigest(body: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

const roots: string[] = [];
let runCounter = 0;
function nextRunId(): string {
	runCounter += 1;
	return `link-run-${runCounter}`;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; bin: string; target: string; journalRoot: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-link-")));
	roots.push(root);
	await fs.mkdir(path.join(root, "packages/coding-agent/src"), { recursive: true });
	await fs.writeFile(path.join(root, "packages/coding-agent/src/cli.ts"), "");
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	const target = path.join(bin, "gjc");
	await fs.symlink(path.join(root, "packages/coding-agent/src/cli.ts"), target);
	await writeReceipt(target, root, "gjc", path.join(root, "packages/coding-agent/src/cli.ts"));
	const journalRoot = path.join(root, "agent");
	await fs.mkdir(journalRoot, { mode: 0o700 });
	return { root, bin, target, journalRoot };
}

async function writeReceipt(target: string, root: string, alias: string, source: string): Promise<void> {
	const stat = await fs.lstat(target);
	const body = {
		version: 1,
		alias,
		target,
		root,
		source,
		parent: path.dirname(target),
		identity: { dev: String(stat.dev), ino: String(stat.ino) },
	};
	await fs.writeFile(`${target}.gjc-managed.json`, `${JSON.stringify({ ...body, auth: receiptDigest(body) })}\n`, {
		mode: 0o600,
	});
	await fs.chmod(`${target}.gjc-managed.json`, 0o600);
}

describe("managed link doctor: descriptor", () => {
	it("describes an owned, healthy source link with stable c1 candidates", async () => {
		const f = await fixture();
		const d = await describeManagedLink(f.target, f.root);
		expect(d.status).toBe("healthy");
		expect(d.receiptTrusted).toBe(true);
		expect(d.candidates).toHaveLength(3);
		expect(d.candidates.map(c => c.kind).sort()).toEqual(["binary", "source", "wrapper"]);
	});

	it("classifies a regular foreign file (not a symlink) at the target name as foreign, never healthy", async () => {
		const f = await fixture();
		await fs.rm(f.target);
		await fs.rm(`${f.target}.gjc-managed.json`, { force: true });
		await fs.writeFile(f.target, "#!/bin/sh\necho not-managed\n");
		const d = await describeManagedLink(f.target, f.root);
		expect(d.status).toBe("foreign");
		expect(d.receiptTrusted).toBe(false);
	});

	it("does not treat an unowned symlink named gjc as managed even when it points at a known candidate", async () => {
		const f = await fixture();
		await fs.rm(`${f.target}.gjc-managed.json`);
		const d = await describeManagedLink(f.target, f.root);
		expect(d.receiptTrusted).toBe(false);
		expect(d.status).toBe("foreign");
	});

	it("rejects a forged receipt (auth digest mismatch) and does not claim ownership", async () => {
		const f = await fixture();
		await fs.writeFile(
			`${f.target}.gjc-managed.json`,
			JSON.stringify({
				version: 1,
				alias: "gjc",
				target: f.target,
				root: f.root,
				source: "x",
				parent: f.bin,
				identity: { dev: "0", ino: "0" },
				auth: "forged",
			}),
		);
		const d = await describeManagedLink(f.target, f.root);
		expect(d.receiptTrusted).toBe(false);
		expect(d.status).toBe("foreign");
	});

	it("classifies a broken (target missing) managed link distinctly from foreign", async () => {
		const f = await fixture();
		await fs.rm(f.target);
		const d = await describeManagedLink(f.target, f.root);
		expect(d.status).toBe("broken");
		expect(d.reasonCode).toBe("target_missing");
	});

	it("classifies a trusted-receipt link that has drifted from its recorded source as broken, not healthy or foreign", async () => {
		const f = await fixture();
		await fs.rm(f.target);
		await fs.symlink("/nonexistent/somewhere/else", f.target);
		// The receipt is rewritten against the CURRENT (drifted) link identity but
		// still records the original source path — this exercises "known prior
		// target" drift detection (an authentic receipt whose recorded source no
		// longer matches the live link target) rather than blind trust of any
		// receipt file.
		await writeReceipt(f.target, f.root, "gjc", path.join(f.root, "packages/coding-agent/src/cli.ts"));
		const d = await describeManagedLink(f.target, f.root);
		expect(d.receiptTrusted).toBe(true);
		expect(d.status).toBe("broken");
		expect(d.reasonCode).toBe("target_drifted_from_receipt");
	});

	it("reports a selected candidate that no longer exists as unresolved on repair, not silently accepted", async () => {
		const f = await fixture();
		const d = await describeManagedLink(f.target, f.root);
		const wrapperCandidate = d.candidates.find(c => c.kind === "wrapper");
		expect(wrapperCandidate?.exists).toBe(false);
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: wrapperCandidate!.id,
				mode: "fix",
				allowRisks: ["install-replace"],
				yes: true,
				journalRoot: f.journalRoot,
				runId: nextRunId(),
			},
			d,
		);
		expect(r.state).toBe("blocked");
		expect(r.reasonCode).toBe("candidate_unresolved");
	});

	it("rejects an unknown --ref not present in this target's candidate list", async () => {
		const f = await fixture();
		const d = await describeManagedLink(f.target, f.root);
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: "c1:link:rdeadbeef:source:pdeadbeef",
				mode: "fix",
				allowRisks: ["install-replace"],
				yes: true,
				journalRoot: f.journalRoot,
				runId: nextRunId(),
			},
			d,
		);
		expect(r.state).toBe("blocked");
		expect(r.reasonCode).toBe("candidate_selection_missing");
	});
});

describe("managed link doctor: repair (no host actions, isolated fixtures only)", () => {
	it("preview (dry-run) makes zero changes and requires an explicit --ref even in preview mode's authorization gate", async () => {
		const f = await fixture();
		const before = await fs.readlink(f.target);
		const d = await describeManagedLink(f.target, f.root);
		const sourceCandidate = d.candidates.find(c => c.kind === "source")!;
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: sourceCandidate.id,
				mode: "dry-run",
				allowRisks: [],
				yes: false,
			},
			d,
		);
		expect(r.state).toBe("blocked");
		expect(r.reasonCode).toBe("authorization_missing");
		expect(await fs.readlink(f.target)).toBe(before);
		expect(await fs.readdir(f.bin)).toContain("gjc");
	});

	it("no-op / zero-changes preview leaves the filesystem untouched even when authorized", async () => {
		const f = await fixture();
		const before = await fs.readlink(f.target);
		const beforeFiles = (await fs.readdir(f.bin)).sort();
		const d = await describeManagedLink(f.target, f.root);
		const sourceCandidate = d.candidates.find(c => c.kind === "source")!;
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: sourceCandidate.id,
				mode: "dry-run",
				allowRisks: ["install-replace"],
				yes: true,
			},
			d,
		);
		expect(r.state).toBe("planned");
		expect(r.changed).toBe(false);
		expect(await fs.readlink(f.target)).toBe(before);
		expect((await fs.readdir(f.bin)).sort()).toEqual(beforeFiles);
	});

	it("repairs a broken (missing target) managed link by creating a fresh exclusive symlink and a fresh receipt", async () => {
		const f = await fixture();
		await fs.rm(f.target);
		const d = await describeManagedLink(f.target, f.root);
		expect(d.status).toBe("broken");
		const sourceCandidate = d.candidates.find(c => c.kind === "source")!;
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: sourceCandidate.id,
				mode: "fix",
				allowRisks: ["install-replace"],
				yes: true,
				journalRoot: f.journalRoot,
				runId: nextRunId(),
			},
			d,
		);
		expect(r.state, r.reasonCode).toBe("verified");
		expect(r.changed).toBe(true);
		expect(await fs.readlink(f.target)).toBe(sourceCandidate.path);
		const after = await describeManagedLink(f.target, f.root);
		expect(after.status).toBe("healthy");
		expect(after.receiptTrusted).toBe(true);
	});

	it("refuses to repair a regular foreign file rather than replacing it", async () => {
		const f = await fixture();
		await fs.rm(f.target);
		await fs.rm(`${f.target}.gjc-managed.json`, { force: true });
		await fs.writeFile(f.target, "not a symlink");
		const before = await fs.readFile(f.target, "utf8");
		const d = await describeManagedLink(f.target, f.root);
		expect(d.status).toBe("foreign");
		const anyCandidateId = d.candidates[0]!.id;
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: anyCandidateId,
				mode: "fix",
				allowRisks: ["install-replace"],
				yes: true,
				journalRoot: f.journalRoot,
				runId: nextRunId(),
			},
			d,
		);
		expect(r.state).toBe("blocked");
		expect(r.changed).toBe(false);
		expect(await fs.readFile(f.target, "utf8")).toBe(before);
	});

	it("touches only the requested alias — a repair on gjc never mutates a sibling alias link in the same directory", async () => {
		const f = await fixture();
		const secondAlias = path.join(f.bin, "second-alias");
		await fs.symlink(path.join(f.root, "packages/coding-agent/src/cli.ts"), secondAlias);
		await writeReceipt(secondAlias, f.root, "second-alias", path.join(f.root, "packages/coding-agent/src/cli.ts"));
		await fs.rm(f.target);
		const d = await describeManagedLink(f.target, f.root, "gjc");
		const sourceCandidate = d.candidates.find(c => c.kind === "source")!;
		const beforeSecondAlias = await fs.readlink(secondAlias);
		const r = await repairManagedLink(
			{
				targetPath: f.target,
				alias: "gjc",
				root: f.root,
				ref: sourceCandidate.id,
				mode: "fix",
				allowRisks: ["install-replace"],
				yes: true,
				journalRoot: f.journalRoot,
				runId: nextRunId(),
			},
			d,
		);
		expect(r.state, r.reasonCode).toBe("verified");
		expect(await fs.readlink(secondAlias)).toBe(beforeSecondAlias);
	});
});
