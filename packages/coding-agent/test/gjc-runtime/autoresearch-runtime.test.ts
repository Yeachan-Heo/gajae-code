import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTORESEARCH_LEDGER_EVENT_KINDS,
	type AutoresearchMode,
	autoresearchClear,
	autoresearchHandoff,
	autoresearchIssueVerdict,
	autoresearchLogRun,
	autoresearchRead,
	autoresearchRecordCritic,
	autoresearchWrite,
	getAutoresearchPaths,
	runNativeAutoresearchCommand,
} from "@gajae-code/coding-agent/gjc-runtime/autoresearch-runtime";
import {
	autoresearchRlmArtifactRoot,
	sessionAutoresearchDir,
	sessionAutoresearchRunsDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

const runtimeSourcePath = path.join(import.meta.dir, "..", "..", "src", "gjc-runtime", "autoresearch-runtime.ts");

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-runtime-"));
	tempRoots.push(dir);
	return dir;
}

function baseMission(root: string, overrides: Partial<Parameters<typeof autoresearchWrite>[0]> = {}) {
	return {
		cwd: root,
		objective: "Optimize the tokenizer hot path",
		mode: "web" as AutoresearchMode,
		deliverables: ["Benchmark report", "Patch series"],
		constraints: ["No public API change", "Memory under 512 MB"],
		slug: "tokenizer-mission",
		...overrides,
	};
}

async function writeSpec(root: string, content: string): Promise<string> {
	const specPath = path.join(root, "deep-interview-spec.md");
	await fs.writeFile(specPath, content, "utf-8");
	return specPath;
}

const HANDBOFF_SPEC = `# Optimize the tokenizer hot path

## Metadata
- Interview ID: tokenizer-mission
- Type: brownfield

autoresearch-mode: mixed

## Goal
Improve the tokenizer hot path without changing the public API.

## Constraints
- No public API change
- Memory under 512 MB

## Deliverables
- Benchmark report
- Patch series
`;

describe("autoresearch session layout", () => {
	it("resolves every autoresearch path under .gjc/_session-{id}/", () => {
		const root = "/repo";
		const sessionDir = sessionAutoresearchDir(root, TEST_SESSION_ID);
		expect(sessionDir).toBe(path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`, "autoresearch"));
		expect(sessionAutoresearchRunsDir(root, TEST_SESSION_ID)).toBe(path.join(sessionDir, "runs"));
		expect(autoresearchRlmArtifactRoot(root, TEST_SESSION_ID, "run-1")).toBe(path.join(sessionDir, "runs", "run-1"));

		const paths = getAutoresearchPaths(root, TEST_SESSION_ID);
		for (const candidate of [paths.dir, paths.missionPath, paths.ledgerPath]) {
			const relative = path.relative(path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`), candidate);
			expect(relative.startsWith("..")).toBe(false);
			expect(path.isAbsolute(relative)).toBe(false);
		}
		expect(paths.missionPath).toBe(path.join(sessionDir, "mission.json"));
		expect(paths.ledgerPath).toBe(path.join(sessionDir, "ledger.jsonl"));
	});

	it("never writes the legacy global autoresearch store (grep-style)", async () => {
		const source = await Bun.file(runtimeSourcePath).text();
		// The dead global store path must not appear anywhere in the runtime
		// source: no write target can resolve there if the literal path is absent.
		expect(source).not.toContain("~/.gjc/autoresearch");
		expect(source).not.toContain("getAutoresearchDbPath");
		expect(source).not.toContain("getAutoresearchProjectDir");
		expect(source).not.toContain(".gjc/autoresearch");
		// All persisted targets route through the sanctioned .gjc/** writers.
		expect(source).toContain("writeGuardedJsonAtomic");
		expect(source).toContain("appendJsonl");
	});
});

