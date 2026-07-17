import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	emitMermaid,
	insertPlanGraphBlock,
	PLAN_GRAPH_BEGIN_MARKER,
	PLAN_GRAPH_END_MARKER,
	PlanGraphError,
	parsePlanSteps,
	runNativePlanGraphCommand,
	validatePlanGraph,
} from "@gajae-code/coding-agent/gjc-runtime/plan-graph-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-plan-graph-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const NORMAL_PLAN = `# Plan: build the parser

Some prose describing the plan.

## Plan Steps

| id | title | depends_on | role | risk | acceptance |
|----|-------|------------|------|------|------------|
| S1 | parser skeleton | - | executor | - | fixtures parse |
| S2 | mermaid emitter | S1 | executor | low: naming churn | emitter output matches fixture |
| S3 | idempotent insert | S2 | executor | med: marker collision | double run diff is empty |
| S4 | ralplan SKILL contract | - | planner | high: upstream agreement needed | real ralplan output contains section |

## ADR

Decision text.
`;

const CYCLE_PLAN = `## Plan Steps

| id | title | depends_on | role | risk | acceptance |
|----|-------|------------|------|------|------------|
| S1 | a | S3 | executor | - | ok |
| S2 | b | S1 | executor | - | ok |
| S3 | c | S2 | executor | - | ok |
`;

const DANGLING_PLAN = `## Plan Steps

| id | title | depends_on | role | risk | acceptance |
|----|-------|------------|------|------|------------|
| S1 | a | - | executor | - | ok |
| S2 | b | S9 | executor | - | ok |
`;

const MALFORMED_PLAN = `## Plan Steps

