import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { runRalplanCliCommand } from "../../src/commands/ralplan";
import { parseReviewConflictDocument } from "../../src/gjc-runtime/ralplan-review-conflicts";

const SESSION = "ralplan-redact-session";
const SECRET = "sk-ant-api03-ralplanartifactsecret";
const TOKEN = "ralplan-bearer-token-value";
let previousSession: string | undefined;

beforeAll(() => {
	previousSession = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = SESSION;
});

afterAll(() => {
	if (previousSession === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = previousSession;
});

async function tempDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "ralplan-redact-"));
}

async function stageReceipt(
	root: string,
	runId: string,
	stage: "architect" | "critic",
): Promise<{ path: string; sha256: string }> {
	const result = await runRalplanCliCommand(
		["--write", "--stage", stage, "--stage_n", "1", "--artifact", `# ${stage}\n`, "--run-id", runId, "--json"],
		root,
	);
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout ?? "{}") as { path: string; sha256: string };
}

function repeatedTargetDisposition(
	targetIds: readonly [string, string],
	arch: { path: string; sha256: string },
	crit: { path: string; sha256: string },
): string {
	return JSON.stringify({
		schema: "ralplan.review_conflicts.v1",
		plannerStageN: 1,
		findings: [
			{
				findingId: "arch-1",
				targetId: targetIds[0],
				action: "add",
				severity: "watch",
				evidence: "ordinary evidence",
				sourceRole: "architect",
				sourceReceipt: { stage: "architect", stageN: 1, path: arch.path, sha256: arch.sha256 },
			},
			{
				findingId: "crit-1",
				targetId: targetIds[1],
				action: "add",
				severity: "watch",
				evidence: "ordinary evidence",
				sourceRole: "critic",
				sourceReceipt: { stage: "critic", stageN: 1, path: crit.path, sha256: crit.sha256 },
			},
		],
		dispositions: [],
	});
}

