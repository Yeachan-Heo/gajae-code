import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { getWorkflowMutationDecision } from "@gajae-code/coding-agent/skill-state/workflow-mutation-guard";

const SESSION_ID = "redteam-session";
const tempRoots: string[] = [];
const CONTINUATION = "\\\n";

type PlanningPhase = {
	skill: "deep-interview" | "ralplan" | "ultragoal";
	phase: string;
};

const PLANNING_PHASES: PlanningPhase[] = [
	{ skill: "deep-interview", phase: "interviewing" },
	{ skill: "ralplan", phase: "planner" },
	{ skill: "ultragoal", phase: "goal-planning" },
];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-guard-redteam-"));
	tempRoots.push(root);
	return root;
}

async function writeActiveSkill(cwd: string, planning: PlanningPhase): Promise<void> {
	const now = new Date().toISOString();
	await fs.mkdir(sessionStateDir(cwd, SESSION_ID), { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: planning.skill,
		phase: planning.phase,
		updated_at: now,
		active_skills: [
			{
				skill: planning.skill,
				phase: planning.phase,
				active: true,
				updated_at: now,
				session_id: SESSION_ID,
			},
		],
	};
	await Bun.write(activeSnapshotPath(cwd, SESSION_ID), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, SESSION_ID, planning.skill),
		`${JSON.stringify({ active: true, current_phase: planning.phase, session_id: SESSION_ID }, null, 2)}\n`,
	);
}

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	} as AgentTool;
}

async function decisionFor(cwd: string, command: string) {
	return getWorkflowMutationDecision({
		cwd,
		sessionId: SESSION_ID,
		tool: tool("bash"),
		args: { command },
	});
}

/** Commands that are pure gjc/read-only flows and must remain usable in planning. */
const LEGIT_GJC_FLOWS = [
	"gjc state read --json | jq .valid",
	"gjc state read --json && gjc ultragoal status --json",
	"gjc state read --json; gjc deep-interview status --json",
	"GJC_SESSION_ID=s1 gjc deep-interview inspect --session-id s1 --json",
	"LC_ALL=C LANG=C TZ=UTC NO_COLOR=1 GJC_SESSION_ID=s1 gjc state read --json",
	"echo hi | gjc state read --json",
	"gjc state read --json | jq . | grep true | head -1 | wc -l",
	"gjc state read --json || true",
	"gjc state read --json | tr -d '\\n'",
	'gjc state read --json <<\'EOF\'\nDIFFERENT_DELIMITER\nopen("src/product.ts", "w")\nEOF',
	"cat <<'A' | gjc state read --json\nfirst heredoc\nA",
	"cat <<'A' <<'B' | gjc state read --json\nfirst heredoc\nA\nsecond heredoc\nB",
	"'gjc' state read --json",
	'"gjc" state read --json',
	"gjc state read --json\r\n",
	'bun -e \'const p=Bun.spawnSync(["gjc","deep-interview","inspect","--json"]); process.stdout.write(p.stdout)\'',
] as const;

/** Known mutators and syntax forms that the baseline scanner must reject. */
const KNOWN_MUTATION_CASES = [
	// sort's output switches: bare, combined, path-prefixed, and quoted forms.
	// Attached short-option argument (`-oFILE`) still names an output file.
	"gjc state read --json | sort -osrc/product.ts",
	"gjc state read --json | sort -o src/product.ts",
	"gjc state read --json | sort --output=src/product.ts",
	"gjc state read --json | sort -uo src/product.ts",
	"gjc state read --json | /usr/bin/sort -o src/product.ts",
	"gjc state read --json | /usr/bin/sort --output=src/product.ts",
	'gjc state read --json | "sort" -o src/product.ts',
	"gjc state read --json | 'sort' --output=src/product.ts",
	"gjc state read --json | '/usr/bin/sort' -o src/product.ts",

	// A mutating segment alongside gjc must not inherit the whitelist.
	"gjc state read --json && tee src/product.ts",
	"gjc state read --json; touch src/product.ts",
	'gjc state read --json && python -c \'open("src/product.ts", "w").write("x")\'',
	"gjc state read --json > src/product.ts",
	"gjc state read --json | tr -d '\\n' > src/product.ts",
	// Delimiter oddities, CRLF, multiple heredocs, and hidden post-heredoc writes.
	"gjc state read --json <<'EOF'\nNOT_EOF\ntouch src/product.ts\nEOF\ntouch src/product.ts",
	"gjc state read --json <<'A' <<'B'\nA\nB\ntouch src/product.ts\nA\nB",
	"gjc state read --json\r\ntee src/product.ts",
	// Empty list segments must not hide a following mutator.
	"gjc state read --json && && tee src/product.ts",
	"gjc state read --json || ; tee src/product.ts",
	// Backslash continuation after a list delimiter and after a heredoc operator.
	`gjc state read --json && ${CONTINUATION}tee src/product.ts`,
	`gjc state read --json <<'EOF' ${CONTINUATION}; tee src/product.ts\nEOF`,
	// Function-definition syntax without `()` still executes its body when called.
	"gjc state read --json && true; function write_it { echo x > src/product.ts; }; write_it",
] as const;

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workflow guard gjc whitelist red-team", () => {
	it("G1 admits pure gjc/read-only pipelines in every active planning phase", async () => {
		for (const planning of PLANNING_PHASES) {
			const cwd = await makeTempRoot();
			await writeActiveSkill(cwd, planning);
			for (const command of LEGIT_GJC_FLOWS) {
				const decision = await decisionFor(cwd, command);
				expect(decision.blocked, `${planning.skill}/${planning.phase}: ${command}`).toBe(false);
				expect(decision.targets).toEqual([]);
			}
		}
	});

	it("G2 blocks known mutators across sort, heredoc, delimiter, and shell syntax variants", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, PLANNING_PHASES[0]);
		for (const command of KNOWN_MUTATION_CASES) {
			const decision = await decisionFor(cwd, command);
			expect(decision.blocked, command).toBe(true);
		}
	});

	it("G3 blocks explicit mutating segments beside an admitted gjc segment", async () => {
		const cwd = await makeTempRoot();
		await writeActiveSkill(cwd, { skill: "ralplan", phase: "planner" });
		for (const command of [
			"gjc ralplan status --json && tee src/product.ts",
			'gjc ralplan status --json && python -c \'open("src/product.ts", "w").write("x")\'',
			"gjc ralplan status --json && command tee src/product.ts",
		]) {
			const decision = await decisionFor(cwd, command);
			expect(decision.blocked, command).toBe(true);
		}
	});
});