describe("autoresearch mission write boundary (AC-16)", () => {
	it("rejects a missing mode", async () => {
		const root = await tempDir();
		const result = await autoresearchWrite({
			...baseMission(root),
			mode: undefined as unknown as AutoresearchMode,
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("must be one of web, mixed, or data");
		expect((result as Error).message).toContain("never inferred");
	});

	it("rejects an invalid mode value", async () => {
		const root = await tempDir();
		const result = await autoresearchWrite({
			...baseMission(root),
			mode: "bogus" as AutoresearchMode,
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("must be one of web, mixed, or data");
	});

	it("rejects a missing mode even when a data file is present (mode is never inferred)", async () => {
		const root = await tempDir();
		// A data file at the exact session root a mode would have been inferred
		// from, if the runtime inferred modes — it must not.
		await fs.mkdir(path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`, "autoresearch"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`, "autoresearch", "DATA.md"),
			"# dataset\n",
			"utf-8",
		);
		const result = await autoresearchWrite({
			...baseMission(root),
			mode: undefined as unknown as AutoresearchMode,
		}).catch((error: unknown) => error);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("must be one of web, mixed, or data");
		expect((result as Error).message).toContain("never inferred");
	});

	it("persists an explicit mode on the mission artifact", async () => {
		const root = await tempDir();
		const receipt = await autoresearchWrite(baseMission(root, { mode: "data" }));
		expect(receipt.ok).toBe(true);
		expect(receipt.mission.mode).toBe("data");
		const readBack = await autoresearchRead(root, TEST_SESSION_ID);
		expect(readBack.mission?.mode).toBe("data");
	});
});

describe("autoresearch ledger", () => {
	it("appends events in order with the expected kinds", async () => {
		const root = await tempDir();
		await autoresearchWrite(baseMission(root)); // mission_created
		await autoresearchWrite(baseMission(root, { mode: "data" })); // mode_set
		await autoresearchLogRun({
			cwd: root,
			runId: "run-1",
			status: "keep",
			description: "first baseline",
			metric: 42,
			slug: "tokenizer-mission",
		}); // run_logged
		await autoresearchRecordCritic({
			cwd: root,
			status: { verdict: "OKAY", pass: true },
			evidence: ["critic read the report"],
			caveats: [],
			evaluator: "critic-agent",
			slug: "tokenizer-mission",
		}); // critic_recorded
		await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "best_effort", confidence: 0.8 },
			evidence: ["benchmark improved 12%"],
			caveats: ["single machine only"],
			evaluator: "mission-agent",
			slug: "tokenizer-mission",
		}); // verdict_issued
		await autoresearchClear(root); // kernel_cleared

		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		expect(ledger.map(event => event.event)).toEqual([
			"mission_created",
			"mode_set",
			"run_logged",
			"critic_recorded",
			"verdict_issued",
			"kernel_cleared",
		]);
		expect(new Set(ledger.map(event => event.event))).toEqual(new Set(AUTORESEARCH_LEDGER_EVENT_KINDS));
		for (const event of ledger) {
			expect(typeof event.eventId).toBe("string");
			expect(event.eventId.length).toBeGreaterThan(0);
			expect(typeof event.timestamp).toBe("string");
		}
	});

	it("emits mission_created on create and mode_set only on a mode change", async () => {
		const root = await tempDir();
		const created = await autoresearchWrite(baseMission(root));
		expect(created.ledgerEvent?.event).toBe("mission_created");
		expect(created.ledgerEvent?.mode).toBe("web");

		const changed = await autoresearchWrite(baseMission(root, { mode: "mixed" }));
		expect(changed.ledgerEvent?.event).toBe("mode_set");
		expect(changed.ledgerEvent?.mode).toBe("mixed");
		expect(changed.ledgerEvent?.previousMode).toBe("web");

		const unchanged = await autoresearchWrite(baseMission(root, { mode: "mixed" }));
		expect(unchanged.ledgerEvent).toBeUndefined();
	});

	it("clear removes the mission and emits kernel_cleared", async () => {
		const root = await tempDir();
		await autoresearchWrite(baseMission(root));
		const clear = await autoresearchClear(root);
		expect(clear.cleared).toBe(true);
		expect(clear.ledgerEvent.event).toBe("kernel_cleared");
		const readBack = await autoresearchRead(root, TEST_SESSION_ID);
		expect(readBack.exists).toBe(false);
		const kinds = readBack.ledger.map(event => event.event);
		expect(kinds).toEqual(["mission_created", "kernel_cleared"]);
	});
});

