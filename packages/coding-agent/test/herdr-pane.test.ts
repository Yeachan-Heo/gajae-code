import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHerdrClearTitleArgs,
	buildHerdrReleaseArgs,
	buildHerdrReportArgs,
	buildHerdrTitleArgs,
	createHerdrReporter,
	type HerdrReportProcess,
	type HerdrSessionEvent,
	installHerdrReporter,
	resolveHerdrPaneEnvironment,
	sanitizeHerdrPaneTitle,
	syncHerdrPaneTitle,
} from "../src/utils/herdr-pane";

function paneEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { HERDR_ENV: "1", HERDR_PANE_ID: "pane-7", ...extra } as NodeJS.ProcessEnv;
}

interface SpawnCall {
	command: string[];
	killed: boolean;
}

function recordingSpawn(exitCode = 0) {
	const calls: SpawnCall[] = [];
	let unrefCount = 0;
	const spawn = (command: string[]): HerdrReportProcess => {
		const call: SpawnCall = { command, killed: false };
		calls.push(call);
		return {
			exited: Promise.resolve(exitCode),
			kill() {
				call.killed = true;
			},
			unref() {
				unrefCount += 1;
			},
		};
	};
	return { calls, spawn, unrefCount: () => unrefCount };
}

/** Emitter standing in for AgentSession.subscribe. */
function eventSource() {
	let listener: ((event: HerdrSessionEvent) => void) | null = null;
	let unsubscribed = 0;
	return {
		subscribe(next: (event: HerdrSessionEvent) => void) {
			listener = next;
			return () => {
				unsubscribed += 1;
				listener = null;
			};
		},
		emit(event: HerdrSessionEvent) {
			listener?.(event);
		},
		get attached() {
			return listener !== null;
		},
		get unsubscribeCount() {
			return unsubscribed;
		},
	};
}

const PANE = { paneId: "pane-7", binPath: "/usr/bin/herdr" };

