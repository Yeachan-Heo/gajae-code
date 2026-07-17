import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { GcContext } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { tmuxSessionsGcAdapter } from "@gajae-code/coding-agent/gjc-runtime/tmux-gc";
import { __setMutationServerProofForTests } from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

const env = { GJC_TMUX_COMMAND: "tmux-test" };
const project = "/tmp/gjc-project";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResult): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

function ctx(): GcContext {
	return {
		probe: () => ({ status: "dead" }),
		force: false,
		env,
		cwd: project,
	};
}

function sessionLine(overrides: {
	name: string;
	attached?: boolean;
	created?: number;
	profile?: string;
	panes?: number;
	panePid?: number;
	branch?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
	ownerGeneration?: string;
	nativeSessionId?: string;
}): string {
	return [
		overrides.name,
		"1",
		overrides.attached ? "1" : "0",
		String(overrides.created ?? 1_770_000_000),
		overrides.profile ?? "1",
		"root",
		String(overrides.panes ?? (overrides.panePid ? 1 : 0)),
		overrides.panePid ? String(overrides.panePid) : "",
		overrides.branch ?? "",
		overrides.branch?.replaceAll("/", "-") ?? "",
		overrides.project ?? "",
		overrides.sessionId ?? "",
		overrides.sessionStateFile ?? "",
		overrides.ownerGeneration ?? "generation-1",
		"",
		overrides.nativeSessionId ?? "$1",
	].join("\t");
}