describe("gjc ralplan --write artifact scrub", () => {
	it("drops credential shapes from planner and pending-approval bodies", async () => {
		const root = await tempDir();
		try {
			const body = `# Plan\nUse ${SECRET} and Bearer ${TOKEN}.\nKeep src/app.ts.\n`;
			const planner = await runRalplanCliCommand(
				["--write", "--stage", "planner", "--stage_n", "1", "--artifact", body, "--run-id", "redact-run", "--json"],
				root,
			);
			expect(planner.status).toBe(0);
			const plannerPayload = JSON.parse(planner.stdout ?? "{}") as { sha256: string; path: string };
			const stored = await fs.readFile(plannerPayload.path, "utf8");
			expect(stored).not.toContain(SECRET);
			expect(stored).not.toContain(TOKEN);
			expect(stored).toContain("src/app.ts");
			expect(createHash("sha256").update(stored).digest("hex")).toBe(plannerPayload.sha256);

			const finalWrite = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"final",
					"--stage_n",
					"2",
					"--artifact",
					`# Final\n${SECRET}\n`,
					"--run-id",
					"redact-run",
					"--json",
				],
				root,
			);
			expect(finalWrite.status).toBe(0);
			const finalPayload = JSON.parse(finalWrite.stdout ?? "{}") as {
				path: string;
				sha256: string;
				pending_approval_path: string;
			};
			const stage = await fs.readFile(finalPayload.path, "utf8");
			const pending = await fs.readFile(finalPayload.pending_approval_path, "utf8");
			expect(pending).toBe(stage);
			expect(pending).not.toContain(SECRET);
			expect(createHash("sha256").update(stage).digest("hex")).toBe(finalPayload.sha256);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps an ordinary plan and dedupes an identical rewrite", async () => {
		const root = await tempDir();
		try {
			const body = "# Plan\nKeep src/app.ts and the ordinary review note.\n";
			const args = [
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				body,
				"--run-id",
				"plain-run",
				"--json",
			];
			const first = await runRalplanCliCommand(args, root);
			expect(first.status).toBe(0);
			const payload = JSON.parse(first.stdout ?? "{}") as { path: string; sha256: string };
			expect(await fs.readFile(payload.path, "utf8")).toBe(body);
			const second = await runRalplanCliCommand(args, root);
			expect(second.status).toBe(0);
			const again = JSON.parse(second.stdout ?? "{}") as { deduplicated?: boolean; sha256: string };
			expect(again.deduplicated).toBe(true);
			expect(again.sha256).toBe(payload.sha256);
			expect(await fs.readFile(payload.path, "utf8")).toBe(body);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes credential text from disposition evidence and leaves receipt digests", async () => {
		const root = await tempDir();
		try {
			const architect = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"architect",
					"--stage_n",
					"1",
					"--artifact",
					"# architect\n",
					"--run-id",
					"disp-redact",
					"--json",
				],
				root,
			);
			const critic = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"critic",
					"--stage_n",
					"1",
					"--artifact",
					"# critic\n",
					"--run-id",
					"disp-redact",
					"--json",
				],
				root,
			);
			expect(architect.status).toBe(0);
			expect(critic.status).toBe(0);
			const arch = JSON.parse(architect.stdout ?? "{}") as { path: string; sha256: string };
			const crit = JSON.parse(critic.stdout ?? "{}") as { path: string; sha256: string };
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(
				artifactPath,
				JSON.stringify({
					schema: "ralplan.review_conflicts.v1",
					plannerStageN: 1,
					findings: [
						{
							findingId: "arch-1",
							targetId: "contract.field",
							action: "remove",
							severity: "block",
							evidence: `drop ${SECRET}`,
							sourceRole: "architect",
							sourceReceipt: { stage: "architect", stageN: 1, path: arch.path, sha256: arch.sha256 },
						},
						{
							findingId: "crit-1",
							targetId: "contract.field",
							action: "add",
							severity: "watch",
							evidence: "keep the field",
							sourceRole: "critic",
							sourceReceipt: { stage: "critic", stageN: 1, path: crit.path, sha256: crit.sha256 },
						},
					],
					dispositions: [
						{
							conflictId: "conflict:contract.field:arch-1:crit-1",
							choice: "accept_architect",
							rationale: "ordinary rationale",
							decisionOwner: "ralplan-leader",
							affectedSections: ["## Contracts"],
						},
					],
				}),
			);
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					"disp-redact",
					"--json",
				],
				root,
			);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			expect(stored).not.toContain(SECRET);
			expect(stored).toContain(arch.sha256);
			expect(stored).toContain(crit.sha256);
			expect(parseReviewConflictDocument(stored).schema).toBe("ralplan.review_conflicts.v1");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes credential-shaped disposition identifiers", async () => {
		const root = await tempDir();
		try {
			const architect = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"architect",
					"--stage_n",
					"1",
					"--artifact",
					"# architect\n",
					"--run-id",
					"id-redact",
					"--json",
				],
				root,
			);
			const critic = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"critic",
					"--stage_n",
					"1",
					"--artifact",
					"# critic\n",
					"--run-id",
					"id-redact",
					"--json",
				],
				root,
			);
			expect(architect.status).toBe(0);
			expect(critic.status).toBe(0);
			const arch = JSON.parse(architect.stdout ?? "{}") as { path: string; sha256: string };
			const crit = JSON.parse(critic.stdout ?? "{}") as { path: string; sha256: string };
			const targetId = `Bearer ${TOKEN}`;
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(
				artifactPath,
				JSON.stringify({
					schema: "ralplan.review_conflicts.v1",
					plannerStageN: 1,
					findings: [
						{
							findingId: SECRET,
							targetId,
							action: "remove",
							severity: "block",
							evidence: "ordinary evidence",
							sourceRole: "architect",
							sourceReceipt: { stage: "architect", stageN: 1, path: arch.path, sha256: arch.sha256 },
						},
						{
							findingId: "crit-1",
							targetId,
							action: "add",
							severity: "watch",
							evidence: "ordinary evidence",
							sourceRole: "critic",
							sourceReceipt: { stage: "critic", stageN: 1, path: crit.path, sha256: crit.sha256 },
						},
					],
					dispositions: [
						{
							conflictId: `conflict:${targetId}:crit-1:${SECRET}`,
							choice: "accept_architect",
							rationale: "ordinary rationale",
							decisionOwner: "ralplan-leader",
							affectedSections: ["## Contracts"],
							dispositionedAt: SECRET,
						},
					],
				}),
			);
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					"id-redact",
					"--json",
				],
				root,
			);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			expect(stored).not.toContain(SECRET);
			expect(stored).not.toContain(TOKEN);
			expect(stored).toContain(arch.sha256);
			expect(stored).toContain(crit.sha256);
			const parsed = parseReviewConflictDocument(stored);
			expect(parsed.findings.map(finding => finding.findingId)).not.toContain(SECRET);
			expect(parsed.dispositions[0]?.conflictId).not.toContain(SECRET);
			expect(parsed.dispositions[0]?.dispositionedAt).not.toContain(SECRET);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("refuses distinct disposition target ids that sanitize to one id", async () => {
		const root = await tempDir();
		try {
			const runId = "id-collide";
			const arch = await stageReceipt(root, runId, "architect");
			const crit = await stageReceipt(root, runId, "critic");
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(
				artifactPath,
				repeatedTargetDisposition(
					["sk-ant-api03-ralplanlefttarget01", "sk-ant-api03-ralplanrighttarget1"],
					arch,
					crit,
				),
			);
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					runId,
					"--json",
				],
				root,
			);
			expect(written.status).toBe(2);
			expect(written.stderr ?? "").toContain("distinct target ids collapse");
			await expect(fs.access(path.join(path.dirname(arch.path), "stage-01-disposition.md"))).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps repeated findings that share one original disposition target", async () => {
		const root = await tempDir();
		try {
			const runId = "id-repeat";
			const arch = await stageReceipt(root, runId, "architect");
			const crit = await stageReceipt(root, runId, "critic");
			const targetId = "sk-ant-api03-ralplanrepeatedtarget";
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(artifactPath, repeatedTargetDisposition([targetId, targetId], arch, crit));
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					runId,
					"--json",
				],
				root,
			);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			const parsed = parseReviewConflictDocument(stored);
			expect(parsed.findings).toHaveLength(2);
			expect(new Set(parsed.findings.map(finding => finding.targetId)).size).toBe(1);
			expect(parsed.findings.map(finding => finding.findingId).sort()).toEqual(["arch-1", "crit-1"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("refuses distinct target ids that match only after scrub and trim", async () => {
		const root = await tempDir();
		try {
			const runId = "id-trim";
			const arch = await stageReceipt(root, runId, "architect");
			const crit = await stageReceipt(root, runId, "critic");
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(
				artifactPath,
				repeatedTargetDisposition(
					["\u200b sk-ant-api03-ralplanlefttarget01", "sk-ant-api03-ralplanrighttarget1"],
					arch,
					crit,
				),
			);
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					runId,
					"--json",
				],
				root,
			);
			expect(written.status).toBe(2);
			expect(written.stderr ?? "").toContain("distinct target ids collapse");
			await expect(fs.access(path.join(path.dirname(arch.path), "stage-01-disposition.md"))).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps repeated findings that share one spaced credential target", async () => {
		const root = await tempDir();
		try {
			const runId = "id-trim-repeat";
			const arch = await stageReceipt(root, runId, "architect");
			const crit = await stageReceipt(root, runId, "critic");
			const targetId = "\u200b sk-ant-api03-ralplanrepeatedtarget";
			const artifactPath = path.join(root, "disposition.json");
			await fs.writeFile(artifactPath, repeatedTargetDisposition([targetId, targetId], arch, crit));
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"disposition",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					runId,
					"--json",
				],
				root,
			);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			const parsed = parseReviewConflictDocument(stored);
			expect(parsed.findings).toHaveLength(2);
			expect(new Set(parsed.findings.map(finding => finding.targetId)).size).toBe(1);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

const PROPERTY_SEED = 5472026;

describe("scrubRalplanPersistedBody property", () => {
	it("property: scrub idempotence and safe-text agreement, seed 5472026, 64 inputs", async () => {
		const { scrubRalplanPersistedBody } = await import("../../src/gjc-runtime/ralplan-runtime");
		const noteArbitrary = fc.integer({ min: 0, max: 9999 }).map(value => `note${value}`);
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 9999 }), noteArbitrary, (index, note) => {
				const safe = `# Plan\nKeep src/file${index}.ts ${note}.\n`;
				expect(scrubRalplanPersistedBody("planner", safe)).toBe(safe);
				expect(scrubRalplanPersistedBody("planner", safe)).toBe(
					scrubRalplanPersistedBody("planner", scrubRalplanPersistedBody("planner", safe)),
				);
				const planted = `# Plan\n${SECRET} ${note}\n`;
				const redacted = scrubRalplanPersistedBody("planner", planted);
				expect(redacted).not.toContain(SECRET);
				expect(redacted).toContain(note);
				expect(scrubRalplanPersistedBody("planner", redacted)).toBe(redacted);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});

	it("property: disposition target collapse after scrub and trim, seed 5472026, 64 inputs", async () => {
		const { scrubRalplanPersistedBody } = await import("../../src/gjc-runtime/ralplan-runtime");
		const credential = fc
			.integer({ min: 0, max: 999_999 })
			.map(value => `sk-ant-api03-ralplantarget${String(value).padStart(6, "0")}`);
		const pad = fc.constantFrom("", " ", "\t", "\n", "\u200b", "\u200b ", " \u200b");
		const body = (left: string, right: string) =>
			JSON.stringify({
				schema: "ralplan.review_conflicts.v1",
				plannerStageN: 1,
				findings: [
					{
						findingId: "arch-1",
						targetId: left,
						action: "add",
						severity: "watch",
						evidence: "ordinary evidence",
						sourceRole: "architect",
						sourceReceipt: { stage: "architect", stageN: 1, path: "architect.md", sha256: "a" },
					},
					{
						findingId: "crit-1",
						targetId: right,
						action: "add",
						severity: "watch",
						evidence: "ordinary evidence",
						sourceRole: "critic",
						sourceReceipt: { stage: "critic", stageN: 1, path: "critic.md", sha256: "b" },
					},
				],
				dispositions: [],
			});
		fc.assert(
			fc.property(credential, credential, pad, pad, (leftSecret, rightSecret, leftPad, rightPad) => {
				const left = `${leftPad}${leftSecret}${leftPad}`;
				const right = `${rightPad}${rightSecret}${rightPad}`;
				if (left === right) {
					const stored = scrubRalplanPersistedBody("disposition", body(left, right));
					const parsed = parseReviewConflictDocument(stored);
					expect(new Set(parsed.findings.map(finding => finding.targetId)).size).toBe(1);
					expect(stored).not.toContain(leftSecret);
					expect(scrubRalplanPersistedBody("disposition", stored)).toBe(stored);
					return;
				}
				expect(() => scrubRalplanPersistedBody("disposition", body(left, right))).toThrow(
					/distinct target ids collapse/,
				);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});

describe("ralplan OSC strip on the write path", () => {
	it("a long run of unterminated ESC prefixes stays cheap before persistence", async () => {
		const { scrubRalplanPersistedBody } = await import("../../src/gjc-runtime/ralplan-runtime");
		const count = 80_000;
		const body = `${"\u001b]".repeat(count)}TAIL`;
		const started = performance.now();
		const stored = scrubRalplanPersistedBody("planner", body);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(stored).toBe(`${"]".repeat(count)}TAIL\n`);
	}, 30_000);

	it("a file of repeated terminated OSC sequences stays cheap on write", async () => {
		const root = await tempDir();
		try {
			const count = 120_000;
			const between = "plan: keep this sentence";
			const artifactPath = path.join(root, "planner.md");
			await fs.writeFile(
				artifactPath,
				`${"\u001b]x\u0007".repeat(count)}${between}${"\u001b]y\u001b\\".repeat(count)}`,
			);
			const started = performance.now();
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					"osc-repeat",
					"--json",
				],
				root,
			);
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			expect(stored).toContain(between);
			expect(stored).not.toContain("\u001b]");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