describe("resolveHerdrPaneEnvironment", () => {
	it("returns null outside a Herdr pane even when a binary is resolvable", () => {
		expect(resolveHerdrPaneEnvironment({ env: {} as NodeJS.ProcessEnv, which: () => "/usr/bin/herdr" })).toBeNull();
		expect(
			resolveHerdrPaneEnvironment({
				env: { HERDR_ENV: "0", HERDR_PANE_ID: "pane-7" } as NodeJS.ProcessEnv,
				which: () => "/usr/bin/herdr",
			}),
		).toBeNull();
	});

	it("requires a pane id", () => {
		expect(
			resolveHerdrPaneEnvironment({ env: { HERDR_ENV: "1" } as NodeJS.ProcessEnv, which: () => "/usr/bin/herdr" }),
		).toBeNull();
	});

	it("prefers HERDR_BIN_PATH over a PATH lookup", () => {
		expect(
			resolveHerdrPaneEnvironment({
				env: paneEnv({ HERDR_BIN_PATH: "/opt/herdr/herdr" }),
				which: () => "/usr/bin/herdr",
			}),
		).toEqual({ paneId: "pane-7", binPath: "/opt/herdr/herdr" });
	});

	it("falls back to a PATH lookup and reports null when the binary is absent", () => {
		expect(resolveHerdrPaneEnvironment({ env: paneEnv(), which: () => "/usr/bin/herdr" })).toEqual({
			paneId: "pane-7",
			binPath: "/usr/bin/herdr",
		});
		expect(resolveHerdrPaneEnvironment({ env: paneEnv(), which: () => null })).toBeNull();
	});

	it("rejects a pane id that is not an opaque identifier", () => {
		for (const paneId of ["--source", "pane 7", "pane;rm -rf /", "$(id)", "-x"]) {
			expect(
				resolveHerdrPaneEnvironment({ env: paneEnv({ HERDR_PANE_ID: paneId }), which: () => "/usr/bin/herdr" }),
			).toBeNull();
		}
	});

	it("does not throw when the PATH lookup itself fails", () => {
		expect(
			resolveHerdrPaneEnvironment({
				env: paneEnv(),
				which: () => {
					throw new Error("which exploded");
				},
			}),
		).toBeNull();
	});

	it("defers to the ancestor gjc that already owns the pane", () => {
		expect(
			resolveHerdrPaneEnvironment({
				env: paneEnv({
					GJC_HERDR_PANE_OWNER: JSON.stringify({
						version: 1,
						paneId: "pane-7",
						pid: 100,
						incarnation: "linux:100",
						token: "ancestor-token-100",
					}),
				}),
				which: () => "/usr/bin/herdr",
				pid: 200,
				processIncarnation: () => "linux:100",
			}),
		).toBeNull();
	});

	it("still reports when the standing claim is this process's own", () => {
		const env = paneEnv();
		installHerdrReporter(eventSource().subscribe, {
			env,
			spawn: recordingSpawn().spawn,
			which: () => "/usr/bin/herdr",
			pid: 100,
			processIncarnation: () => "linux:100",
		});
		expect(
			resolveHerdrPaneEnvironment({
				env,
				which: () => "/usr/bin/herdr",
				pid: 100,
				processIncarnation: () => "linux:100",
			}),
		).toEqual({ paneId: "pane-7", binPath: "/usr/bin/herdr" });
	});

	it("ignores a claim inherited from a different pane", () => {
		expect(
			resolveHerdrPaneEnvironment({
				env: paneEnv({
					GJC_HERDR_PANE_OWNER: JSON.stringify({
						version: 1,
						paneId: "pane-3",
						pid: 100,
						incarnation: "linux:100",
						token: "foreign-pane-token",
					}),
				}),
				which: () => "/usr/bin/herdr",
				pid: 200,
			}),
		).toEqual({ paneId: "pane-7", binPath: "/usr/bin/herdr" });
	});

	it("handles a Herdr pane id that contains a colon", () => {
		const env = paneEnv({
			HERDR_PANE_ID: "wT:p1",
			GJC_HERDR_PANE_OWNER: JSON.stringify({
				version: 1,
				paneId: "wT:p1",
				pid: 100,
				incarnation: "linux:100",
				token: "colon-pane-token",
			}),
		});
		expect(
			resolveHerdrPaneEnvironment({
				env,
				which: () => "/usr/bin/herdr",
				pid: 200,
				processIncarnation: () => "linux:100",
			}),
		).toBeNull();
	});

	it("reclaims a marker after PID reuse", () => {
		const env = paneEnv({
			GJC_HERDR_PANE_OWNER: JSON.stringify({
				version: 1,
				paneId: "pane-7",
				pid: 100,
				incarnation: "linux:old",
				token: "reused-pid-token",
			}),
		});
		expect(
			resolveHerdrPaneEnvironment({
				env,
				which: () => "/usr/bin/herdr",
				pid: 200,
				processIncarnation: () => "linux:new",
			}),
		).toEqual({ paneId: "pane-7", binPath: "/usr/bin/herdr" });
		expect(env.GJC_HERDR_PANE_OWNER).toBeUndefined();
	});

	it("reclaims a marker after the parent exits", () => {
		const env = paneEnv({
			GJC_HERDR_PANE_OWNER: JSON.stringify({
				version: 1,
				paneId: "pane-7",
				pid: 100,
				incarnation: "linux:dead",
				token: "dead-parent-token",
			}),
		});
		expect(
			resolveHerdrPaneEnvironment({
				env,
				which: () => "/usr/bin/herdr",
				pid: 200,
				processIncarnation: () => undefined,
			}),
		).toEqual({ paneId: "pane-7", binPath: "/usr/bin/herdr" });
		expect(env.GJC_HERDR_PANE_OWNER).toBeUndefined();
	});

	it("fails closed when a non-Linux owner probe is unverifiable", () => {
		const env = paneEnv({
			GJC_HERDR_PANE_OWNER: JSON.stringify({
				version: 1,
				paneId: "pane-7",
				pid: 100,
				incarnation: "darwin:1:2",
				token: "unverifiable-owner",
			}),
		});
		expect(
			resolveHerdrPaneEnvironment({
				env,
				which: () => "/usr/bin/herdr",
				pid: 200,
				processProbe: () => ({ state: "unverifiable" }),
			}),
		).toBeNull();
		expect(env.GJC_HERDR_PANE_OWNER).toBeDefined();
	});

	it("does not trust a same-process marker supplied through the environment", () => {
		const env = paneEnv({
			GJC_HERDR_PANE_OWNER: JSON.stringify({
				version: 1,
				paneId: "pane-7",
				pid: process.pid,
				incarnation: "linux:spoofed",
				token: "spoofed-token-123456",
			}),
		});
		expect(resolveHerdrPaneEnvironment({ env, which: () => "/usr/bin/herdr" })).toEqual({
			paneId: "pane-7",
			binPath: "/usr/bin/herdr",
		});
		expect(env.GJC_HERDR_PANE_OWNER).toBeUndefined();
	});
});

