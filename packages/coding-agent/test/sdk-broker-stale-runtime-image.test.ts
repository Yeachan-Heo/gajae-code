import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { Broker } from "../src/sdk/broker/broker";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { ensureBroker, isBrokerReusable } from "../src/sdk/broker/ensure";
import {
	isSdkInternalRuntimeImagePresent,
	resolveSdkInternalSpawnCommand,
	sdkInternalRuntimeImageForTest,
} from "../src/sdk/broker/runtime";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

const currentGeneration = (packageJson as { version: string }).version;
/** Real brokers are spawned here; give them the budget the other broker suites use. */
const BROKER_TEST_TIMEOUT_MS = 30_000;
const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

/** A stand-in runtime image: readable, executable, and never actually spawned. */
async function writeRuntimeImage(file: string): Promise<string> {
	await Bun.write(file, "#!/bin/sh\nexit 0\n");
	await fs.chmod(file, 0o755);
	return file;
}

/** A live, current-generation record that differs only in its published runtime evidence. */
function discoveryWithRuntime(runtime: string | undefined): BrokerDiscovery {
	return {
		version: SDK_STATE_VERSION,
		protocolVersion: 3,
		packageGeneration: currentGeneration,
		runtime,
		ownerId: "owner-fixture",
		pid: process.pid,
		incarnation: "incarnation-fixture",
		host: "127.0.0.1",
		port: 1,
		url: "ws://127.0.0.1:1",
		token: "token-fixture",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
}

async function stopDiscoveredBroker(agentDir: string): Promise<void> {
	try {
		const current = await readBrokerDiscovery(agentDir);
		if (current) process.kill(current.pid, "SIGTERM");
	} catch {}
}

describe("sdk broker stale runtime image", () => {
	test(
		"a started broker publishes exactly the image its internal spawns execute",
		async () => {
			const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-published-"));
			const broker = new Broker({ agentDir });
			try {
				const discovery = await broker.start();
				expect(discovery.runtime).toBe(resolveSdkInternalSpawnCommand("session-host-internal").file);
				await fs.access(discovery.runtime!, fs.constants.R_OK | fs.constants.X_OK);
			} finally {
				await broker.stop().catch(() => {});
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		},
		BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"ensureBroker replaces a live incumbent whose runtime image was removed",
		async () => {
			const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-removed-"));
			// Model the production failure: the broker was started from an executable
			// (a Cellar-pinned Bun) that a package upgrade later deleted. The process
			// stays live and keeps heartbeating; only its spawn image is gone.
			const removedRuntime = path.join(agentDir, "removed-runtime");
			await writeRuntimeImage(removedRuntime);
			const incumbent = new Broker({ agentDir, runtime: removedRuntime });
			let incumbentDiscovery: BrokerDiscovery;
			try {
				incumbentDiscovery = await incumbent.start();
				expect(incumbentDiscovery.packageGeneration).toBe(currentGeneration);
				expect(incumbentDiscovery.runtime).toBe(removedRuntime);
				await fs.rm(removedRuntime);

				const replacement = await ensureBroker({ agentDir });
				expect(replacement.ownerId).not.toBe(incumbentDiscovery.ownerId);
				expect(replacement.pid).not.toBe(incumbentDiscovery.pid);
				expect(replacement.packageGeneration).toBe(currentGeneration);
				expect(replacement.runtime).toBe(resolveSdkInternalSpawnCommand("session-host-internal").file);

				const published = await readBrokerDiscovery(agentDir);
				expect(published?.ownerId).toBe(replacement.ownerId);
			} finally {
				await incumbent.stop().catch(() => {});
				await stopDiscoveredBroker(agentDir);
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		},
		BROKER_TEST_TIMEOUT_MS,
	);

	test(
		"ensureBroker reuses a live incumbent whose runtime image is intact",
		async () => {
			const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-intact-"));
			const runtime = path.join(agentDir, "intact-runtime");
			await writeRuntimeImage(runtime);
			const incumbent = new Broker({ agentDir, runtime });
			try {
				const incumbentDiscovery = await incumbent.start();
				const reused = await ensureBroker({ agentDir });
				expect(reused.ownerId).toBe(incumbentDiscovery.ownerId);
				expect(reused.pid).toBe(incumbentDiscovery.pid);
			} finally {
				await incumbent.stop().catch(() => {});
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		},
		BROKER_TEST_TIMEOUT_MS,
	);

	// The permission this process sees is not the permission the broker spawns
	// with: only the image being gone is caller-independent proof.
	test.skipIf(isWindows || isRoot)(
		"ensureBroker keeps a live incumbent whose runtime image this caller cannot execute",
		async () => {
			const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-unexecutable-"));
			const runtime = path.join(agentDir, "unexecutable-runtime");
			await writeRuntimeImage(runtime);
			const incumbent = new Broker({ agentDir, runtime });
			try {
				const incumbentDiscovery = await incumbent.start();
				await fs.chmod(runtime, 0o600);

				const reused = await ensureBroker({ agentDir });
				expect(reused.ownerId).toBe(incumbentDiscovery.ownerId);
				expect(reused.pid).toBe(incumbentDiscovery.pid);
			} finally {
				await incumbent.stop().catch(() => {});
				await fs.chmod(runtime, 0o700).catch(() => {});
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		},
		BROKER_TEST_TIMEOUT_MS,
	);

	test("a present image, and a path whose parent is no longer a directory", async () => {
		const dir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-probe-"));
		try {
			const image = await writeRuntimeImage(path.join(dir, "image"));
			expect(await isSdkInternalRuntimeImagePresent(image)).toBe(true);
			expect(await isSdkInternalRuntimeImagePresent(path.join(dir, "missing"))).toBe(false);
			// Every host reports this as absence: ENOTDIR on POSIX, ENOENT on Windows.
			expect(await isSdkInternalRuntimeImagePresent(path.join(image, "nested"))).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(isWindows)("POSIX inconclusive probes keep the image present", async () => {
		const dir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-probe-posix-"));
		try {
			const unexecutable = path.join(dir, "unexecutable");
			await writeRuntimeImage(unexecutable);
			await fs.chmod(unexecutable, 0o000);
			expect(await isSdkInternalRuntimeImagePresent(unexecutable)).toBe(true);

			// ELOOP: the image cannot be inspected, but nothing proves it is gone.
			await fs.symlink(path.join(dir, "loop-b"), path.join(dir, "loop-a"));
			await fs.symlink(path.join(dir, "loop-a"), path.join(dir, "loop-b"));
			expect(await isSdkInternalRuntimeImagePresent(path.join(dir, "loop-a"))).toBe(true);

			if (!isRoot) {
				// EACCES: a directory this caller may not traverse, e.g. a sandbox.
				const locked = path.join(dir, "locked");
				await fs.mkdir(locked);
				const hidden = await writeRuntimeImage(path.join(locked, "image"));
				await fs.chmod(locked, 0o000);
				try {
					expect(await isSdkInternalRuntimeImagePresent(hidden)).toBe(true);
				} finally {
					await fs.chmod(locked, 0o700);
				}
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!isWindows)("Windows images have no execute bit to lose", async () => {
		const dir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-probe-win-"));
		const image = path.join(dir, "image.exe");
		try {
			// Windows cannot express a non-executable regular file; a read-only image
			// is still present, and only a deleted one retires its broker.
			await writeRuntimeImage(image);
			await fs.chmod(image, 0o444);
			expect(await isSdkInternalRuntimeImagePresent(image)).toBe(true);
			// Windows refuses to unlink a file carrying the read-only attribute, so
			// clear it once the probe has seen it. Deletion is the assertion below.
			await fs.chmod(image, 0o666);
			await fs.rm(image);
			expect(await isSdkInternalRuntimeImagePresent(image)).toBe(false);
		} finally {
			await fs.chmod(image, 0o666).catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a runtime image deleted between exec and publication is still published", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-window-")));
		try {
			// Source-runtime evidence: an absolute marker outside a compiled bundle
			// and no embedded files. Only the image on disk changes below.
			const markerPath = path.join(dir, "internal-source-marker-2178.txt");
			await Bun.write(markerPath, "source marker\n");
			const execPath = await writeRuntimeImage(path.join(dir, "vanishing-bun"));
			expect(sdkInternalRuntimeImageForTest({ execPath, embeddedFiles: [], markerPath })).toBe(execPath);

			// The production window: a package upgrade removes the interpreter this
			// process was exec'd from before the broker writes its discovery record.
			await fs.rm(execPath);
			const published = sdkInternalRuntimeImageForTest({ execPath, embeddedFiles: [], markerPath });
			expect(published).toBe(execPath);
			expect(await isSdkInternalRuntimeImagePresent(published!)).toBe(false);
			// Publishing nothing here would read as legacy evidence and make the one
			// broker that can never spawn reusable forever.
			expect(await isBrokerReusable(discoveryWithRuntime(published))).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("unclassifiable runtime evidence publishes nothing and stays reusable", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-runtime-unclassified-")));
		try {
			const markerPath = path.join(dir, "internal-source-marker-2178.txt");
			await Bun.write(markerPath, "source marker\n");
			const execPath = await writeRuntimeImage(path.join(dir, "runtime"));
			// Embedded files that contradict the marker: neither source nor compiled.
			expect(
				sdkInternalRuntimeImageForTest({ execPath, embeddedFiles: [{ name: "other.txt" }], markerPath }),
			).toBeUndefined();
			// No Bun means no source runtime to name; a bare execPath would be some
			// other interpreter, which is worse evidence than none.
			expect(
				sdkInternalRuntimeImageForTest({ execPath, embeddedFiles: [], markerPath, bunAvailable: false }),
			).toBeUndefined();
			expect(await isBrokerReusable(discoveryWithRuntime(undefined))).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a compiled runtime publishes an on-disk image, never its virtual bundle path", async () => {
		const markerName = "internal-source-marker-2178-a1b2c3.txt";
		const published = sdkInternalRuntimeImageForTest({
			execPath: "/$bunfs/root/gjc",
			embeddedFiles: [{ name: markerName }],
			markerPath: `/$bunfs/root/${markerName}`,
		});
		expect(published).toBeDefined();
		// The OS current-image answer, not the bundle entry: nothing on disk backs
		// `/$bunfs`, so publishing it would retire every healthy compiled broker.
		expect(await isSdkInternalRuntimeImagePresent(published!)).toBe(true);
	});
});
