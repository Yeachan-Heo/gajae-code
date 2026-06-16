import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { GcContext } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { tmuxSessionsGcAdapter } from "@gajae-code/coding-agent/gjc-runtime/tmux-gc";

const env = { GJC_TMUX_COMMAND: "tmux-redteam" };
const cwd = "/tmp/gjc-redteam-project";

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
		cwd,
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

function optionValue(cmd: string[], option: string): boolean {
	return cmd.includes("show-options") && cmd.at(-1) === option;
}

describe("tmux GC red-team adversarial safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not prune an attached GJC session even when project path and branch worktree are gone", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_attached_stale\n");
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_attached_stale",
						attached: true,
						branch: "gone-branch",
						project: "/tmp/gjc-redteam-missing-project",
					}),
				);
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_attached_stale");

		expect(result.errors).toEqual([]);
		expect(record).toMatchObject({ status: "live", stale: false, removable: false, pid_status: "alive" });
		expect(record?.reason).toBe("tmux_session_attached_or_has_live_panes");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-redteam", "kill-session", "-t", "=gajae_code_attached_stale"]);
	});

	it("revalidates before pruning and skips kill when a stale candidate becomes attached after classification", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		let richListCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_toctou\n");
				richListCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "gajae_code_toctou",
						attached: richListCount > 1,
						branch: "deleted-branch",
						project: "/tmp/gjc-redteam-deleted-project",
					}),
				);
			}
			if (optionValue(cmd, "@gjc-profile")) return spawnResult(0, "1\n");
			if (optionValue(cmd, "@gjc-project")) return spawnResult(0, "/tmp/gjc-redteam-deleted-project\n");
			if (optionValue(cmd, "@gjc-branch")) return spawnResult(0, "deleted-branch\n");
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_toctou");

		expect(record).toMatchObject({ status: "stale", stale: true, removable: true, reason: "project_missing" });
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "tmux_revalidation_failed_or_became_live",
		});
		expect(calls).not.toContainEqual(["tmux-redteam", "kill-session", "-t", "=gajae_code_toctou"]);
	});

	it("never prunes a non-GJC untagged session that superficially resembles an idle orphan", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae-code-old-orphan-looking\n");
				return spawnResult(
					0,
					sessionLine({ name: "gajae-code-old-orphan-looking", profile: "", created: 1_600_000_000 }),
				);
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae-code-old-orphan-looking");

		expect(record).toMatchObject({ status: "unclassified", stale: false, removable: false });
		expect(record?.reason).toBe("untagged_tmux_session");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-redteam", "kill-session", "-t", "=gajae-code-old-orphan-looking"]);
	});

	it("prunes a genuine GJC-owned metadata-less idle orphan only after ownership, no-attachment, age, and revalidation", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "gajae_code_idle_orphan\n");
				return spawnResult(
					0,
					sessionLine({ name: "gajae_code_idle_orphan", profile: "1", created: 1_770_000_000 }),
				);
			}
			if (optionValue(cmd, "@gjc-profile")) return spawnResult(0, "1\n");
			if (cmd.includes("show-options")) return spawnResult(0, "\n");
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "gajae_code_idle_orphan");

		expect(record).toMatchObject({
			status: "stale",
			stale: true,
			removable: true,
			reason: "metadata_less_gjc_owned_idle_orphan",
		});
		expect(record?.detail).toContain("createdAt=2026-02-02T02:40:00.000Z");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({ removed: true });
		expect(calls).toContainEqual(["tmux-redteam", "kill-session", "-t", "=gajae_code_idle_orphan"]);
	});
});