describe("herdr pane ownership", () => {
	it("stamps the claim into the environment that spawned children inherit", () => {
		const env = paneEnv();
		installHerdrReporter(eventSource().subscribe, {
			env,
			spawn: recordingSpawn().spawn,
			which: () => "/usr/bin/herdr",
			pid: 4242,
		});

		const marker = JSON.parse(env.GJC_HERDR_PANE_OWNER ?? "null") as {
			paneId?: string;
			pid?: number;
			version?: number;
		};
		expect(marker).toMatchObject({ version: 1, paneId: "pane-7", pid: 4242 });
	});

	it("clears its inherited claim when released", () => {
		const env = paneEnv();
		const reporter = installHerdrReporter(eventSource().subscribe, {
			env,
			spawn: recordingSpawn().spawn,
			which: () => "/usr/bin/herdr",
			pid: 4242,
		});

		reporter?.release();
		expect(env.GJC_HERDR_PANE_OWNER).toBeUndefined();
	});

	it("clears the exact claim even when identity probing is transient", () => {
		const env = paneEnv();
		let probes = 0;
		const reporter = installHerdrReporter(eventSource().subscribe, {
			env,
			spawn: recordingSpawn().spawn,
			which: () => "/usr/bin/herdr",
			processIncarnation: () => `linux:${++probes}`,
		});

		reporter?.release();
		expect(env.GJC_HERDR_PANE_OWNER).toBeUndefined();
	});

	it("keeps a nested gjc from claiming or releasing its parent's pane", () => {
		// A session shelling out to `gjc doctor` hands the child the same
		// HERDR_PANE_ID. Before the claim marker the child registered as the pane's
		// agent and, on exit, released that authority and cleared the title; because
		// Herdr's per-source sequence is a monotonic watermark seeded from the wall
		// clock, every later report from the parent fell below the child's watermark
		// and the pane disappeared from the agent list until it was restarted.
		const env = paneEnv();
		const parent = recordingSpawn();
		const parentSource = eventSource();
		installHerdrReporter(parentSource.subscribe, {
			env,
			spawn: parent.spawn,
			which: () => "/usr/bin/herdr",
			pid: 100,
			processIncarnation: () => "linux:100",
		});
		expect(parent.calls).toHaveLength(1);

		const nested = recordingSpawn();
		const nestedSource = eventSource();
		const nestedOptions = {
			env,
			spawn: nested.spawn,
			which: () => "/usr/bin/herdr",
			pid: 200,
			processIncarnation: () => "linux:100",
		};
		const nestedReporter = installHerdrReporter(nestedSource.subscribe, nestedOptions);
		syncHerdrPaneTitle("nested doctor run", nestedOptions);

		expect(nestedReporter).toBeNull();
		expect(nestedSource.attached).toBe(false);
		expect(nested.calls).toHaveLength(0);

		// The parent keeps reporting for the pane it owns.
		parentSource.emit({ type: "agent_start" });
		expect(parent.calls.map(call => call.command.at(-3))).toEqual(["idle", "working"]);
		const marker = JSON.parse(env.GJC_HERDR_PANE_OWNER ?? "null") as { paneId?: string; pid?: number };
		expect(marker).toMatchObject({ paneId: "pane-7", pid: 100 });
	});
});

describe("herdr reporter argv", () => {
	it("emits the documented custom-integration argv", () => {
		expect(buildHerdrReportArgs("pane-7", "working", 3)).toEqual([
			"pane",
			"report-agent",
			"pane-7",
			"--source",
			"custom:gjc",
			"--agent",
			"gjc",
			"--state",
			"working",
			"--seq",
			"3",
		]);
		expect(buildHerdrReleaseArgs("pane-7", 4)).toEqual([
			"pane",
			"release-agent",
			"pane-7",
			"--source",
			"custom:gjc",
			"--agent",
			"gjc",
			"--seq",
			"4",
		]);
	});

	it("never forwards prompt or message content as arguments", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });
		source.emit({ type: "agent_start" });
		source.emit({ type: "message_start", toolName: "s3cret-token" } as HerdrSessionEvent);
		source.emit({ type: "tool_execution_start", toolName: "bash" });

		const argv = calls.flatMap(call => call.command).join(" ");
		expect(argv).not.toContain("s3cret-token");
		expect(argv).not.toContain("bash");
	});
});

