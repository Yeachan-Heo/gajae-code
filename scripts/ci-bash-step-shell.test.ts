import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";

/**
 * A `run:` step that uses Bash syntax must say so when its job can land on a Windows
 * runner: GitHub's default shell there is PowerShell, where `set -euo pipefail` fails
 * before the step body executes. The diagnostic artifact provenance steps run in the
 * cross-platform binaries matrix, so they have to declare `shell: bash`.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

type Step = { name?: string; run?: string; shell?: string; uses?: string; if?: string };
type Job = {
	"runs-on"?: unknown;
	defaults?: { run?: { shell?: string } };
	strategy?: { matrix?: Record<string, unknown> };
	steps?: Step[];
};
type Workflow = { defaults?: { run?: { shell?: string } }; jobs?: Record<string, Job> };

/** Constructs that only a POSIX shell understands. */
const BASH_ONLY_MARKERS = ["set -euo pipefail", "set -eu ", "set -e\n"];

function usesBashSyntax(run: string): boolean {
	return BASH_ONLY_MARKERS.some(marker => run.includes(marker));
}

/** Whether a step's own condition already keeps it off Windows runners. */
function excludedFromWindows(step: Step): boolean {
	const condition = step.if ?? "";
	return /runner\.os\s*!=\s*'Windows'/.test(condition) || /matrix\.platform\s*!=\s*'win32'/.test(condition);
}

/** Whether any runner this job can use is a Windows image. */
function canRunOnWindows(job: Job): boolean {
	const serialized = JSON.stringify([job["runs-on"], job.strategy?.matrix ?? null]).toLowerCase();
	return serialized.includes("windows");
}

async function workflowFiles(): Promise<string[]> {
	const entries = await fs.readdir(WORKFLOWS);
	return entries.filter(entry => entry.endsWith(".yml") || entry.endsWith(".yaml")).sort();
}

describe("cross-platform run steps declare their shell", () => {
	it("gives every Windows-capable Bash step an explicit shell", async () => {
		const offenders: string[] = [];
		for (const file of await workflowFiles()) {
			const document = parse(await Bun.file(path.join(WORKFLOWS, file)).text()) as Workflow;
			const workflowShell = document.defaults?.run?.shell;
			for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
				if (!canRunOnWindows(job)) continue;
				const jobShell = job.defaults?.run?.shell ?? workflowShell;
				for (const step of job.steps ?? []) {
					if (typeof step.run !== "string" || !usesBashSyntax(step.run)) continue;
					if (excludedFromWindows(step)) continue;
					// An explicit non-Bash shell is a deliberate choice, not a defect.
					const shell = step.shell ?? jobShell;
					if (shell !== undefined && !shell.startsWith("bash")) continue;
					if (shell === undefined) {
						offenders.push(`${file} :: ${jobName} :: ${step.name ?? step.run.slice(0, 40)}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps the diagnostic provenance steps valid Bash", async () => {
		const document = parse(await Bun.file(path.join(WORKFLOWS, "ci.yml")).text()) as Workflow;
		const provenanceSteps: (Step & { windowsCapable: boolean })[] = [];
		for (const job of Object.values(document.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (typeof step.run === "string" && step.run.includes("verify-diagnostic-artifact-provenance.ts")) {
					provenanceSteps.push({ ...step, windowsCapable: canRunOnWindows(job) });
				}
			}
		}
		// Exactly one of them is the cross-platform binaries step.
		expect(provenanceSteps.filter(step => step.windowsCapable).length).toBe(1);
		expect(provenanceSteps.length).toBeGreaterThanOrEqual(2);
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-ci-shell-"));
		const bash = Bun.which("bash") ?? "/bin/bash";
		try {
			for (const [index, step] of provenanceSteps.entries()) {
				// Only a Windows-capable step needs an explicit shell; a Linux-only job may
				// rely on the runner default, and demanding more would change unrelated jobs.
				if (step.windowsCapable) expect(step.shell).toBe("bash");
				// Actual local syntax check of the script body, not just its YAML shape.
				const scriptPath = path.join(workspace, `step-${index}.sh`);
				await Bun.write(scriptPath, `${step.run}\n`);
				const checked = Bun.spawnSync({
					cmd: [bash, "-n", scriptPath],
					stdout: "pipe",
					stderr: "pipe",
				});
				expect({
					index,
					exitCode: checked.exitCode,
					stderr: new TextDecoder().decode(checked.stderr ?? new Uint8Array()),
				}).toEqual({ index, exitCode: 0, stderr: "" });
			}
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("leaves the Linux-only provenance step untouched", async () => {
		const raw = await Bun.file(path.join(WORKFLOWS, "ci.yml")).text();
		// The scope of this contribution is the cross-platform step; adding a Windows
		// shell/comment to a Linux-only job would be an unrelated graph change. Main
		// native consumers also verify transferred provenance on Linux-only runners.
		expect(raw.split("# The binaries matrix includes a Windows runner").length - 1).toBe(1);
		const document = parse(raw) as Workflow;
		const linuxOnly = Object.values(document.jobs ?? {})
			.filter(job => !canRunOnWindows(job))
			.flatMap(job => job.steps ?? [])
			.filter(step => typeof step.run === "string" && step.run.includes("verify-diagnostic-artifact-provenance.ts"));
		expect(linuxOnly.length).toBe(3);
		expect(linuxOnly.filter(step => step.shell === undefined)).toHaveLength(1);
	});

	it("parses every workflow with the repository's own YAML checker", async () => {
		const checked = Bun.spawnSync({
			cmd: [process.execPath, path.join(REPO_ROOT, "scripts", "check-workflow-yaml.ts")],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(checked.exitCode).toBe(0);
	});
});
