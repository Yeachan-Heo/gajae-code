import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalSessionRoot, legacySessionRoot } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { resolveGjcSessionForWrite } from "@gajae-code/coding-agent/gjc-runtime/session-resolution";
import {
	createUltragoalPlan,
	getUltragoalStatusForSession,
	readUltragoalPlan,
	recordUltragoalNudgeForSession,
	writePlanForSession,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const SESSION_ID = "test-session";
const roots: string[] = [];

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ultragoal-affinity-"));
	roots.push(cwd);
	const previous = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = SESSION_ID;
	await createUltragoalPlan({ cwd, brief: "Preserve ordinary flow affinity" });
	const canonicalRoot = canonicalSessionRoot(cwd, SESSION_ID);
	const legacyRoot = legacySessionRoot(cwd, SESSION_ID);
	await fs.rename(canonicalRoot, legacyRoot);
	const session = resolveGjcSessionForWrite(cwd, { envSessionId: SESSION_ID });
	const plan = await readUltragoalPlan(cwd, SESSION_ID);
	if (!plan) throw new Error("fixture plan missing");
	await fs.mkdir(canonicalRoot, { recursive: true });
	return { cwd, canonicalRoot, legacyRoot, session, plan, previous };
}

async function restoreEnv(previous: string | undefined): Promise<void> {
	if (previous === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = previous;
}

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("ordinary Ultragoal session affinity", () => {
	it("writes an admitted legacy plan without re-resolving a new canonical duplicate", async () => {
		const { cwd, canonicalRoot, legacyRoot, session, plan, previous } = await fixture();
		try {
			plan.brief = "Updated through admitted legacy authority";
			await writePlanForSession(cwd, plan, session);
			expect(await Bun.file(path.join(legacyRoot, "ultragoal", "brief.md")).text()).toContain("Updated through");
			expect(await Bun.file(path.join(canonicalRoot, "ultragoal", "brief.md")).exists()).toBe(false);
		} finally {
			await restoreEnv(previous);
		}
	});

	it("reads status from the admitted legacy root after a canonical duplicate appears", async () => {
		const { cwd, session, previous } = await fixture();
		try {
			const status = await getUltragoalStatusForSession(cwd, session);
			expect(status.exists).toBe(true);
			expect(status.goals).toHaveLength(1);
		} finally {
			await restoreEnv(previous);
		}
	});

	it("records a nudge in the admitted legacy ledger after a canonical duplicate appears", async () => {
		const { cwd, canonicalRoot, legacyRoot, session, previous } = await fixture();
		try {
			const result = await recordUltragoalNudgeForSession(
				{
					cwd,
					target: { goalId: "G001", targetKind: "story" },
					surface: "pause",
					budget: 2,
					reason: "Affinity regression",
				},
				session,
			);
			expect(result.nudged).toBe(true);
			expect(await Bun.file(path.join(legacyRoot, "ultragoal", "ledger.jsonl")).text()).toContain('"event":"nudge"');
			expect(await Bun.file(path.join(canonicalRoot, "ultragoal", "ledger.jsonl")).exists()).toBe(false);
		} finally {
			await restoreEnv(previous);
		}
	});
});