| id | title | depends_on | role | risk | acceptance |
|----|-------|------------|------|------|------------|
| S1 | a | - | executor | catastrophic: nope | ok |
`;

function tinyPlan(row: string, header?: string, separator?: string): string {
	return `## Plan Steps\n\n${header ?? "| id | title | depends_on | role | risk | acceptance |"}\n${
		separator ?? "|----|-------|------------|------|------|------------|"
	}\n${row}\n`;
}

async function writePlan(dir: string, content: string, name = "plan.md"): Promise<string> {
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, content, "utf-8");
	return filePath;
}

function expectKind(fn: () => unknown, kind: string): PlanGraphError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(PlanGraphError);
		expect((error as PlanGraphError).kind).toBe(kind);
		return error as PlanGraphError;
	}
	throw new Error(`expected PlanGraphError(${kind})`);
}

describe("plan-graph parser + validation", () => {
	it("parses the normal fixture into steps, edges, and risks", () => {
		const table = parsePlanSteps(NORMAL_PLAN);
		const graph = validatePlanGraph(table.steps);
		expect(graph.steps.map(step => step.id)).toEqual(["S1", "S2", "S3", "S4"]);
		expect(graph.edges).toEqual([
			{ from: "S1", to: "S2" },
			{ from: "S2", to: "S3" },
		]);
		expect(graph.steps[0].risk).toBeNull();
		expect(graph.steps[1].risk).toEqual({ level: "low", note: "naming churn" });
		expect(graph.steps[3].risk).toEqual({ level: "high", note: "upstream agreement needed" });
	});

	it("fails closed on a dependency cycle with the cycle path", () => {
		const table = parsePlanSteps(CYCLE_PLAN);
		const error = expectKind(() => validatePlanGraph(table.steps), "cycle");
		expect(error.message).toContain("S1");
	});

	it("survives a degenerate long linear chain without stack overflow", () => {
		const rows: string[] = ["| S1 | step | - | executor | - | ok |"];
		for (let i = 2; i <= 2000; i++) rows.push(`| S${i} | step | S${i - 1} | executor | - | ok |`);
		const plan = `## Plan Steps\n\n| id | title | depends_on | role | risk | acceptance |\n|----|-------|------------|------|------|------------|\n${rows.join("\n")}\n`;
		const graph = validatePlanGraph(parsePlanSteps(plan).steps);
		expect(graph.steps.length).toBe(2000);
		expect(graph.edges.length).toBe(1999);
	});

	it("fails closed on a dangling depends_on reference", () => {
		const table = parsePlanSteps(DANGLING_PLAN);
		const error = expectKind(() => validatePlanGraph(table.steps), "dangling_ref");
		expect(error.message).toContain("S9");
	});

	it("fails closed on a malformed risk cell with a line number", () => {
		const error = expectKind(() => parsePlanSteps(MALFORMED_PLAN), "malformed_row");
		expect(error.message).toMatch(/line \d+/);
	});

	it("fails closed on duplicate step ids", () => {
		const plan = NORMAL_PLAN.replace("| S4 |", "| S1 |");
		const table = parsePlanSteps(plan);
		expectKind(() => validatePlanGraph(table.steps), "duplicate_id");
	});

	it("fails closed when the section is missing", () => {
		expectKind(() => parsePlanSteps("# Plan without steps\n\njust prose\n"), "missing_section");
	});

	it("ignores a Plan Steps heading inside a fenced code example", () => {
		const fencedExample =
			"```markdown\n## Plan Steps\n\n| id | title | depends_on | role | risk | acceptance |\n|----|----|----|----|----|----|\n| S9 | fake | - | executor | - | fake |\n```\n\n";
		const table = parsePlanSteps(fencedExample + NORMAL_PLAN);
		expect(table.steps.map(step => step.id)).toEqual(["S1", "S2", "S3", "S4"]);
	});

	it("fails closed when the only Plan Steps heading is fenced", () => {
		const plan = "```markdown\n## Plan Steps\n```\nprose\n";
		expectKind(() => parsePlanSteps(plan), "missing_section");
	});

	it("fails closed on duplicate Plan Steps sections", () => {
		expectKind(() => parsePlanSteps(`${NORMAL_PLAN}\n${CYCLE_PLAN}`), "duplicate_section");
	});

	it("rejects self-dependency as a cycle", () => {
		const table = parsePlanSteps(tinyPlan("| S1 | a | S1 | executor | - | ok |"));
		expectKind(() => validatePlanGraph(table.steps), "cycle");
	});

	it("rejects a separator row whose column count differs from the header", () => {
		expectKind(
			() => parsePlanSteps(tinyPlan("| S1 | a | - | executor | - | ok |", undefined, "|-|")),
			"malformed_row",
		);
	});

	it("rejects blank depends_on and risk cells (explicit `-` required)", () => {
		expectKind(() => parsePlanSteps(tinyPlan("| S1 | a |  | executor | - | ok |")), "malformed_row");
		expectKind(() => parsePlanSteps(tinyPlan("| S1 | a | - | executor |  | ok |")), "malformed_row");
	});

	it("rejects roles outside the contract enum", () => {
		expectKind(() => parsePlanSteps(tinyPlan("| S1 | a | - | root | - | ok |")), "malformed_row");
	});

	it("rejects a duplicate dependency inside one cell", () => {
		const plan = `## Plan Steps\n\n| id | title | depends_on | role | risk | acceptance |\n|----|----|----|----|----|----|\n| S1 | a | - | executor | - | ok |\n| S2 | b | S1, S1 | executor | - | ok |\n`;
		expectKind(() => parsePlanSteps(plan), "malformed_row");
	});

	it("accepts the optional status column and rejects unknown status values", () => {
		const header = "| id | title | depends_on | role | risk | acceptance | status |";
		const separator = "|----|----|----|----|----|----|----|";
		const table = parsePlanSteps(tinyPlan("| S1 | a | - | executor | - | ok | pending |", header, separator));
		expect(table.steps[0].status).toBe("pending");
		expect(emitMermaid(validatePlanGraph(table.steps))).not.toContain("pending");
		expectKind(
			() => parsePlanSteps(tinyPlan("| S1 | a | - | executor | - | ok | exploded |", header, separator)),
			"malformed_row",
		);
	});
});

describe("plan-graph mermaid emitter", () => {
	it("emits deterministic flowchart text with risk classes", () => {
		const graph = validatePlanGraph(parsePlanSteps(NORMAL_PLAN).steps);
		const mermaid = emitMermaid(graph);
		expect(mermaid.startsWith("flowchart TD")).toBe(true);
		expect(mermaid).toContain('S1["S1: parser skeleton · executor"]');
		expect(mermaid).toContain('S4["⚠ S4: ralplan SKILL contract · planner"]');
		expect(mermaid).toContain("S1 --> S2");
		expect(mermaid).toContain("class S4 riskHigh");
		expect(mermaid).toContain("class S3 riskMed");
		expect(mermaid).toContain("class S2 riskLow");
		expect(emitMermaid(graph)).toBe(mermaid);
	});

	it("sanitizes label text so bracket injection cannot forge nodes or edges", () => {
		const table = parsePlanSteps(tinyPlan("| S1 | x] --> S999[hijack | - | executor | - | ok |"));
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		const labelLine = mermaid.split("\n").find(line => line.includes("S1["));
		expect(labelLine).toBeDefined();
		// Inside the quoted label no structural bracket may survive.
		const inner = (labelLine ?? "").slice((labelLine ?? "").indexOf('"') + 1, (labelLine ?? "").lastIndexOf('"'));
		expect(inner).not.toContain("[");
		expect(inner).not.toContain("]");
		expect(inner).not.toContain(">");
		expect(mermaid).not.toContain("S999[");
	});

	it("escapes double quotes and backticks in titles", () => {
		const table = parsePlanSteps(tinyPlan('| S1 | say "hi" via `cli` | - | executor | - | ok |'));
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		expect(mermaid).toContain("say 'hi' via 'cli'");
	});
});