describe("herdr reporter state machine", () => {
	it("reports idle at startup and detaches the process handle", () => {
		const { calls, spawn, unrefCount } = recordingSpawn();
		const reporter = createHerdrReporter(PANE, eventSource().subscribe, { env: paneEnv(), spawn });

		expect(reporter.state).toBe("idle");
		expect(calls).toHaveLength(1);
		const command = calls[0]?.command ?? [];
		expect(command.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			...buildHerdrReportArgs("pane-7", "idle", 0).slice(0, -1),
		]);
		expect(unrefCount()).toBe(1);
	});

	it("tracks working/idle across a turn and dedupes repeated states", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		source.emit({ type: "agent_start" });
		expect(reporter.state).toBe("working");
		source.emit({ type: "tool_execution_start", toolName: "read" });
		source.emit({ type: "tool_execution_end", toolName: "read" });
		expect(reporter.state).toBe("working");
		source.emit({ type: "agent_end" });
		expect(reporter.state).toBe("idle");

		expect(calls.map(call => call.command.at(-3))).toEqual(["idle", "working", "idle"]);
	});

	it("reports blocked while the ask tool owns the turn", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		source.emit({ type: "agent_start" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		expect(reporter.state).toBe("blocked");
		source.emit({ type: "tool_execution_end", toolName: "ask" });
		expect(reporter.state).toBe("working");

		expect(calls.map(call => call.command.at(-3))).toEqual(["idle", "working", "blocked", "working"]);
	});

	it("stays blocked until the outermost nested ask completes", () => {
		const { spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		source.emit({ type: "agent_start" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		source.emit({ type: "tool_execution_end", toolName: "ask" });
		expect(reporter.state).toBe("blocked");
		source.emit({ type: "tool_execution_end", toolName: "ask" });
		expect(reporter.state).toBe("working");
	});

	it("does not leave a turn stuck blocked when a cancelled ask never ends", () => {
		const { spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		source.emit({ type: "agent_start" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		expect(reporter.state).toBe("blocked");
		source.emit({ type: "agent_end" });
		expect(reporter.state).toBe("idle");
		source.emit({ type: "agent_start" });
		expect(reporter.state).toBe("working");
	});

	it("assigns strictly increasing sequence numbers including the release", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = installHerdrReporter(source.subscribe, {
			env: paneEnv(),
			spawn,
			which: () => "/usr/bin/herdr",
		});
		expect(reporter).not.toBeNull();
		if (!reporter) throw new Error("expected Herdr reporter");

		source.emit({ type: "agent_start" });
		source.emit({ type: "agent_end" });
		reporter.release();

		// Metadata carries its own per-source sequence in Herdr, so only the
		// lifecycle reports share this counter.
		const seqs = calls
			.filter(call => !call.command.includes("report-metadata"))
			.map(call => Number(call.command.at(-1)));
		expect(seqs).toHaveLength(4);
		expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
		expect(new Set(seqs).size).toBe(4);
	});

	it("starts sequences above the ones a previous session in the pane used", async () => {
		// Herdr keeps the accepted sequence watermark on the terminal, so a second
		// gjc process in the same pane must not restart the count: its reports
		// would be dropped and the session would be missing from the sidebar.
		const first = recordingSpawn();
		const firstSource = eventSource();
		const firstReporter = installHerdrReporter(firstSource.subscribe, {
			env: paneEnv(),
			spawn: first.spawn,
			which: () => "/usr/bin/herdr",
		});
		expect(firstReporter).not.toBeNull();
		firstSource.emit({ type: "agent_start" });
		firstSource.emit({ type: "agent_end" });
		firstReporter?.release();

		await Bun.sleep(2);
		const second = recordingSpawn();
		createHerdrReporter(PANE, eventSource().subscribe, { env: paneEnv(), spawn: second.spawn });

		const lastOfFirst = Math.max(
			...first.calls
				.filter(call => !call.command.includes("report-metadata"))
				.map(call => Number(call.command.at(-1))),
		);
		const firstOfSecond = Number(second.calls[0]?.command.at(-1));
		expect(firstOfSecond).toBeGreaterThan(lastOfFirst);
	});

	it("does not reuse a sequence seed for reporters created in one tick", () => {
		const first = recordingSpawn();
		createHerdrReporter(PANE, eventSource().subscribe, { env: paneEnv(), spawn: first.spawn });
		const second = recordingSpawn();
		createHerdrReporter(PANE, eventSource().subscribe, { env: paneEnv(), spawn: second.spawn });

		expect(Number(second.calls[0]?.command.at(-1))).toBeGreaterThan(Number(first.calls[0]?.command.at(-1)));
	});

	it("releases the authority exactly once and unsubscribes", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = installHerdrReporter(source.subscribe, {
			env: paneEnv(),
			spawn,
			which: () => "/usr/bin/herdr",
		});
		expect(reporter).not.toBeNull();

		reporter?.release();
		reporter?.release();

		expect(source.attached).toBe(false);
		expect(source.unsubscribeCount).toBe(1);
		expect(calls).toHaveLength(3);
		expect(calls[1]?.command.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			...buildHerdrReleaseArgs("pane-7", 0).slice(0, -1),
		]);
		expect(calls[2]?.command.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			...buildHerdrClearTitleArgs("pane-7", 0).slice(0, -1),
		]);
	});

	it("ignores events and reports after release", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = installHerdrReporter(source.subscribe, {
			env: paneEnv(),
			spawn,
			which: () => "/usr/bin/herdr",
		});
		expect(reporter).not.toBeNull();

		reporter?.release();
		source.emit({ type: "agent_start" });
		reporter?.report("working");

		// idle at startup, then release-agent and the title retraction.
		expect(calls).toHaveLength(3);
	});

	it("does not release pane authority from the uninstalled reporter", () => {
		const { calls, spawn } = recordingSpawn();
		const reporter = createHerdrReporter(PANE, eventSource().subscribe, { env: paneEnv(), spawn });

		reporter.release();
		expect(calls).toHaveLength(1);
	});

	it("keeps reporting after a spawn throws synchronously", () => {
		let attempts = 0;
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, {
			env: paneEnv(),
			spawn: () => {
				attempts += 1;
				throw new Error("ENOENT");
			},
		});

		source.emit({ type: "agent_start" });
		expect(reporter.state).toBe("working");
		expect(attempts).toBe(2);
	});

	it("does not produce an unhandled rejection when the herdr process fails", async () => {
		const source = eventSource();
		createHerdrReporter(PANE, source.subscribe, {
			env: paneEnv(),
			spawn: () => ({
				exited: Promise.reject(new Error("spawn herdr ENOENT")),
				kill() {},
				unref() {},
			}),
		});

		// A pending rejection would surface on the next microtask drain.
		await Bun.sleep(0);
		expect(source.attached).toBe(true);
	});

	it("kills a herdr invocation that never exits", async () => {
		const calls: SpawnCall[] = [];
		const source = eventSource();
		createHerdrReporter(PANE, source.subscribe, {
			env: paneEnv(),
			spawn: (command: string[]) => {
				const call: SpawnCall = { command, killed: false };
				calls.push(call);
				return {
					exited: new Promise<number>(() => {}),
					kill() {
						call.killed = true;
					},
					unref() {},
				};
			},
		});

		await Bun.sleep(1600);
		expect(calls[0]?.killed).toBe(true);
	}, 5000);
});

