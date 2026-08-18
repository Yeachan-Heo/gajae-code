import { describe, expect, it } from "bun:test";
import {
	buildHerdrClearTitleArgs,
	buildHerdrReleaseArgs,
	buildHerdrReportArgs,
	buildHerdrTitleArgs,
	createHerdrReporter,
	type HerdrReportProcess,
	type HerdrSessionEvent,
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
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

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
		const firstReporter = createHerdrReporter(PANE, firstSource.subscribe, { env: paneEnv(), spawn: first.spawn });
		firstSource.emit({ type: "agent_start" });
		firstSource.emit({ type: "agent_end" });
		firstReporter.release();

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

	it("releases the authority exactly once and unsubscribes", () => {
		const { calls, spawn } = recordingSpawn();
		const source = eventSource();
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		reporter.release();
		reporter.release();

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
		const reporter = createHerdrReporter(PANE, source.subscribe, { env: paneEnv(), spawn });

		reporter.release();
		source.emit({ type: "agent_start" });
		reporter.report("working");

		// idle at startup, then release-agent and the title retraction.
		expect(calls).toHaveLength(3);
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