describe("plan-graph document insertion (idempotency)", () => {
	it("inserts the block after the table, then replaces it on re-run with zero diff", () => {
		const table = parsePlanSteps(NORMAL_PLAN);
		const graph = validatePlanGraph(table.steps);
		const mermaid = emitMermaid(graph);
		const once = insertPlanGraphBlock(NORMAL_PLAN, mermaid, table);
		expect(once).toContain(PLAN_GRAPH_BEGIN_MARKER);
		expect(once).toContain(PLAN_GRAPH_END_MARKER);
		expect(once.indexOf("## ADR")).toBeGreaterThan(once.indexOf(PLAN_GRAPH_END_MARKER));

		const tableAgain = parsePlanSteps(once);
		const twice = insertPlanGraphBlock(once, emitMermaid(validatePlanGraph(tableAgain.steps)), tableAgain);
		expect(twice).toBe(once);
	});

	it("preserves CRLF line endings and stays byte-idempotent", () => {
		const crlfPlan = NORMAL_PLAN.replaceAll("\n", "\r\n");
		const table = parsePlanSteps(crlfPlan);
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		const once = insertPlanGraphBlock(crlfPlan, mermaid, table);
		expect(once.includes("\r\n")).toBe(true);
		// Every newline stays CRLF — no mixed endings.
		expect(once.replaceAll("\r\n", "").includes("\n")).toBe(false);
		const tableAgain = parsePlanSteps(once);
		const twice = insertPlanGraphBlock(once, emitMermaid(validatePlanGraph(tableAgain.steps)), tableAgain);
		expect(twice).toBe(once);
	});

	it("fails closed on an unpaired marker", () => {
		const broken = `${NORMAL_PLAN}\n${PLAN_GRAPH_BEGIN_MARKER}\n`;
		const table = parsePlanSteps(broken);
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		expectKind(() => insertPlanGraphBlock(broken, mermaid, table), "marker_mismatch");
	});

	it("fails closed on two marker pairs instead of replacing only the first", () => {
		const table = parsePlanSteps(NORMAL_PLAN);
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		const once = insertPlanGraphBlock(NORMAL_PLAN, mermaid, table);
		const doubled = `${once}\n${PLAN_GRAPH_BEGIN_MARKER}\nstale\n${PLAN_GRAPH_END_MARKER}\n`;
		const tableAgain = parsePlanSteps(doubled);
		expectKind(() => insertPlanGraphBlock(doubled, mermaid, tableAgain), "marker_mismatch");
	});

	it("ignores marker text quoted inside fenced documentation examples", () => {
		const docExample = `\`\`\`markdown\n${PLAN_GRAPH_BEGIN_MARKER}\nexample\n${PLAN_GRAPH_END_MARKER}\n\`\`\`\n\n`;
		const planWithDocs = docExample + NORMAL_PLAN;
		const table = parsePlanSteps(planWithDocs);
		const mermaid = emitMermaid(validatePlanGraph(table.steps));
		const once = insertPlanGraphBlock(planWithDocs, mermaid, table);
		// The fenced example must be untouched and the real block inserted below the table.
		expect(once).toContain(`${PLAN_GRAPH_BEGIN_MARKER}\nexample`);
		expect(once.indexOf("flowchart TD")).toBeGreaterThan(once.indexOf("| S4 |"));
		const tableAgain = parsePlanSteps(once);
		const twice = insertPlanGraphBlock(once, emitMermaid(validatePlanGraph(tableAgain.steps)), tableAgain);
		expect(twice).toBe(once);
	});
});

