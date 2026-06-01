import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SkillTool } from "@gajae-code/coding-agent/tools/skill";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";

async function makeSkill(name: string, content: string): Promise<Skill> {
	const dir = await mkdtemp(path.join(os.tmpdir(), `skill-tool-${name}-`));
	const filePath = path.join(dir, "SKILL.md");
	await writeFile(filePath, content, "utf8");
	return {
		name,
		description: `${name} test skill`,
		filePath,
		baseDir: dir,
		source: "test",
		content,
	};
}

interface CapturedSend {
	message: { customType: string; content: unknown; details?: unknown; attribution?: string };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

async function makeTempCwd(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "skill-tool-cwd-"));
}

function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function stateBaseDir(cwd: string, sessionId?: string): string {
	if (!sessionId) return path.join(cwd, ".gjc/state");
	return path.join(cwd, ".gjc/state/sessions", encodeSessionSegment(sessionId));
}

async function writeCallerModeState(
	cwd: string,
	skill: string,
	currentPhase: string,
	sessionId?: string,
): Promise<void> {
	const filePath = path.join(stateBaseDir(cwd, sessionId), `${skill}-state.json`);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(
		filePath,
		JSON.stringify(
			{
				skill,
				version: 1,
				active: true,
				current_phase: currentPhase,
				...(sessionId ? { session_id: sessionId } : {}),
			},
			null,
			2,
		),
	);
}

async function readModeState(cwd: string, skill: string, sessionId?: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(path.join(stateBaseDir(cwd, sessionId), `${skill}-state.json`), "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return null;
		throw err;
	}
}

function createSession(
	cwd: string,
	skills: Skill[],
	capture: CapturedSend[],
	overrides: Partial<ToolSession> = {},
	streaming = false,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sendCustomMessage: async (message, options) => {
			capture.push({ message, options });
			// streaming flag is a placeholder; underlying agent-session.ts handles steer-vs-append
			// based on its own isStreaming. The test asserts the options arg the tool passes
			// to sendCustomMessage, which is what matters for behavior verification.
			void streaming;
		},
		...overrides,
	};
}