describe("autoresearch verdict receipts", () => {
	it("round-trips a verdict receipt with an optional critic receipt of a distinct evaluator", async () => {
		const root = await tempDir();
		await autoresearchWrite(baseMission(root));
		const criticReceipt = await autoresearchRecordCritic({
			cwd: root,
			status: { verdict: "OKAY", pass: true },
			evidence: ["critic reviewed the report and notebook"],
			caveats: ["notebook cells not re-run"],
			evaluator: "critic-agent-42",
			slug: "tokenizer-mission",
		});
		const verdict = await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "best_effort", terminal: false, confidence: 0.8 },
			evidence: ["benchmark improved 12%"],
			caveats: ["single machine only"],
			evaluator: "mission-agent",
			criticReceipt,
			slug: "tokenizer-mission",
		});

		expect(verdict.receiptId.length).toBeGreaterThan(0);
		expect(verdict.status).toEqual({ verdict: "best_effort", terminal: false, confidence: 0.8 });
		expect(verdict.evidence).toEqual(["benchmark improved 12%"]);
		expect(verdict.caveats).toEqual(["single machine only"]);
		expect(verdict.evaluator).toBe("mission-agent");
		expect(verdict.criticReceipt).toBeDefined();
		expect(verdict.criticReceipt!.criticId.length).toBeGreaterThan(0);
		expect(verdict.criticReceipt!.status).toEqual({ verdict: "OKAY", pass: true });
		expect(verdict.criticReceipt!.evaluator).toBe("critic-agent-42");
		expect(verdict.criticReceipt!.evaluator).not.toBe(verdict.evaluator);

		// The ledger row persists the full receipt; re-read round-trips it.
		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		const issued = ledger.find(event => event.event === "verdict_issued");
		expect(issued).toBeDefined();
		const persisted = issued!.verdictReceipt as AutoresearchVerdictReceiptLike;
		expect(persisted.receiptId).toBe(verdict.receiptId);
		expect(persisted.status).toEqual(verdict.status);
		expect(persisted.evidence).toEqual(verdict.evidence);
		expect(persisted.caveats).toEqual(verdict.caveats);
		expect(persisted.evaluator).toBe("mission-agent");
		expect(persisted.criticReceipt).toEqual(verdict.criticReceipt);

		const criticRecorded = ledger.find(event => event.event === "critic_recorded");
		expect(criticRecorded).toBeDefined();
		expect((criticRecorded!.criticReceipt as AutoresearchCriticReceiptLike).evaluator).toBe("critic-agent-42");
	});

	it("records a critic pass without a mission verdict (critic_recorded is its own kind)", async () => {
		const root = await tempDir();
		await autoresearchWrite(baseMission(root));
		const critic = await autoresearchRecordCritic({
			cwd: root,
			status: { verdict: "ITERATE", pass: false },
			evidence: ["report misses the cold-start numbers"],
			caveats: [],
			evaluator: "critic-agent-7",
		});
		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		expect(ledger.map(event => event.event)).toEqual(["mission_created", "critic_recorded"]);
		expect(critic.evaluator).toBe("critic-agent-7");
	});
});

