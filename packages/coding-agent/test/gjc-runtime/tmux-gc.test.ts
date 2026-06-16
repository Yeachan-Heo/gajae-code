import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { GcContext } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { tmuxSessionsGcAdapter } from "@gajae-code/coding-agent/gjc-runtime/tmux-gc";

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
	].join("\t");
}

describe("tmux GC safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
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

	it("prunes metadata-less GJC-owned idle orphan only when ownership is proven and not attached", async () => {
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
			if (cmd.includes("show-options")) return spawnResult(0, cmd.at(-1) === "@gjc-profile" ? "1\n" : "\n");
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const orphan = result.records.find(entry => entry.id === "gajae_code_orphan");
		const unrelated = result.records.find(entry => entry.id === "unrelated_orphan");

		expect(orphan).toMatchObject({ status: "stale", removable: true, reason: "metadata_less_gjc_owned_idle_orphan" });
		expect(unrelated).toMatchObject({ status: "unclassified", removable: false, reason: "untagged_tmux_session" });
		expect(await tmuxSessionsGcAdapter.prune(orphan!, ctx())).toEqual({ removed: true });
		expect(calls).toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_orphan"]);
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=unrelated_orphan"]);
	});

	it("revalidation skips kill when a removable session becomes attached before prune", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
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
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_race");

		expect(record).toMatchObject({ status: "stale", removable: true, reason: "project_missing" });
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "tmux_revalidation_failed_or_became_live",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_race"]);
	});

	it("final status read blocks kill when a revalidated candidate becomes attached", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
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
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_final_race");

		expect(record).toMatchObject({ status: "stale", removable: true, reason: "project_missing" });
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
			removed: false,
			error: "gjc_tmux_session_live:gajae_code_final_race",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_final_race"]);
	});

	it("final status read blocks kill when a detached revalidated candidate has live pane PIDs", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
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
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@gjc-profile") return spawnResult(0, "1\n");
				if (option === "@gjc-project") return spawnResult(0, "/tmp/missing-gjc-project\n");
				if (option === "@gjc-branch") return spawnResult(0, "stale\n");
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_final_pane_race");

		expect(record).toMatchObject({ status: "stale", removable: true, reason: "project_missing" });
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
			removed: false,
			error: "gjc_tmux_session_live:gajae_code_final_pane_race",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=gajae_code_final_pane_race"]);
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
