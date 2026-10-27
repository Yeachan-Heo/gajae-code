import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import * as lifecycle from "../src/sdk/broker/lifecycle";
import { SessionManager } from "../src/session/session-manager";

async function makePair(label: string) {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-${label}-`));
	const sdk = path.join(root, "sdk");
	await fs.mkdir(sdk, { recursive: true });
	const id = "race-resume";
	return {
		root,
		sdk,
		id,
		markerPath: path.join(sdk, `${id}.lifecycle.json`),
		readyPath: path.join(sdk, `${id}.lifecycle.ready.json`),
	};
}

const deadMarker = { pid: 999_999_999, effectMarker: "dead", incarnation: "dead" };

test("retire binds cleanup to the observed marker when a live pair is republished", async () => {
	const pair = await makePair("retire-live-race");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const incarnation = lifecycle.processIncarnation(process.pid);
		const live = { pid: process.pid, effectMarker: "live", incarnation };
		let calls = 0;
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			calls += 1;
			if (calls === 1) {
				await fs.writeFile(pair.markerPath, JSON.stringify(live));
				await fs.writeFile(pair.readyPath, JSON.stringify(live));
			}
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.markerPath, "utf8")).toBe(JSON.stringify(live));
		expect(await fs.readFile(pair.readyPath, "utf8")).toBe(JSON.stringify(live));
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

test("retire binds cleanup to an atomically republished live pair", async () => {
	const pair = await makePair("retire-live-atomic-race");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const incarnation = lifecycle.processIncarnation(process.pid);
		const live = { pid: process.pid, effectMarker: "atomic-live", incarnation };
		let calls = 0;
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			calls += 1;
			if (calls !== 1) return;
			for (const [target, suffix] of [
				[pair.markerPath, "marker"],
				[pair.readyPath, "ready"],
			] as const) {
				await fs.rm(target, { force: true });
				const temporary = path.join(pair.root, `${suffix}.tmp`);
				await fs.writeFile(temporary, JSON.stringify(live));
				await fs.rename(temporary, target);
			}
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.markerPath, "utf8")).toBe(JSON.stringify(live));
		expect(await fs.readFile(pair.readyPath, "utf8")).toBe(JSON.stringify(live));
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

test("retire keeps a ready marker replaced after observation", async () => {
	const pair = await makePair("retire-ready-race");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const live = {
			pid: process.pid,
			effectMarker: "ready-live",
			incarnation: lifecycle.processIncarnation(process.pid),
		};
		let calls = 0;
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			calls += 1;
			if (calls === 2) await fs.writeFile(pair.readyPath, JSON.stringify(live));
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.markerPath, "utf8")).toBe(JSON.stringify(deadMarker));
		expect(await fs.readFile(pair.readyPath, "utf8")).toBe(JSON.stringify(live));
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

test("retire does not remove a different exited owner", async () => {
	const pair = await makePair("retire-other-dead");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const other = { pid: 999_999_998, effectMarker: "other", incarnation: "other" };
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			await fs.writeFile(pair.markerPath, JSON.stringify(other));
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.markerPath, "utf8")).toBe(JSON.stringify(other));
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

test("retire tolerates primary removal during observation race", async () => {
	const pair = await makePair("retire-removed");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			await fs.rm(pair.markerPath);
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.readyPath, "utf8")).toBe(JSON.stringify(deadMarker));
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

test("retire tolerates malformed primary during observation race", async () => {
	const pair = await makePair("retire-malformed");
	try {
		await fs.writeFile(pair.markerPath, JSON.stringify(deadMarker));
		await fs.writeFile(pair.readyPath, JSON.stringify(deadMarker));
		const result = await lifecycle.retireExitedLifecycleMarkerPairForTest(pair.root, pair.id, async () => {
			await fs.writeFile(pair.markerPath, "{}");
		});
		expect(result).toBe(false);
		expect(await fs.readFile(pair.markerPath, "utf8")).toBe("{}");
	} finally {
		await fs.rm(pair.root, { recursive: true, force: true });
	}
});

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