describe("herdr pane title", () => {
	it("emits the documented metadata argv for a title and its retraction", () => {
		expect(buildHerdrTitleArgs("pane-7", "Refactor auth middleware", 2)).toEqual([
			"pane",
			"report-metadata",
			"pane-7",
			"--source",
			"custom:gjc",
			"--agent",
			"gjc",
			"--title",
			"Refactor auth middleware",
			"--seq",
			"2",
		]);
		expect(buildHerdrClearTitleArgs("pane-7", 3)).toEqual([
			"pane",
			"report-metadata",
			"pane-7",
			"--source",
			"custom:gjc",
			"--clear-title",
			"--seq",
			"3",
		]);
	});

	it("collapses a session name into a single-line title", () => {
		expect(sanitizeHerdrPaneTitle("  Fix   flaky\ttest  ")).toBe("Fix flaky test");
		expect(sanitizeHerdrPaneTitle("Fix\r\nflaky test")).toBe("Fix flaky test");
	});

	it("drops a title that carries no visible text", () => {
		expect(sanitizeHerdrPaneTitle(undefined)).toBeUndefined();
		expect(sanitizeHerdrPaneTitle("")).toBeUndefined();
		expect(sanitizeHerdrPaneTitle("   \n\t ")).toBeUndefined();
		expect(sanitizeHerdrPaneTitle("\u001b]0;pwned\u0007")).toBe("]0;pwned");
	});

	it("bounds the reported title", () => {
		const sanitized = sanitizeHerdrPaneTitle("x".repeat(500));
		expect(sanitized).toHaveLength(120);
	});

	it("reports the sanitized session title for the pane", () => {
		const { calls, spawn } = recordingSpawn();

		syncHerdrPaneTitle("Ship  the\nrelease", { env: paneEnv(), which: () => "/usr/bin/herdr", spawn });

		expect(calls).toHaveLength(1);
		const command = calls[0]?.command ?? [];
		expect(command.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			"pane",
			"report-metadata",
			"pane-7",
			"--source",
			"custom:gjc",
			"--agent",
			"gjc",
			"--title",
			"Ship the release",
			"--seq",
		]);
		expect(Number(command.at(-1))).toBeGreaterThan(0);
	});

	it("advances the metadata sequence between title reports", () => {
		const { calls, spawn } = recordingSpawn();
		const options = { env: paneEnv(), which: () => "/usr/bin/herdr", spawn };

		syncHerdrPaneTitle("first", options);
		syncHerdrPaneTitle("second", options);

		const [first, second] = calls.map(call => Number(call.command.at(-1)));
		expect(second).toBeGreaterThan(first as number);
	});

	it("is a no-op outside a Herdr pane", () => {
		const { calls, spawn } = recordingSpawn();

		syncHerdrPaneTitle("Ship the release", {
			env: {} as NodeJS.ProcessEnv,
			which: () => "/usr/bin/herdr",
			spawn,
		});

		expect(calls).toHaveLength(0);
	});

	it("keeps the previous title when the session has no usable name", () => {
		const { calls, spawn } = recordingSpawn();
		const options = { env: paneEnv(), which: () => "/usr/bin/herdr", spawn };

		syncHerdrPaneTitle(undefined, options);
		syncHerdrPaneTitle("   ", options);

		expect(calls).toHaveLength(0);
	});

	it("truncates without splitting a surrogate pair", () => {
		// 119 ASCII chars + one emoji (2 UTF-16 code units) = 121 code units.
		// A naive slice(0, 120) would leave a lone high surrogate at the end.
		const emoji = "🚀";
		const title = "a".repeat(119) + emoji;
		expect(title.length).toBe(121);
		const sanitized = sanitizeHerdrPaneTitle(title);
		expect(sanitized).toHaveLength(119);
		const last = sanitized!.charCodeAt(sanitized!.length - 1);
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
	});
});

