import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import * as lifecycle from "../src/sdk/broker/lifecycle";
import { SessionManager } from "../src/session/session-manager";

test("launch cleanup retires an exited id pair regardless of age or ready marker contents", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-launch-"));
	const sdk = path.join(root, "sdk");
	const id = "stale-resume";
	const markerPath = path.join(sdk, `${id}.lifecycle.json`);
	const readyPath = path.join(sdk, `${id}.lifecycle.ready.json`);
	try {
		await fs.mkdir(sdk, { recursive: true });
		await fs.writeFile(markerPath, JSON.stringify({ pid: 999_999_999, effectMarker: "old", incarnation: "old" }));
		await fs.writeFile(
			readyPath,
			JSON.stringify({ pid: 999_999_998, effectMarker: "different", incarnation: "different" }),
		);

		const retire = (
			lifecycle as typeof lifecycle & {
				retireExitedLifecycleMarkerPair?: (root: string, id: string) => Promise<boolean>;
			}
		).retireExitedLifecycleMarkerPair;
		expect(retire).toBeFunction();
		await expect(retire?.(root, id)).resolves.toBe(true);
		await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(readyPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("launch cleanup keeps a pair owned by the current live process", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-live-"));
	const sdk = path.join(root, "sdk");
	const id = "live-resume";
	const markerPath = path.join(sdk, `${id}.lifecycle.json`);
	const readyPath = path.join(sdk, `${id}.lifecycle.ready.json`);
	try {
		await fs.mkdir(sdk, { recursive: true });
		const incarnation = lifecycle.processIncarnation(process.pid);
		expect(incarnation).toBeString();
		if (!incarnation) throw new Error("Expected the current process incarnation.");
		const marker = { pid: process.pid, effectMarker: "live", incarnation };
		await fs.writeFile(markerPath, JSON.stringify(marker));
		await fs.writeFile(readyPath, JSON.stringify(marker));

		await expect(lifecycle.retireExitedLifecycleMarkerPair(root, id)).resolves.toBe(false);
		await expect(fs.stat(markerPath)).resolves.toBeDefined();
		await expect(fs.stat(readyPath)).resolves.toBeDefined();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("marker sweep counts only lifecycle marker candidates against its inspection limit", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-limit-"));
	const sdk = path.join(root, "sdk");
	const id = "expired-marker";
	const markerPath = path.join(sdk, `${id}.lifecycle.json`);
	try {
		await fs.mkdir(sdk, { recursive: true });
		const marker = { pid: 999_999_999, effectMarker: "old", incarnation: "old" };
		for (let index = 0; index < 70; index += 1) {
			await fs.writeFile(path.join(sdk, `unrelated-${index}.lifecycle.ready.json`), "unrelated");
		}
		await fs.writeFile(path.join(sdk, `${id}.lifecycle.ready.json`), JSON.stringify(marker));
		await fs.writeFile(markerPath, JSON.stringify(marker));
		const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(markerPath, expiredAt, expiredAt);

		await expect(lifecycle.reapDeadLifecycleMarkers(root)).resolves.toBe(1);
		await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("published ready marker exposes revocation for detached host shutdown", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-revoke-"));
	const id = "detached-ready";
	const effectMarker = "detached-ready-effect";
	let revoke: (() => Promise<boolean>) | undefined;
	try {
		await lifecycle.writeSessionLifecycleReady(
			root,
			id,
			effectMarker,
			() => true,
			callback => {
				revoke = callback;
			},
		);
		const readyPath = path.join(root, "sdk", `${id}.lifecycle.ready.json`);
		await expect(fs.stat(readyPath)).resolves.toBeDefined();
		expect(revoke).toBeFunction();
		await expect(revoke?.()).resolves.toBe(true);
		await expect(fs.stat(readyPath)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("real session host removes ready and endpoint markers after SIGTERM", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-ready-host-exit-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const broker = new Broker({ agentDir });
	let hostPid: number | undefined;
	try {
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const source = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await source.ensureOnDisk();
		const sessionId = source.getSessionId();
		const sessionPath = source.getSessionFile();
		await broker.start();
		const result = await broker.handleRequest(
			"session.resume",
			{ cwd: root, stateRoot, sessionId, sessionPath, readinessTimeoutMs: 20_000 },
			"stale-ready-host-exit",
		);
		expect(result.ok).toBe(true);
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
		const endpoint = JSON.parse(await fs.readFile(endpointPath, "utf8")) as { pid?: unknown };
		hostPid = typeof endpoint.pid === "number" ? endpoint.pid : undefined;
		if (!hostPid) throw new Error("Session endpoint did not publish a host pid.");
		process.kill(hostPid, "SIGTERM");
		const exitDeadline = Date.now() + 20_000;
		let exited = false;
		while (Date.now() < exitDeadline) {
			try {
				process.kill(hostPid, 0);
			} catch {
				exited = true;
				break;
			}
			await Bun.sleep(25);
		}
		expect(exited).toBe(true);
		const cleanupDeadline = Date.now() + 5_000;
		while (Date.now() < cleanupDeadline) {
			if (!(await Bun.file(readyPath).exists()) && !(await Bun.file(endpointPath).exists())) break;
			await Bun.sleep(25);
		}
		expect(await Bun.file(readyPath).exists()).toBe(false);
		expect(await Bun.file(endpointPath).exists()).toBe(false);
		await broker.stop();

		expect(await Bun.file(endpointPath).exists()).toBe(false);
	} finally {
		if (hostPid) {
			try {
				process.kill(hostPid, "SIGTERM");
			} catch {}
		}
		await broker.stop().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}, 35_000);
