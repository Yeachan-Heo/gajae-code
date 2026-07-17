import { describe, expect, it } from "bun:test";
import { commands, runCli } from "@gajae-code/coding-agent/cli";
import { COMPUTER_BROKER_CLI_FLAG } from "@gajae-code/coding-agent/gjc-runtime/computer-broker";
import {
	type Gate0NativeController,
	isGate0Result,
	runComputerBrokerGate0,
} from "@gajae-code/coding-agent/gjc-runtime/computer-broker-gate0";
import {
	type Gate0LifecycleMarker,
	type Gate0TmuxChild,
	gate0TmuxEnvironment,
	runGate0TmuxLifecycle,
} from "@gajae-code/coding-agent/gjc-runtime/computer-broker-gate0-tmux";

function controller(overrides: Partial<Gate0NativeController> = {}): Gate0NativeController {
	return {
		gate0PermissionStatus: () => ({ accessibility: true, screenRecording: true }),
		gate0RequestScreenRecording: () => true,
		gate0HarmlessProbe: () => ({ screenshot: true, accessibility: true, pointerMoveRestore: true }),
		...overrides,
	};
}

function persistentProbe() {
	return {
		topology: "gate0" as const,
		phase: "A1" as const,
		permission: { accessibility: true, screenRecording: true },
		requestAttempted: false,
		success: true,
		code: "ok" as const,
		ancestry: { kind: "persistent_child" as const, bounded: true as const },
		lifecycle: [] as Gate0LifecycleMarker[],
	};
}

function persistentOutput(nonce: string, sequences: Array<"preflight" | "postflight">): Uint8Array {
	return new TextEncoder().encode(
		`${sequences.map(sequence => JSON.stringify({ nonce, sequence, result: persistentProbe() })).join("\n")}\n`,
	);
}

function acceleratedA1TimeoutClock(): () => number {
	let calls = 0;
	return () => {
		calls++;
		if (calls <= 3) return 0;
		if (calls <= 6) return 599;
		return 824;
	};
}

