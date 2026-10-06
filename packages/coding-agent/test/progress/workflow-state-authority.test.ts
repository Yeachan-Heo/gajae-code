import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	activeEntryPath,
	activeSnapshotPath,
	activeStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import * as stateWriter from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import { acpProgressReportText } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { buildSessionProjectProgress } from "@gajae-code/coding-agent/progress/collect-project-progress";
import type { ProjectProgressSnapshot } from "@gajae-code/coding-agent/progress/progress-contract";
import { toProjectProgressSnapshot } from "@gajae-code/coding-agent/progress/progress-snapshot";
import {
	readVisibleSkillActiveStateWithStatus,
	syncSkillActiveState,
} from "@gajae-code/coding-agent/skill-state/active-state";
import { executeAcpBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@gajae-code/coding-agent/slash-commands/types";
import { TempDir } from "@gajae-code/utils";

/**
 * The per-skill `active/<skill>.json` entries are the workflow authority; the
 * session `skill-active-state.json` snapshot is a cache rebuilt from them. These
 * tests drive the real writer and then read through the shared progress
 * projection that `/progress` and `session.progress` (Q32) both consume.
 */
const SESSION_ID = "sess-authority";

interface ProgressReads {
	/** Q32 payload, built exactly as the runtime `getProjectProgress` binding builds it. */
	snapshot: ProjectProgressSnapshot;
	/** Human `/progress` text from the text-mode dispatcher. */
	human: string;
}

const DISCARDED_NOTE =
	"Workflow state snapshot is stale; workflows it lists without an authoritative per-entry record were discarded, not reported as active.";
const UNRESOLVED_NOTE =
	"Workflow state lists workflows whose authority cannot be established; they are not reported as active, and their absence is unconfirmed.";

describe("progress workflow-state authority", () => {
	let tempDir: TempDir;
	let cwd: string;
	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-progress-authority-");
		cwd = tempDir.path();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	const snapshotPath = () => activeSnapshotPath(cwd, SESSION_ID);
	const entryPath = (skill: string) => activeEntryPath(cwd, SESSION_ID, skill);

	async function activate(skill: string, phase: string): Promise<void> {
		await syncSkillActiveState({ cwd, skill, phase, active: true, sessionId: SESSION_ID });
	}

	/**
	 * Deactivate through the real writer while the snapshot rebuild fails, the
	 * window a crash between entry removal and rebuild leaves on disk.
	 */
	async function deactivateWithoutSnapshotRebuild(skill: string): Promise<void> {
		const rebuild = vi
			.spyOn(stateWriter, "rebuildActiveSnapshot")
			.mockRejectedValue(new Error("simulated crash before snapshot rebuild"));
		await expect(syncSkillActiveState({ cwd, skill, active: false, sessionId: SESSION_ID })).rejects.toThrow(
			"simulated crash before snapshot rebuild",
		);
		expect(rebuild).toHaveBeenCalledTimes(1);
		rebuild.mockRestore();
	}

	async function snapshotActiveSkills(): Promise<string[]> {
		const raw = JSON.parse(await Bun.file(snapshotPath()).text()) as {
			active_skills?: { skill: string; active?: boolean }[];
		};
		return (raw.active_skills ?? []).filter(entry => entry.active !== false).map(entry => entry.skill);
	}

	async function stateFingerprint(): Promise<string> {
		const dir = path.dirname(snapshotPath());
		const files: string[] = [];
		for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
			const filePath = path.join(dir, name);
			const stat = await fs.stat(filePath);
			files.push(stat.isFile() ? `${name}:${stat.mtimeMs}:${await Bun.file(filePath).text()}` : `${name}/`);
		}
		return files.join("\n");
	}

	async function readProgress(): Promise<ProgressReads> {
		const output: string[] = [];
		const runtime = {
			session: {
				getGoalModeState: () => undefined,
				getTodoPhases: () => [],
				getSubagentLifecycleStatuses: () => [],
			},
			sessionManager: { getCwd: () => cwd, getSessionId: () => SESSION_ID, getBranch: () => [] },
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;
		await expect(executeAcpBuiltinSlashCommand("/progress", runtime)).resolves.toEqual({ consumed: true });
		const snapshot = toProjectProgressSnapshot(
			await buildSessionProjectProgress(runtime.session, runtime.sessionManager),
		);
		// `/progress` and Q32 render from the same projection.
		expect(acpProgressReportText({ page: { items: [snapshot], complete: true } })).toBe(output[0]);
		return { snapshot, human: output[0] ?? "" };
	}

	const stateNotes = (snapshot: ProjectProgressSnapshot) =>
		snapshot.attention.filter(item => item.source === "state").map(item => item.text);

	it("does not report the last workflow active after its entry is removed and the snapshot rebuild is skipped", async () => {
		await activate("ralplan", "critic");
		expect(await snapshotActiveSkills()).toEqual(["ralplan"]);
		await deactivateWithoutSnapshotRebuild("ralplan");
		expect(await Bun.file(entryPath("ralplan")).exists()).toBe(false);
		expect(await snapshotActiveSkills()).toEqual(["ralplan"]);

		const before = await stateFingerprint();
		expect((await readVisibleSkillActiveStateWithStatus(cwd, SESSION_ID)).status).toBe("discarded");
		const { snapshot, human } = await readProgress();
		expect(await stateFingerprint()).toBe(before);

		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.state).not.toBe("in-progress");
		expect(snapshot.state).toBe("no-tracked-work");
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: [],
			recovered: [],
			discarded: ["workflow-state"],
			unresolved: [],
		});
		expect(stateNotes(snapshot)).toEqual([DISCARDED_NOTE]);
		expect(human).not.toContain("ralplan");
		expect(human).not.toContain("could not be read");
		expect(human).toContain(DISCARDED_NOTE);
	});

	it("keeps the surviving workflow when one of two is removed and the snapshot rebuild is skipped", async () => {
		await activate("ralplan", "critic");
		await activate("autoresearch", "research");
		expect((await snapshotActiveSkills()).toSorted()).toEqual(["autoresearch", "ralplan"]);
		await deactivateWithoutSnapshotRebuild("ralplan");
		expect((await snapshotActiveSkills()).toSorted()).toEqual(["autoresearch", "ralplan"]);

		const { snapshot, human } = await readProgress();
		expect(snapshot.activeWork.workflows.map(workflow => [workflow.skill, workflow.phase])).toEqual([
			["autoresearch", "research"],
		]);
		expect(snapshot.sources.discarded).toEqual(["workflow-state"]);
		expect(snapshot.sources.unreadable).toEqual([]);
		expect(human).toContain("autoresearch: research");
		expect(human).not.toContain("ralplan");
		expect(human).toContain(DISCARDED_NOTE);
	});

	it("reports nothing stale after an ordinary deactivation", async () => {
		await activate("ralplan", "critic");
		await syncSkillActiveState({ cwd, skill: "ralplan", active: false, sessionId: SESSION_ID });
		expect(await snapshotActiveSkills()).toEqual([]);

		expect((await readVisibleSkillActiveStateWithStatus(cwd, SESSION_ID)).status).toBe("read");
		const { snapshot, human } = await readProgress();
		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.state).toBe("no-tracked-work");
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: [],
			recovered: [],
			discarded: [],
			unresolved: [],
		});
		expect(stateNotes(snapshot)).toEqual([]);
		expect(human).toContain("none active");
	});

	it("reports an active workflow written through the real writer without any recovery note", async () => {
		await activate("ralplan", "critic");
		const { snapshot } = await readProgress();
		expect(snapshot.activeWork.workflows.map(workflow => [workflow.skill, workflow.phase])).toEqual([
			["ralplan", "critic"],
		]);
		expect(snapshot.state).toBe("in-progress");
		expect(stateNotes(snapshot)).toEqual([]);
	});

	it("keeps a legacy root-only record authoritative", async () => {
		await Bun.write(
			snapshotPath(),
			JSON.stringify({ version: 1, active: true, skill: "ralplan", phase: "critic", session_id: SESSION_ID }),
		);
		expect((await readVisibleSkillActiveStateWithStatus(cwd, SESSION_ID)).status).toBe("read");
		const { snapshot, human } = await readProgress();
		expect(snapshot.activeWork.workflows.map(workflow => [workflow.skill, workflow.phase])).toEqual([
			["ralplan", "critic"],
		]);
		expect(snapshot.state).toBe("in-progress");
		expect(stateNotes(snapshot)).toEqual([]);
		expect(human).toContain("ralplan: critic");
	});

	it("keeps a legacy root-only record alongside authoritative per-skill entries", async () => {
		await Bun.write(
			snapshotPath(),
			JSON.stringify({ version: 1, active: true, skill: "ralplan", phase: "critic", session_id: SESSION_ID }),
		);
		await stateWriter.writeActiveEntry(cwd, SESSION_ID, "autoresearch", {
			skill: "autoresearch",
			phase: "research",
			active: true,
			session_id: SESSION_ID,
		});
		const { snapshot } = await readProgress();
		expect(snapshot.activeWork.workflows.map(workflow => workflow.skill).toSorted()).toEqual([
			"autoresearch",
			"ralplan",
		]);
		expect(stateNotes(snapshot)).toEqual([]);
	});

	it("reports an unstamped snapshot row without an entry as unresolved, neither active nor absent", async () => {
		// Pre-guarded-writer shape: both derived rebuilds and authoritative activation
		// seeds were written like this, so the record alone cannot establish authority.
		await Bun.write(
			snapshotPath(),
			JSON.stringify({
				version: 1,
				active: true,
				skill: "ralplan",
				phase: "critic",
				session_id: SESSION_ID,
				active_skills: [{ skill: "ralplan", phase: "critic", active: true, session_id: SESSION_ID }],
			}),
		);
		const before = await stateFingerprint();
		expect((await readVisibleSkillActiveStateWithStatus(cwd, SESSION_ID)).status).toBe("unresolved");
		const { snapshot, human } = await readProgress();
		expect(await stateFingerprint()).toBe(before);
		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.state).not.toBe("in-progress");
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: [],
			recovered: [],
			discarded: [],
			unresolved: ["workflow-state"],
		});
		expect(stateNotes(snapshot)).toEqual([UNRESOLVED_NOTE]);
		expect(human).toContain(UNRESOLVED_NOTE);
		expect(human).toContain("unknown: workflow state could not be reconciled");
		expect(human).not.toContain("none active");
		expect(human).not.toContain("could not be read");
	});

	it("reports an unreadable authoritative entry as unreadable even when the snapshot lists the workflow", async () => {
		await activate("ralplan", "critic");
		await Bun.write(entryPath("ralplan"), '{"skill": "ralplan", "act');
		expect(await snapshotActiveSkills()).toEqual(["ralplan"]);

		const { snapshot, human } = await readProgress();
		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.state).not.toBe("in-progress");
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: ["workflow-state"],
			recovered: [],
			discarded: [],
			unresolved: [],
		});
		expect(human).toContain("unknown: workflow state could not be read");
		expect(human).not.toContain("none active");
	});

	it.each([
		["an empty object", "{}"],
		["null", "null"],
		["an array", '[{"skill": "ralplan", "active": true}]'],
		["an object without a skill", '{"phase": "critic", "active": true}'],
		["an object with a blank skill", '{"skill": "  ", "phase": "critic", "active": true}'],
	])("reports an existing authoritative entry holding %s as unreadable, not as deleted", async (_label, contents) => {
		await activate("ralplan", "critic");
		await Bun.write(entryPath("ralplan"), contents);
		expect(await Bun.file(entryPath("ralplan")).exists()).toBe(true);
		expect(await snapshotActiveSkills()).toEqual(["ralplan"]);

		const before = await stateFingerprint();
		const { snapshot, human } = await readProgress();

		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.state).not.toBe("in-progress");
		expect(snapshot.sources).toEqual({
			sessionStateRead: true,
			unreadable: ["workflow-state"],
			recovered: [],
			discarded: [],
			unresolved: [],
		});
		expect(stateNotes(snapshot)).not.toContain(DISCARDED_NOTE);
		expect(human).toContain("unknown: workflow state could not be read");
		expect(human).not.toContain("none active");
		expect(human).not.toContain(DISCARDED_NOTE);
		expect(human).not.toContain("ralplan: critic");
		await expect(readVisibleSkillActiveStateWithStatus(cwd, SESSION_ID)).rejects.toThrow(
			"is not a skill entry record",
		);
		// HUD/guard callers keep the tolerant reader, which still skips the record.
		expect(await stateWriter.readActiveEntries(cwd, { sessionId: SESSION_ID })).toEqual([]);
		expect(await stateFingerprint()).toBe(before);
	});

	it("does not let a malformed authoritative entry beside a surviving workflow pass as a deletion", async () => {
		await activate("ralplan", "critic");
		await activate("autoresearch", "research");
		await Bun.write(entryPath("ralplan"), "{}");

		const { snapshot, human } = await readProgress();
		expect(snapshot.activeWork.workflows).toEqual([]);
		expect(snapshot.sources.unreadable).toEqual(["workflow-state"]);
		expect(snapshot.sources.discarded).toEqual([]);
		expect(human).toContain("unknown: workflow state could not be read");
		expect(human).not.toContain(DISCARDED_NOTE);
	});

	it("recovers from authoritative entries when a derived snapshot is unreadable", async () => {
		await activate("ralplan", "critic");
		await Bun.write(snapshotPath(), "{not json");
		const { snapshot } = await readProgress();
		expect(snapshot.activeWork.workflows.map(workflow => workflow.skill)).toEqual(["ralplan"]);
		expect(snapshot.sources.recovered).toEqual(["workflow-state"]);
		expect(snapshot.sources.discarded).toEqual([]);
		expect(stateNotes(snapshot)).toEqual([
			"Workflow state snapshot could not be read; its contents were recovered from authoritative per-entry records.",
		]);
		expect(await fs.readdir(activeStateDir(cwd, SESSION_ID))).toEqual(["ralplan.json"]);
	});
});