describe("autoresearch intake (AC-14..AC-15)", () => {
	it("handoff intake via --spec writes the mission and asks zero questions", async () => {
		const root = await tempDir();
		const specPath = await writeSpec(root, HANDBOFF_SPEC);
		const result = await runNativeAutoresearchCommand(["--spec", specPath, "--json"], root);
		expect(result.status).toBe(0);
		expect(result.intake).toBe("handoff");
		expect(result.missionCreated).toBe(true);
		const payload = JSON.parse(result.stdout!) as {
			intake: string;
			mission: { objective: string; mode: string; slug: string; deliverables: string[]; constraints: string[] };
			mission_path: string;
		};
		expect(payload.intake).toBe("handoff");
		expect(payload.mission.mode).toBe("mixed");
		expect(payload.mission.slug).toBe("tokenizer-mission");
		expect(payload.mission.objective).toBe("Optimize the tokenizer hot path");
		expect(payload.mission.deliverables).toEqual(["Benchmark report", "Patch series"]);
		expect(payload.mission.constraints).toEqual(["No public API change", "Memory under 512 MB"]);
		// Zero clarification questions: no clarification signal in the receipt.
		expect(JSON.stringify(payload)).not.toContain("clarification_required");

		const mission = (await autoresearchRead(root, TEST_SESSION_ID)).mission;
		expect(mission?.intake).toBe("handoff");
		expect(mission?.specPath).toBe(specPath);
		expect(mission?.handedOffAt).toBeDefined();
	});

	it("handoff intake hard-fails when the spec declares no explicit mode", async () => {
		const root = await tempDir();
		const specPath = await writeSpec(root, "# A spec without a mode declaration\n\n## Constraints\n- Nothing\n");
		const result = await runNativeAutoresearchCommand(["--spec", specPath], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("autoresearch-mode");
		expect(result.stderr).toContain("never inferred");
	});

	it("handoff intake accepts a bulleted mode declaration in the metadata block", async () => {
		const root = await tempDir();
		const specPath = await writeSpec(
			root,
			"# Bulleted metadata\n\n## Metadata\n- Interview ID: bulleted-mission\n- autoresearch-mode: data\n",
		);
		const result = await runNativeAutoresearchCommand(["--spec", specPath, "--json"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout!) as { mission: { mode: string; slug: string } };
		expect(payload.mission.mode).toBe("data");
		expect(payload.mission.slug).toBe("bulleted-mission");
	});

	it("bare invocation is cold intake and flags clarification", async () => {
		const root = await tempDir();
		const result = await runNativeAutoresearchCommand(["--json"], root);
		expect(result.status).toBe(0);
		expect(result.intake).toBe("cold");
		const payload = JSON.parse(result.stdout!) as { intake: string; clarification_required: boolean };
		expect(payload.intake).toBe("cold");
		expect(payload.clarification_required).toBe(true);
		// No mission may exist: clarification must happen before research begins.
		expect((await autoresearchRead(root, TEST_SESSION_ID)).exists).toBe(false);
	});

	it("positional goal is cold intake and carries the goal text", async () => {
		const root = await tempDir();
		const result = await runNativeAutoresearchCommand(["Optimize the tokenizer throughput", "--json"], root);
		expect(result.status).toBe(0);
		expect(result.intake).toBe("cold");
		const payload = JSON.parse(result.stdout!) as {
			intake: string;
			goal: string;
			clarification_required: boolean;
		};
		expect(payload.intake).toBe("cold");
		expect(payload.goal).toBe("Optimize the tokenizer throughput");
		expect(payload.clarification_required).toBe(true);
		expect((await autoresearchRead(root, TEST_SESSION_ID)).exists).toBe(false);
	});

	it("writes a clarified cold mission, reads it through the CLI, and clears it through the CLI", async () => {
		const root = await tempDir();
		const write = await runNativeAutoresearchCommand(
			[
				"write",
				"--goal",
				"Measure parser throughput",
				"--mode",
				"data",
				"--slug",
				"parser-throughput",
				"--deliverable",
				"Verdict",
				"--constraint",
				"No source edits",
				"--json",
			],
			root,
		);
		expect(write.status).toBe(0);
		const written = JSON.parse(write.stdout!) as { mission: { slug: string; mode: string; objective: string } };
		expect(written.mission.slug).toBe("parser-throughput");
		expect(written.mission.mode).toBe("data");
		expect(written.mission.objective).toBe("Measure parser throughput");
		const read = await runNativeAutoresearchCommand(["read", "--json"], root);
		expect(read.status).toBe(0);
		const readPayload = JSON.parse(read.stdout!) as {
			exists: boolean;
			mission: { slug: string };
			ledger: Array<{ event: string }>;
		};
		expect(readPayload.exists).toBe(true);
		expect(readPayload.mission.slug).toBe("parser-throughput");
		expect(readPayload.ledger.map(entry => entry.event)).toEqual(["mission_created"]);
		const cleared = await runNativeAutoresearchCommand(["clear", "--json"], root);
		expect(cleared.status).toBe(0);
		expect(JSON.parse(cleared.stdout!)).toMatchObject({ cleared: true, ledger_event: "kernel_cleared" });
		expect((await autoresearchRead(root, TEST_SESSION_ID)).exists).toBe(false);
	});

	it("rejects unsafe cold mission slugs", async () => {
		const root = await tempDir();
		const result = await runNativeAutoresearchCommand(
			["write", "--goal", "Measure parser throughput", "--mode", "data", "--slug", "!!!"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid path component");
	});

	it("records run, critic, verdict, and report through public CLI verbs", async () => {
		const root = await tempDir();
		await runNativeAutoresearchCommand(
			["write", "--goal", "Measure parser throughput", "--mode", "data", "--slug", "parser-throughput"],
			root,
		);
		const run = await runNativeAutoresearchCommand(
			["log-run", "--run-id", "run-1", "--status", "keep", "--description", "baseline", "--metric", "42"],
			root,
		);
		expect(run.status).toBe(0);
		const critic = await runNativeAutoresearchCommand(
			["critic", "--status-json", '{"verdict":"OKAY"}', "--evidence", "reviewed", "--evaluator", "critic"],
			root,
		);
		expect(critic.status).toBe(0);
		const verdict = await runNativeAutoresearchCommand(
			["verdict", "--status-json", '{"verdict":"best_effort"}', "--evidence", "measured", "--evaluator", "agent"],
			root,
		);
		expect(verdict.status).toBe(0);
		const report = await runNativeAutoresearchCommand(["report", "--summary", "Measured parser throughput"], root);
		expect(report.status).toBe(0);
		expect(report.stdout).toContain("report_path=");
		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		expect(ledger.map(entry => entry.event)).toEqual([
			"mission_created",
			"run_logged",
			"critic_recorded",
			"verdict_issued",
		]);
	});

	it("rejects unknown flags", async () => {
		const root = await tempDir();
		const result = await runNativeAutoresearchCommand(["--bogus"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown flag");
	});

	it("renders help without touching any session state", async () => {
		const root = await tempDir();
		const result = await runNativeAutoresearchCommand(["--help"], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--spec");
		expect(result.stdout).toContain("Handoff intake");
		expect(result.stdout).toContain("Cold intake");
		expect((await autoresearchRead(root, TEST_SESSION_ID)).exists).toBe(false);
	});

	it("handoff intake reads a spec, asks nothing, and still refuses to infer mode", async () => {
		const root = await tempDir();
		const specPath = path.join(root, "deep-interview-demo.md");

		// A spec with no explicit mode declaration must be rejected, even though a
		// data file sits right next to it: mode is never inferred (AC-16).
		await fs.writeFile(path.join(root, "DATA.md"), "# dataset\n", "utf-8");
		await fs.writeFile(specPath, "# Spec\n\n## Goal\n\nMeasure throughput.\n", "utf-8");
		await expect(autoresearchHandoff({ cwd: root, specPath })).rejects.toThrow(/mission mode explicitly/);

		// With the mode declared, handoff intake succeeds and asks zero questions.
		await fs.writeFile(specPath, "# Spec\n\nautoresearch-mode: data\n\n## Goal\n\nMeasure throughput.\n", "utf-8");
		const receipt = await autoresearchHandoff({ cwd: root, specPath });

		expect(receipt.mission.mode).toBe("data");
		expect(receipt.specPath).toBe(specPath);
		const persisted = await autoresearchRead(root, TEST_SESSION_ID);
		expect(persisted.exists).toBe(true);
		expect(persisted.mission?.mode).toBe("data");
	});

	it("handoff intake fails closed when the spec path does not exist", async () => {
		const root = await tempDir();
		await expect(autoresearchHandoff({ cwd: root, specPath: path.join(root, "missing-spec.md") })).rejects.toThrow(
			/could not read spec/,
		);
	});
});

interface AutoresearchVerdictReceiptLike {
	receiptId: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	criticReceipt?: AutoresearchCriticReceiptLike;
}

interface AutoresearchCriticReceiptLike {
	criticId: string;
	status: Record<string, unknown>;
	evidence: string[];
	caveats: string[];
	evaluator: string;
	recordedAt: string;
}
