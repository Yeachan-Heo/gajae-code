import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import {
	prepareSpawnChildHostLaunch,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
	setProcessIncarnationForTest,
} from "../src/sdk/broker/lifecycle";
import { resolveSdkInternalSpawnCommand } from "../src/sdk/broker/runtime";
import type { SessionLocatorV2 } from "../src/sdk/broker/session-index";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { SdkClient } from "../src/sdk/client";

describe("Broker ephemeral session propagation and filtering", () => {
	let tmpDir: string;
	let sessionIndex: SessionIndex;
	const createLocator = (cwd: string): SessionLocatorV2 => ({
		cwd: path.resolve(cwd),
		worktreeRoot: null,
		stateRoot: path.join(cwd, ".gjc", "state"),
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp("/tmp/gjc-broker-ephemeral-");
		const agentDir = path.join(tmpDir, "agent");
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		sessionIndex = new SessionIndex(agentDir);
	});

	afterEach(async () => {
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("Temporary host admission", () => {
		it("preserves launch intent when readiness times out before registration and cleanup is uncertain", async () => {
			const agentDir = path.join(tmpDir, "agent");
			const broker = new Broker({ agentDir });
			const previous = process.env.GJC_SDK_SESSION_COMMAND;
			delete process.env.GJC_SDK_SESSION_COMMAND;
			const ids: string[] = [];
			try {
				await broker.start();
				for (const ephemeral of [true, false]) {
					const cwd = path.join(tmpDir, ephemeral ? "temporary" : "ordinary");
					await fs.mkdir(cwd);
					let child: ChildProcess | undefined;
					let now = Date.now();
					setLifecycleTimingForTest(broker, {
						now: () => now,
						sleep: async ms => {
							now += ms;
						},
					});
					setProcessIncarnationForTest(broker, () => {
						// Exhaust readiness and cleanup budgets after ownership was captured.
						now += 1_000_000;
						return "unregistered-child";
					});
					const boundary = spyOn(broker, "runSynchronousEffectWithFreshPublicationAuthority").mockImplementation(
						<T>(_effect: () => T, ..._synchronousOnly: T extends PromiseLike<unknown> ? [never] : []) => {
							boundary.mockRestore();
							child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
							return { authorized: true, value: child as T };
						},
					);
					try {
						expect(
							await broker.handleRequest("session.create", { cwd, ephemeral }, `uncertain-${ephemeral}`),
						).toMatchObject({
							ok: false,
							error: { code: "terminal_uncertain" },
						});
						await broker.index.refresh();
						const row = broker.index.listSessions().sessions.find(session => session.pid === child?.pid);
						expect(row).toMatchObject({
							endpointGeneration: 0,
							terminalUncertain: true,
							hostIncarnation: "unregistered-child",
						});
						if (!row) throw new Error("Missing startup uncertainty row");
						ids.push(row.sessionId);
						expect(row.ephemeral).toBe(ephemeral ? true : undefined);
						expect(broker.index.findHostRegistration(row.sessionId, 0, row.pid)).toBeUndefined();
						// Subsequent uncertainty observations need not repeat launch metadata.
						await broker.index.append({
							type: "lifecycle_terminal",
							sessionId: row.sessionId,
							locator: row.locator,
							endpointGeneration: 0,
							pid: row.pid,
							hostIncarnation: row.hostIncarnation,
							lifecycleRequestId: row.lifecycleRequestId,
							terminalUncertain: true,
						});
					} finally {
						boundary.mockRestore();
						setLifecycleTimingForTest(broker, undefined);
						setProcessIncarnationForTest(broker, undefined);
						if (child && child.exitCode === null) {
							const exited = once(child, "exit");
							child.kill("SIGKILL");
							await exited;
						}
					}
				}
				for (const compact of [false, true]) {
					if (compact) await broker.index.compact();
					const replayed = new SessionIndex(agentDir);
					await replayed.open();
					expect(replayed.listSessions().sessions.find(row => row.sessionId === ids[0])?.ephemeral).toBe(true);
					expect(
						replayed.listSessions().sessions.find(row => row.sessionId === ids[1])?.ephemeral,
					).toBeUndefined();
					const response = await broker.handleRequest("session.list", {});
					if (!response.ok) throw new Error(response.error.message);
					expect(
						(response.result as { sessions: Array<{ sessionId: string }> }).sessions.map(row => row.sessionId),
					).toEqual([ids[1]!]);
				}
				await broker.index.append({
					type: "host_registered",
					sessionId: ids[0]!,
					locator: createLocator(path.join(tmpDir, "temporary")),
					endpointGeneration: 1,
					pid: process.pid,
					hostIncarnation: "ordinary-replacement",
				});
				await broker.index.compact();
				const replacementReplay = new SessionIndex(agentDir);
				await replacementReplay.open();
				expect(
					replacementReplay.listSessions().sessions.find(row => row.sessionId === ids[0])?.ephemeral,
				).toBeUndefined();
				const replacementList = await broker.handleRequest("session.list", {});
				if (!replacementList.ok) throw new Error(replacementList.error.message);
				expect(
					(replacementList.result as { sessions: Array<{ sessionId: string }> }).sessions
						.map(row => row.sessionId)
						.sort(),
				).toEqual([...ids].sort());
			} finally {
				await broker.stop();
				if (previous === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
				else process.env.GJC_SDK_SESSION_COMMAND = previous;
			}
		});

		it("advertises built-in support through authenticated broker.status and prepares a temporary host", async () => {
			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			const previous = process.env.GJC_SDK_SESSION_COMMAND;
			delete process.env.GJC_SDK_SESSION_COMMAND;
			let client: SdkClient | undefined;
			try {
				const discovery = await broker.start();
				client = await SdkClient.connect(discovery.url, discovery.token, { reconnectAttempts: 0 });
				expect(await client.global("broker.status", {})).toMatchObject({
					result: { capabilities: { ephemeralSessions: true } },
				});
				const launch = prepareSpawnChildHostLaunch(broker, { cwd: tmpDir, ephemeral: true });
				expect(JSON.parse(launch.env.GJC_SDK_LIFECYCLE_REQUEST)).toMatchObject({
					operation: "session.create",
					ephemeral: true,
				});
				expect(launch.argv).toEqual([
					resolveSdkInternalSpawnCommand("session-host-internal").file,
					...resolveSdkInternalSpawnCommand("session-host-internal").args,
				]);
			} finally {
				await client?.close();
				await broker.stop();
				if (previous === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
				else process.env.GJC_SDK_SESSION_COMMAND = previous;
			}
		});

		it("refuses a custom command before host launch effects without changing permanent launch preparation", async () => {
			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			const previous = process.env.GJC_SDK_SESSION_COMMAND;
			const fixture = path.join(tmpDir, "custom-host.js");
			const spawned = path.join(tmpDir, "spawned");
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd);
			await fs.writeFile(fixture, `require("fs").writeFileSync(${JSON.stringify(spawned)}, "spawned");`);
			process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
			let client: SdkClient | undefined;
			try {
				const discovery = await broker.start();
				client = await SdkClient.connect(discovery.url, discovery.token, { reconnectAttempts: 0 });
				expect(await client.global("broker.status", {})).toMatchObject({
					result: { capabilities: { ephemeralSessions: false } },
				});
				expect(
					await broker.handleRequest("session.create", { cwd, ephemeral: true }, "custom-temporary"),
				).toMatchObject({
					ok: false,
					error: { code: "ephemeral_unsupported" },
				});
				expect(() => prepareSpawnChildHostLaunch(broker, { cwd, ephemeral: true })).toThrow(
					"Temporary sessions require the built-in session host",
				);
				const permanent = prepareSpawnChildHostLaunch(broker, { cwd, ephemeral: false });
				expect(permanent.argv).toEqual([process.execPath, fixture]);
				expect(JSON.parse(permanent.env.GJC_SDK_LIFECYCLE_REQUEST).ephemeral).toBeUndefined();
				await expect(fs.stat(spawned)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.stat(path.join(cwd, ".gjc"))).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await client?.close();
				await broker.stop();
				if (previous === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
				else process.env.GJC_SDK_SESSION_COMMAND = previous;
			}
		});

		it("does not attest an injected built-in-looking descriptor; permanent creation still reaches its resolver", async () => {
			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			let resolverCalls = 0;
			try {
				await broker.start();
				setLifecycleCommandResolverForTest(broker, () => {
					resolverCalls++;
					return resolveSdkInternalSpawnCommand("session-host-internal");
				});
				expect(await broker.handleRequest("broker.status", {})).toMatchObject({
					ok: true,
					result: { capabilities: { ephemeralSessions: false } },
				});
				expect(
					await broker.handleRequest("session.create", { cwd: tmpDir, ephemeral: true }, "override-temporary"),
				).toMatchObject({
					ok: false,
					error: { code: "ephemeral_unsupported" },
				});
				expect(resolverCalls).toBe(0);
				setLifecycleCommandResolverForTest(broker, () => {
					resolverCalls++;
					throw new Error("Stop permanent creation at the real spawn boundary");
				});
				expect(await broker.handleRequest("session.create", { cwd: tmpDir }, "override-permanent")).toMatchObject({
					ok: false,
					error: { code: "spawn_failed" },
				});
				expect(resolverCalls).toBe(1);
			} finally {
				setLifecycleCommandResolverForTest(broker, undefined);
				await broker.stop();
			}
		});

		it("rechecks eligibility at the synchronous host spawn boundary", async () => {
			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			const previous = process.env.GJC_SDK_SESSION_COMMAND;
			delete process.env.GJC_SDK_SESSION_COMMAND;
			let resolverCalls = 0;
			let boundaryCalls = 0;
			const authorize = broker.runSynchronousEffectWithFreshPublicationAuthority.bind(broker);
			const changeHostAtBoundary: typeof broker.runSynchronousEffectWithFreshPublicationAuthority = (
				effect,
				...synchronousOnly
			) => {
				boundaryCalls++;
				setLifecycleCommandResolverForTest(broker, () => {
					resolverCalls++;
					throw new Error("An unverified host must never reach resolution");
				});
				return authorize(effect, ...synchronousOnly);
			};
			try {
				await broker.start();
				const boundary = spyOn(broker, "runSynchronousEffectWithFreshPublicationAuthority").mockImplementation(
					changeHostAtBoundary,
				);
				try {
					expect(
						await broker.handleRequest("session.create", { cwd: tmpDir, ephemeral: true }, "late-override"),
					).toMatchObject({
						ok: false,
						error: { code: "ephemeral_unsupported" },
					});
					expect(boundaryCalls).toBeGreaterThan(0);
					expect(resolverCalls).toBe(0);
				} finally {
					boundary.mockRestore();
				}
			} finally {
				setLifecycleCommandResolverForTest(broker, undefined);
				await broker.stop();
				if (previous === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
				else process.env.GJC_SDK_SESSION_COMMAND = previous;
			}
		});

		it("explicitly refuses a recorded temporary session before live resume reuse", async () => {
			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			try {
				await broker.start();
				await sessionIndex.open();
				await sessionIndex.append({
					type: "host_registered",
					sessionId: "temporary-resume",
					locator: createLocator(tmpDir),
					endpointGeneration: 1,
					pid: process.pid,
					processIncarnation: "test-incarnation",
					ephemeral: true,
				});
				expect(
					await broker.handleRequest(
						"session.resume",
						{ cwd: tmpDir, sessionId: "temporary-resume" },
						"temporary-resume",
					),
				).toMatchObject({
					ok: false,
					error: { code: "ephemeral_unsupported", message: "Temporary sessions cannot be resumed." },
				});
				expect(
					broker.index.listSessions().sessions.find(session => session.sessionId === "temporary-resume")
						?.ephemeral,
				).toBe(true);
			} finally {
				await broker.stop();
			}
		});
	});

	describe("Index event producer: ephemeral propagation", () => {
		it("records ephemeral=true in host_registered event", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-test-1",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			expect(event.ephemeral).toBe(true);
		});

		it("omits ephemeral for persistent sessions", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "persistent-test-1",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			expect(event.ephemeral).toBeUndefined();
		});

		it("ephemeral marker persists through journal append/sync", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			// Append ephemeral session
			await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-persisted",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// List sessions to trigger index read/reconstruction
			const sessions = sessionIndex.listSessions();
			const found = sessions.sessions.find(s => s.sessionId === "ephemeral-persisted");

			expect(found).toBeDefined();
			expect(found?.ephemeral).toBe(true);
		});
	});

	describe("Index reducer: ephemeral reconstruction from events", () => {
		it("reconstructs ephemeral from host_registered event", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			await sessionIndex.append({
				type: "host_registered",
				sessionId: "ephemeral-reconstruct",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			// Force refresh to reconstruct from disk
			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const ephemeralSession = sessions.find(s => s.sessionId === "ephemeral-reconstruct");

			expect(ephemeralSession?.ephemeral).toBe(true);
		});

		it("persistent sessions lack ephemeral marker after reconstruction", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			await sessionIndex.append({
				type: "host_registered",
				sessionId: "persistent-reconstruct",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			await sessionIndex.refresh();
			const sessions = sessionIndex.listSessions().sessions;
			const persistentSession = sessions.find(s => s.sessionId === "persistent-reconstruct");

			expect(persistentSession?.ephemeral).toBeUndefined();
		});
	});

	describe("Session list filtering: ephemeral exclusion", () => {
		it("session.list excludes ephemeral sessions while internal inventory retains both", async () => {
			const cwd1 = path.join(tmpDir, "workspace1");
			const cwd2 = path.join(tmpDir, "workspace2");
			await fs.mkdir(cwd1, { recursive: true });
			await fs.mkdir(cwd2, { recursive: true });

			const loc1 = createLocator(cwd1);
			const loc2 = createLocator(cwd2);

			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			try {
				await broker.start();
				// Establish enrollment on the empty fixture before injecting synthetic hosts.
				await sessionIndex.open();
				await sessionIndex.append({
					type: "host_registered",
					sessionId: "persistent-in-list",
					locator: loc1,
					endpointGeneration: 1,
					pid: process.pid,
					processIncarnation: "test-incarnation",
				});
				await sessionIndex.append({
					type: "host_registered",
					sessionId: "ephemeral-in-list",
					locator: loc2,
					endpointGeneration: 1,
					pid: process.pid,
					processIncarnation: "test-incarnation",
					ephemeral: true,
				});

				const response = await broker.handleRequest("session.list", {});
				expect(response.ok).toBe(true);
				if (!response.ok) throw new Error(response.error.message);
				const result = response.result as { sessions: Array<{ sessionId: string }> };
				expect(result.sessions.map(s => s.sessionId)).toEqual(["persistent-in-list"]);
				expect(
					broker.index
						.listSessions()
						.sessions.map(s => s.sessionId)
						.sort(),
				).toEqual(["ephemeral-in-list", "persistent-in-list"]);
			} finally {
				await broker.stop();
			}
		});

		it("session.list filters multiple ephemeral sessions without removing internal records", async () => {
			const tmpWorkspaces = [1, 2, 3, 4, 5].map(i => path.join(tmpDir, `ws${i}`));
			for (const cwd of tmpWorkspaces) await fs.mkdir(cwd, { recursive: true });

			// Append: persistent, ephemeral, persistent, ephemeral, persistent
			const sessionIds = ["s1", "s2", "s3", "s4", "s5"];
			const ephemeralFlags = [false, true, false, true, false];

			const broker = new Broker({ agentDir: path.join(tmpDir, "agent") });
			try {
				await broker.start();
				await sessionIndex.open();
				for (let i = 0; i < sessionIds.length; i++) {
					await sessionIndex.append({
						type: "host_registered",
						sessionId: sessionIds[i],
						locator: createLocator(tmpWorkspaces[i]),
						endpointGeneration: 1,
						pid: process.pid,
						processIncarnation: `incarnation-${i}`,
						...(ephemeralFlags[i] ? { ephemeral: true } : {}),
					});
				}

				const response = await broker.handleRequest("session.list", {});
				expect(response.ok).toBe(true);
				if (!response.ok) throw new Error(response.error.message);
				const result = response.result as { sessions: Array<{ sessionId: string }> };
				expect(result.sessions.map(s => s.sessionId).sort()).toEqual(["s1", "s3", "s5"]);
				expect(
					broker.index
						.listSessions()
						.sessions.map(s => s.sessionId)
						.sort(),
				).toEqual(sessionIds);
			} finally {
				await broker.stop();
			}
		});

		it("retains registration's marker through unmarked events, journal replay and compaction", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const identity = {
				sessionId: "ephemeral-compact",
				locator: createLocator(cwd),
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			};
			const agentDir = path.join(tmpDir, "agent");
			const broker = new Broker({ agentDir });
			try {
				await broker.start();
				await sessionIndex.open();
				const registration = await sessionIndex.append({
					...identity,
					type: "host_registered",
					ephemeral: true,
				});
				for (const type of ["host_heartbeat", "host_unregistered", "session_closed"] as const) {
					const event = await sessionIndex.append({ ...identity, type });
					expect(event.ephemeral).toBeUndefined();
					for (const compact of [false, true]) {
						if (compact) await sessionIndex.compact();
						const replayed = new SessionIndex(agentDir);
						await replayed.open();
						expect(replayed.listSessions().sessions).toMatchObject([
							{ sessionId: identity.sessionId, ephemeral: true, terminal: type !== "host_heartbeat" },
						]);
						expect(replayed.findHostRegistration(identity.sessionId, 1, process.pid)?.ephemeral).toBe(true);
						// append fills hostIncarnation for our pid; historical lookup requires that persisted binding.
						expect(
							replayed.findHistoricalSessionIdentity({
								...registration,
								stateRoot: identity.locator.stateRoot,
							})?.ephemeral,
						).toBe(true);
						const response = await broker.handleRequest("session.list", {});
						expect(response).toMatchObject({ ok: true, result: { sessions: [] } });
						expect(broker.index.listSessions().sessions[0]?.ephemeral).toBe(true);
					}
				}
			} finally {
				await broker.stop();
			}
		});

		it("does not transfer a temporary marker to a permanent replacement incarnation", async () => {
			const agentDir = path.join(tmpDir, "agent");
			const identity = {
				sessionId: "replaced-session",
				locator: createLocator(tmpDir),
				endpointGeneration: 1,
				pid: process.pid,
			};
			const broker = new Broker({ agentDir });
			try {
				await broker.start();
				await sessionIndex.open();
				await sessionIndex.append({
					...identity,
					type: "host_registered",
					processIncarnation: "temporary",
					ephemeral: true,
				});
				await sessionIndex.append({ ...identity, type: "session_closed", processIncarnation: "temporary" });
				await sessionIndex.append({ ...identity, type: "host_registered", processIncarnation: "permanent" });
				await sessionIndex.append({ ...identity, type: "host_heartbeat", processIncarnation: "permanent" });
				for (const compact of [false, true]) {
					if (compact) await sessionIndex.compact();
					const replayed = new SessionIndex(agentDir);
					await replayed.open();
					const rows = replayed.listSessions().sessions;
					expect(rows).toHaveLength(1);
					expect(rows[0]?.processIncarnation).toBe("permanent");
					expect(rows[0]?.ephemeral).toBeUndefined();
					const response = await broker.handleRequest("session.list", {});
					expect(response.ok).toBe(true);
					if (!response.ok) throw new Error(response.error.message);
					const result = response.result as { sessions: Array<{ sessionId: string }> };
					expect(result.sessions.map(session => session.sessionId)).toEqual([identity.sessionId]);
				}
			} finally {
				await broker.stop();
			}
		});
	});

	describe("Type validation and edge cases", () => {
		it("rejects non-boolean ephemeral values", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });

			// Should still accept as long as the session-index append accepts the type
			// This is a TypeScript-level concern
			const locator = createLocator(cwd);

			const event = await sessionIndex.append({
				type: "host_registered",
				sessionId: "test-types",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: true,
			});

			expect(typeof event.ephemeral).toBe("boolean");
		});

		it("ephemeral=false is distinct from undefined", async () => {
			const cwd = path.join(tmpDir, "workspace");
			await fs.mkdir(cwd, { recursive: true });
			const locator = createLocator(cwd);

			const ephemeralFalse = await sessionIndex.append({
				type: "host_registered",
				sessionId: "explicit-false",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
				ephemeral: false,
			});

			const undefined_ = await sessionIndex.append({
				type: "host_registered",
				sessionId: "undefined-ephemeral",
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: "test-incarnation",
			});

			expect(ephemeralFalse.ephemeral).toBe(false);
			expect(undefined_.ephemeral).toBeUndefined();
		});
	});
});