describe("computer broker Gate-0", () => {
	it("keeps hidden computer broker selectors out of actual public help", async () => {
		expect(commands.map(command => command.name)).not.toContain("--internal-computer-gate0");
		expect(commands.map(command => command.name)).not.toContain(COMPUTER_BROKER_CLI_FLAG);
		const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
		const child = Bun.spawn([process.execPath, cli, "--help"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(`${stdout}\n${stderr}`).not.toContain("--internal-computer-gate0");
		expect(`${stdout}\n${stderr}`).not.toContain(COMPUTER_BROKER_CLI_FLAG);
	});

	it("dispatches the exact hidden computer broker selector", async () => {
		const previousExitCode = process.exitCode;
		let invocations = 0;
		try {
			process.exitCode = 0;
			await runCli([COMPUTER_BROKER_CLI_FLAG], {
				runComputerBrokerFromEnvironment: async () => {
					invocations++;
				},
			});
			expect(invocations).toBe(1);
			expect(process.exitCode).toBe(0);
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it("refuses extra argv for the hidden computer broker selector", async () => {
		const previousExitCode = process.exitCode;
		let invocations = 0;
		try {
			process.exitCode = 0;
			await runCli([COMPUTER_BROKER_CLI_FLAG, "unexpected"], {
				runComputerBrokerFromEnvironment: async () => {
					invocations++;
				},
			});
			expect(invocations).toBe(0);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it.if(process.platform === "darwin")("fails closed when hidden malloc re-exec cannot start", async () => {
		const previousMalloc = process.env.MallocStackLogging;
		const previousGuard = process.env.GJC_MALLOC_ENV_REEXEC;
		const previousExitCode = process.exitCode;
		let invoked = false;
		let stdout = "";
		try {
			process.env.MallocStackLogging = "1";
			delete process.env.GJC_MALLOC_ENV_REEXEC;
			await runCli(["--internal-computer-gate0"], {
				reexecWithScrubbedMallocEnv: async () => null,
				runGate0FromEnvironment: async () => {
					invoked = true;
				},
				writeGate0Output: value => {
					stdout += value;
				},
			});
			expect(invoked).toBe(false);
			expect(process.exitCode).toBe(1);
			const output = JSON.parse(stdout);
			expect(output).toMatchObject({ success: false, code: "internal_error" });
			expect(isGate0Result(output)).toBe(true);
		} finally {
			if (previousMalloc === undefined) delete process.env.MallocStackLogging;
			else process.env.MallocStackLogging = previousMalloc;
			if (previousGuard === undefined) delete process.env.GJC_MALLOC_ENV_REEXEC;
			else process.env.GJC_MALLOC_ENV_REEXEC = previousGuard;
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it.if(process.platform === "darwin")("fails closed when broker malloc re-exec cannot start", async () => {
		const previousMalloc = process.env.MallocStackLogging;
		const previousGuard = process.env.GJC_MALLOC_ENV_REEXEC;
		const previousExitCode = process.exitCode;
		let invoked = false;
		try {
			process.env.MallocStackLogging = "1";
			delete process.env.GJC_MALLOC_ENV_REEXEC;
			await runCli([COMPUTER_BROKER_CLI_FLAG], {
				reexecWithScrubbedMallocEnv: async () => null,
				runComputerBrokerFromEnvironment: async () => {
					invoked = true;
				},
			});
			expect(invoked).toBe(false);
			expect(process.exitCode).toBe(1);
		} finally {
			if (previousMalloc === undefined) delete process.env.MallocStackLogging;
			else process.env.MallocStackLogging = previousMalloc;
			if (previousGuard === undefined) delete process.env.GJC_MALLOC_ENV_REEXEC;
			else process.env.GJC_MALLOC_ENV_REEXEC = previousGuard;
			process.exitCode = previousExitCode ?? 0;
		}
	});

	it("refuses malformed input with a stable code", async () => {
		const output = await runComputerBrokerGate0("not-json");
		expect(output).toMatchObject({ success: false, code: "invalid_input" });
	});

	it("attempts an explicit screen-recording request at most once", async () => {
		let requests = 0;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "probe", request: true }), {
			controllerFactory: () =>
				controller({
					gate0PermissionStatus: () => ({ accessibility: true, screenRecording: false }),
					gate0RequestScreenRecording: () => {
						requests++;
						return false;
					},
					gate0HarmlessProbe: () => ({ screenshot: false, accessibility: true, pointerMoveRestore: true }),
				}),
		});
		expect(requests).toBe(1);
		expect(output.requestAttempted).toBe(true);
		expect(output.code).toBe("permission_pending");
	});

	it("never requests Screen Recording during a non-requesting preflight", async () => {
		let requests = 0;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "probe", request: false }), {
			controllerFactory: () =>
				controller({
					gate0PermissionStatus: () => ({ accessibility: true, screenRecording: false }),
					gate0RequestScreenRecording: () => {
						requests++;
						return false;
					},
					gate0HarmlessProbe: () => ({ screenshot: false, accessibility: true, pointerMoveRestore: true }),
				}),
		});
		expect(requests).toBe(0);
		expect(output).toMatchObject({ requestAttempted: false, success: false, code: "permission_denied" });
	});

	it("awaits A2 lifecycle cleanup after its deadline expires", async () => {
		const clock = [0, 0, 599, 599];
		let observeAbort = () => {};
		const abortedSignal = new Promise<void>(resolve => {
			observeAbort = resolve;
		});
		let releaseCleanup = () => {};
		const output = runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
			controllerFactory: () => controller(),
			timeoutMs: 900,
			now: () => clock.shift() ?? 599,
			lifecycleRunner: ({ signal }) =>
				new Promise<Gate0LifecycleMarker[]>(resolve => {
					signal?.addEventListener("abort", () => {
						observeAbort();
						releaseCleanup = () =>
							resolve(["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"]);
					});
				}),
		});
		await abortedSignal;
		let settled = false;
		void output.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseCleanup();
		expect(await output).toMatchObject({ success: false, code: "timeout" });
	});

	it("does not return an A1 timeout until lifecycle cleanup and child exit complete", async () => {
		let observeAbort = () => {};
		const abortedSignal = new Promise<void>(resolve => {
			observeAbort = resolve;
		});
		let killed = 0;
		let releaseCleanup = () => {};
		let releaseExit = (_code: number) => {};
		const exited = new Promise<number>(resolve => {
			releaseExit = resolve;
		});
		const output = runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 900,
			now: acceleratedA1TimeoutClock(),
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: new ReadableStream({
					start: stream =>
						stream.enqueue(
							new TextEncoder().encode(
								`${JSON.stringify({ nonce, sequence: "preflight", result: { topology: "gate0", phase: "A1", permission: { accessibility: true, screenRecording: true }, requestAttempted: false, success: true, code: "ok", ancestry: { kind: "persistent_child", bounded: true }, lifecycle: [] } })}\n`,
							),
						),
				}),
				exited,
				kill: () => killed++,
			}),
			lifecycleRunner: ({ signal }) =>
				new Promise<Gate0LifecycleMarker[]>(resolve => {
					signal?.addEventListener("abort", () => {
						observeAbort();
						releaseCleanup = () =>
							resolve(["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"]);
					});
				}),
		});
		await abortedSignal;
		let settled = false;
		void output.then(() => {
			settled = true;
		});
		releaseCleanup();
		for (let attempt = 0; attempt < 100 && killed === 0; attempt++) await Bun.sleep(1);
		expect(settled).toBe(false);
		expect(killed).toBeGreaterThan(0);
		releaseExit(0);
		expect(await output).toMatchObject({ success: false, code: "timeout" });
	});

	it("uses one A1 deadline across preflight and the lifecycle runner", async () => {
		let clock = 0;
		const lifecycleTimeouts: number[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 90,
			now: () => clock,
			persistentChildSpawner: ({ nonce }) => ({
				stdin: {
					write: () => {},
					flush: async () => {
						clock += 10;
					},
					end: async () => {},
				},
				stdout: new ReadableStream({
					start: stream => stream.enqueue(persistentOutput(nonce, ["preflight", "postflight"])),
				}),
				exited: Promise.resolve(0),
				kill: () => {},
			}),
			lifecycleRunner: async ({ timeoutMs }) => {
				lifecycleTimeouts.push(timeoutMs ?? 0);
				return ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"];
			},
		});
		expect(lifecycleTimeouts).toEqual([50]);
		expect(output).toMatchObject({ success: true, code: "ok" });
	});

	it("fails closed when A1 child cleanup cannot be confirmed", async () => {
		let clock = 0;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 30,
			now: () => clock,
			persistentChildSpawner: () => ({
				stdin: {
					write: () => {},
					flush: async () => {
						clock = 30;
					},
					end: async () => {},
				},
				stdout: new ReadableStream<Uint8Array>(),
				exited: new Promise<number>(() => {}),
				kill: () => {},
			}),
		});
		expect(output).toMatchObject({ success: false, code: "internal_error" });
	});

	it("passes A2 only the shared operational budget remaining after preflight", async () => {
		let clock = 0;
		let probes = 0;
		const lifecycleTimeouts: number[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
			timeoutMs: 90,
			now: () => clock,
			controllerFactory: () =>
				controller({
					gate0HarmlessProbe: () => {
						if (++probes === 1) clock += 10;
						return { screenshot: true, accessibility: true, pointerMoveRestore: true };
					},
				}),
			lifecycleRunner: async ({ timeoutMs }) => {
				lifecycleTimeouts.push(timeoutMs ?? 0);
				return ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"];
			},
		});
		expect(lifecycleTimeouts).toEqual([50]);
		expect(output).toMatchObject({ success: true, code: "ok" });
	});

	it("refuses source-mode A1 before spawning an experiment child", async () => {
		let spawned = false;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => false,
			persistentChildSpawner: () => {
				spawned = true;
				throw new Error("must not spawn");
			},
		});
		expect(output).toMatchObject({ phase: "A1", success: false, code: "native_unavailable" });
		expect(spawned).toBe(false);
	});

	it("maps A1 setup failures to one redacted result", async () => {
		for (const dependencies of [
			{
				isCompiledBinary: () => {
					throw new Error("private setup detail");
				},
			},
			{
				isCompiledBinary: () => true,
				persistentChildSpawner: () => {
					throw new Error("private spawn detail");
				},
			},
		]) {
			const output = await runComputerBrokerGate0(
				JSON.stringify({ operation: "lifecycle", phase: "A1" }),
				dependencies,
			);
			expect(output).toMatchObject({ phase: "A1", success: false, code: "internal_error" });
			expect(JSON.stringify(output)).not.toMatch(/private|detail/);
			expect(isGate0Result(output)).toBe(true);
		}
	});

	it("uses the complete failing A1 snapshot without mixing permissions", async () => {
		const denied = {
			...persistentProbe(),
			permission: { accessibility: false, screenRecording: true },
			success: false,
			code: "permission_denied" as const,
		};
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: new ReadableStream({
					start: stream =>
						stream.enqueue(
							new TextEncoder().encode(
								`${JSON.stringify({ nonce, sequence: "preflight", result: denied })}\n${JSON.stringify({ nonce, sequence: "postflight", result: persistentProbe() })}\n`,
							),
						),
				}),
				exited: Promise.resolve(0),
				kill: () => {},
			}),
			lifecycleRunner: async () => ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
		});
		expect(output).toMatchObject({ success: false, code: "permission_denied", permission: denied.permission });
		expect(isGate0Result(output)).toBe(true);
	});

	it("escalates a TERM-resistant A1 child to SIGKILL", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 900,
			now: acceleratedA1TimeoutClock(),
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: new ReadableStream({ start: stream => stream.enqueue(persistentOutput(nonce, ["preflight"])) }),
				exited: exited.promise,
				kill: signal => {
					signals.push(String(signal));
					if (signal === "SIGKILL") exited.resolve(-1);
				},
			}),
			lifecycleRunner: ({ signal }) =>
				new Promise(resolve => {
					signal?.addEventListener("abort", () =>
						resolve(["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"]),
					);
				}),
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(output).toMatchObject({ success: false, code: "timeout" });
	});

	it("rejects duplicate A1 frames and nonzero child shutdown", async () => {
		for (const fixture of [
			{ sequences: ["preflight", "preflight"] as const, exitCode: 0 },
			{ sequences: ["preflight", "postflight"] as const, exitCode: 1 },
		]) {
			const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
				isCompiledBinary: () => true,
				persistentChildSpawner: ({ nonce }) => ({
					stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
					stdout: new ReadableStream({
						start: stream => stream.enqueue(persistentOutput(nonce, [...fixture.sequences])),
					}),
					exited: Promise.resolve(fixture.exitCode),
					kill: () => {},
				}),
				lifecycleRunner: async () => ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
			});
			expect(output).toMatchObject({ phase: "A1", success: false, code: "internal_error" });
		}
	});

	it("does not classify misleading internal messages as permission failures", async () => {
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "probe" }), {
			controllerFactory: () => {
				throw new Error("permission denied while decoding an internal database");
			},
		});
		expect(output.code).toBe("internal_error");
	});

	it("fails closed on malformed, extra, and incomplete hidden result contracts", async () => {
		const valid = {
			topology: "gate0",
			phase: "A2",
			permission: { accessibility: true, screenRecording: true },
			requestAttempted: false,
			success: true,
			code: "ok",
			ancestry: { kind: "outer_owner", bounded: true },
			lifecycle: ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
		};
		expect(isGate0Result({ ...valid, extra: true })).toBe(false);
		expect(isGate0Result({ ...valid, success: false })).toBe(false);
		expect(isGate0Result({ ...valid, phase: "A1" })).toBe(false);
		expect(isGate0Result({ ...valid, permission: { accessibility: false, screenRecording: false } })).toBe(false);
		expect(isGate0Result({ ...valid, lifecycle: [] })).toBe(false);
		for (const lifecycle of [
			["preflight", "cleaned"],
			["preflight", "tmux_created", "attached", "reattached", "detached", "cleaned"],
		]) {
			const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
				controllerFactory: () => controller(),
				lifecycleRunner: async () => lifecycle as Gate0LifecycleMarker[],
			});
			expect(output).toMatchObject({ success: false, code: "internal_error" });
		}
	});

	it("returns only redacted result fields", async () => {
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "probe" }), {
			controllerFactory: () => controller(),
		});
		expect(Object.keys(output).sort()).toEqual([
			"ancestry",
			"code",
			"lifecycle",
			"permission",
			"phase",
			"requestAttempted",
			"success",
			"topology",
		]);
		expect(JSON.stringify(output)).not.toMatch(/png|pixel|coordinate|text|key|secret/i);
	});

	it("runs A2 preflight and post-transition probes around the tmux lifecycle", async () => {
		let probes = 0;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
			controllerFactory: () =>
				controller({
					gate0HarmlessProbe: () => ({ screenshot: ++probes > 0, accessibility: true, pointerMoveRestore: true }),
				}),
			lifecycleRunner: async () => ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
		});
		expect(probes).toBe(2);
		expect(output).toMatchObject({ success: true, code: "ok", ancestry: { kind: "outer_owner" } });
	});

	it("returns canonical failures across A2 permission transitions", async () => {
		const granted = { accessibility: true, screenRecording: true };
		const denied = { accessibility: false, screenRecording: true };
		for (const fixture of [
			{
				statuses: [denied, denied, granted, granted],
				probes: [
					{ screenshot: true, accessibility: false, pointerMoveRestore: false },
					{ screenshot: true, accessibility: true, pointerMoveRestore: true },
				],
				expected: denied,
			},
			{
				statuses: [granted, granted, granted, denied],
				probes: [
					{ screenshot: true, accessibility: true, pointerMoveRestore: true },
					{ screenshot: true, accessibility: false, pointerMoveRestore: false },
				],
				expected: denied,
			},
		]) {
			const statuses = [...fixture.statuses];
			const probes = [...fixture.probes];
			const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
				controllerFactory: () =>
					controller({
						gate0PermissionStatus: () => statuses.shift() ?? denied,
						gate0HarmlessProbe: () => probes.shift() ?? fixture.probes.at(-1)!,
					}),
				lifecycleRunner: async () => ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
			});
			expect(output).toMatchObject({ success: false, code: "permission_denied", permission: fixture.expected });
			expect(isGate0Result(output)).toBe(true);
		}
	});

	it("rechecks permission after a harmless-probe race", async () => {
		const statuses = [
			{ accessibility: true, screenRecording: true },
			{ accessibility: false, screenRecording: true },
		];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "probe" }), {
			controllerFactory: () =>
				controller({
					gate0PermissionStatus: () => statuses.shift() ?? statuses[0]!,
				}),
		});
		expect(output).toMatchObject({ success: false, code: "permission_denied", permission: { accessibility: false } });
		expect(isGate0Result(output)).toBe(true);
	});
	it("uses a random no-config tmux server and strips nested ownership environment", async () => {
		const argv: string[][] = [];
		const options: Array<{ env: NodeJS.ProcessEnv }> = [];
		const exits = [0, 0, 0, 0, 0, 0, 1];
		const spawn = (command: string[], spawnOptions: { env: NodeJS.ProcessEnv }): Gate0TmuxChild => {
			argv.push(command);
			options.push(spawnOptions);
			return {
				exited: Promise.resolve(exits.shift() ?? 1),
				stdin: { write: () => {}, end: async () => {} },
				kill: () => {},
			};
		};
		await runGate0TmuxLifecycle({
			phase: "A2",
			tmuxCommand: "/usr/bin/tmux",
			env: {
				PATH: "/bin",
				TMUX: "outer",
				TMUX_PANE: "%1",
				GJC_TMUX_OWNER: "owner",
				GJC_COORDINATOR_SESSION_ID: "session",
				TERM_PROGRAM: "Ghostty",
				CMUX_BUNDLE_ID: "com.cmuxterm.app",
				GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
			},
			randomBytes: () => ({ toString: () => "0123456789abcdef01234567" }),
			spawn,
		});
		const prefix = ["/usr/bin/tmux", "-f", "/dev/null", "-L", "gjc-gate0-0123456789abcdef01234567"];
		expect(argv).toEqual([
			[...prefix, "new-session", "-d", "-s", "gate0", "--", "/bin/sleep", "15"],
			[...prefix, "has-session", "-t", "gate0"],
			[...prefix, "-C", "attach-session", "-t", "gate0"],
			[...prefix, "has-session", "-t", "gate0"],
			[...prefix, "-C", "attach-session", "-t", "gate0"],
			[...prefix, "kill-server"],
			[...prefix, "has-session", "-t", "gate0"],
		]);
		expect(
			gate0TmuxEnvironment({
				TMUX: "outer",
				TMUX_PANE: "%1",
				GJC_TMUX_OWNER: "owner",
				GJC_COORDINATOR_SESSION_ID: "session",
				TERM_PROGRAM: "Ghostty",
				CMUX_BUNDLE_ID: "com.cmuxterm.app",
				GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app",
				PATH: "/bin",
			}),
		).toEqual({ PATH: "/bin" });
		expect(options.every(option => JSON.stringify(option.env) === JSON.stringify({ PATH: "/bin" }))).toBe(true);
	});

	it("fails closed when random-server cleanup cannot be verified", async () => {
		const exits = [0, 0, 0, 0, 0, 1];
		const spawn = (): Gate0TmuxChild => ({
			exited: Promise.resolve(exits.shift() ?? 0),
			stdin: { write: () => {}, end: async () => {} },
			kill: () => {},
		});
		await expect(runGate0TmuxLifecycle({ phase: "A2", tmuxCommand: "/usr/bin/tmux", spawn })).rejects.toThrow(
			"GATE0_CLEANUP_FAILURE",
		);
	});

	it("requires confirmed client termination after TERM and SIGKILL", async () => {
		const signals: string[] = [];
		await expect(
			runGate0TmuxLifecycle({
				phase: "A2",
				tmuxCommand: "/usr/bin/tmux",
				timeoutMs: 30,
				spawn: () => ({
					exited: new Promise<number>(() => {}),
					stdin: { write: () => {}, end: async () => {} },
					kill: signal => signals.push(String(signal)),
				}),
			}),
		).rejects.toThrow("GATE0_CLEANUP_FAILURE");
		expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
	});

	it("fails closed when tmux client termination throws", async () => {
		await expect(
			runGate0TmuxLifecycle({
				phase: "A2",
				tmuxCommand: "/usr/bin/tmux",
				timeoutMs: 30,
				spawn: () => ({
					exited: new Promise<number>(() => {}),
					stdin: { write: () => {}, end: async () => {} },
					kill: () => {
						throw new Error("unavailable");
					},
				}),
			}),
		).rejects.toThrow("GATE0_CLEANUP_FAILURE");
	});

	it("accepts a nonzero kill-server status only when absence is verified", async () => {
		const exits = [0, 0, 0, 0, 0, 1, 1];
		const markers = await runGate0TmuxLifecycle({
			phase: "A2",
			tmuxCommand: "/usr/bin/tmux",
			spawn: () => ({
				exited: Promise.resolve(exits.shift() ?? 1),
				stdin: { write: () => {}, end: async () => {} },
				kill: () => {},
			}),
		});
		expect(markers.at(-1)).toBe("cleaned");
	});
	it("rejects nested persistent-frame extras without leaking them", async () => {
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: new ReadableStream({
					start: stream =>
						stream.enqueue(
							new TextEncoder().encode(
								`${JSON.stringify({
									nonce,
									sequence: "preflight",
									result: {
										...persistentProbe(),
										permission: { accessibility: true, screenRecording: true, secret: "leak" },
									},
								})}\n`,
							),
						),
				}),
				exited: Promise.resolve(0),
				kill: () => {},
			}),
		});
		expect(output).toMatchObject({ success: false, code: "internal_error" });
		expect(JSON.stringify(output)).not.toContain("leak");
		expect(isGate0Result(output)).toBe(true);
	});

	it("cleans an A1 child when stream setup fails", async () => {
		const signals: string[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			persistentChildSpawner: () => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: {
					getReader: () => {
						throw new Error("stream setup failed");
					},
				} as unknown as ReadableStream<Uint8Array>,
				exited: Promise.resolve(0),
				kill: signal => signals.push(String(signal)),
			}),
		});
		expect(output).toMatchObject({ success: false, code: "internal_error" });
		expect(signals).toEqual([]);
		expect(isGate0Result(output)).toBe(true);
	});

	it("cleans a namespace after a nonzero new-session client", async () => {
		const argv: string[][] = [];
		const exits = [1, 1, 1];
		await expect(
			runGate0TmuxLifecycle({
				phase: "A2",
				tmuxCommand: "/usr/bin/tmux",
				randomBytes: () => ({ toString: () => "a".repeat(24) }),
				spawn: command => {
					argv.push(command);
					return {
						exited: Promise.resolve(exits.shift() ?? 1),
						stdin: { write: () => {}, end: async () => {} },
						kill: () => {},
					};
				},
			}),
		).rejects.toThrow("GATE0_TMUX_FAILURE");
		expect(argv.map(command => command.at(-1))).toEqual(["15", "kill-server", "gate0"]);
		expect(
			argv.every(command => command.slice(1, 5).join(" ") === "-f /dev/null -L gjc-gate0-aaaaaaaaaaaaaaaaaaaaaaaa"),
		).toBe(true);
	});

	it("cleans a namespace after a timed-out new-session client", async () => {
		const argv: string[][] = [];
		const signals: string[] = [];
		const createExit = Promise.withResolvers<number>();
		let calls = 0;
		await expect(
			runGate0TmuxLifecycle({
				phase: "A2",
				tmuxCommand: "/usr/bin/tmux",
				timeoutMs: 60,
				randomBytes: () => ({ toString: () => "b".repeat(24) }),
				spawn: command => {
					argv.push(command);
					if (calls++ === 0) {
						return {
							exited: createExit.promise,
							stdin: { write: () => {}, end: async () => {} },
							kill: signal => {
								signals.push(String(signal));
								if (signal === "SIGKILL") createExit.resolve(-1);
							},
						};
					}
					return { exited: Promise.resolve(1), stdin: { write: () => {}, end: async () => {} }, kill: () => {} };
				},
			}),
		).rejects.toThrow("GATE0_TIMEOUT");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(argv.map(command => command.at(-1))).toEqual(["15", "kill-server", "gate0"]);
	});
	it("keeps A2 controller construction inside its one lifecycle deadline", async () => {
		let clock = 0;
		let lifecycleCalls = 0;
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A2" }), {
			timeoutMs: 30,
			now: () => clock,
			controllerFactory: () => {
				clock = 30;
				return controller();
			},
			lifecycleRunner: async () => {
				lifecycleCalls++;
				return ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"];
			},
		});
		expect(output).toMatchObject({ success: false, code: "timeout" });
		expect(lifecycleCalls).toBe(0);
	});

	it("preserves A1 SIGKILL fallback when SIGTERM throws", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 900,
			now: acceleratedA1TimeoutClock(),
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: async () => {} },
				stdout: new ReadableStream({ start: stream => stream.enqueue(persistentOutput(nonce, ["preflight"])) }),
				exited: exited.promise,
				kill: signal => {
					signals.push(String(signal));
					if (signal === "SIGTERM") throw new Error("term unavailable");
					if (signal === "SIGKILL") exited.resolve(-1);
				},
			}),
			lifecycleRunner: ({ signal }) =>
				new Promise(resolve =>
					signal?.addEventListener("abort", () =>
						resolve(["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"]),
					),
				),
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(output).toMatchObject({ success: false, code: "timeout" });
	});

	it("reserves A1 termination time when writer close never settles", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const output = await runComputerBrokerGate0(JSON.stringify({ operation: "lifecycle", phase: "A1" }), {
			isCompiledBinary: () => true,
			timeoutMs: 900,
			now: acceleratedA1TimeoutClock(),
			persistentChildSpawner: ({ nonce }) => ({
				stdin: { write: () => {}, flush: async () => {}, end: () => new Promise<void>(() => {}) },
				stdout: new ReadableStream({
					start: stream => stream.enqueue(persistentOutput(nonce, ["preflight", "postflight"])),
				}),
				exited: exited.promise,
				kill: signal => {
					signals.push(String(signal));
					if (signal === "SIGKILL") exited.resolve(-1);
				},
			}),
			lifecycleRunner: async () => ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
		});
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(output).toMatchObject({ success: false, code: "timeout" });
	});

	it("bounds rejected and never-settling tmux control closes before namespace cleanup", async () => {
		for (const end of [() => Promise.reject(new Error("close failed")), () => new Promise<void>(() => {})]) {
			const exited = Promise.withResolvers<number>();
			const signals: string[] = [];
			let calls = 0;
			await expect(
				runGate0TmuxLifecycle({
					phase: "A2",
					tmuxCommand: "/usr/bin/tmux",
					timeoutMs: 100,
					spawn: () => {
						if (calls++ === 2)
							return {
								exited: exited.promise,
								stdin: { write: () => {}, end },
								kill: signal => {
									signals.push(String(signal));
									if (signal === "SIGKILL") exited.resolve(-1);
								},
							};
						return {
							exited: Promise.resolve(calls === 5 ? 1 : 0),
							stdin: { write: () => {}, end: async () => {} },
							kill: () => {},
						};
					},
				}),
			).rejects.toThrow("GATE0_TMUX_FAILURE");
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(calls).toBe(5);
		}
	});

	it("uses tmux SIGKILL fallback after a throwing SIGTERM", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		let calls = 0;
		await expect(
			runGate0TmuxLifecycle({
				phase: "A2",
				tmuxCommand: "/usr/bin/tmux",
				timeoutMs: 30,
				spawn: () => {
					if (calls++ === 2)
						return {
							exited: exited.promise,
							stdin: { write: () => {}, end: () => Promise.reject(new Error("close failed")) },
							kill: signal => {
								signals.push(String(signal));
								if (signal === "SIGTERM") throw new Error("term unavailable");
								if (signal === "SIGKILL") exited.resolve(-1);
							},
						};
					return {
						exited: Promise.resolve(calls === 5 ? 1 : 0),
						stdin: { write: () => {}, end: async () => {} },
						kill: () => {},
					};
				},
			}),
		).rejects.toThrow("GATE0_TMUX_FAILURE");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
