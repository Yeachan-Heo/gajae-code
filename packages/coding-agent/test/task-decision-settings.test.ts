import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileSettingsSchema } from "../src/config/settings-schema";

describe("task decision settings", () => {
	it("accepts explicit provider and authority selection without changing ordinary task settings", () => {
		const input = {
			task: {
				decision: { enabled: true, provider: "jev", mode: "routing", timeoutMs: 1234 },
				autorouting: { enabled: false },
			},
		};
		const result = reconcileSettingsSchema(input);
		expect(result.report.valid).toBe(true);
		expect(result.settings.task).toEqual(input.task);
	});

	it("rejects unrecognized providers and authority modes", () => {
		for (const decision of [{ provider: "ollama" }, { mode: "auto" }]) {
			expect(reconcileSettingsSchema({ task: { decision } }).report.valid).toBe(false);
		}
	});

	it("rejects unbounded, fractional, and nonpositive deadlines", () => {
		for (const timeoutMs of [0, -1, 0.5, 60_001, Number.NaN, Number.POSITIVE_INFINITY, "invalid"]) {
			expect(reconcileSettingsSchema({ task: { decision: { timeoutMs } } }).report.valid).toBe(false);
		}
		for (const timeoutMs of [1, 5000, 60_000]) {
			expect(reconcileSettingsSchema({ task: { decision: { timeoutMs } } }).report.valid).toBe(true);
		}
	});
});

const collectorModule = new URL("../src/task/decision-collection.ts", import.meta.url).href;

async function collectIsolated(
	enabled: boolean,
	env: Record<string, string>,
	projectCollection?: string,
): Promise<{ mode: string | null; hasContent: boolean; count: number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-decision-consent-"));
	try {
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		await fs.mkdir(home);
		await fs.mkdir(project);
		if (projectCollection !== undefined) {
			await Bun.write(path.join(project, ".env"), `GJC_TASK_COLLECTION=${projectCollection}\n`);
		}
		const script = path.join(project, "probe.ts");
		await Bun.write(
			script,
			`import { beginTaskDecision, exportTaskDecisionEvents } from ${JSON.stringify(collectorModule)};
const options = { rootDir: ${JSON.stringify(path.join(root, "store"))}, decisionEnabled: ${enabled} };
const recorder = await beginTaskDecision({ role: "executor", taskId: "synthetic", sessionIdHash: "session",
 runMode: "initial", repoCwdHash: "repo", assignmentHash: "assignment", assignment: "synthetic private text" }, options);
await recorder?.finish({status:"completed"});
const events = await exportTaskDecisionEvents({...options, includeContent:true});
process.stdout.write(JSON.stringify({ mode: events[0]?.mode ?? null, hasContent: events[0]?.assignment !== undefined, count:events.length }));
`,
		);
		const child = Bun.spawn([process.execPath, script], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				GJC_CONFIG_DIR: path.join(home, ".gjc"),
				GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("decision collection consent precedence", () => {
	it("automatically collects only metadata for an enabled feature with trusted env unset", async () => {
		expect(await collectIsolated(true, {})).toEqual({ mode: "metadata", hasContent: false, count: 2 });
	});

	it("preserves ordinary opt-in collection when the decision feature is off", async () => {
		expect(await collectIsolated(false, { GJC_TASK_COLLECTION: "metadata" })).toEqual({
			mode: "metadata",
			hasContent: false,
			count: 2,
		});
		expect(await collectIsolated(false, {})).toEqual({ mode: null, hasContent: false, count: 0 });
	});

	it("honors explicit off, unsupported values, and the telemetry kill switch", async () => {
		const cases: Record<string, string>[] = [
			{ GJC_TASK_COLLECTION: "off" },
			{ GJC_TASK_COLLECTION: "invalid" },
			{ GJC_TASK_COLLECTION: "false" },
			{ GJC_TASK_COLLECTION: "content", GJC_DISABLE_TELEMETRY: "1" },
		];
		for (const env of cases) {
			expect(await collectIsolated(true, env)).toEqual({ mode: null, hasContent: false, count: 0 });
		}
	});

	it("allows raw content only through trusted explicit consent, not project dotenv", async () => {
		expect(await collectIsolated(true, { GJC_TASK_COLLECTION: "content" })).toEqual({
			mode: "content",
			hasContent: true,
			count: 2,
		});
		expect(await collectIsolated(true, {}, "content")).toEqual({
			mode: "metadata",
			hasContent: false,
			count: 2,
		});
	});
});