describe("tmux GC safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		__setMutationServerProofForTests(null);
	});

	it("classifies attached/live tagged sessions with stale metadata as non-removable and does not prune", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, sessionLine({ name: "gajae_code_live", attached: true, branch: "stale", project })),
		);

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_live");

		expect(result.errors).toEqual([]);
		expect(record).toMatchObject({ status: "live", stale: false, removable: false, pid_status: "alive" });
		expect(record?.reason).toBe("tmux_session_attached_or_has_live_panes");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(Bun.spawnSync).not.toHaveBeenCalledWith(
			["tmux-test", "kill-session", "-t", "=gajae_code_live"],
			expect.any(Object),
		);
	});

	it("keeps markerless metadata-less GJC-owned idle orphans non-removable", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_orphan\nunrelated_orphan\n");
				return spawnResult(
					0,
					[
						sessionLine({ name: "gajae_code_orphan", profile: "1", created: 1_770_000_000 }),
						sessionLine({ name: "unrelated_orphan", profile: "", created: 1_770_000_000 }),
					].join("\n"),
				);
			}
			if (cmd.includes("show-options")) {
				const target = cmd[cmd.indexOf("-t") + 1] ?? "";
				return spawnResult(0, cmd.at(-1) === "@gjc-profile" && target.includes("gajae_code_orphan") ? "1\n" : "\n");
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const orphan = result.records.find(entry => entry.id === "gajae_code_orphan");
		const unrelated = result.records.find(entry => entry.id === "unrelated_orphan");

		expect(orphan).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "metadata_less_gjc_owned_idle_orphan_missing_terminal_marker",
		});
		expect(unrelated).toMatchObject({ status: "unclassified", removable: false, reason: "untagged_tmux_session" });
		expect(await tmuxSessionsGcAdapter.prune(orphan!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_orphan"]);
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=unrelated_orphan"]);
	});

	it("classifies terminal detached sessions but refuses prune without exact server proof", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/gjc-terminal-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-1",
				state: "completed",
				cwd: project,
				workdir: project,
				session_file: null,
			}),
		);
		const calls: string[][] = [];
		__setMutationServerProofForTests(() => ({ pid: 1, startTime: "test" }));
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_done\n");
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_done",
						branch: "main",
						project,
						sessionId: "session-1",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("display-message") && cmd.at(-1) === "#{session_id}") return spawnResult(0, "$1\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, `${project}\n`);
				if (option === "@gjc-branch") return spawnResult(0, "main\n");
				if (option === "@gjc-session-id") return spawnResult(0, "session-1\n");
				if (option === "@gjc-owner-generation") return spawnResult(0, "generation-1\n");
				if (option === "@gjc-session-state-file") return spawnResult(0, `${stateFile}\n`);
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "gajae_code_done");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
				removed: false,
				error: "gjc_tmux_cleanup_target_changed",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_done"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("keeps stale project or branch metadata non-removable without a terminal marker", async () => {
		const missingProject = "/tmp/gjc-missing-project";
		const nonRepoProject = "/tmp";
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}")
					return spawnResult(0, "gajae_code_missing_project\ngajae_code_no_worktree\n");
				return spawnResult(
					0,
					[
						sessionLine({ name: "gajae_code_missing_project", branch: "main", project: missingProject }),
						sessionLine({
							name: "gajae_code_no_worktree",
							branch: "definitely-missing-gjc-branch",
							project: nonRepoProject,
						}),
					].join("\n"),
				);
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const missing = result.records.find(entry => entry.id === "gajae_code_missing_project");
		const noWorktree = result.records.find(entry => entry.id === "gajae_code_no_worktree");

		expect(missing).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "project_missing_without_terminal_marker",
		});
		expect(noWorktree).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "branch_no_worktree_without_terminal_marker",
		});
		expect(await tmuxSessionsGcAdapter.prune(missing!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(await tmuxSessionsGcAdapter.prune(noWorktree!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_missing_project"]);
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_no_worktree"]);
	});

	it("keeps attached sessions non-removable even when their runtime marker is terminal", async () => {
		const stateFile = "/tmp/gjc-terminal-attached-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-1",
				state: "completed",
				cwd: project,
				workdir: project,
				session_file: null,
			}),
		);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_attached_done\n");
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_attached_done",
						attached: true,
						branch: "main",
						project,
						sessionId: "session-1",
						sessionStateFile: stateFile,
					}),
				);
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "gajae_code_attached_done");

			expect(record).toMatchObject({
				status: "live",
				removable: false,
				reason: "tmux_session_attached_or_has_live_panes",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
				removed: false,
				skipped: "not_removable_tmux_session",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_attached_done"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("revalidation skips kill when a removable session becomes attached before prune", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/gjc-terminal-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "race-session",
				state: "completed",
				cwd: "/tmp/missing-gjc-project",
				workdir: "/tmp/missing-gjc-project",
				session_file: null,
			}),
		);
		const calls: string[][] = [];
		let listCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_race\n");
				listCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_race",
						attached: listCount > 1,
						branch: "stale",
						project: "/tmp/missing-gjc-project",
						sessionId: "race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("display-message") && cmd.at(-1) === "#{session_id}") return spawnResult(0, "$1\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				if (option === "@gjc-session-id") return spawnResult(0, "race-session\n");
				if (option === "@gjc-owner-generation") return spawnResult(0, "generation-1\n");
				if (option === "@gjc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "gajae_code_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
				removed: false,
				skipped: "tmux_revalidation_failed_or_became_live",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("final status read blocks kill when a revalidated candidate becomes attached", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/gjc-terminal-final-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "final-race-session",
				state: "completed",
				cwd: "/tmp/missing-gjc-project",
				workdir: "/tmp/missing-gjc-project",
				session_file: null,
			}),
		);
		const calls: string[][] = [];
		let richListCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_final_race\n");
				richListCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_final_race",
						attached: richListCount > 2,
						branch: "stale",
						project: "/tmp/missing-gjc-project",
						sessionId: "final-race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("display-message") && cmd.at(-1) === "#{session_id}") return spawnResult(0, "$1\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				if (option === "@gjc-session-id") return spawnResult(0, "final-race-session\n");
				if (option === "@gjc-owner-generation") return spawnResult(0, "generation-1\n");
				if (option === "@gjc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "gajae_code_final_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
				removed: false,
				error: "gjc_tmux_session_live:gajae_code_final_race",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_final_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("final status read blocks kill when a detached revalidated candidate has live pane PIDs", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/gjc-terminal-final-pane-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "final-pane-race-session",
				state: "completed",
				cwd: "/tmp/missing-gjc-project",
				workdir: "/tmp/missing-gjc-project",
				session_file: null,
			}),
		);
		const calls: string[][] = [];
		let richListCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_final_pane_race\n");
				richListCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_final_pane_race",
						attached: false,
						panePid: richListCount > 2 ? 43210 : undefined,
						branch: "stale",
						project: "/tmp/missing-gjc-project",
						sessionId: "final-pane-race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("display-message") && cmd.at(-1) === "#{session_id}") return spawnResult(0, "$1\n");
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				if (option === "@gjc-session-id") return spawnResult(0, "final-pane-race-session\n");
				if (option === "@gjc-owner-generation") return spawnResult(0, "generation-1\n");
				if (option === "@gjc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "gajae_code_final_pane_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
				removed: false,
				error: "gjc_tmux_session_live:gajae_code_final_pane_race",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_final_pane_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("keeps old detached prefix-named untagged sessions non-removable", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_user_owned\n");
				return spawnResult(0, sessionLine({ name: "gajae_code_user_owned", profile: "", created: 1_600_000_000 }));
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_user_owned");

		expect(record).toMatchObject({ status: "unclassified", stale: false, removable: false });
		expect(record?.reason).toBe("untagged_tmux_session");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_user_owned"]);
	});
});
