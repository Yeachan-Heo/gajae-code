import { describe, expect, it, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";
import { lifecycleArgs } from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	type BrokerDiscovery,
	brokerDiscoveryPath,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	ensureBroker,
	reapSpawnedBrokerForTest,
	registerBrokerOwnerForTest,
} from "../src/sdk/broker/ensure";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { readSessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";
import { resolveSdkInternalSpawnCommand } from "../src/sdk/broker/runtime";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const brokerEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

it("SDK internal commands self-spawn compiled binaries without source entrypoints", () => {
	const compiled = {
		execPath: "/opt/gjc/gjc",
		mode: "compiled" as const,
		argsPrefix: [],
		reloadPicksUpSourceEdits: false,
		warning: "Rebuild",
	};
	expect(resolveSdkInternalSpawnCommand("broker-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "broker-internal"],
	});
	expect(resolveSdkInternalSpawnCommand("session-host-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "session-host-internal"],
	});
});

it("SDK lifecycle model presets reach the session host parser", () => {
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: "/repo/.gjc/state",

			cwd: "/repo",
			modelPreset: "codex-eco",
		}),
	);
	expect(lifecycleArgs(request, "/repo", "/agent").mpreset).toBe("codex-eco");
});

it("SDK lifecycle launch requests require a worktree identity", () => {
	expect(() =>
		readSessionLifecycleLaunchRequest(
			JSON.stringify({ operation: "session.create", sessionId: "session-1", stateRoot: "/state" }),
		),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});
async function waitForDiscovery(agentDir: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return discovery;
		await sleep(20);
	}
	throw new Error("Timed out waiting for broker discovery.");
}
describe("SDK broker identity and discovery", () => {
	it("persists identity and writes a redacted private discovery record", async () => {
		const dir = await temp();
		const a = await getBrokerIdentityKey(dir);
		expect(await getBrokerIdentityKey(dir)).toBe(a);
		const d = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "x",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: 1,
			heartbeatAt: Date.now(),
		};
		await writeBrokerDiscovery(dir, d);
		const persisted = await readBrokerDiscovery(dir);
		expect(persisted).not.toBeNull();
		expect(redactBrokerDiscovery(persisted!).token).toBe("[redacted]");
		if (process.platform !== "win32")
			expect((await fs.stat(path.join(dir, "sdk", "broker.json"))).mode & 0o777).toBe(0o600);
	});

	it("rejects discovery bound to a different process incarnation", async () => {
		const dir = await temp();
		await writeBrokerDiscovery(dir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "stale",
			pid: process.pid,
			incarnation: "different-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});

		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("treats a truncated discovery record as unavailable", async () => {
		const dir = await temp();
		await fs.mkdir(path.dirname(brokerDiscoveryPath(dir)), { recursive: true });
		await fs.writeFile(brokerDiscoveryPath(dir), '{"version":1,"pid":');
		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("refreshes discovery heartbeat, removes it on stop, and can restart", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 45 });
		const first = await broker.start();
		const deadline = Date.now() + 5_000;
		let refreshed = await readBrokerDiscovery(dir);
		while ((!refreshed || refreshed.heartbeatAt <= first.heartbeatAt) && Date.now() < deadline) {
			await sleep(10);
			refreshed = await readBrokerDiscovery(dir);
		}
		expect(refreshed?.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
		await broker.stop();
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		const restarted = await ensureBroker({ agentDir: dir });
		expect(restarted.token).not.toBe(first.token);
		const owner = (await import("../src/sdk/broker/ensure")).brokerOwnerForTest(dir);
		await owner?.stop();
	}, 15_000);
	it("terminates and reaps the spawned broker when discovery times out", async () => {
		const dir = await temp();
		// Force ensureBroker's discovery reads to never resolve a live record so the
		// discovery wait is doomed from the start. The real broker still spawns and
		// stays alive as a detached daemon, which is exactly the orphan path the reap
		// must close. Capture its pid from the discovery file (bypassing the spy)
		// before ensureBroker times out and reaps it.
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(null);
		try {
			const { promise: gotPid, resolve: onPid } = Promise.withResolvers<number | undefined>();
			void (async () => {
				const deadline = Date.now() + 12_000;
				while (Date.now() < deadline) {
					try {
						const raw = JSON.parse(await fs.readFile(brokerDiscovery.brokerDiscoveryPath(dir), "utf8")) as {
							pid?: number;
						};
						if (typeof raw.pid === "number") return onPid(raw.pid);
					} catch {}
					await sleep(25);
				}
				onPid(undefined);
			})();
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(
				"Timed out waiting for detached SDK broker discovery.",
			);
			const brokerPid = await gotPid;
			// The spawned detached broker must have been terminated + reaped, not orphaned.
			expect(typeof brokerPid).toBe("number");
			expect(brokerDiscovery.isPidAlive(brokerPid!)).toBe(false);
			// No owner handle leaked for the failed agent dir.
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
	it("fails fast and reaps the spawned broker when it exits before discovery", async () => {
		const dir = await temp();
		// Plant an unsupported session-index snapshot so the spawned broker's start()
		// rejects immediately and it exits before publishing discovery. ensureBroker
		// must take the early-exit path (not the 10s timeout) and leave no orphan.
		await fs.mkdir(path.join(dir, "sdk", "sessions"), { recursive: true });
		await fs.writeFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), JSON.stringify({ version: 99 }));
		await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(/exited before discovery/);
		// No owner handle leaked for the failed agent dir.
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		// No discovery record was published: the broker exited before writing one.
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		await fs.rm(dir, { recursive: true, force: true });
	}, 15_000);
	it("escalates to SIGKILL and awaits verified exit when a live child emits error after SIGTERM", async () => {
		// Reproduces the PR #2157 review blocker: a still-live broker child emits
		// `error` during SIGTERM (e.g. a transient signal-delivery failure). The
		// reaper must treat that as diagnostic only, escalate to SIGKILL, and await
		// an actual exit/close — never resolve on `error` alone and orphan the child.
		// This condition is not deterministically reproducible with a real OS process,
		// so a controllable child surface drives the exact reap control flow. Before
		// the fix the `error` event resolved the wait as if the child had exited, so
		// SIGKILL was never reached and the process stayed alive.
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				if (sig === "SIGTERM") {
					// Still-live child surfaces an error mid-teardown without exiting.
					queueMicrotask(() => child.emit("error", new Error("signal delivery failed during teardown")));
					return true;
				}
				if (sig === "SIGKILL") {
					queueMicrotask(() => {
						child.signalCode = "SIGKILL";
						child.emit("exit", null, "SIGKILL");
					});
					return true;
				}
				return false;
			},
		});
		// Production always retains ensureBroker's spawn-error listener on the child;
		// keep one here so emitting `error` matches that surface (and is not fatal).
		child.on("error", () => {});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
		// SIGTERM's emitted `error` must NOT count as exit: escalation reached SIGKILL.
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		// Termination was proven by an observed exit, not by the earlier `error`.
		expect(child.signalCode).toBe("SIGKILL");
	}, 10_000);

	it("does not signal a child whose exit is already authoritative", async () => {
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4243,
			exitCode: 0 as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});

		await reapSpawnedBrokerForTest(child as unknown as ChildProcess, { gracefulMs: 1, killVerifyMs: 1 });

		expect(signals).toEqual([]);
	});
	it("reaps a spawn failure with no process as a no-op instead of waiting on SIGKILL", async () => {
		// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
		// undefined and there is nothing to signal or await. Reaping must be a no-op
		// rather than running out the SIGKILL cap and reporting a stuck child that
		// never existed — the distinct failure this owner must keep closed.
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: (): boolean => false,
		});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
	}, 10_000);

	it("retains unverified broker authority and fences replacement startup", async () => {
		const dir = await temp();
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4244,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});
		const owner = registerBrokerOwnerForTest(dir, child as unknown as ChildProcess, {
			gracefulMs: 1,
			killVerifyMs: 1,
		});
		const competingDiscovery: BrokerDiscovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "competitor",
			pid: process.pid,
			incarnation: "competing-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "competitor-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(competingDiscovery);
		try {
			await expect(owner.stop()).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);

			// A new ensure must retry the exact retained owner and reject; it may not
			// discard that authority handle and spawn a replacement.
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);
			expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

			child.signalCode = "SIGKILL";
			await owner.stop();
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not let a stale stop handle delete its successor owner", async () => {
		const dir = await temp();
		const exitedChild = (pid: number) =>
			Object.assign(new EventEmitter(), {
				pid,
				exitCode: 0 as number | null,
				signalCode: null as NodeJS.Signals | null,
				kill: (): boolean => true,
			});
		const first = registerBrokerOwnerForTest(dir, exitedChild(4245) as unknown as ChildProcess);
		const successor = registerBrokerOwnerForTest(dir, exitedChild(4246) as unknown as ChildProcess);

		await first.stop();
		expect(brokerOwnerForTest(dir)).toBe(successor);
		await successor.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("shares one in-process startup and owner across concurrent ensure calls", async () => {
		const dir = await temp();
		const first = ensureBroker({ agentDir: dir });
		const second = ensureBroker({ agentDir: dir });

		expect(second).toBe(first);
		const [left, right] = await Promise.all([first, second]);
		expect(right).toEqual(left);
		const owner = brokerOwnerForTest(dir);
		expect(owner).toBeDefined();
		await owner?.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("leaves exactly one live detached broker after concurrent process startup", async () => {
		const dir = await temp();
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "run", brokerEntrypoint, "sdk", "broker-internal", "--agent-dir", dir], {
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		try {
			const discovery = await waitForDiscovery(dir);
			// The losing broker exits once it observes the winner's discovery record.
			// Poll instead of a fixed delay so the assertion is robust to CI scheduling
			// (the loser's exit can lag the discovery write under load).
			for (let attempt = 0; attempt < 200 && children.every(child => child.exitCode === null); attempt++)
				await sleep(25);
			const exited = children.filter(child => child.exitCode !== null);
			expect(exited).toHaveLength(1);
			const owner = children.find(child => child.exitCode === null);
			expect(owner).toBeDefined();
			expect(discovery.pid).toBe(owner!.pid!);
			process.kill(discovery.pid, "SIGTERM");
			await Promise.all(children.map(child => child.exited));
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("returns only an endpoint bound to the indexed incarnation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, "state");
		const endpointPath = path.join(stateRoot, "sdk", "s.json");
		const broker = new Broker({ agentDir: dir });
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "s", pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			endpointMtimeMs,
		});
		const endpointIncarnation = createHash("sha256")
			.update(JSON.stringify({ endpointGeneration: 3, endpointMtimeMs, pid: process.pid, sessionId: "s" }))
			.digest("hex");
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation,
			}),
		).toEqual({
			ok: true,
			result: { sessionId: "s", pid: process.pid, token: "session-secret" },
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation: "0".repeat(64),
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 2 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 1,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 4 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
	});
	it("rejects a cross-scope live resume without returning the indexed endpoint", async () => {
		const dir = await temp();
		const liveCwd = path.join(dir, "live-workspace");
		const requestedCwd = path.join(dir, "requested-workspace");
		const stateRoot = path.join(liveCwd, ".gjc", "state");
		const sessionId = "shared-live-session";
		const sessionDir = SessionManager.getDefaultSessionDir(liveCwd, dir);
		const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(requestedCwd, { recursive: true });
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: liveCwd })}\n`,
		);
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, token: "foreign-workspace-token" }),
		);
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: liveCwd, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			const result = await broker.handleRequest(
				"session.resume",
				{
					cwd: requestedCwd,
					target: { path: requestedCwd },
					sessionId,
					sessionPath,
				},
				"cross-scope-resume",
			);
			expect(result).toEqual({
				ok: false,
				error: {
					code: "endpoint_stale",
					message: "Live session does not match the requested resume scope.",
				},
			});
			expect(JSON.stringify(result)).not.toContain("foreign-workspace-token");
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("replays only the same lifecycle body and conflicts when a caller reuses its key for the same target", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const input = { sessionId: "saved", sessionPath: path.join(dir, "missing.json"), trace: "first" };
			const first = await broker.handleRequest("session.delete", input, "caller-key");
			expect(await broker.handleRequest("session.delete", input, "caller-key")).toEqual(first);
			expect(await broker.handleRequest("session.delete", { ...input, trace: "changed" }, "caller-key")).toEqual({
				ok: false,
				error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("binds session.delete to the requested session header and configured storage root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "repo");
		const sessions = path.join(getSessionsDir(dir), "project");
		const requested = path.join(sessions, "requested.jsonl");
		const other = path.join(sessions, "other.jsonl");
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(requested, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
		await fs.writeFile(other, `${JSON.stringify({ type: "session", id: "other" })}\n`);
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: other, cwd },
					"delete-cross-session",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "session.delete path does not contain the requested session." },
			});
			expect(await fs.readFile(other, "utf8")).toContain('"other"');
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: path.join(dir, "outside.jsonl"), cwd },
					"delete-outside-root",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is outside the configured session storage root.",
				},
			});
			expect(await fs.readFile(requested, "utf8")).toContain('"requested"');
			const external = path.join(dir, "external.jsonl");
			const externalArtifacts = external.slice(0, -6);
			const linked = path.join(sessions, "linked.jsonl");
			await fs.writeFile(external, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
			await fs.mkdir(externalArtifacts);
			await fs.symlink(external, linked);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: linked, cwd },
					"delete-symlink-escape",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is a symlink.",
				},
			});
			expect(await fs.readFile(external, "utf8")).toContain('"requested"');
			expect((await fs.stat(externalArtifacts)).isDirectory()).toBe(true);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects traversal and conflicting session-id aliases before lifecycle state access", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(await broker.handleRequest("session.get_endpoint", { sessionId: "../escape" })).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "sessionId must be a canonical safe identifier" },
			});
			expect(
				await broker.handleRequest("session.close", { sessionId: "session-a", id: "session-b" }, "alias-conflict"),
			).toEqual({ ok: false, error: { code: "invalid_input", message: "sessionId aliases conflict" } });
			await expect(fs.stat(path.join(dir, "sdk", "escape.json"))).rejects.toThrow();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays id and sessionId lifecycle aliases under one caller idempotency key", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const first = await broker.handleRequest("session.close", { sessionId: "missing" }, "same-close");
			expect(await broker.handleRequest("session.close", { id: "missing" }, "same-close")).toEqual(first);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a non-default lifecycle state root at broker ingress", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: dir, stateRoot: path.join(dir, "alternate-state") },
					"alternate-state-root",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "stateRoot must be the default .gjc/state for cwd." },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("uses verified deletion to remove the exact transcript, artifacts, and indexed authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "verified-delete";
		const sessionPath = path.join(getSessionsDir(dir), "project", `${sessionId}.jsonl`);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await fs.writeFile(path.join(artifactsDir, "artifact.txt"), "artifact");
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			expect(
				await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "verified-delete-key"),
			).toEqual({ ok: true, result: { sessionId } });
			await expect(fs.stat(sessionPath)).rejects.toThrow();
			await expect(fs.stat(artifactsDir)).rejects.toThrow();
			expect(await broker.handleRequest("session.list", {})).toMatchObject({
				ok: true,
				result: { sessions: [] },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves typed verified-delete partial-cleanup evidence", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "pending-delete";
		const sessionPath = path.join(getSessionsDir(dir), `${sessionId}.jsonl`);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async () => ({
			kind: "cleanup_pending" as const,

			phase: "artifacts" as const,
			error: new Error("artifact cleanup denied"),
			artifactsIdentity: { dev: 7n, ino: 8n },
			transcriptIdentity: { dev: 5n, ino: 6n },
		});
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"pending-delete-key",
			);
			expect(pending).toEqual({
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Saved session cleanup is pending in artifacts: artifact cleanup denied",
					cleanup: {
						phase: "artifacts",
						artifactsIdentity: { dev: "7", ino: "8" },
						transcriptIdentity: { dev: "5", ino: "6" },
					},
				},
			});
			expect(
				await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "pending-delete-key"),
			).toEqual(pending);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns endpoint_stale without dispatching close after endpoint generation rotation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "rotating";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		let controlRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					void (async () => {
						await fs.writeFile(
							endpointPath,
							JSON.stringify({
								sessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${server.port}`,
								token: "replacement-token",
							}),
						);
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator: { repo: dir, stateRoot },
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
						ws.send(JSON.stringify({ type: "hello" }));
					})();
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string; type?: string };
					if (frame.type === "control_request") controlRequests++;
					if (frame.id) ws.send(JSON.stringify({ id: frame.id, ok: true }));
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "initial-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "rotating-close")).toEqual({
				ok: false,
				error: { code: "endpoint_stale", message: "session endpoint is stale" },
			});
			expect(controlRequests).toBe(0);
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a typed session-host close failure without signal fallback", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "flush-failure";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					ws.send(JSON.stringify({ type: "hello" }));
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string };
					if (frame.id)
						ws.send(
							JSON.stringify({
								id: frame.id,
								ok: false,
								error: { code: "flush_failed", message: "session flush failed" },
							}),
						);
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "flush-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "flush-close")).toEqual({
				ok: false,
				error: { code: "flush_failed", message: "session flush failed" },
			});
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
