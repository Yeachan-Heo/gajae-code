import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
import { DEFAULT_ARTIFACT_MAX_BYTES, OutputSink } from "@gajae-code/coding-agent/session/streaming-output";
import { BashTool, type ToolSession } from "@gajae-code/coding-agent/tools";
import type { Shell } from "@gajae-code/natives";
import * as piNatives from "@gajae-code/natives";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-lifecycle-"));
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForGone(pid: number, timeoutMs = 2_500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true;
		await Bun.sleep(50);
	}
	return !processExists(pid);
}

function makeToolSession(tempDir: string, settings: Settings): ToolSession {
	const artifacts = new ArtifactManager(path.join(tempDir, "artifacts"));
	return {
		cwd: tempDir,
		hasUI: false,
		settings,
		getSessionId: () => "bash-lifecycle-test",
		getAgentId: () => "0-Test",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
	} as unknown as ToolSession;
}

describe("bash resource lifecycle", () => {
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
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	it("repeated async bash jobs return native shell session count to baseline", async () => {
		const baseline = getShellSessionCount();
		const tool = new BashTool(makeToolSession(tempDir, settings));

		for (let index = 0; index < 3; index++) {
			const started = await tool.execute(`call-${index}`, {
				command: `printf async-${index}`,
				async: true,
				timeout: 5,
			});
			const jobId = started.details?.async?.jobId;
			expect(jobId).toBeString();
			await manager.waitForAll();
			expect(manager.getJob(jobId! as string)?.status).toBe("completed");
			expect(getShellSessionCount()).toBe(baseline);
		}
	});

	it("repeated monitor jobs return native shell session count to baseline", async () => {
		const baseline = getShellSessionCount();
		const tool = new BashTool(makeToolSession(tempDir, settings));

		for (let index = 0; index < 3; index++) {
			const { jobId } = await tool.startMonitorJob({ command: `printf monitor-${index}`, timeout: 5 });
			await manager.waitForAll();
			expect(manager.getJob(jobId)?.status).toBe("completed");
			expect(getShellSessionCount()).toBe(baseline);
		}
	});

	it("keeps a cancelled persistent shell reachable until native run settles", async () => {
		const baseline = getShellSessionCount();
		const controller = new AbortController();
		const run = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 10_000,
			signal: controller.signal,
			sessionKey: "cancel-reachable",
		});

		await Bun.sleep(100);
		expect(getShellSessionCount()).toBeGreaterThan(baseline);
		controller.abort();
		const result = await run;
		expect(result.cancelled).toBe(true);
		expect(getShellSessionCount()).toBe(baseline);
		await disposeAllShellSessions();
		expect(getShellSessionCount()).toBe(baseline);
	});

	it("reaps owned descendants on cancellation without killing unrelated siblings", async () => {
		if (process.platform === "win32") return;

		const sibling = Bun.spawn(["python3", "-c", "import time; time.sleep(10)"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const pidFile = path.join(tempDir, "owned.pid");
		const controller = new AbortController();
		const run = executeBash(
			`python3 -c 'import os,time; open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())); time.sleep(10)'`,
			{
				cwd: tempDir,
				timeout: 10_000,
				signal: controller.signal,
				sessionKey: "owned-pid-cancel",
			},
		);

		const deadline = Date.now() + 2_000;
		while (!fs.existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(25);
		expect(fs.existsSync(pidFile)).toBe(true);
		const ownedPid = Number(fs.readFileSync(pidFile, "utf8"));
		expect(processExists(ownedPid)).toBe(true);
		controller.abort();
		const result = await run;
		expect(result.cancelled).toBe(true);
		expect(await waitForGone(ownedPid)).toBe(true);
		expect(processExists(sibling.pid)).toBe(true);
		sibling.kill("SIGKILL");
		await sibling.exited.catch(() => undefined);
	});

	it("caps bash artifact output and annotates truncation metadata", async () => {
		const artifactPath = path.join(tempDir, "capped.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "cap",
			spillThreshold: 4,
			artifactMaxBytes: 16,
		});

		sink.push("a".repeat(40));
		const summary = await sink.dump();
		const artifact = fs.readFileSync(artifactPath, "utf8");

		expect(summary.artifactId).toBe("cap");
		expect(summary.artifactTruncatedBytes).toBeGreaterThan(0);
		expect(artifact).toContain("artifact truncated after 16 bytes");
		expect(Buffer.byteLength(artifact, "utf8")).toBeLessThan(DEFAULT_ARTIFACT_MAX_BYTES);
		expect(artifact.length).toBeLessThan(120);
	});

	it("caps direct artifact saves and annotates truncation", async () => {
		const manager = new ArtifactManager(path.join(tempDir, "direct-artifacts"));
		const id = await manager.save("x".repeat(64), "bash", { maxBytes: 12 });
		const savedPath = await manager.getPath(id);
		expect(savedPath).toBeString();
		const saved = fs.readFileSync(savedPath!, "utf8");
		expect(saved).toContain("artifact truncated after 12 bytes");
		expect(saved.length).toBeLessThan(96);
	});
	it("does not let a late-retired shell replace its same-key successor", async () => {
		const originalRun = piNatives.Shell.prototype.run;
		let runCalls = 0;
		let firstRunSettled: (() => void) | undefined;
		const shells: Shell[] = [];
		const runSpy = vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (
			this: Shell,
			options,
			onChunk,
		) {
			runCalls++;
			shells.push(this);
			if (runCalls === 1) {
				onChunk?.(null, "started\n");
				return new Promise(resolve => {
					firstRunSettled = () => resolve({ exitCode: 130, cancelled: true, timedOut: false });
				});
			}
			if (runCalls === 2) {
				onChunk?.(null, "replacement\n");
				return Promise.resolve({ exitCode: 0, cancelled: false, timedOut: false });
			}
			if (runCalls === 3) {
				onChunk?.(null, "after-late-settle\n");
				return Promise.resolve({ exitCode: 0, cancelled: false, timedOut: false });
			}
			return originalRun.call(this, options, onChunk);
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue(undefined);
		const controller = new AbortController();
		const first = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5_000,
			signal: controller.signal,
			sessionKey: "late-retiring-replacement",
		});

		await Bun.sleep(50);
		controller.abort();
		const firstResult = await first;
		expect(firstResult.cancelled).toBe(true);
		expect(abortSpy).toHaveBeenCalledTimes(1);

		const replacement = await executeBash("printf replacement", {
			cwd: tempDir,
			timeout: 5_000,
			sessionKey: "late-retiring-replacement",
		});
		expect(replacement.output.trim()).toBe("replacement");
		expect(shells[1]).not.toBe(shells[0]);

		firstRunSettled?.();
		await Bun.sleep(0);

		const afterLateSettle = await executeBash("printf after-late-settle", {
			cwd: tempDir,
			timeout: 5_000,
			sessionKey: "late-retiring-replacement",
		});
		expect(afterLateSettle.output.trim()).toBe("replacement");
		expect(runCalls).toBe(2);

		runSpy.mockRestore();
		abortSpy.mockRestore();
	});

	it("caps minimized raw output artifacts through ArtifactManager", async () => {
		const artifacts = new ArtifactManager(path.join(tempDir, "artifacts"));
		const session = {
			getArtifactManager: () => artifacts,
			allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
		} as unknown as ToolSession;
		const originalText = "x".repeat(DEFAULT_ARTIFACT_MAX_BYTES + 1024);
		const bashModule = await import("@gajae-code/coding-agent/tools/bash");
		const artifactId = await bashModule.saveBashOriginalArtifactForTests(session, originalText);

		expect(artifactId).toBeString();
		const artifactPath = path.join(tempDir, "artifacts", `${artifactId}.bash-original.log`);
		expect(fs.existsSync(artifactPath)).toBe(true);
		const saved = fs.readFileSync(artifactPath, "utf8");
		expect(saved).toContain(`artifact truncated after ${DEFAULT_ARTIFACT_MAX_BYTES} bytes`);
		expect(fs.statSync(artifactPath).size).toBeLessThan(DEFAULT_ARTIFACT_MAX_BYTES + 512);
	});
});
