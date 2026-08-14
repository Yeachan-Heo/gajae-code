import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TelegramDaemonFs } from "../src/sdk/bus/telegram-daemon";
import {
	isLegacyStrayDaemonArgs,
	reapTelegramDaemonOrphans,
	type TelegramStrayProcessRef,
} from "../src/sdk/bus/telegram-daemon-orphan-reap";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-legacy-stray-test-"));
}

const AGENT_DIR_ARGS = (agentDir: string) => [
	"/old/workspace/dist/gjc",
	"notify",
	"daemon-internal",
	"--owner-id",
	"5513-msr3xott-bbdihsv4vin",
	"--agent-dir",
	agentDir,
];

describe("legacy stray daemon argv signature", () => {
	const agentDir = "/home/u/.gjc/agent";

	test("matches the exact daemon-internal invocation for this agent dir", () => {
		expect(isLegacyStrayDaemonArgs(AGENT_DIR_ARGS(agentDir), agentDir)).toBe(true);
	});

	test("rejects near-miss invocations", () => {
		// Different agent dir.
		expect(isLegacyStrayDaemonArgs(AGENT_DIR_ARGS("/home/u/.gjc/other"), agentDir)).toBe(false);
		// Subcommand tokens not adjacent.
		expect(
			isLegacyStrayDaemonArgs(["gjc", "notify", "health", "daemon-internal", "--agent-dir", agentDir], agentDir),
		).toBe(false);
		// Substring lookalikes are not token matches.
		expect(isLegacyStrayDaemonArgs(["gjc", "notify-daemon-internal", "--agent-dir", agentDir], agentDir)).toBe(false);
		// Missing --agent-dir binding.
		expect(isLegacyStrayDaemonArgs(["gjc", "notify", "daemon-internal"], agentDir)).toBe(false);
	});
});

interface FakeStray {
	pid: number;
	incarnation: string;
	args: string[];
	alive: boolean;
	terminations: NodeJS.Signals[];
}

function strayDeps(input: {
	agentDir: string;
	strays: FakeStray[];
	sightings: Map<string, number>;
	now: () => number;
}) {
	const byPid = new Map(input.strays.map(stray => [stray.pid, stray]));
	return {
		pidAlive: (pid: number) => byPid.get(pid)?.alive ?? false,
		pidIncarnation: (pid: number) => byPid.get(pid)?.incarnation,
		now: input.now,
		listCandidatePids: async () => input.strays.map(stray => stray.pid),
		strayReference: (pid: number): TelegramStrayProcessRef | undefined => {
			const stray = byPid.get(pid);
			if (!stray?.alive) return undefined;
			return {
				incarnation: stray.incarnation,
				args: () => stray.args,
				terminateTree: (signal?: NodeJS.Signals) => {
					stray.terminations.push(signal ?? "SIGTERM");
					stray.alive = false;
					return true;
				},
			};
		},
		straySightings: input.sightings,
	};
}

async function sweep(agentDir: string, deps: ReturnType<typeof strayDeps>) {
	return await reapTelegramDaemonOrphans({
		agentDir,
		currentOwnerId: "cur",
		currentAcquisitionId: "cur-acq",
		currentPid: 99999,
		currentIncarnation: "linux:99999:1",
		fsImpl: fs.promises as unknown as TelegramDaemonFs,
		deps,
	});
}

describe("legacy stray daemon sweep", () => {
	test("terminates a confirmed pre-registry stray on the second sighting", async () => {
		const agentDir = tempAgentDir();
		try {
			let clock = 1_000_000;
			const stray: FakeStray = {
				pid: 31056,
				incarnation: "darwin:31056:7",
				args: AGENT_DIR_ARGS(agentDir),
				alive: true,
				terminations: [],
			};
			const sightings = new Map<string, number>();
			const deps = strayDeps({ agentDir, strays: [stray], sightings, now: () => clock });

			// First sighting: recorded, never signaled.
			const first = await sweep(agentDir, deps);
			expect(stray.alive).toBe(true);
			expect(first.receipt.terminated).toBe(0);
			expect(first.receipt.reasons.legacy_stray_pending_confirmation).toBe(1);
			expect(sightings.size).toBe(1);

			// Second sighting before the confirmation window: still not signaled.
			clock += 10_000;
			const early = await sweep(agentDir, deps);
			expect(stray.alive).toBe(true);
			expect(early.receipt.reasons.legacy_stray_pending_confirmation).toBe(1);

			// Confirmed sighting after the window: terminated.
			clock += 60_000;
			const confirmed = await sweep(agentDir, deps);
			expect(stray.alive).toBe(false);
			expect(stray.terminations.length).toBeGreaterThan(0);
			expect(confirmed.receipt.terminated).toBe(1);
			expect(confirmed.receipt.reasons.legacy_stray_reaped).toBe(1);
			expect(confirmed.decisions.some(d => d.kind === "reaped" && d.pid === stray.pid)).toBe(true);
			expect(sightings.size).toBe(0);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("never signals non-matching processes and prunes their ledger entries", async () => {
		const agentDir = tempAgentDir();
		try {
			let clock = 1_000_000;
			const unrelated: FakeStray = {
				pid: 555,
				incarnation: "darwin:555:1",
				args: ["/usr/bin/some-tool", "--agent-dir", agentDir],
				alive: true,
				terminations: [],
			};
			const otherAgentDir: FakeStray = {
				pid: 556,
				incarnation: "darwin:556:1",
				args: AGENT_DIR_ARGS(path.join(agentDir, "elsewhere")),
				alive: true,
				terminations: [],
			};
			const sightings = new Map<string, number>();
			const deps = strayDeps({ agentDir, strays: [unrelated, otherAgentDir], sightings, now: () => clock });

			await sweep(agentDir, deps);
			clock += 60_000;
			const result = await sweep(agentDir, deps);
			expect(unrelated.alive).toBe(true);
			expect(otherAgentDir.alive).toBe(true);
			expect(result.receipt.terminated).toBe(0);
			expect(result.receipt.reasons.legacy_stray_reaped).toBeUndefined();
			expect(sightings.size).toBe(0);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("an incarnation change resets confirmation (PID reuse is never inherited)", async () => {
		const agentDir = tempAgentDir();
		try {
			let clock = 1_000_000;
			const stray: FakeStray = {
				pid: 777,
				incarnation: "darwin:777:1",
				args: AGENT_DIR_ARGS(agentDir),
				alive: true,
				terminations: [],
			};
			const sightings = new Map<string, number>();
			const deps = strayDeps({ agentDir, strays: [stray], sightings, now: () => clock });

			await sweep(agentDir, deps);
			// PID reused by a different process incarnation with the same argv shape.
			stray.incarnation = "darwin:777:2";
			clock += 60_000;
			const result = await sweep(agentDir, deps);
			expect(stray.alive).toBe(true);
			expect(result.receipt.terminated).toBe(0);
			expect(result.receipt.reasons.legacy_stray_pending_confirmation).toBe(1);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
