import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { getRuntimeResourceCounts } from "@gajae-code/coding-agent/debug/runtime-gauges";
import {
	type BashResult,
	buildMinimizerOptions,
	disposeAllShellSessions,
	executeBash,
	getShellSessionCount,
	normalizeMinimizedSaveResultForTests,
	setShellFactoryForTests,
} from "@gajae-code/coding-agent/exec/bash-executor";
import {
	extendOwnedDarwinAncestry,
	parseOwnershipRecord,
	retainOwnedProcess,
} from "@gajae-code/coding-agent/exec/bash-shell-guardian";
import {
	createUtf8LineDecoder,
	parseAuthenticatedWorkerResponse,
} from "@gajae-code/coding-agent/exec/bash-shell-supervisor";
import { IsolatedShell } from "@gajae-code/coding-agent/exec/isolated-shell";
import { DEFAULT_MAX_BYTES } from "@gajae-code/coding-agent/session/streaming-output";
import * as shellSnapshot from "@gajae-code/coding-agent/utils/shell-snapshot";
import type { Shell } from "@gajae-code/natives";
import * as piNatives from "@gajae-code/natives";
import { safeRmSync } from "../../../scripts/safe-cleanup";

const BACKGROUND_COMPLETION_RACE_MS = 750;
// Direct executor callers retain the shared 20 KiB head alongside the 50 KiB tail.
const ARTIFACT_HEAD_BYTES_DEFAULT = 20 * 1024;
const KILL_MARKER_DELAY_SECONDS = "0.4";
const KILL_MARKER_ASSERTION_WAIT_MS = 900;

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-exec-"));
}