describe("herdr server replacement", () => {
	/** Stand-in for the socket watch; the test drives replacement directly. */
	function fakeWatch() {
		let onReplaced: (() => void) | null = null;
		let closed = 0;
		return {
			watch(_socketPath: string, next: () => void) {
				onReplaced = next;
				return () => {
					closed += 1;
					onReplaced = null;
				};
			},
			replace() {
				onReplaced?.();
			},
			get watching() {
				return onReplaced !== null;
			},
			get closeCount() {
				return closed;
			},
		};
	}

	const SOCKET_PANE = { paneId: "pane-7", binPath: "/usr/bin/herdr", socketPath: "/tmp/herdr/herdr.sock" };

	it("re-reports the current state when the server is replaced", () => {
		const { calls, spawn } = recordingSpawn();
		const events = eventSource();
		const watcher = fakeWatch();
		const reporter = createHerdrReporter(SOCKET_PANE, events.subscribe, {
			env: paneEnv(),
			spawn,
			watchServerReplacement: watcher.watch,
		});
		events.emit({ type: "agent_start" });
		const beforeReplacement = calls.length;

		watcher.replace();

		const stateReports = calls
			.slice(beforeReplacement)
			.map(call => call.command)
			.filter(command => command.includes("report-agent"));
		expect(stateReports).toHaveLength(1);
		expect(stateReports[0]?.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			...buildHerdrReportArgs("pane-7", "working", 0).slice(0, -1),
		]);
		// The state memo must survive the re-assert, or the next real transition
		// would be deduplicated against a cleared value.
		expect(reporter.state).toBe("working");
	});

	it("raises the sequence so the replaced server accepts the re-report", () => {
		const { calls, spawn } = recordingSpawn();
		const events = eventSource();
		const watcher = fakeWatch();
		createHerdrReporter(SOCKET_PANE, events.subscribe, {
			env: paneEnv(),
			spawn,
			watchServerReplacement: watcher.watch,
		});
		watcher.replace();

		const [initial, reasserted] = calls
			.filter(call => call.command.includes("report-agent"))
			.map(call => Number(call.command.at(-1)));
		expect(reasserted).toBeGreaterThan(initial as number);
	});

	it("re-sends the last reported title so the pane is not left unlabeled", () => {
		const { calls, spawn } = recordingSpawn();
		const events = eventSource();
		const watcher = fakeWatch();
		const options = { env: paneEnv(), which: () => "/usr/bin/herdr", spawn };
		createHerdrReporter(SOCKET_PANE, events.subscribe, {
			...options,
			watchServerReplacement: watcher.watch,
		});
		syncHerdrPaneTitle("Ship the release", options);
		const beforeReplacement = calls.length;

		watcher.replace();

		const commands = calls.slice(beforeReplacement).map(call => call.command);
		const title = commands.find(command => command.includes("report-metadata"));
		expect(title?.slice(0, -1)).toEqual([
			"/usr/bin/herdr",
			...buildHerdrTitleArgs("pane-7", "Ship the release", 0).slice(0, -1),
		]);
	});

	it("stops watching once the pane authority is released", () => {
		const { spawn } = recordingSpawn();
		const events = eventSource();
		const watcher = fakeWatch();
		const reporter = createHerdrReporter(SOCKET_PANE, events.subscribe, {
			env: paneEnv(),
			spawn,
			watchServerReplacement: watcher.watch,
		});
		expect(watcher.watching).toBe(true);

		reporter.release();

		expect(watcher.closeCount).toBe(1);
		expect(watcher.watching).toBe(false);
	});

	it("does not watch when the pane environment names no socket", () => {
		const { spawn } = recordingSpawn();
		const events = eventSource();
		const watcher = fakeWatch();
		createHerdrReporter(PANE, events.subscribe, {
			env: paneEnv(),
			spawn,
			watchServerReplacement: watcher.watch,
		});

		expect(watcher.watching).toBe(false);
	});

	it("carries the socket path from the pane environment", () => {
		const resolved = resolveHerdrPaneEnvironment({
			env: paneEnv({ HERDR_BIN_PATH: "/usr/bin/herdr", HERDR_SOCKET_PATH: "/tmp/herdr/herdr.sock" }),
		});

		expect(resolved).toEqual({ paneId: "pane-7", binPath: "/usr/bin/herdr", socketPath: "/tmp/herdr/herdr.sock" });
	});
	it("detects a real socket being unlinked and rebound", async () => {
		// The production watch is the whole point of the feature: a server
		// replacement is unlink-then-bind on the same path, which arrives as a
		// single event while the path momentarily has no inode.
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-socket-"));
		const socketPath = path.join(directory, "herdr.sock");
		fs.writeFileSync(socketPath, "");
		const { calls, spawn } = recordingSpawn();
		const reporter = createHerdrReporter(
			{ paneId: "pane-7", binPath: "/usr/bin/herdr", socketPath },
			eventSource().subscribe,
			{ env: paneEnv(), spawn },
		);
		const before = calls.filter(call => call.command.includes("report-agent")).length;

		try {
			fs.unlinkSync(socketPath);
			fs.writeFileSync(socketPath, "");

			const deadline = Date.now() + 5_000;
			while (calls.filter(call => call.command.includes("report-agent")).length === before) {
				if (Date.now() > deadline) break;
				await Bun.sleep(50);
			}

			expect(calls.filter(call => call.command.includes("report-agent")).length).toBe(before + 1);
		} finally {
			reporter.release();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
