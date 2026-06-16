import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	disposeAllShellSessions,
	executeBash,
	getShellSessionCount,
} from "@gajae-code/coding-agent/exec/bash-executor";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "@gajae-code/coding-agent/session/streaming-output";
import { BashTool, type ToolSession } from "@gajae-code/coding-agent/tools";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-redteam-"));
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(filePath)) return true;
		await Bun.sleep(25);
	}
	return fs.existsSync(filePath);
}

async function waitForSessionCountAtMost(count: number, timeoutMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getShellSessionCount() <= count) return true;
		await Bun.sleep(25);
	}
	return getShellSessionCount() <= count;
}

function makeToolSession(tempDir: string, settings: Settings): ToolSession {
	const artifacts = new ArtifactManager(path.join(tempDir, "artifacts"));
	return {
		cwd: tempDir,
		hasUI: false,
		settings,
		getSessionId: () => "bash-redteam-test",
		getAgentId: () => "0-Redteam",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
	} as unknown as ToolSession;
}

describe("bash resource lifecycle red-team", () => {
	let tempDir: string;
	let settings: Settings;
	let manager: AsyncJobManager;

	beforeEach(async () => {
		tempDir = makeTempDir();
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true, cwd: tempDir });
		settings.set("async.enabled", true);
		manager = new AsyncJobManager({ retentionMs: 20, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		await disposeAllShellSessions();
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1_000 });
		AsyncJobManager.resetForTests();
		await disposeAllShellSessions();
		resetSettingsForTest();
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not leak native shell sessions across many sequential async and monitor bash jobs", async () => {
		const baseline = getShellSessionCount();
		const tool = new BashTool(makeToolSession(tempDir, settings));

		for (let index = 0; index < 12; index++) {
			const started = await tool.execute(`async-${index}`, {
				command: `printf 'async-${index}\\n'`,
				async: true,
				timeout: 5,
			});
			const jobId = started.details?.async?.jobId;
			expect(jobId).toBeString();
			await manager.waitForAll();
			expect(manager.getJob(jobId! as string)?.status).toBe("completed");
			expect(getShellSessionCount()).toBe(baseline);

			const monitor = await tool.startMonitorJob({ command: `printf 'monitor-${index}\\n'`, timeout: 5 });
			await manager.waitForAll();
			expect(manager.getJob(monitor.jobId)?.status).toBe("completed");
			expect(getShellSessionCount()).toBe(baseline);
		}
	});

	// U6 owns the JS-layer lifecycle contract: cancelled persistent shell sessions
	// remain reachable to disposeAllShellSessions during bounded native cleanup,
	// then leave the registry after native settle. Descendant/grandchild reaping is
	// delegated to pi-shell and verified by native unit U3; this JS test exercises
	// the integration again after U3 merges and the dev native addon is rebuilt.
	it("keeps a cancelled persistent shell disposable through bounded native cleanup", async () => {
		if (process.platform === "win32") return;

		const baseline = getShellSessionCount();
		const sibling = Bun.spawn(["python3", "-c", "import time; time.sleep(20)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const pidFile = path.join(tempDir, "owned-direct-child.pid");
		const controller = new AbortController();
		const command = `python3 -c 'import os,time; open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())); time.sleep(20)'`;

		try {
			const run = executeBash(command, {
				cwd: tempDir,
				timeout: 30_000,
				signal: controller.signal,
				sessionKey: "redteam-cancel-disposable",
			});

			expect(await waitForFile(pidFile)).toBe(true);
			const directChildPid = Number(fs.readFileSync(pidFile, "utf8"));
			expect(Number.isInteger(directChildPid)).toBe(true);
			expect(directChildPid).not.toBe(sibling.pid);
			expect(processExists(directChildPid)).toBe(true);
			expect(processExists(sibling.pid)).toBe(true);
			expect(getShellSessionCount()).toBeGreaterThan(baseline);

			controller.abort();
			expect(getShellSessionCount()).toBeGreaterThanOrEqual(baseline);

			const cleanupStartedAt = Date.now();
			await disposeAllShellSessions();
			const cleanupMs = Date.now() - cleanupStartedAt;
			expect(cleanupMs).toBeLessThan(2_500);
			expect(await waitForSessionCountAtMost(baseline)).toBe(true);

			const result = await run;
			expect(result.cancelled).toBe(true);
			expect(processExists(sibling.pid)).toBe(true);
		} finally {
			sibling.kill("SIGKILL");
			await sibling.exited.catch(() => undefined);
		}
	});

	it("caps huge bash artifacts with truncation metadata instead of unbounded growth", async () => {
		const tool = new BashTool(makeToolSession(tempDir, settings));
		const result = await tool.execute("huge-artifact", {
			command: "python3 -c 'import sys; sys.stdout.write(\"x\" * (12 * 1024 * 1024))'",
			timeout: 30,
		});

		const meta = result.details?.meta?.truncation;
		expect(meta?.artifactId).toBeString();
		expect(meta?.truncatedBy).toBe("bytes");
		expect(meta?.totalBytes).toBeGreaterThan(DEFAULT_ARTIFACT_MAX_BYTES / 2);
		expect(meta?.totalBytes).toBeLessThanOrEqual(DEFAULT_ARTIFACT_MAX_BYTES);
		expect(meta?.outputBytes).toBeGreaterThan(0);
		expect(meta?.outputBytes).toBeLessThan(meta!.totalBytes);
		expect(meta?.outputBytes).toBeLessThanOrEqual(DEFAULT_ARTIFACT_MAX_BYTES);

		const artifactPath = path.join(tempDir, "artifacts", `${meta!.artifactId}.bash.log`);
		expect(fs.existsSync(artifactPath)).toBe(true);
		expect(fs.statSync(artifactPath).size).toBe(meta!.totalBytes);
	});
});
