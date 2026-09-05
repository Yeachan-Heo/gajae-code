import { afterEach, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@gajae-code/utils";
import { disposeAllOwnedProcesses, liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";
import { connectToServer, MCPConnectionCleanupFailure } from "../../src/runtime-mcp/client";
import { MCPManager } from "../../src/runtime-mcp/manager";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";
import { StdioTransport } from "../../src/runtime-mcp/transports/stdio";
import { MCPExpectedFailure } from "../../src/runtime-mcp/types";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function processState(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "?";
		return `state=${state}`;
	} catch {
		return "gone";
	}
}

/**
 * Whether a pid is alive. A zombie (state Z) is NOT alive: it executes no code
 * and only its reaping remains, which is the parent reaper's job. Counting
 * zombies as alive makes the teardown assertions hostage to an external reaper
 * (PID 1 under shard load), which is exactly what previously timed this test
 * out. Non-Linux falls back to signal-0 probing.
 */
function isAlive(pid: number): boolean {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
			if (state === "Z" || state === "X") return false;
		} catch {
			// No such process (or it raced out of the table).
			return false;
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Wait for the fixture's grandchild pid file. The fixture writes its root pid
 * first and the spawned grandchild pid second, so a timeout here is a fixture
 * readiness failure (root never became ready), not a product teardown failure
 * — the error surfaces the root's live state for diagnosis instead of hanging.
 */
async function waitForPid(childPidFile: string, rootPidFile: string): Promise<number> {
	try {
		// The readiness window is bounded well under the test budget so a dead
		// fixture surfaces the diagnostic below instead of a bare timeout.
		await waitFor(async () => {
			const text = await Bun.file(childPidFile)
				.text()
				.catch(() => "");
			return Number(text) > 0;
		}, 4_000);
		return Number(await Bun.file(childPidFile).text());
	} catch (error) {
		const rootPid = Number(
			(await Bun.file(rootPidFile)
				.text()
				.catch(() => "")) || 0,
		);
		const rootInfo = rootPid > 0 ? `${rootPid} ${processState(rootPid)}` : "no root pid file written";
		throw new Error(
			`fixture readiness failed: grandchild pid file never appeared; root=${rootInfo} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

const servers: Bun.Server<unknown>[] = [];
const STDIO_LIFECYCLE_ISOLATION = "GJC_TEST_MCP_STDIO_LIFECYCLE_ISOLATED";

async function runIsolatedStdioLifecycleTest(): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "test", import.meta.path, "--test-name-pattern", "close and reconnect dispose"],
		{
			cwd: join(import.meta.dir, "..", ".."),
			env: { ...process.env, [STDIO_LIFECYCLE_ISOLATION]: "1" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}

afterEach(async () => {
	try {
		await Promise.all(servers.splice(0).map(server => server.stop(true)));
	} finally {
		await disposeAllOwnedProcesses();
	}
});

describe("MCP stdio transport lifecycle", () => {
	test("propagates backpressured write failures without unhandled rejection", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", "setTimeout(() => process.exit(1), 100)"],
			timeout: 1_000,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await transport.connect();
			await expect(
				transport.notify("notifications/large", { text: "x".repeat(64 * 1024 * 1024) }),
			).rejects.toBeInstanceOf(MCPExpectedFailure);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test("delivers request timeouts while a write remains backpressured", async () => {
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			timeout: 25,
		});
		try {
			await transport.connect();
			await expect(transport.request("tools/list", { text: "x".repeat(64 * 1024 * 1024) })).rejects.toThrow(
				"Request timeout after 25ms",
			);
		} finally {
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test("close before cleanup registration joins the attempt without declaring completion early", async () => {
		const before = liveOwnedProcessCount();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const spawnMarker = `/tmp/gjc-mcp-stdio-close-before-register-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let closeSettled = false;
		const transport = new StdioTransport({
			command: process.execPath,
			args: [
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned"); setInterval(() => {}, 1000);`,
			],
			prepareSpawn: async launch => {
				entered.resolve();
				await release.promise;
				return launch;
			},
		});
		const connectAttempt = transport.connect();
		void connectAttempt.catch(() => {});
		try {
			await entered.promise;
			const closeAttempt = transport.close().finally(() => {
				closeSettled = true;
			});
			await Bun.sleep(0);
			expect(closeSettled).toBe(false);
			release.resolve();

			await expect(connectAttempt).rejects.toThrow("MCP stdio connection attempt was closed");
			await closeAttempt;
			expect(transport.connected).toBe(false);
			expect(await Bun.file(spawnMarker).exists()).toBe(false);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
		} finally {
			release.resolve();
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test.each([
		["before cleanup registration", "before-registration", "abort"],
		["during capsule allocation", "during-allocation", "timeout"],
		["after guards and before process spawn", "before-spawn", "abort"],
	] as const)(
		"%s cancellation joins preparation, prevents spawn, and runs each owned cleanup once",
		async (_label, phase, cancellation) => {
			const before = liveOwnedProcessCount();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const closeStarted = Promise.withResolvers<void>();
			const cleanupOwners = new Set<number>();
			const abortController = new AbortController();
			const abortFailure = new Error(`synthetic ${phase} abort`);
			const spawnMarker = `/tmp/gjc-mcp-stdio-late-spawn-${phase}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			let cleanupAttempts = 0;
			let guardAttempts = 0;
			let outcomeSettled = false;
			const originalClose = StdioTransport.prototype.close;
			const closeSpy = vi.spyOn(StdioTransport.prototype, "close").mockImplementation(function (
				this: StdioTransport,
			) {
				const closing = originalClose.call(this);
				closeStarted.resolve();
				return closing;
			});

			const cleanup = async () => {
				cleanupAttempts++;
				expect(cleanupOwners.delete(1)).toBe(true);
			};
			try {
				const outcome = connectToServer(
					`stdio-${phase}`,
					{
						type: "stdio",
						command: process.execPath,
						args: [
							"-e",
							`require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned"); setInterval(() => {}, 1000);`,
						],
						timeout: cancellation === "timeout" ? 20 : 5_000,
						prepareSpawn: async launch => {
							if (!launch.registerCleanup) throw new Error("missing stdio cleanup registrar");
							if (phase === "before-registration") {
								entered.resolve();
								await release.promise;
								cleanupOwners.add(1);
								launch.registerCleanup(cleanup);
								return { ...launch, afterProcessExit: cleanup };
							}
							cleanupOwners.add(1);
							launch.registerCleanup(cleanup);
							if (phase === "during-allocation") {
								entered.resolve();
								await release.promise;
							}
							return { ...launch, afterProcessExit: cleanup };
						},
						spawnGuard: async () => {
							guardAttempts++;
						},
						afterSpawnGuardForTest:
							phase === "before-spawn"
								? async () => {
										entered.resolve();
										await release.promise;
									}
								: undefined,
					},
					{ signal: abortController.signal },
				).then(
					() => ({ status: "resolved" as const, error: undefined }),
					error => ({ status: "rejected" as const, error }),
				);
				void outcome.then(() => {
					outcomeSettled = true;
				});

				await entered.promise;
				if (cancellation === "abort") abortController.abort(abortFailure);
				await closeStarted.promise;
				const outcomeSettledBeforeRelease = outcomeSettled;
				release.resolve();

				const result = await outcome;
				expect(outcomeSettledBeforeRelease).toBe(false);
				expect(result.status).toBe("rejected");
				expect(result.error).toBeInstanceOf(MCPExpectedFailure);
				if (cancellation === "abort") expect((result.error as Error).cause).toBe(abortFailure);
				else expect((result.error as Error).message).toContain("timed out after 20ms");
				expect(guardAttempts).toBe(phase === "before-spawn" ? 1 : 0);
				expect(cleanupAttempts).toBe(1);
				expect([...cleanupOwners]).toEqual([]);
				expect(await Bun.file(spawnMarker).exists()).toBe(false);
				expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
			} finally {
				abortController.abort(new Error(`stdio ${phase} test cleanup`));
				release.resolve();
				closeSpy.mockRestore();
				await disposeAllOwnedProcesses();
			}
		},
		10_000,
	);

	test("failed spawn keeps rejected cleanup owned, combines both errors, and fences reconnect", async () => {
		const before = liveOwnedProcessCount();
		const missingCommand = join(import.meta.dir, "fixtures", "missing-stdio-server");
		const cleanupFailure = new Error("synthetic failed-spawn cleanup failure");
		const cleanupOwners = new Set<number>();
		const cleanupAttempts: number[] = [];
		let prepareAttempts = 0;
		let rejectFirstCleanup = true;
		const transport = new StdioTransport({
			command: missingCommand,
			args: [],
			timeout: 500,
			prepareSpawn: async launch => {
				const owner = ++prepareAttempts;
				cleanupOwners.add(owner);
				return {
					...launch,
					command: owner === 1 ? launch.command : process.execPath,
					args: owner === 1 ? launch.args : ["-e", "setInterval(() => {}, 1000)"],
					afterProcessExit: async () => {
						cleanupAttempts.push(owner);
						if (owner === 1 && rejectFirstCleanup) {
							rejectFirstCleanup = false;
							throw cleanupFailure;
						}
						expect(cleanupOwners.delete(owner)).toBe(true);
					},
				};
			},
		});
		try {
			let failure: unknown;
			try {
				await transport.connect();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(MCPExpectedFailure);
			const combined = failure instanceof Error ? failure.cause : undefined;
			expect(combined).toBeInstanceOf(AggregateError);
			if (!(combined instanceof AggregateError)) throw new Error("Expected combined stdio cleanup failure");
			expect(combined.errors).toHaveLength(2);
			expect(combined.errors[0]).toBeInstanceOf(Error);
			expect(combined.errors[0]).not.toBe(cleanupFailure);
			expect(combined.errors[1]).toBe(cleanupFailure);
			expect([...cleanupOwners]).toEqual([1]);
			expect(cleanupAttempts).toEqual([1]);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);

			await expect(transport.connect()).rejects.toThrow("MCP stdio child teardown is incomplete");
			expect(prepareAttempts).toBe(1);
			expect(cleanupAttempts).toEqual([1]);

			await transport.close();
			expect([...cleanupOwners]).toEqual([]);
			expect(cleanupAttempts).toEqual([1, 1]);

			await transport.connect();
			expect(prepareAttempts).toBe(2);
			expect([...cleanupOwners]).toEqual([2]);
			await transport.close();
			expect([...cleanupOwners]).toEqual([]);
			expect(cleanupAttempts).toEqual([1, 1, 2]);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
		} finally {
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test("preparation failure retains registered rm ownership for explicit close and fences reconnect", async () => {
		const before = liveOwnedProcessCount();
		const preparationFailure = new Error("synthetic preparation failure after allocation");
		const rmFailure = new Error("synthetic preparation rm failure");
		const cleanupOwners = new Set<number>();
		let prepareAttempts = 0;
		let rmAttempts = 0;
		const transport = new StdioTransport({
			command: process.execPath,
			timeout: 500,
			prepareSpawn: async launch => {
				const owner = ++prepareAttempts;
				cleanupOwners.add(owner);
				if (!launch.registerCleanup) throw new Error("missing stdio cleanup registrar");
				launch.registerCleanup(async () => {
					rmAttempts++;
					if (rmAttempts === 1) throw rmFailure;
					expect(cleanupOwners.delete(owner)).toBe(true);
				});
				throw preparationFailure;
			},
		});
		try {
			let failure: unknown;
			try {
				await transport.connect();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(MCPExpectedFailure);
			const combined = failure instanceof Error ? failure.cause : undefined;
			expect(combined).toBeInstanceOf(AggregateError);
			if (!(combined instanceof AggregateError)) throw new Error("Expected combined preparation cleanup failure");
			expect(combined.errors).toEqual([preparationFailure, rmFailure]);
			expect([...cleanupOwners]).toEqual([1]);
			expect(prepareAttempts).toBe(1);
			expect(rmAttempts).toBe(1);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);

			await expect(transport.connect()).rejects.toThrow("MCP stdio child teardown is incomplete");
			expect(prepareAttempts).toBe(1);
			expect(rmAttempts).toBe(1);

			await transport.close();
			expect([...cleanupOwners]).toEqual([]);
			expect(rmAttempts).toBe(2);
			await transport.close();
			expect(rmAttempts).toBe(2);
		} finally {
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test("client factory exposes cleanup ownership after every automatic removal attempt fails", async () => {
		const before = liveOwnedProcessCount();
		const spawnFailure = new Error("synthetic factory-path spawn failure");
		const cleanupFailures = [
			new Error("synthetic factory-path removal failure 1"),
			new Error("synthetic factory-path removal failure 2"),
			new Error("synthetic factory-path removal failure 3"),
		];
		const cleanupOwners = new Set<number>();
		let cleanupAttempts = 0;
		let prepareAttempts = 0;
		let spawnAttempts = 0;
		let failure: unknown;
		try {
			await connectToServer("stdio-cleanup-owner", {
				type: "stdio",
				command: process.execPath,
				timeout: 500,
				prepareSpawn: async launch => {
					const owner = ++prepareAttempts;
					cleanupOwners.add(owner);
					return {
						...launch,
						afterProcessExit: async () => {
							const cleanupFailure = cleanupFailures[cleanupAttempts++];
							if (cleanupFailure) throw cleanupFailure;
							expect(cleanupOwners.delete(owner)).toBe(true);
						},
					};
				},
				spawnGuard: async () => {
					spawnAttempts++;
					throw spawnFailure;
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(MCPConnectionCleanupFailure);
		const combined = failure instanceof Error ? failure.cause : undefined;
		expect(combined).toBeInstanceOf(AggregateError);
		if (!(combined instanceof AggregateError)) throw new Error("Expected combined factory cleanup failure");
		expect(combined.errors).toEqual([spawnFailure, ...cleanupFailures]);
		expect(cleanupAttempts).toBe(3);
		expect([...cleanupOwners]).toEqual([1]);
		expect(prepareAttempts).toBe(1);
		expect(spawnAttempts).toBe(1);
		if (!(failure instanceof MCPConnectionCleanupFailure)) {
			throw new Error("Expected recoverable factory cleanup failure");
		}
		await failure.close();
		expect(cleanupAttempts).toBe(4);
		expect([...cleanupOwners]).toEqual([]);
		await failure.close();
		expect(cleanupAttempts).toBe(4);
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
	}, 10_000);

	test("manager retains cleanup diagnostics and fences reconnect until explicit cleanup succeeds", async () => {
		const before = liveOwnedProcessCount();
		const name = "manager-cleanup-owner";
		const spawnFailure = new Error("synthetic manager spawn failure");
		const cleanupFailures = [
			new Error("synthetic manager removal failure 1"),
			new Error("synthetic manager removal failure 2"),
			new Error("synthetic manager removal failure 3"),
			new Error("synthetic manager removal failure 4"),
		];
		const cleanupOwners = new Set<number>();
		const cleanupAttempts: number[] = [];
		let prepareAttempts = 0;
		let spawnAttempts = 0;
		const config = {
			type: "stdio" as const,
			command: process.execPath,
			timeout: 500,
			prepareSpawn: async (launch: { command: string; args: readonly string[]; cwd: string }) => {
				const owner = ++prepareAttempts;
				cleanupOwners.add(owner);
				return {
					...launch,
					afterProcessExit: async () => {
						cleanupAttempts.push(owner);
						const ownerAttempt = cleanupAttempts.filter(candidate => candidate === owner).length;
						const cleanupFailure = owner === 1 ? cleanupFailures[ownerAttempt - 1] : undefined;
						if (cleanupFailure) throw cleanupFailure;
						expect(cleanupOwners.delete(owner)).toBe(true);
					},
				};
			},
			spawnGuard: async () => {
				spawnAttempts++;
				throw spawnFailure;
			},
		};
		const manager = new MCPManager(process.cwd(), null, { maxStartupTimeoutMs: 1_000 });

		const first = await manager.connectServers({ [name]: config }, {});
		const retained = manager.getPendingConnectionCleanupFailureForTests(name);
		expect(first.errors.has(name)).toBe(true);
		expect(retained).toBeInstanceOf(MCPConnectionCleanupFailure);
		const retainedCause = retained?.cause;
		expect(retainedCause).toBeInstanceOf(AggregateError);
		if (!(retainedCause instanceof AggregateError)) throw new Error("Expected retained manager cleanup failure");
		expect(retainedCause.errors).toEqual([spawnFailure, ...cleanupFailures.slice(0, 3)]);
		expect(cleanupAttempts).toEqual([1, 1, 1]);
		expect([...cleanupOwners]).toEqual([1]);
		expect(prepareAttempts).toBe(1);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(1);
		expect(manager.getPendingConnectionCleanupFailureForTests(name)).toBe(retained);
		expect(manager.getAllServerNames()).toContain(name);

		const fenced = await manager.connectServers({ [name]: config }, {});
		expect(fenced.errors.has(name)).toBe(true);
		expect(manager.getPendingConnectionCleanupFailureForTests(name)).toBe(retained);
		expect(prepareAttempts).toBe(1);
		expect(cleanupAttempts).toEqual([1, 1, 1]);

		let reconnectFailure: unknown;
		try {
			await manager.reconnectServer(name);
		} catch (error) {
			reconnectFailure = error;
		}
		expect(reconnectFailure).toBeInstanceOf(MCPConnectionCleanupFailure);
		if (!(reconnectFailure instanceof MCPConnectionCleanupFailure)) throw new Error("Expected owned cleanup failure");
		const reconnectCause = reconnectFailure instanceof Error ? reconnectFailure.cause : undefined;
		expect(reconnectCause).toBeInstanceOf(AggregateError);
		if (!(reconnectCause instanceof AggregateError)) throw new Error("Expected reconnect cleanup failure");
		expect(reconnectCause.errors).toEqual([spawnFailure, ...cleanupFailures]);
		expect(cleanupAttempts).toEqual([1, 1, 1, 1]);
		expect([...cleanupOwners]).toEqual([1]);
		expect(prepareAttempts).toBe(1);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(1);
		expect(manager.getPendingConnectionCleanupFailureForTests(name)).toBe(reconnectFailure);

		await manager.disconnectServer(name);
		expect(cleanupAttempts).toEqual([1, 1, 1, 1, 1]);
		expect([...cleanupOwners]).toEqual([]);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(0);
		expect(manager.getPendingConnectionCleanupFailureForTests(name)).toBeUndefined();
		expect(manager.getAllServerNames()).not.toContain(name);

		await manager.connectServers({ [name]: config }, {});
		expect(prepareAttempts).toBe(2);
		expect(spawnAttempts).toBe(2);
		expect(cleanupAttempts).toEqual([1, 1, 1, 1, 1, 2]);
		expect([...cleanupOwners]).toEqual([]);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(0);
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
		await manager.disconnectAll();
	}, 10_000);

	test("repeated removal failures keep cleanup owned and fence reconnect until a close succeeds", async () => {
		const before = liveOwnedProcessCount();
		const cleanupFailures = [
			new Error("synthetic normal-close removal failure 1"),
			new Error("synthetic normal-close removal failure 2"),
		];
		const cleanupOwners = new Set<number>();
		const cleanupAttempts: number[] = [];
		let prepareAttempts = 0;
		const transport = new StdioTransport({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			timeout: 500,
			prepareSpawn: async launch => {
				const owner = ++prepareAttempts;
				cleanupOwners.add(owner);
				return {
					...launch,
					afterProcessExit: async () => {
						cleanupAttempts.push(owner);
						const cleanupFailure = owner === 1 ? cleanupFailures[cleanupAttempts.length - 1] : undefined;
						if (cleanupFailure) throw cleanupFailure;
						expect(cleanupOwners.delete(owner)).toBe(true);
					},
				};
			},
		});
		try {
			await transport.connect();
			expect([...cleanupOwners]).toEqual([1]);

			let closeFailure: unknown;
			try {
				await transport.close();
			} catch (error) {
				closeFailure = error;
			}
			expect(closeFailure).toBe(cleanupFailures[0]);
			expect(transport.connected).toBe(false);
			expect([...cleanupOwners]).toEqual([1]);
			expect(cleanupAttempts).toEqual([1]);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);

			await expect(transport.connect()).rejects.toThrow("MCP stdio child teardown is incomplete");
			expect(prepareAttempts).toBe(1);
			expect(cleanupAttempts).toEqual([1]);

			await expect(transport.close()).rejects.toBe(cleanupFailures[1]);
			expect([...cleanupOwners]).toEqual([1]);
			expect(cleanupAttempts).toEqual([1, 1]);
			await expect(transport.connect()).rejects.toThrow("MCP stdio child teardown is incomplete");
			expect(prepareAttempts).toBe(1);

			await transport.close();
			expect([...cleanupOwners]).toEqual([]);
			expect(cleanupAttempts).toEqual([1, 1, 1]);

			await transport.connect();
			expect(prepareAttempts).toBe(2);
			expect([...cleanupOwners]).toEqual([2]);
			await transport.close();
			expect([...cleanupOwners]).toEqual([]);
			expect(cleanupAttempts).toEqual([1, 1, 1, 2]);
			expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
		} finally {
			await transport.close().catch(() => {});
		}
	}, 10_000);

	test("normal close and reconnect dispose the old child tree and cleanup owner", async () => {
		vi.restoreAllMocks();
		if (process.env[STDIO_LIFECYCLE_ISOLATION] !== "1") {
			await runIsolatedStdioLifecycleTest();
			return;
		}
		const before = liveOwnedProcessCount();
		const base = `/tmp/gjc-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const rootPidFile = `${base}.root.pid`;
		const childPidFile = `${base}.child.pid`;
		// The fixture root runs on the already-resident Bun runtime and reports
		// its own pid first and the spawned grandchild pid second, so readiness
		// is observable and distinguishable from the transport's close/reconnect
		// ownership contract below.
		const command = [
			process.execPath,
			join(import.meta.dir, "fixtures", "stdio-process-tree.ts"),
			childPidFile,
			rootPidFile,
		];
		let cleanupOwner = 0;
		const cleanupOwners = new Set<number>();
		const cleanupAttempts: number[] = [];
		const transport = new StdioTransport({
			command: command[0],
			args: command.slice(1),
			timeout: 500,
			prepareSpawn: async launch => {
				const owner = ++cleanupOwner;
				cleanupOwners.add(owner);
				const cleanup = async () => {
					expect(cleanupOwners.delete(owner)).toBe(true);
					cleanupAttempts.push(owner);
				};
				if (!launch.registerCleanup) throw new Error("missing stdio cleanup registrar");
				launch.registerCleanup(cleanup);
				return { ...launch, afterProcessExit: cleanup };
			},
		});
		await transport.connect();
		expect([...cleanupOwners]).toEqual([1]);
		const oldChildPid = await waitForPid(childPidFile, rootPidFile);
		expect(isAlive(oldChildPid)).toBe(true);

		await transport.close();
		await waitFor(() => !isAlive(oldChildPid));
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
		expect([...cleanupOwners]).toEqual([]);
		expect(cleanupAttempts).toEqual([1]);

		await Bun.write(childPidFile, "");
		await transport.connect();
		expect([...cleanupOwners]).toEqual([2]);
		const newChildPid = await waitForPid(childPidFile, rootPidFile);
		expect(newChildPid).not.toBe(oldChildPid);
		expect(isAlive(oldChildPid)).toBe(false);
		await transport.close();
		await waitFor(() => !isAlive(newChildPid));
		expect([...cleanupOwners]).toEqual([]);
		expect(cleanupAttempts).toEqual([1, 2]);
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);
	});
});

describe("MCP HTTP transport lifecycle", () => {
	test("request timeout covers hanging response bodies after headers", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 100 });
		await transport.connect();
		await expect(transport.request("tools/list")).rejects.toThrow("Request timeout after 100ms");
		await transport.close();
	});

	test("per-request SSE closes after matching response", async () => {
		let nextId: string | number = "1";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			async fetch(req) {
				const request = (await req.json()) as { id?: string | number };
				nextId = request.id ?? nextId;
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: {"jsonrpc":"2.0","id":${JSON.stringify(nextId)},"result":{"ok":true}}\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });

		await transport.close();
	});

	test("failed GET SSE listener cancels the response body", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.close();
					},
				});
				return new Response(stream, { status: 500 });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await transport.startSSEListener();

		await transport.close();
	});
	test("redacts background SSE parser diagnostics without changing error or close handling", async () => {
		const credential = "sse-query-credential";
		const rawSseMarker = "MALICIOUS_SSE_PAYLOAD_MARKER";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`data: ${rawSseMarker}\n\n`));
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const url = `${server.url.href}?access_token=${credential}`;
		const transport = new HttpTransport({ type: "http", url, timeout: 1_000 });
		const errors: Error[] = [];
		let closeCount = 0;
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		let closed = false;

		try {
			transport.onError = error => errors.push(error);
			transport.onClose = () => {
				closeCount += 1;
			};

			await transport.connect();
			await transport.startSSEListener();
			await waitFor(() => errors.length === 1 && closeCount === 1);

			expect(errors[0]).toBeInstanceOf(SyntaxError);
			expect(debugSpy).toHaveBeenCalledTimes(1);
			expect(debugSpy).toHaveBeenCalledWith("HTTP SSE stream error");
			expect(infoSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();

			await transport.close();
			closed = true;
			expect(closeCount).toBe(2);
		} finally {
			try {
				if (!closed) await transport.close();
			} finally {
				vi.restoreAllMocks();
			}
		}
	});
});