describe("SkillTool", () => {
	it("createIf returns null when no skills are loaded", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sendCustomMessage: async () => {},
		};
		expect(SkillTool.createIf(session)).toBeNull();
	});

	it("createIf returns null when session lacks sendCustomMessage", async () => {
		const ultragoal = await makeSkill("ultragoal", "# Ultragoal\nBody");
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [ultragoal],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(SkillTool.createIf(session)).toBeNull();
	});

	it("dispatches the chained skill same-turn without deliverAs nextTurn", async () => {
		const cwd = await makeTempCwd();
		const ultragoal = await makeSkill("ultragoal", "---\nname: ultragoal\n---\n# Ultragoal\nTrack execution.");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [ultragoal], captured);
		const tool = SkillTool.createIf(session);
		expect(tool).not.toBeNull();

		const result = await tool!.execute("call-1", { name: "ultragoal", args: "go" });
		const firstBlock = result.content[0];
		expect(firstBlock?.type).toBe("text");
		expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("Handed off");
		expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("ultragoal");
		expect(result.details?.name).toBe("ultragoal");
		expect(result.details?.args).toBe("go");

		expect(captured).toHaveLength(1);
		const sent = captured[0]!;
		expect(sent.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(sent.message.attribution).toBe("user");
		expect(sent.options).toEqual({ triggerTurn: false });
		expect(sent.options?.deliverAs).toBeUndefined();

		const content = sent.message.content as string;
		expect(content).toContain("# Ultragoal");
		expect(content).toContain("Track execution.");
		expect(content).toContain("User: go");
	});

	it("omits the User: line when args are absent or whitespace", async () => {
		const cwd = await makeTempCwd();
		const di = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [di], captured);
		const tool = SkillTool.createIf(session)!;
		await tool.execute("call-1", { name: "deep-interview", args: "   " });
		const content = captured[0]!.message.content as string;
		expect(content).not.toContain("User:");
	});

	it("rejects chaining into the currently active skill (recursive-self guard)", async () => {
		const cwd = await makeTempCwd();
		const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nBody");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [deepInterview, ralplan], captured, {
			getActiveSkillState: () => ({ skill: "deep-interview", session_id: "session-1" }),
		});
		const tool = SkillTool.createIf(session)!;

		await expect(tool.execute("call-1", { name: " deep-interview " })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call-1", { name: "deep-interview" })).rejects.toThrow(
			/refusing to chain into currently active skill "deep-interview"/,
		);
		expect(captured).toHaveLength(0);
	});

	it("rejects chaining when caller phase is not terminal (phase guard)", async () => {
		const cwd = await makeTempCwd();
		const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nBody");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [deepInterview, ralplan], captured, {
			getActiveSkillState: () => ({ skill: "deep-interview", session_id: "s1" }),
			getActiveSkillPhase: () => "interviewing",
		});
		const tool = SkillTool.createIf(session)!;

		await expect(tool.execute("call-1", { name: "ralplan" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call-1", { name: "ralplan" })).rejects.toThrow(
			/refusing to chain from "deep-interview" \(phase=interviewing\) into "ralplan"/,
		);
		expect(captured).toHaveLength(0);
	});

	it("chains successfully when caller phase is 'handoff' and atomically updates state", async () => {
		const cwd = await makeTempCwd();
		await writeCallerModeState(cwd, "deep-interview", "handoff", "s1");
		const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [deepInterview, ralplan], captured, {
			getActiveSkillState: () => ({ skill: "deep-interview", session_id: "s1" }),
			getActiveSkillPhase: () => "handoff",
		});
		const tool = SkillTool.createIf(session)!;

		const result = await tool.execute("call-1", { name: "ralplan" });
		expect(result.details?.name).toBe("ralplan");
		expect(captured).toHaveLength(1);

		// Caller mode-state demoted; callee mode-state activated.
		const di = await readModeState(cwd, "deep-interview", "s1");
		expect(di?.active).toBe(false);
		expect(di?.current_phase).toBe("handoff");
		expect(di?.handoff_to).toBe("ralplan");
		const rp = await readModeState(cwd, "ralplan", "s1");
		expect(rp?.active).toBe(true);
		expect(rp?.handoff_from).toBe("deep-interview");
	});

	it("supports R->U handoff (ralplan in handoff phase chains to ultragoal)", async () => {
		const cwd = await makeTempCwd();
		await writeCallerModeState(cwd, "ralplan", "handoff", "s1");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");
		const ultragoal = await makeSkill("ultragoal", "---\nname: ultragoal\n---\nGo");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [ralplan, ultragoal], captured, {
			getActiveSkillState: () => ({ skill: "ralplan", session_id: "s1" }),
			getActiveSkillPhase: () => "handoff",
		});
		const tool = SkillTool.createIf(session)!;

		await tool.execute("call-1", { name: "ultragoal" });
		const rp = await readModeState(cwd, "ralplan", "s1");
		expect(rp?.active).toBe(false);
		expect(rp?.handoff_to).toBe("ultragoal");
		const ug = await readModeState(cwd, "ultragoal", "s1");
		expect(ug?.active).toBe(true);
		expect(ug?.handoff_from).toBe("ralplan");
	});

	it("supports backward U->R chain (ultragoal in handoff phase chains to ralplan)", async () => {
		const cwd = await makeTempCwd();
		await writeCallerModeState(cwd, "ultragoal", "handoff", "s1");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");
		const ultragoal = await makeSkill("ultragoal", "---\nname: ultragoal\n---\nGo");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [ralplan, ultragoal], captured, {
			getActiveSkillState: () => ({ skill: "ultragoal", session_id: "s1" }),
			getActiveSkillPhase: () => "handoff",
		});
		const tool = SkillTool.createIf(session)!;

		await tool.execute("call-1", { name: "ralplan" });
		const ug = await readModeState(cwd, "ultragoal", "s1");
		expect(ug?.active).toBe(false);
		expect(ug?.handoff_to).toBe("ralplan");
		const rp = await readModeState(cwd, "ralplan", "s1");
		expect(rp?.active).toBe(true);
		expect(rp?.handoff_from).toBe("ultragoal");
	});

	// Terminal-phase allow-list coverage (architect blocker, code lane).
	// TERMINAL_PHASES = {complete, completed, handoff, failed, cancelled, canceled, inactive}.
	// For each terminal phase, the caller (deep-interview) must be allowed to
	// chain into ralplan; handoff in particular is the documented happy path
	// and the others must also pass the guard.
	const TERMINAL_PHASES_TO_TEST = ["complete", "completed", "failed", "cancelled", "canceled", "inactive"] as const;
	for (const phase of TERMINAL_PHASES_TO_TEST) {
		it(`allows chaining when caller phase is terminal '${phase}'`, async () => {
			const cwd = await makeTempCwd();
			await writeCallerModeState(cwd, "deep-interview", phase, "s1");
			const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
			const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");
			const captured: CapturedSend[] = [];
			const session = createSession(cwd, [deepInterview, ralplan], captured, {
				getActiveSkillState: () => ({ skill: "deep-interview", session_id: "s1" }),
				getActiveSkillPhase: () => phase,
			});
			const tool = SkillTool.createIf(session)!;

			const result = await tool.execute("call-1", { name: "ralplan" });
			expect(result.details?.name).toBe("ralplan");
			expect(captured).toHaveLength(1);
			const rp = await readModeState(cwd, "ralplan", "s1");
			expect(rp?.active).toBe(true);
			expect(rp?.handoff_from).toBe("deep-interview");
		});
	}

	it("calls handoff CLI before dispatching the chained skill (ordering)", async () => {
		const cwd = await makeTempCwd();
		await writeCallerModeState(cwd, "deep-interview", "handoff", "s1");
		const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");

		// Use sendCustomMessage to inspect mode-state at dispatch time.
		// If handoff ran first, deep-interview-state.json already has active=false when
		// the message is captured.
		let modeStateAtDispatch: Record<string, unknown> | null = null;
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [deepInterview, ralplan], captured, {
			getActiveSkillState: () => ({ skill: "deep-interview", session_id: "s1" }),
			getActiveSkillPhase: () => "handoff",
			sendCustomMessage: async (message, options) => {
				modeStateAtDispatch = await readModeState(cwd, "deep-interview", "s1");
				captured.push({ message, options });
			},
		});
		const tool = SkillTool.createIf(session)!;

		await tool.execute("call-1", { name: "ralplan" });
		expect(modeStateAtDispatch).not.toBeNull();
		expect((modeStateAtDispatch as Record<string, unknown> | null)?.active).toBe(false);
	});

	it("surfaces handoff CLI failure as a ToolError when caller mode-state is missing", async () => {
		const cwd = await makeTempCwd();
		// Do NOT pre-write caller mode-state; handoff will fail with "caller is not active".
		const deepInterview = await makeSkill("deep-interview", "---\nname: deep-interview\n---\nBody");
		const ralplan = await makeSkill("ralplan", "---\nname: ralplan\n---\nPlan");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [deepInterview, ralplan], captured, {
			getActiveSkillState: () => ({ skill: "deep-interview", session_id: "s1" }),
			getActiveSkillPhase: () => "handoff",
		});
		const tool = SkillTool.createIf(session)!;
		await expect(tool.execute("call-1", { name: "ralplan" })).rejects.toThrow(/handoff failed/);
		expect(captured).toHaveLength(0);
	});

	it("throws a ToolError naming the available skills when the name is unknown", async () => {
		const cwd = await makeTempCwd();
		const a = await makeSkill("ralplan", "ralplan body");
		const b = await makeSkill("team", "team body");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [a, b], captured);
		const tool = SkillTool.createIf(session)!;
		await expect(tool.execute("call-1", { name: "does-not-exist" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call-1", { name: "does-not-exist" })).rejects.toThrow(/Available: ralplan, team/);
		expect(captured).toHaveLength(0);
	});

	it("rejects empty name", async () => {
		const cwd = await makeTempCwd();
		const a = await makeSkill("ralplan", "body");
		const captured: CapturedSend[] = [];
		const session = createSession(cwd, [a], captured);
		const tool = SkillTool.createIf(session)!;
		await expect(tool.execute("call-1", { name: "   " })).rejects.toBeInstanceOf(ToolError);
		expect(captured).toHaveLength(0);
	});
});