describe("executeBash", () => {
	it("caps minimizer captures to the supported protocol boundary", () => {
		const base = { enabled: true, settingsPath: "", only: [], except: [] };
		expect(buildMinimizerOptions({ ...base, maxCaptureBytes: Number.MAX_SAFE_INTEGER })?.maxCaptureBytes).toBe(
			4 * 1024 * 1024,
		);
		expect(buildMinimizerOptions({ ...base, maxCaptureBytes: 0 })?.maxCaptureBytes).toBe(1024);
	});

	it("never admits the guardian itself as an owned cleanup target", () => {
		const owned = new Map<string, { pid: number; incarnation: string }>();
		expect(retainOwnedProcess(owned, { pid: 41, incarnation: "guardian" }, 41)).toBe(false);
		expect(owned.size).toBe(0);
		expect(retainOwnedProcess(owned, { pid: 42, incarnation: "child" }, 41)).toBe(true);
		expect(owned.get("42:child")).toEqual({ pid: 42, incarnation: "child" });
	});

	it("rejects null and malformed ownership ledger records", () => {
		expect(parseOwnershipRecord("null")).toBeUndefined();
		expect(parseOwnershipRecord("[]")).toBeUndefined();
		expect(parseOwnershipRecord('{"pid":42,"incarnation":"linux:1"}')).toBeUndefined();
		expect(parseOwnershipRecord('{"pid":42,"incarnation":"linux:1","signature":"00"}')).toEqual({
			pid: 42,
			incarnation: "linux:1",
			signature: "00",
		});
	});

	it("extends Darwin ancestry after the recorded root has disappeared", () => {
		const known = new Set([100n]);
		const candidates = new Map([
			[42, { uniqueId: 200n, parentUniqueId: 100n }],
			[43, { uniqueId: 300n, parentUniqueId: 200n }],
		]);
		expect(extendOwnedDarwinAncestry(known, candidates)).toEqual([42, 43]);
		expect(known).toEqual(new Set([100n, 200n, 300n]));
	});
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		setShellFactoryForTests(undefined);
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) {
			safeRmSync(tempDir, { recursive: true });
		}
	});

	it("preserves an explicit capped minimizer artifact below the default cap", () => {
		const result = normalizeMinimizedSaveResultForTests(
			{ status: "saved", artifactId: "lower-cap", complete: false, omittedBytes: 7 },
			"short original",
		);

		expect(result).toEqual({
			status: "saved",
			artifactId: "lower-cap",
			complete: false,
			omittedBytes: 7,
		});
	});

	it("returns non-zero exit codes without cancellation", async () => {
		const result = await executeBash("exit 7", { cwd: tempDir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.cancelled).toBe(false);
	});

	it("starts the command timeout after isolated shell readiness", async () => {
		if (process.platform === "win32") return;
		setShellFactoryForTests(() => ({
			ready: async () => await Bun.sleep(1_200),
			run: async () => ({ exitCode: 0, cancelled: false, timedOut: false }),
			abort: async () => undefined,
			close: async () => undefined,
		}));

		const startedAt = Date.now();
		const result = await executeBash("printf ready", {
			cwd: tempDir,
			timeout: 1_000,
			sessionKey: "slow-shell-readiness",
			oneShot: true,
		});
		expect(result).toMatchObject({ exitCode: 0, cancelled: false });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_100);
	});

	it("cancels promptly while isolated shell readiness is stalled", async () => {
		if (process.platform === "win32") return;
		const closeSpy = vi.fn(async () => undefined);
		setShellFactoryForTests(() => ({
			ready: async () => await new Promise(() => {}),
			run: async () => ({ exitCode: 0, cancelled: false, timedOut: false }),
			abort: async () => undefined,
			close: closeSpy,
		}));

		const controller = new AbortController();
		const promise = executeBash("printf never", {
			cwd: tempDir,
			timeout: 1_000,
			signal: controller.signal,
			sessionKey: "stalled-shell-readiness",
			oneShot: true,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	it("owns a starting persistent shell during concurrent disposal", async () => {
		if (process.platform === "win32") return;
		await disposeAllShellSessions();
		const ready = Promise.withResolvers<void>();
		const closeSpy = vi.fn(async () => undefined);
		const runSpy = vi.fn(async () => ({ exitCode: 0, cancelled: false, timedOut: false }));
		setShellFactoryForTests(() => ({
			ready: async () => await ready.promise,
			run: runSpy,
			abort: async () => undefined,
			close: closeSpy,
		}));

		const execution = executeBash("printf never", {
			cwd: tempDir,
			timeout: 1_000,
			sessionKey: "dispose-during-startup",
		});
		for (let attempt = 0; attempt < 40 && getShellSessionCount() === 0; attempt++) await Bun.sleep(5);
		expect(getShellSessionCount()).toBe(1);

		await disposeAllShellSessions();
		expect(getShellSessionCount()).toBe(0);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		ready.resolve();
		await expect(execution).rejects.toThrow("disposed during startup");
		expect(runSpy).not.toHaveBeenCalled();
		expect(getShellSessionCount()).toBe(0);
	});

	it("coalesces concurrent creation for the same persistent session key", async () => {
		await disposeAllShellSessions();
		const ready = Promise.withResolvers<void>();
		let created = 0;
		let persisted = "";
		setShellFactoryForTests(() => {
			created++;
			return {
				ready: async () => await ready.promise,
				run: async ({ command }: { command: string }) => {
					if (command.startsWith("export ")) persisted = command.slice("export ".length);
					return { exitCode: 0, cancelled: false, timedOut: false, output: persisted };
				},
				abort: async () => undefined,
				close: async () => undefined,
			};
		});

		const first = executeBash("export shared", {
			cwd: tempDir,
			disableShellSnapshot: true,
			sessionKey: "coalesced-startup",
		});
		const second = executeBash("printf shared", {
			cwd: tempDir,
			disableShellSnapshot: true,
			sessionKey: "coalesced-startup",
		});
		await Bun.sleep(25);
		expect(created).toBe(1);
		ready.resolve();
		await Promise.all([first, second]);
		expect(created).toBe(1);
		expect(getShellSessionCount()).toBe(1);
	});

	it("does not create a queued same-key shell after concurrent disposal", async () => {
		const ready = Promise.withResolvers<void>();
		const closeSpy = vi.fn(async () => ready.resolve());
		let created = 0;
		setShellFactoryForTests(() => {
			created++;
			return {
				ready: async () => await ready.promise,
				run: async () => ({ exitCode: 0, cancelled: false, timedOut: false }),
				abort: async () => undefined,
				close: closeSpy,
			};
		});

		const first = executeBash("printf first", {
			cwd: tempDir,
			disableShellSnapshot: true,
			sessionKey: "queued-disposal",
		}).catch(error => error);
		const second = executeBash("printf second", {
			cwd: tempDir,
			disableShellSnapshot: true,
			sessionKey: "queued-disposal",
		}).catch(error => error);
		for (let attempt = 0; attempt < 40 && created === 0; attempt++) await Bun.sleep(5);
		expect(created).toBe(1);
		const disposal = disposeAllShellSessions();
		ready.resolve();
		await disposal;
		const [firstError, secondError] = await Promise.all([first, second]);
		expect(firstError).toBeInstanceOf(Error);
		expect(secondError).toBeInstanceOf(Error);
		expect((firstError as Error).message).toContain("disposed during startup");
		expect((secondError as Error).message).toContain("disposed during startup");
		expect(created).toBe(1);
		expect(closeSpy).toHaveBeenCalled();
		expect(getShellSessionCount()).toBe(0);
	});

	it("contains shell self-signals in a sacrificial child and restores the persistent session", async () => {
		if (process.platform === "win32") return;

		const fixture = path.join(import.meta.dir, "fixtures", "bash-self-signal-repro.ts");
		const child = Bun.spawn([process.execPath, fixture], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const completion = await Promise.race([
			child.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
			Bun.sleep(20_000).then(() => ({ kind: "timeout" as const })),
		]);
		if (completion.kind === "timeout") child.kill("SIGKILL");
		expect(completion.kind).toBe("exit");
		if (completion.kind !== "exit") return;
		const diagnostic = await stderr;
		expect(completion.exitCode, diagnostic).toBe(0);

		const report = JSON.parse(await stdout) as {
			hostPid: number;
			identity: BashResult;
			substitutionIdentity: BashResult;
			timeoutIdentity: BashResult;
			persistent: BashResult;
			builtinTrap: BashResult;
			builtinTrapFinalized: boolean;
			builtinTrapRecovery: BashResult;
			externalTrap: BashResult;
			externalTrapFinalized: boolean;
			externalTrapRecovery: BashResult;
			processGroupTerm: BashResult;
			processGroupTermFinalized: boolean;
			processGroupTermRecovery: BashResult;
			uncatchableKill: BashResult;
			uncatchableKillFinalized: boolean;
			uncatchableKillRecovery: BashResult;
			userSignal: BashResult;
			userSignalFinalized: boolean;
			userSignalRecovery: BashResult;
			descendantSignal: BashResult;
			descendantPid: number;
			descendantGone: boolean;
			alarmSignal: BashResult;
			alarmPid: number;
			alarmGone: boolean;
			parentAlive: boolean;
		};
		const [shellPid, bashPid] = report.identity.output.split("|").map(Number);
		expect(shellPid).toBeGreaterThan(0);
		expect(bashPid).toBe(shellPid);
		expect(shellPid).not.toBe(report.hostPid);
		for (const nested of [report.substitutionIdentity, report.timeoutIdentity]) {
			const [workerPid, childSid, childPgid] = nested.output.trim().split("|").map(Number);
			expect(workerPid).toBe(shellPid);
			expect(childSid).toBe(childPgid);
			expect(childSid).not.toBe(report.hostPid);
			expect(childSid).not.toBe(workerPid);
		}
		expect(report.persistent?.output).toBe("preserved");
		for (const name of ["builtinTrap", "externalTrap"] as const) {
			expect(report[name]).toMatchObject({ exitCode: 133, signal: "SIGTRAP", cancelled: false });
			expect(report[`${name}Finalized`]).toBe(true);
			expect(report[`${name}Recovery`]?.output).toBe("recovered");
		}
		expect(report.processGroupTerm).toMatchObject({ exitCode: 143, signal: "SIGTERM", cancelled: false });
		expect(report.processGroupTermFinalized).toBe(true);
		expect(report.processGroupTermRecovery?.output).toBe("recovered");
		expect(report.uncatchableKill).toMatchObject({ exitCode: 137, signal: "SIGKILL", cancelled: false });
		expect(report.uncatchableKillFinalized).toBe(true);
		expect(report.uncatchableKillRecovery?.output).toBe("recovered");
		expect(report.userSignal).toMatchObject({
			exitCode: 128 + os.constants.signals.SIGUSR1,
			signal: "SIGUSR1",
			cancelled: false,
		});
		expect(report.userSignalFinalized).toBe(true);
		expect(report.userSignalRecovery.output).toBe("recovered");
		expect(report.descendantSignal).toMatchObject({ exitCode: 137, signal: "SIGKILL", cancelled: false });
		expect(report.descendantPid).toBeGreaterThan(0);
		expect(report.descendantGone).toBe(true);
		expect(report.alarmSignal).toMatchObject({ exitCode: 142, signal: "SIGALRM", cancelled: false });
		expect(report.alarmPid).toBeGreaterThan(0);
		expect(report.alarmGone).toBe(true);
		expect(report.parentAlive).toBe(true);
	}, 30_000);

	it("evicts an idle worker that dies before the next same-key command", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "idle-worker-death";
		const identity = await executeBash('printf "%s" "$$"', { cwd: tempDir, timeout: 5_000, sessionKey });
		const workerPid = Number.parseInt(identity.output, 10);
		expect(workerPid).toBeGreaterThan(0);
		process.kill(workerPid, "SIGKILL");
		await Bun.sleep(100);

		const recovered = await executeBash("printf recovered", { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(recovered.output).toBe("recovered");
	});

	it("force-retires a stopped runtime and recovers the same session key", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "stopped-runtime-retirement";
		const startedAt = Date.now();
		const stopped = await executeBash("kill -STOP $$", { cwd: tempDir, timeout: 1_000, sessionKey });
		expect(stopped.cancelled).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		const recovered = await executeBash("printf recovered", { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(recovered.output).toBe("recovered");
	});

	it("re-admits a queued same-key command after its predecessor self-signals", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "queued-terminal-recovery";
		const killed = executeBash("sleep 0.2; kill -KILL $$", { cwd: tempDir, timeout: 5_000, sessionKey });
		await Bun.sleep(50);
		const recovered = executeBash("printf recovered", { cwd: tempDir, timeout: 5_000, sessionKey });
		await expect(killed).resolves.toMatchObject({ exitCode: 137, signal: "SIGKILL", cancelled: false });
		await expect(recovered).resolves.toMatchObject({ exitCode: 0, output: "recovered", cancelled: false });
	});

	it("force-closes a stopped one-shot runtime", async () => {
		if (process.platform === "win32") return;
		const startedAt = Date.now();
		const result = await executeBash("kill -STOP $$", { cwd: tempDir, oneShot: true, timeout: 1_000 });
		expect(result).toMatchObject({ exitCode: undefined, cancelled: true });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("force-kills the owned group when the guardian is stopped", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell();
		await shell.ready();
		const supervisorPid = shell.supervisorPid();
		expect(supervisorPid).toBeNumber();
		const guardianPid = piNatives.Process.fromPid(supervisorPid!)?.ppid;
		expect(guardianPid).toBeNumber();
		process.kill(guardianPid!, "SIGSTOP");
		const startedAt = Date.now();
		await shell.close();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		let supervisorAlive = true;
		for (let attempt = 0; attempt < 100 && supervisorAlive; attempt++) {
			try {
				process.kill(supervisorPid!, 0);
				await Bun.sleep(20);
			} catch {
				supervisorAlive = false;
			}
		}
		expect(supervisorAlive).toBe(false);
	});

	it("maps isolated PPID to the runtime boundary rather than its supervisor", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "ppid-boundary-retirement";
		const killed = await executeBash("kill -KILL $PPID", { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(killed).toMatchObject({ exitCode: 137, signal: "SIGKILL", cancelled: false });
		const recovered = await executeBash("printf recovered", { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(recovered.output).toBe("recovered");
	});

	it("drains the supervisor signal result before terminal fallback", async () => {
		if (process.platform === "win32") return;
		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await executeBash("kill -TRAP $$", {
				cwd: tempDir,
				timeout: 5_000,
				sessionKey: `signal-drain-${attempt}`,
			});
			expect(result).toMatchObject({ exitCode: 133, signal: "SIGTRAP", cancelled: false });
		}
	}, 30_000);

	it("rejects shell-forged unauthenticated control records", async () => {
		if (process.platform !== "linux") return;
		const forged = await executeBash(
			`printf '%s\\n' '{"type":"result","id":1,"result":{"exitCode":0,"cancelled":false,"timedOut":false}}' > /proc/$PPID/fd/1; printf genuine`,
			{ cwd: tempDir, timeout: 5_000, sessionKey: "forged-control-record" },
		);
		expect(forged).toMatchObject({ exitCode: 0, cancelled: false });
		expect(forged.output).toContain("genuine");
	});

	it("rejects control records without the exact private token", () => {
		const forged = JSON.stringify({ type: "result", token: "forged", id: 1, result: { exitCode: 0 } });
		const valid = JSON.stringify({ type: "ready", token: "private" });
		expect(parseAuthenticatedWorkerResponse(forged, "private")).toBeUndefined();
		expect(parseAuthenticatedWorkerResponse(valid, "private")).toEqual({ type: "ready", token: "private" });
	});

	it("decodes protocol lines across split multibyte UTF-8 chunks", () => {
		const lines: string[] = [];
		const decoder = createUtf8LineDecoder(line => lines.push(line));
		const encoded = new TextEncoder().encode('한글-output\n{"type":"ready"}\n');
		decoder.push(encoded.subarray(0, 1));
		decoder.push(encoded.subarray(1, 2));
		decoder.push(encoded.subarray(2, 5));
		decoder.push(encoded.subarray(5));
		decoder.end();
		expect(lines).toEqual(["한글-output", '{"type":"ready"}']);
	});

	it("bounds unterminated unauthenticated protocol bytes", () => {
		let overflowed = 0;
		const decoder = createUtf8LineDecoder(() => undefined, {
			maxBufferedBytes: 8,
			onOverflow: () => overflowed++,
		});
		decoder.push(new TextEncoder().encode("12345678"));
		decoder.push(new TextEncoder().encode("9"));
		decoder.push(new TextEncoder().encode("ignored"));
		expect(overflowed).toBe(1);
	});

	it("accepts worst-case escaped supported final protocol records", () => {
		let receivedBytes = 0;
		let overflowed = 0;
		const decoder = createUtf8LineDecoder(
			line => {
				receivedBytes = Buffer.byteLength(line);
			},
			{ onOverflow: () => overflowed++ },
		);
		const captured = "\0".repeat(4 * 1024 * 1024);
		const line = JSON.stringify({ text: captured, originalText: captured });
		decoder.push(new TextEncoder().encode(`${line}\n`));
		decoder.end();
		expect(overflowed).toBe(0);
		expect(receivedBytes).toBe(Buffer.byteLength(line));
	});

	it("does not expose ownership ledger secrets to shell commands or their supervisor parent", async () => {
		if (process.platform !== "linux") return;
		const result = await executeBash(
			`{ env; tr '\\0' '\\n' < /proc/$PPID/environ; } | grep 'GJC_SHELL_OWNERSHIP_LEDGER_' || true`,
			{ cwd: tempDir, timeout: 5_000, sessionKey: "ownership-secret-scrub" },
		);
		expect(result).toMatchObject({ exitCode: 0, output: "" });
	});

	it("reaps an escaped child after its recorded root exits before group death", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell();
		const pidFile = path.join(tempDir, "vanished-root-setsid.pid");
		try {
			const result = await shell.run({
				command: `python3 -c 'import os,time; pid=os.fork(); (os.setsid(), open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())), time.sleep(30)) if pid == 0 else None'; while [ ! -s "${pidFile}" ]; do sleep 0.01; done; kill -KILL 0`,
				cwd: tempDir,
				timeoutMs: 10_000,
			});
			expect(result.signal).toBe("SIGKILL");
			const descendantPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try {
					process.kill(descendantPid, 0);
					await Bun.sleep(20);
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		} finally {
			await shell.close();
		}
	});

	it("reaps a reparented grandchild when the embedded timeout builtin expires", async () => {
		if (process.platform === "win32") return;
		const pidFile = path.join(tempDir, "timeout-grandchild.pid");
		const sessionKey = "contained-timeout-grandchild";
		const command = `timeout 0.1 python3 -c 'import os,signal,time; pid=os.fork(); (open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())), signal.signal(signal.SIGTERM, signal.SIG_IGN), time.sleep(30)) if pid == 0 else time.sleep(30)'`;
		const startedAt = Date.now();
		const result = await executeBash(command, { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(result).toMatchObject({ exitCode: 124, cancelled: false });
		expect(Date.now() - startedAt).toBeLessThan(3_000);
		const grandchildPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		expect(grandchildPid).toBeGreaterThan(0);
		let gone = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				process.kill(grandchildPid, 0);
				await Bun.sleep(25);
			} catch {
				gone = true;
				break;
			}
		}
		expect(gone).toBe(true);
		const recovered = await executeBash("printf recovered", { cwd: tempDir, timeout: 5_000, sessionKey });
		expect(recovered.output).toBe("recovered");
	}, 30_000);

	it("evicts a worker that fails during initialization", async () => {
		if (process.platform === "win32") return;
		let creations = 0;
		setShellFactoryForTests(options => {
			creations++;
			return creations === 1
				? new IsolatedShell(options, { workerArgv: [process.execPath, "-e", "process.exit(23)"] })
				: new IsolatedShell(options);
		});
		await expect(
			executeBash("printf first", { cwd: tempDir, timeout: 5_000, sessionKey: "init-failure" }),
		).rejects.toThrow("exit code 23");

		const recovered = await executeBash("printf recovered", {
			cwd: tempDir,
			timeout: 5_000,
			sessionKey: "init-failure",
		});
		expect(recovered.output).toBe("recovered");
	});

	it("bounds close while a worker is stalled before readiness", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell(undefined, {
			workerArgv: [process.execPath, "-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
		});
		const startedAt = Date.now();
		await shell.close();
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("does not execute or globally abort a cancelled queued isolated run", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell();
		const sideEffect = path.join(tempDir, "cancelled-queued-run");
		try {
			const active = shell.run({ command: "sleep 0.4; printf active", cwd: tempDir, timeoutMs: 5_000 });
			const controller = new AbortController();
			const queued = shell.run({
				command: `printf queued > '${sideEffect}'`,
				cwd: tempDir,
				signal: controller.signal,
				timeoutMs: 5_000,
			});
			controller.abort();
			expect(await active).toMatchObject({ exitCode: 0, cancelled: false });
			expect(await queued).toMatchObject({ cancelled: true });
			expect(fs.existsSync(sideEffect)).toBe(false);
		} finally {
			await shell.close();
		}
	});

	it("does not cancel the active executeBash call when a queued same-key call is aborted", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "queued-executor-cancellation";
		const sideEffect = path.join(tempDir, "cancelled-queued-executor");
		const activeReady = path.join(tempDir, "active-executor-ready");
		const active = executeBash(`touch '${activeReady}'; sleep 1; printf active`, {
			cwd: tempDir,
			sessionKey,
			timeout: 5_000,
		});
		for (let attempt = 0; attempt < 100 && !fs.existsSync(activeReady); attempt++) await Bun.sleep(10);
		const controller = new AbortController();
		const queued = executeBash(`printf queued > '${sideEffect}'`, {
			cwd: tempDir,
			sessionKey,
			signal: controller.signal,
			timeout: 5_000,
		});
		await Bun.sleep(50);
		const abortedAt = Date.now();
		controller.abort();
		expect(await queued).toMatchObject({ cancelled: true });
		expect(Date.now() - abortedAt).toBeLessThan(500);
		expect(await active).toMatchObject({ output: "active", cancelled: false });
		expect(fs.existsSync(sideEffect)).toBe(false);
	});

	it("does not cancel the active executeBash call when a queued same-key call times out", async () => {
		if (process.platform === "win32") return;
		const sessionKey = "queued-executor-timeout";
		const sideEffect = path.join(tempDir, "timed-out-queued-executor");
		const activeReady = path.join(tempDir, "active-timeout-ready");
		const active = executeBash(`touch '${activeReady}'; sleep 2; printf active`, {
			cwd: tempDir,
			sessionKey,
			timeout: 5_000,
		});
		for (let attempt = 0; attempt < 100 && !fs.existsSync(activeReady); attempt++) await Bun.sleep(10);
		const queued = executeBash(`printf queued > '${sideEffect}'`, {
			cwd: tempDir,
			sessionKey,
			timeout: 1_000,
		});
		const timeoutStartedAt = Date.now();
		expect(await queued).toMatchObject({ cancelled: true });
		expect(Date.now() - timeoutStartedAt).toBeLessThan(1_500);
		expect(await active).toMatchObject({ output: "active", cancelled: false });
		expect(fs.existsSync(sideEffect)).toBe(false);
	});

	it("reaps the owned process group when the supervisor exits first", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell();
		const pidFile = path.join(tempDir, "supervisor-first-child.pid");
		try {
			const running = shell.run({
				command: `/bin/sh -c 'trap "" TERM; echo $$ > "${pidFile}"; sleep 30' & while [ ! -s "${pidFile}" ]; do sleep 0.01; done; sleep 30`,
				cwd: tempDir,
				timeoutMs: 35_000,
			});
			for (let attempt = 0; attempt < 100 && !fs.existsSync(pidFile); attempt++) await Bun.sleep(20);
			const descendantPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
			const supervisorPid = shell.supervisorPid();
			expect(supervisorPid).toBeGreaterThan(0);
			process.kill(supervisorPid!, "SIGKILL");
			expect(await running).toMatchObject({
				exitCode: 128 + os.constants.signals.SIGKILL,
				signal: "SIGKILL",
				cancelled: false,
			});
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try {
					process.kill(descendantPid, 0);
					await Bun.sleep(20);
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		} finally {
			await shell.close();
		}
	});

	it("reaps a new-session descendant when the runtime dies first", async () => {
		if (process.platform !== "linux") return;
		const shell = new IsolatedShell();
		const pidFile = path.join(tempDir, "runtime-first-setsid.pid");
		try {
			const result = await shell.run({
				command: `setsid /bin/sh -c 'trap "" TERM; echo $$ > "${pidFile}"; sleep 30' & while [ ! -s "${pidFile}" ]; do sleep 0.01; done; kill -KILL $$`,
				cwd: tempDir,
				timeoutMs: 10_000,
			});
			expect(result).toMatchObject({
				exitCode: 128 + os.constants.signals.SIGKILL,
				signal: "SIGKILL",
				cancelled: false,
			});
			const descendantPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try {
					process.kill(descendantPid, 0);
					await Bun.sleep(20);
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		} finally {
			await shell.close();
		}
	});

	it("reaps a new-session descendant when an uncatchable group signal kills the owned boundary", async () => {
		if (process.platform === "win32") return;
		const shell = new IsolatedShell();
		const pidFile = path.join(tempDir, "group-kill-setsid.pid");
		try {
			const result = await shell.run({
				command: `python3 -c 'import os,signal,time; pid=os.fork(); os._exit(0) if pid else None; os.setsid(); os.closerange(3, 256); signal.signal(signal.SIGTERM, signal.SIG_IGN); open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())); time.sleep(30)' & while [ ! -s "${pidFile}" ]; do sleep 0.01; done; kill -KILL 0`,
				cwd: tempDir,
				timeoutMs: 10_000,
			});
			expect(result).toMatchObject({
				exitCode: 128 + os.constants.signals.SIGKILL,
				signal: "SIGKILL",
				cancelled: false,
			});
			const descendantPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
			let alive = true;
			for (let attempt = 0; attempt < 100 && alive; attempt++) {
				try {
					process.kill(descendantPid, 0);
					await Bun.sleep(20);
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		} finally {
			await shell.close();
		}
	});

	it("scrubs inherited managed transcript paths from shell sessions", async () => {
		const previousSessionFile = process.env.GJC_SESSION_FILE;
		const previousOwnerPath = process.env.GJC_MANAGED_OWNER_TRANSCRIPT_PATH;
		process.env.GJC_SESSION_FILE = "/managed/session.jsonl";
		process.env.GJC_MANAGED_OWNER_TRANSCRIPT_PATH = "/managed/owner.jsonl";
		try {
			await disposeAllShellSessions();
			const result = await executeBash(
				'printf "%s|%s" "$(printenv GJC_SESSION_FILE || printf unset)" "$(printenv GJC_MANAGED_OWNER_TRANSCRIPT_PATH || printf unset)"',
				{
					cwd: tempDir,
					timeout: 5000,
					sessionKey: "managed-env-scrub",
				},
			);
			expect(result.output).toBe("unset|unset");
		} finally {
			if (previousSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
			else process.env.GJC_SESSION_FILE = previousSessionFile;
			if (previousOwnerPath === undefined) delete process.env.GJC_MANAGED_OWNER_TRANSCRIPT_PATH;
			else process.env.GJC_MANAGED_OWNER_TRANSCRIPT_PATH = previousOwnerPath;
			await disposeAllShellSessions();
		}
	});

	it("retains then fully disposes persistent shell sessions (MEM-7)", async () => {
		await disposeAllShellSessions();
		expect(getShellSessionCount()).toBe(0);
		await executeBash("echo hi", { cwd: tempDir, timeout: 5000, sessionKey: "leak-test" });
		expect(getShellSessionCount()).toBeGreaterThanOrEqual(1);
		// Disposal must await native aborts (not fire-and-forget) so shutdown
		// cleanup does not return before resources are released.
		const pending = disposeAllShellSessions();
		expect(pending).toBeInstanceOf(Promise);
		await pending;
		expect(getShellSessionCount()).toBe(0);
	});

	it("owns and disposes one-shot native shells", async () => {
		await disposeAllShellSessions();
		setShellFactoryForTests(options => new piNatives.Shell(options));
		const closeSpy = vi.spyOn(piNatives.Shell.prototype, "close");
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort");
		try {
			const result = await executeBash("echo one-shot", { cwd: tempDir, timeout: 5000, oneShot: true });

			expect(result.output.trim()).toBe("one-shot");
			expect(getShellSessionCount()).toBe(0);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(abortSpy).not.toHaveBeenCalled();
		} finally {
			setShellFactoryForTests(undefined);
		}
	});

	it("reports the bash shell-session owner count via runtime resource gauges", async () => {
		await disposeAllShellSessions();
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBe(0);
		await executeBash("echo hi", { cwd: tempDir, timeout: 5000, sessionKey: "gauge-test" });
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBeGreaterThanOrEqual(1);
		await disposeAllShellSessions();
		expect(getRuntimeResourceCounts()["bash.shellSessions"]).toBe(0);
	});

	it("honors cwd", async () => {
		const result = await executeBash("pwd", { cwd: tempDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(tempDir));
	});

	it("canonicalizes symlinked cwd before execution", async () => {
		if (process.platform === "win32") {
			return;
		}

		const realDir = path.join(tempDir, "real");
		const linkDir = path.join(tempDir, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");

		const result = await executeBash("pwd", { cwd: linkDir, timeout: 5000 });
		expect(result.output.trim()).toBe(fs.realpathSync(linkDir));
	});

	it("passes env vars", async () => {
		const result = await executeBash("echo $PI_TEST_ENV", {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("hello");
	});

	it("applies non-interactive environment defaults", async () => {
		const result = await executeBash('echo "$GIT_TERMINAL_PROMPT:$PI_TEST_ENV"', {
			cwd: tempDir,
			timeout: 5000,
			env: { PI_TEST_ENV: "hello" },
		});
		expect(result.output.trim()).toBe("0:hello");
	});

	it("can ignore configured shell prefixes", async () => {
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash",
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: "false &&",
		});

		const blocked = await executeBash("echo prefixed", { cwd: tempDir, timeout: 5000 });
		expect(blocked.exitCode).not.toBe(0);

		const ignored = await executeBash("echo unprefixed", {
			cwd: tempDir,
			timeout: 5000,
			ignoreShellPrefix: true,
		});
		expect(ignored.output.trim()).toBe("unprefixed");
	});

	it("invokes onChunk with command output", async () => {
		let seenChunk: string | null = null;
		const result = await executeBash("echo hello", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				if (seenChunk === null) {
					seenChunk = chunk;
				}
			},
		});
		expect(result.output.trim()).toBe("hello");
		expect(seenChunk).not.toBeNull();
		expect(seenChunk ?? "").toContain("hello");
	});

	it("returns even if command spawns a background job", async () => {
		if (process.platform === "win32") {
			return;
		}
		const runPromise = executeBash("{ sleep 2; } & echo fg", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);
		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.output).toContain("fg");
		}
	});

	it("returns a real PID for background external commands", async () => {
		if (process.platform === "win32") {
			return;
		}

		const result = await executeBash('python3 -c "import time; time.sleep(10)" & echo $!', {
			cwd: tempDir,
			timeout: 5000,
		});
		const pid = Number.parseInt(result.output.trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(() => process.kill(pid, "SIGKILL")).not.toThrow();
	});

	it("times out commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const sessionKey = "native-timeout-retirement";
		await executeBash("export PI_TIMEOUT_RETIRED=alive", { cwd: tempDir, timeout: 5_000, sessionKey });
		const result = await executeBash("sleep 10", { cwd: tempDir, timeout: 50, sessionKey });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		const recovered = await executeBash('printf "%s" "$' + '{PI_TIMEOUT_RETIRED:-unset}"', {
			cwd: tempDir,
			timeout: 5_000,
			sessionKey,
		});
		expect(recovered.output).toBe("unset");
	});

	it("times out before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const result = await executeBash("sleep 10; echo done", { cwd: tempDir, timeout: 50 });
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("timed out");
		expect(result.output).not.toContain("done");
	});

	it("aborts commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
	});

	it("returns promptly and quarantines the session key when native abort cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		await disposeAllShellSessions();
		setShellFactoryForTests(options => new piNatives.Shell(options));
		const originalRun = piNatives.Shell.prototype.run;
		const runStarted = Promise.withResolvers<void>();
		let runCalls = 0;
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			runCalls++;
			if (runCalls === 1) {
				onChunk?.(null, "started\n");
				runStarted.resolve();
				return new Promise(() => {});
			}
			return originalRun.call(this, options, onChunk);
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "hung-native-abort",
		});
		await runStarted.promise;
		controller.abort();

		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(750).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command cancelled");
		}
		expect(abortSpy).toHaveBeenCalled();

		const next = await executeBash("echo next", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "hung-native-abort",
		});
		expect(next.output.trim()).toBe("next");
		expect(runCalls).toBe(2);
		setShellFactoryForTests(undefined);
	});

	it("restores persistent sessions after native abort cleanup settles", async () => {
		if (process.platform === "win32") {
			return;
		}

		const nativeResult = Promise.withResolvers<{ exitCode: undefined; cancelled: true; timedOut: false }>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			return nativeResult.promise;
		});
		vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const controller = new AbortController();
		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey: "settled-native-abort",
		});
		await Bun.sleep(50);
		controller.abort();
		await promise;

		nativeResult.resolve({ exitCode: undefined, cancelled: true, timedOut: false });
		await Bun.sleep(0);
		vi.restoreAllMocks();

		await executeBash("export PI_AFTER_ABORT=still_persistent", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		const next = await executeBash("printf '%s\n' \"$PI_AFTER_ABORT\"", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "settled-native-abort",
		});
		expect(next.output.trim()).toBe("still_persistent");
	});

	it("returns at the JavaScript timeout when native timeout cleanup stalls", async () => {
		if (process.platform === "win32") {
			return;
		}

		await disposeAllShellSessions();
		setShellFactoryForTests(options => new piNatives.Shell(options));
		const runStarted = Promise.withResolvers<void>();
		vi.spyOn(piNatives.Shell.prototype, "run").mockImplementation((_options, onChunk) => {
			onChunk?.(null, "started\n");
			runStarted.resolve();
			return new Promise(() => {});
		});
		const abortSpy = vi.spyOn(piNatives.Shell.prototype, "abort").mockResolvedValue();

		const promise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 1000,
			sessionKey: "hung-native-timeout",
		});
		await runStarted.promise;
		const raced = await Promise.race([
			promise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(1500).then(() => ({ type: "timeout" as const })),
		]);

		expect(raced.type).toBe("result");
		if (raced.type === "result") {
			expect(raced.result.cancelled).toBe(true);
			expect(raced.result.output).toContain("Command timed out after 1 seconds");
		}
		expect(abortSpy).toHaveBeenCalled();
		setShellFactoryForTests(undefined);
	});

	it("aborts before follow-up output", async () => {
		if (process.platform === "win32") {
			return;
		}
		const controller = new AbortController();
		const promise = executeBash("sleep 10; echo done", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
		});
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");
		expect(result.output).not.toContain("done");
	});

	it("resets persistent session state after abort", async () => {
		if (process.platform === "win32") {
			return;
		}

		const sessionKey = "reset-on-abort";
		await executeBash("export PI_RESET_VAR=alive", { cwd: tempDir, timeout: 5000, sessionKey });
		const beforeAbort = await executeBash("echo $PI_RESET_VAR", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(beforeAbort.output.trim()).toBe("alive");

		const controller = new AbortController();
		const abortPromise = executeBash("sleep 10", {
			cwd: tempDir,
			timeout: 5000,
			signal: controller.signal,
			sessionKey,
		});
		await Bun.sleep(50);
		controller.abort();
		const aborted = await abortPromise;
		expect(aborted.cancelled).toBe(true);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash variable expansion
		const afterAbort = await executeBash("echo ${PI_RESET_VAR:-unset}", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey,
		});
		expect(afterAbort.output.trim()).toBe("unset");
	});
	it("streams output chunks", async () => {
		const chunks: string[] = [];
		const result = await executeBash("i=1; while [ $i -le 20 ]; do echo line$i; i=$((i+1)); done", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: chunk => {
				expect(chunk.length).toBeGreaterThan(0);
				chunks.push(chunk);
			},
		});
		// At least one chunk should have been delivered to onChunk
		expect(chunks.length).toBeGreaterThan(0);
		const combined = chunks.join("");
		expect(combined).toContain("line1");
		// Final result always has the complete output regardless of chunk throttle
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line20");
	});

	it("streams large output without exhausting memory", async () => {
		if (process.platform === "win32") {
			return;
		}
		let sawChunk = false;
		const result = await executeBash("awk 'BEGIN { for (i = 0; i < 100000; i++) printf \"a\" }'", {
			cwd: tempDir,
			timeout: 5000,
			onChunk: () => {
				sawChunk = true;
			},
		});
		expect(sawChunk).toBe(true);
		expect(result.totalBytes).toBe(100000);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).toContain("a");
	});

	it("preserves the shared direct-executor head and tail windows", async () => {
		if (process.platform === "win32") return;
		const startSentinel = "DIRECT-EXECUTOR-START";
		const endSentinel = "DIRECT-EXECUTOR-END";
		const result = await executeBash(
			`printf '%s\\n' '${startSentinel}'; seq 1 20000; printf '%s\\n' '${endSentinel}'`,
			{ cwd: tempDir, timeout: 5_000 },
		);

		const sharedWindowBudget = DEFAULT_MAX_BYTES + ARTIFACT_HEAD_BYTES_DEFAULT;
		expect(result.truncated).toBe(true);
		expect(result.outputBytes).toBeLessThanOrEqual(sharedWindowBudget + 1024);
		expect(result.output.startsWith(`${startSentinel}\n`)).toBe(true);
		expect(result.output.endsWith(`${endSentinel}\n`)).toBe(true);
		expect(result.output).toContain("elided");
	});

	it("handles multi-million line output without freeze or OOM", async () => {
		if (process.platform === "win32") return;

		// 5 million lines ~= 40MB of output. Before the 64KB read buffer and
		// direct-push fixes, this would freeze or OOM the process.
		const lineCount = 5_000_000;
		let chunkCount = 0;
		const start = Date.now();
		const result = await executeBash(`seq 1 ${lineCount}`, {
			cwd: tempDir,
			timeout: 30_000,
			onChunk: () => {
				chunkCount++;
			},
		});
		const elapsed = Date.now() - start;

		// Should complete, not hang or OOM
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);

		// Native execution may cap pathological streams before JavaScript sees every
		// generated line. Keep the regression contract strong enough to prove we
		// streamed a large bounded capture, not just a tiny non-empty placeholder.
		expect(result.totalLines).toBeGreaterThan(100_000);
		expect(result.totalBytes).toBeGreaterThan(DEFAULT_MAX_BYTES * 100);
		expect(result.truncated).toBe(true);

		// Direct executor output remains bounded by the shared head+tail window.
		expect(result.outputBytes).toBeLessThan(result.totalBytes);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + ARTIFACT_HEAD_BYTES_DEFAULT + 1024);

		// The visible numeric tail should stay near the end of the generated sequence.
		const tailValues = result.output
			.split("\n")
			.slice(-1000)
			.map(line => Number(line.trim()))
			.filter(Number.isFinite);
		expect(tailValues.some(value => value >= result.totalLines - 500 && value <= result.totalLines)).toBe(true);

		// With 64KB read buffer, ~40MB should produce ~600 chunks, not 5M.
		// Allow generous headroom but ensure it's orders of magnitude below lineCount.
		expect(chunkCount).toBeLessThan(lineCount / 100);

		// Should complete in reasonable time (not frozen). On a modern machine
		// seq 1 5000000 itself takes ~0.5s; with JS overhead allow 20s.
		expect(elapsed).toBeLessThan(20_000);
	}, 35_000);

	it("sources snapshot env vars across session commands", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);
		const sessionKey = "snapshot-test";
		await executeBash("true", { cwd: tempDir, timeout: 5000, sessionKey });
		const result = await executeBash("echo $PI_SNAPSHOT_TEST", { cwd: tempDir, timeout: 5000, sessionKey });
		expect(result.output.trim()).toBe("from_snapshot");
	});

	it("can disable shell snapshots", async () => {
		if (process.platform === "win32") {
			return;
		}
		const bashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(bashPath)) {
			return;
		}
		const snapshotPath = path.join(tempDir, "disabled-snapshot.sh");
		fs.writeFileSync(snapshotPath, "export PI_DISABLED_SNAPSHOT_TEST=from_snapshot\n");
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: Bun.env.HOME ?? tempDir,
			},
			prefix: undefined,
		});
		vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshotPath);

		const result = await executeBash("printenv PI_DISABLED_SNAPSHOT_TEST || printf unset", {
			cwd: tempDir,
			timeout: 5000,
			disableShellSnapshot: true,
			sessionKey: "disabled-snapshot-test",
		});
		expect(result.output.trim()).toBe("unset");
	});

	it("sources large bash functions without base64 eval wrappers", async () => {
		if (process.platform === "win32") {
			return;
		}
		const realBashPath = Bun.env.SHELL?.includes("bash") ? Bun.env.SHELL : "/bin/bash";
		if (!fs.existsSync(realBashPath)) {
			return;
		}

		const bashPath = path.join(tempDir, "test-bash");
		fs.symlinkSync(realBashPath, bashPath);
		const largeBody = Array.from({ length: 200 }, (_, index) => `    echo "snapshot ${index}"`).join("\n");
		fs.writeFileSync(path.join(tempDir, ".bashrc"), `pi_snapshot_large_function ()\n{\n${largeBody}\n}\n`);

		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: bashPath,
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir,
			},
			prefix: undefined,
		});

		const snapshotPath = await shellSnapshot.getOrCreateSnapshot(bashPath, {
			PATH: Bun.env.PATH ?? "",
			HOME: tempDir,
		});
		expect(snapshotPath).not.toBeNull();
		const snapshot = fs.readFileSync(snapshotPath!, "utf8");
		expect(snapshot).toContain("pi_snapshot_large_function");
		expect(snapshot).not.toContain("base64 -d");

		const result = await executeBash("printf 'snapshot_ok\\n'", {
			cwd: tempDir,
			timeout: 5000,
			sessionKey: "large-function-snapshot",
		});
		expect(result.cancelled).toBe(false);
		expect(result.output.trim()).toBe("snapshot_ok");
	});

	it("does not allow exec to replace the host", async () => {
		const result = await executeBash("exec echo hi", { cwd: tempDir, timeout: 5000 });
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).not.toBeUndefined();
		if (!result.output.includes("hi")) {
			expect(result.output.toLowerCase()).toContain("exec");
		}
	});

	it("completes even when background job keeps stdout pipe open", async () => {
		if (process.platform === "win32") return;

		const runPromise = executeBash("{ sleep 2; echo late; } & echo immediate", {
			cwd: tempDir,
			timeout: 5000,
		});
		const timed = await Promise.race([
			runPromise.then(result => ({ type: "result" as const, result })),
			Bun.sleep(BACKGROUND_COMPLETION_RACE_MS).then(() => ({ type: "timeout" as const })),
		]);

		expect(timed.type).toBe("result");
		if (timed.type === "result") {
			expect(timed.result.cancelled).toBe(false);
			expect(timed.result.exitCode).toBe(0);
			expect(timed.result.output).toContain("immediate");
		}
	});
	it("kills spawned process on timeout (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		// Command creates marker after a short delay, but we timeout before then.
		const result = await executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 100,
		});

		expect(result.cancelled).toBe(true);

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on timeout", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");

		const result = await executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 100,
			},
		);

		expect(result.cancelled).toBe(true);

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills background jobs on abort", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker-bg-abort.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		const promise = executeBash(
			`{ sleep ${KILL_MARKER_DELAY_SECONDS}; echo done > '${markerEscaped}'; } & sleep 10`,
			{
				cwd: tempDir,
				timeout: 10000,
				signal: controller.signal,
			},
		);

		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("kills spawned process on abort (not just orphans it)", async () => {
		if (process.platform === "win32") return;

		const marker = path.join(tempDir, "marker.txt");
		const markerEscaped = marker.replace(/'/g, "'\\''");
		const controller = new AbortController();

		// Command creates marker after a short delay.
		const promise = executeBash(`sleep ${KILL_MARKER_DELAY_SECONDS} && echo done > '${markerEscaped}'`, {
			cwd: tempDir,
			timeout: 10000,
			signal: controller.signal,
		});

		// Abort before the command can create the marker.
		await Bun.sleep(100);
		controller.abort();
		const result = await promise;

		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command cancelled");

		// Wait longer than the command would have needed to create the marker.
		await Bun.sleep(KILL_MARKER_ASSERTION_WAIT_MS);

		// If process was killed (not orphaned), marker should NOT exist
		expect(fs.existsSync(marker)).toBe(false);
	});
});