describe("native gjc plan-graph command", () => {
	it("updates the plan file in place and reports a summary", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, NORMAL_PLAN);
		const result = await runNativePlanGraphCommand([planPath], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("4 steps, 2 edges");
		expect(result.stdout).toContain("risks high=1 med=1 low=1");
		const updated = await fs.readFile(planPath, "utf-8");
		expect(updated).toContain("```mermaid");
		expect(updated).toContain(PLAN_GRAPH_BEGIN_MARKER);
	});

	it("is idempotent end-to-end: second run leaves the file byte-identical", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, NORMAL_PLAN);
		expect((await runNativePlanGraphCommand([planPath], root)).status).toBe(0);
		const afterFirst = await fs.readFile(planPath, "utf-8");
		const second = await runNativePlanGraphCommand([planPath], root);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("unchanged");
		expect(await fs.readFile(planPath, "utf-8")).toBe(afterFirst);
	});

	it("routes session-scoped .gjc plan documents through the audited artifact writer", async () => {
		const root = await tempDir();
		const runDir = path.join(root, ".gjc", "_session-test", "plans", "ralplan", "run-1");
		await fs.mkdir(runDir, { recursive: true });
		const planPath = path.join(runDir, "pending-approval.md");
		await fs.writeFile(planPath, NORMAL_PLAN, "utf-8");
		const result = await runNativePlanGraphCommand([planPath], root);
		expect(result.status).toBe(0);
		const updated = await fs.readFile(planPath, "utf-8");
		expect(updated).toContain(PLAN_GRAPH_BEGIN_MARKER);
		const second = await runNativePlanGraphCommand([planPath], root);
		expect(second.status).toBe(0);
		expect(await fs.readFile(planPath, "utf-8")).toBe(updated);
	});

	it("fails closed on a .gjc target without a session directory (no plain-write fallback)", async () => {
		const root = await tempDir();
		const sharedDir = path.join(root, ".gjc", "shared");
		await fs.mkdir(sharedDir, { recursive: true });
		const planPath = path.join(sharedDir, "plan.md");
		await fs.writeFile(planPath, NORMAL_PLAN, "utf-8");
		const result = await runNativePlanGraphCommand([planPath], root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[session_unresolved]");
		expect(await fs.readFile(planPath, "utf-8")).toBe(NORMAL_PLAN);
	});

	it("--check validates without writing and reports would-update", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, NORMAL_PLAN);
		const result = await runNativePlanGraphCommand([planPath, "--check"], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("would update");
		expect(await fs.readFile(planPath, "utf-8")).toBe(NORMAL_PLAN);
	});

	it("--check fails on marker defects exactly like a mutating run", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, `${NORMAL_PLAN}\n${PLAN_GRAPH_BEGIN_MARKER}\n`);
		const result = await runNativePlanGraphCommand([planPath, "--check"], root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[marker_mismatch]");
	});

	it("exits 1 with kind-tagged stderr on cycle fixtures", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, CYCLE_PLAN);
		const result = await runNativePlanGraphCommand([planPath], root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[cycle]");
		expect(await fs.readFile(planPath, "utf-8")).toBe(CYCLE_PLAN);
	});

	it("exits 1 on dangling and malformed fixtures", async () => {
		const root = await tempDir();
		const dangling = await runNativePlanGraphCommand([await writePlan(root, DANGLING_PLAN, "dangling.md")], root);
		expect(dangling.status).toBe(1);
		expect(dangling.stderr).toContain("[dangling_ref]");
		const malformed = await runNativePlanGraphCommand([await writePlan(root, MALFORMED_PLAN, "malformed.md")], root);
		expect(malformed.status).toBe(1);
		expect(malformed.stderr).toContain("[malformed_row]");
	});

	it("exits 2 on usage errors", async () => {
		const root = await tempDir();
		expect((await runNativePlanGraphCommand([], root)).status).toBe(2);
		expect((await runNativePlanGraphCommand(["missing.md"], root)).status).toBe(2);
		const planPath = await writePlan(root, NORMAL_PLAN);
		expect((await runNativePlanGraphCommand([planPath, "--format", "png"], root)).status).toBe(2);
	});

	it("--json reports machine-readable counts", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, NORMAL_PLAN);
		const result = await runNativePlanGraphCommand([planPath, "--json"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout);
		expect(payload.steps).toBe(4);
		expect(payload.edges).toBe(2);
		expect(payload.risks).toEqual({ high: 1, med: 1, low: 1 });
		expect(payload.changed).toBe(true);
	});

	it("--format ascii previews all validated nodes without silent fallback", async () => {
		const root = await tempDir();
		const planPath = await writePlan(root, NORMAL_PLAN);
		const result = await runNativePlanGraphCommand([planPath, "--format", "ascii", "--check"], root);
		expect(result.status).toBe(0);
		for (const id of ["S1", "S2", "S3", "S4"]) expect(result.stdout).toContain(`${id}:`);
		expect(result.stdout).not.toContain("unavailable");
	});

	it("warns (but succeeds) above the 30-step readability guideline", async () => {
		const rows: string[] = ["| S1 | step | - | executor | - | ok |"];
		for (let i = 2; i <= 31; i++) rows.push(`| S${i} | step | S${i - 1} | executor | - | ok |`);
		const plan = `## Plan Steps\n\n| id | title | depends_on | role | risk | acceptance |\n|----|-------|------------|------|------|------------|\n${rows.join("\n")}\n`;
		const root = await tempDir();
		const planPath = await writePlan(root, plan);
		const result = await runNativePlanGraphCommand([planPath, "--check"], root);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("warning");
		expect(result.stderr).toContain("31 steps");
	});
});
