import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { planTmuxOwnerIsolation } from "../src/gjc-runtime/tmux-owner-isolation";
import { resolveOwner } from "../src/harness-control-plane/owner";
import {
	createHarnessCliEnvWithFixtureBroker,
	type HarnessCliBrokerFixture,
} from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const sessionId = "tmux-owner-test";

let root: string;
let workspace: string;
let cliEnv: HarnessCliBrokerFixture;

async function createUnverifiableTmux(): Promise<{ command: string; log: string }> {
	const bin = path.join(root, "bin");
	const command = path.join(bin, "tmux");
	const log = path.join(root, "tmux.log");
	await mkdir(bin, { recursive: true });
	await writeFile(
		command,
		`#!/usr/bin/env bash
	echo "$@" >> ${JSON.stringify(log)}
	[ "${"$"}{1:-}" = "-L" ] || exit 9
	[ "${"$"}#" -ge 3 ] || exit 9
	case "${"$"}2" in ""|default) exit 9 ;; esac
	shift 2
	if [ "${"$"}1" = "display-message" ]; then
	  echo unexpected-probe-failure >&2
	  exit 9
	fi
	exit 99
	`,
	);
	await chmod(command, 0o755);
	return { command, log };
}

async function createScopedHarnessSeam(): Promise<{
	tmuxCommand: string;
	path: string;
	log: string;
	serverStateDir: string;
}> {
	const bin = path.join(root, "scoped-bin");
	const tmuxCommand = path.join(bin, "tmux");
	const serverStateDir = path.join(root, "scoped-servers");
	const log = path.join(root, "scoped-tmux.log");
	await mkdir(bin, { recursive: true });
	await mkdir(serverStateDir, { recursive: true });
	await writeFile(
		tmuxCommand,
		`#!/usr/bin/env bash
	printf '%s\\n' "$*" >> ${JSON.stringify(log)}
	[ "${"$"}{1:-}" = "-L" ] || exit 9
	[ "${"$"}#" -ge 3 ] || exit 9
	socket="${"$"}2"
	case "$socket" in ""|default) exit 9 ;; esac
	shift 2
	state=${JSON.stringify(serverStateDir)}/"$socket.pid"
	case "${"$"}{1:-}" in
	  display-message)
    if [ ! -f "$state" ] && [ "\${GJC_HARNESS_TEST_SWAP_SERVER:-}" = "1" ]; then sleep 2 & printf '%s\n' "$!" > "$state"; fi

	    if [ "\${GJC_HARNESS_TEST_SCOPED_REPLACE:-}" = "1" ] && [[ "${"$"}{!#}" == *'#{session_id}'*'#{session_name}'* ]] && [ ! -f "$state.swap" ]; then
	      [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
	      sleep 2 & printf '%s\n' "$!" > "$state"

	      : > "$state.swap"
	    fi
	    if [ -f "$state" ]; then
	      pid="$(cat "$state")"
	      if kill -0 "$pid" 2>/dev/null; then
	        if [[ "${"$"}{!#}" == *'#{session_id}'*'#{session_name}'* ]]; then
	          printf '%s\\t%s\n' '${"$"}1' 'gajae_code_harness_tmux-owner-test'
	        else
	          printf '%s\n' "$pid"
	        fi
	        exit 0
	      fi
	    fi
	    printf '%s\n' 'no server running on private test socket' >&2; exit 1 ;;
	  new-session)
	    [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
    command="${"$"}{!#}"
    bash -c "$command" >/dev/null 2>&1 &
    printf '%s\n' "$!" > "$state"
    native_receipt='$1'; printf '%s\n' "\${GJC_HARNESS_TEST_NATIVE_RECEIPT-$native_receipt}"
    exit 0 ;;
	  if-shell)
	    if [ "\${GJC_HARNESS_TEST_KILL_FAIL:-}" = "1" ]; then exit 1; fi
	    [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
	    printf '%s\n' '__gjc_harness_cleanup_ok__'
	    exit 0 ;;
	  kill-session)
	    if [ "\${GJC_HARNESS_TEST_KILL_FAIL:-}" = "1" ]; then exit 1; fi
	    [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
	    exit 0 ;;
	esac
	`,
	);
	await chmod(tmuxCommand, 0o755);
	await writeFile(
		path.join(bin, "systemd-run"),
		`#!/usr/bin/env bash
		request=""
		IFS= read -r request
		if [ "\${GJC_HARNESS_TEST_REPLACE_GENERATION:-}" = "1" ]; then
		  lifecycle="\${GJC_HARNESS_STATE_ROOT}/tmux-owner-test/owner-lifecycle"
		  mkdir -p "$lifecycle"
		  printf '%s\n' '{"schema_version":1,"generation":"replacement-generation","session_id":"tmux-owner-test","published_at":"2026-01-01T00:00:00.000Z"}' > "$lifecycle/generation.json"
		fi
		bun -e 'const request = JSON.parse(process.argv[1]); const created = Bun.spawnSync(request.tmux_argv, { stdout: "pipe", stderr: "pipe" }); if (created.exitCode !== 0) process.exit(created.exitCode ?? 1); if (process.env.GJC_HARNESS_TEST_BOOTSTRAP_RECEIPT !== undefined) { console.log(process.env.GJC_HARNESS_TEST_BOOTSTRAP_RECEIPT); process.exit(0); } const argv = request.tmux_argv; const socket = argv[argv.indexOf("-L") + 1]; const sessionName = argv[argv.indexOf("-s") + 1]; const proof = Bun.spawnSync([argv[0], "-L", socket, "display-message", "-p", "#{pid}"], { stdout: "pipe", stderr: "pipe" }); const serverPid = Number(proof.stdout.toString().trim()); const nativeSessionId = created.stdout.toString().trim(); if (!Number.isSafeInteger(serverPid) || serverPid <= 0 || !/^\\$\\d+$/.test(nativeSessionId)) process.exit(1); console.log(JSON.stringify({ schema_version: 1, ok: true, code: "bootstrapped", native_session_id: nativeSessionId, server_pid: serverPid, server_start_time: process.env.GJC_HARNESS_TEST_SERVER_START_TIME ?? "1", session_name: sessionName }));' -- "$request" || exit $?
		`,
	);
	await chmod(path.join(bin, "systemd-run"), 0o755);
	return { tmuxCommand, path: bin, log, serverStateDir };
}

async function runHarness(
	tmuxCommand: string,
	expectedExitCode = 0,
	env: NodeJS.ProcessEnv = {},
): Promise<Record<string, unknown>> {
	const proc = Bun.spawn(
		[
			"bun",
			cliEntry,
			"harness",
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId, detach: true }),
		],
		{
			cwd: workspace,
			env: {
				...cliEnv.env,
				GJC_HARNESS_STATE_ROOT: root,
				GJC_HARNESS_TEST_ASSUME_LINUX_OWNER_ISOLATION: "1",
				// The owner process must not inherit the test runner's ambient tmux client:
				// its startup title update would target that shared server instead of the
				// private -L socket exercised by this fixture.
				TMUX: "",
				GJC_TMUX_COMMAND: tmuxCommand,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [output, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== expectedExitCode) throw new Error(`harness exit ${exitCode}: ${stderr || output}`);
	return JSON.parse(output) as Record<string, unknown>;
}

const OWNER_EXIT_TIMEOUT_MS = 5_000;

async function retireLiveFixtureOwner(): Promise<void> {
	let owner = await resolveOwner(root, sessionId);
	if (!owner.live) return;
	const proc = Bun.spawn(["bun", cliEntry, "harness", "retire", "--session", sessionId], {
		cwd: workspace,
		env: {
			...cliEnv.env,
			GJC_HARNESS_STATE_ROOT: root,
			GJC_HARNESS_TEST_ASSUME_LINUX_OWNER_ISOLATION: "1",
			TMUX: "",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const retired = output.trim() ? (JSON.parse(output) as { evidence?: { retired?: unknown } }) : undefined;
	if (exitCode !== 0 || retired?.evidence?.retired !== true)
		throw new Error(`Fixture owner retirement failed: ${stderr || output}`);
	for (let i = 0; i < 100 && owner.live; i++) {
		await Bun.sleep(50);
		owner = await resolveOwner(root, sessionId);
	}
	if (owner.live)
		throw new Error(
			`Fixture owner remained live after ${OWNER_EXIT_TIMEOUT_MS}ms; preserving fixture roots for retry.`,
		);
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-tmux-owner-"));
	workspace = await mkdtemp(path.join(tmpdir(), "harness-tmux-workspace-"));
	cliEnv = await createHarnessCliEnvWithFixtureBroker(repoRoot, root);
});

afterEach(async () => {
	await retireLiveFixtureOwner();
	await cliEnv.cleanup();
	await rm(workspace, { recursive: true, force: true });
});

describe("HarnessCommand tmux-resident owner startup", () => {
	it("uses the canonical owner-isolation plan route for a safe tmux server", async () => {
		const argv = [
			"tmux-test",
			"-L",
			"private-test-socket",
			"new-session",
			"-d",
			"-s",
			"gajae_code_harness_tmux-owner-test",
			"-c",
			"/work",
			"owner",
		];
		const plan = await planTmuxOwnerIsolation(
			{
				schema_version: 1,
				op: "plan",
				platform: process.platform,
				session_id: sessionId,
				owner_generation: "generation",
				baseline: { state: "absent" },
				cwd: "/work",
				state_dir: "/state/owner-isolation",
				socket_key: "private-test-socket",
				tmux_argv: argv,
			},
			{
				readCallerCgroup: async () => null,
				probeServer: async () => ({ state: "safe", pid: 1, startTime: "1", cgroup: { classification: "safe" } }),
			},
		);

		const unsafePlan = await planTmuxOwnerIsolation(
			{
				schema_version: 1,
				op: "plan",
				platform: process.platform,
				session_id: sessionId,
				owner_generation: "generation",
				baseline: { state: "absent" },
				cwd: "/work",
				state_dir: "/state/owner-isolation",
				socket_key: "private-test-socket",
				tmux_argv: argv,
			},
			{
				readCallerCgroup: async () => null,
				probeServer: async () => ({ state: "unsafe" }),
			},
		);
		expect(unsafePlan).toMatchObject({ ok: false, code: "server_unsafe" });

		expect(plan).toMatchObject({ ok: true, code: "not_required", server_state: "safe" });
		if (plan.ok)
			expect(plan.execution).toMatchObject({
				mode: "direct",
				argv,
				attempt_session: "gajae_code_harness_tmux-owner-test",
				server_key: "private-test-socket",
				server_absent_before: false,
				server_pid: 1,
				server_start_time: "1",
			});
	});

	it("fails closed for an unknown nonzero tmux probe without dispatching new-session", async () => {
		const { command, log } = await createUnverifiableTmux();
		const result = await runHarness(command, 1);
		const evidence = result.evidence as Record<string, unknown>;

		expect(evidence.ownerRuntime).toBe("manual");
		expect(evidence.ownerFallbackReason).toBe("tmux-owner-server_unverifiable");
		expect(evidence.reason).toBe("tmux-owner-isolation-failed");
		expect(await readFile(log, "utf8")).toContain("display-message -p #{pid}");
		expect(await readFile(log, "utf8")).not.toContain("new-session");
		await expect(access(path.join(root, sessionId, "owner-lifecycle", "generation.json"))).rejects.toThrow();
	});

	it("proves a private tmux owner through the HarnessCommand path", async () => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 0, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "/\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		const evidence = result.evidence as Record<string, unknown>;
		const tmuxLog = await readFile(seam.log, "utf8");
		expect(evidence.ownerRuntime).toBe("tmux");
		expect(evidence.tmuxOwnerSocketKey).toBeUndefined();
		const calls = tmuxLog.trim().split("\n").filter(Boolean);
		const routedCalls = calls.filter(call => call !== "-V" && call !== "--version");
		expect(routedCalls).not.toHaveLength(0);
		const socket = routedCalls.map(call => call.match(/(?:^|\s)-L\s+(\S+)/)?.[1]).find(Boolean);
		expect(socket).toMatch(/^gjc-owner-[0-9a-f]{48}$/);
		expect(routedCalls.filter(call => !call.startsWith(`-L ${socket} `))).toEqual([]);
		expect(calls).toContain(`-L ${socket} display-message -p #{pid}`);
		expect(
			calls.some(call => call.startsWith(`-L ${socket} new-session -d -s gajae_code_harness_tmux-owner-test`)),
		).toBe(true);
		expect((result.state as Record<string, unknown>).ownerLive).toBe(true);
	});

	it.each([
		["noise before receipt", 'noise\n{"schema_version":1,"ok":true,"code":"bootstrapped"}'],
		["extra receipt key", '{"schema_version":1,"ok":true,"code":"bootstrapped","detail":"unexpected"}'],
		["missing receipt key", '{"schema_version":1,"ok":true}'],
		["malformed JSON", '{"schema_version":1,"ok":true,"code":'],
		["wrong receipt schema", '{"schema_version":2,"ok":true,"code":"bootstrapped"}'],
	])("rejects a scoped bootstrap receipt with %s", async (_description, receipt) => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "0::/user.slice/user-1.service\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			GJC_HARNESS_TEST_BOOTSTRAP_RECEIPT: receipt,
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		expect((result.evidence as Record<string, unknown>).ownerFallbackReason).toBe(
			"tmux-owner-scope_bootstrap_failed:tmux-owner-cleanup_uncertain",
		);
	});

	it.each([
		"",
		"$not-a-native-id\n",
		"$1\nnoise",
		"noise\n$1",
		"$1\n$2\n",
	])("rejects a direct creation receipt that is not one immutable native session id: %p", async nativeReceipt => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "/\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			GJC_HARNESS_TEST_NATIVE_RECEIPT: nativeReceipt,
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		expect((result.evidence as Record<string, unknown>).ownerFallbackReason).toBe(
			"tmux-owner-native_session_identity_unavailable:tmux-owner-cleanup_uncertain",
		);
	});

	it("refuses a pre-existing private server swap without mutating the replacement", async () => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_SWAP_SERVER: "1",
			GJC_HARNESS_TEST_CALLER_CGROUP: "/\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		const evidence = result.evidence as Record<string, unknown>;

		const calls = (await readFile(seam.log, "utf8")).trim().split("\n").filter(Boolean);
		expect(evidence.ownerRuntime).toBe("manual");
		expect(evidence.ownerFallbackReason).toBe("tmux-owner-server_race:tmux-owner-cleanup_uncertain");
		expect(calls.some(call => call.includes("kill-session"))).toBe(false);
	});

	it("fails a scoped same-name replacement race without name-based cleanup", async () => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_SCOPED_REPLACE: "1",
			GJC_HARNESS_TEST_CALLER_CGROUP: "0::/user.slice/user-1.service\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		const calls = (await readFile(seam.log, "utf8")).trim().split("\n").filter(Boolean);
		expect({ reason: (result.evidence as Record<string, unknown>).ownerFallbackReason, calls }).toMatchObject({
			reason: "tmux-owner-server_race:tmux-owner-cleanup_uncertain",
		});
		expect(calls.some(call => call.includes("kill-session"))).toBe(false);
	});

	it("rejects a scoped receipt whose server identity differs from the post-spawn proof", async () => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "0::/user.slice/user-1.service\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			GJC_HARNESS_TEST_BOOTSTRAP_RECEIPT:
				'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$1","server_pid":1,"server_start_time":"wrong","session_name":"gajae_code_harness_tmux-owner-test"}',
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		expect((result.evidence as Record<string, unknown>).ownerFallbackReason).toBe(
			"tmux-owner-receipt_server_mismatch",
		);
		expect(await readFile(seam.log, "utf8")).toContain("kill-session -t '$1'");
	});

	it("reports cleanup uncertainty when an exact cleanup kill fails", async () => {
		const seam = await createScopedHarnessSeam();
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "0::/user.slice/user-1.service\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			GJC_HARNESS_TEST_KILL_FAIL: "1",
			GJC_HARNESS_TEST_BOOTSTRAP_RECEIPT:
				'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$1","server_pid":1,"server_start_time":"wrong","session_name":"gajae_code_harness_tmux-owner-test"}',
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		expect((result.evidence as Record<string, unknown>).ownerFallbackReason).toBe(
			"tmux-owner-receipt_server_mismatch:tmux-owner-cleanup_uncertain",
		);
	});

	it("preserves a replacement generation when the staged launch becomes stale", async () => {
		const seam = await createScopedHarnessSeam();
		const lifecycle = path.join(root, sessionId, "owner-lifecycle");
		await mkdir(lifecycle, { recursive: true });
		await writeFile(
			path.join(lifecycle, "generation.json"),
			'{"schema_version":1,"generation":"prior-generation","session_id":"tmux-owner-test","published_at":"2026-01-01T00:00:00.000Z"}\n',
		);
		const result = await runHarness(seam.tmuxCommand, 1, {
			GJC_HARNESS_TEST_CALLER_CGROUP: "0::/user.slice/user-1.service\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/gjc-owner-test.scope\n",
			GJC_HARNESS_TEST_SERVER_START_TIME: "1",
			GJC_HARNESS_TEST_REPLACE_GENERATION: "1",
			PATH: `${seam.path}:${process.env.PATH ?? ""}`,
		});
		expect((result.evidence as Record<string, unknown>).ownerFallbackReason).toBe("tmux-owner-generation_stale");
		expect(await readFile(path.join(lifecycle, "generation.json"), "utf8")).toContain("replacement-generation");
		expect(await readFile(seam.log, "utf8")).toContain("kill-session -t '$1'");
	});

	it("preserves the direct detached-owner fallback when tmux is unavailable", async () => {
		const result = await runHarness(path.join(root, "missing-tmux"));
		const evidence = result.evidence as Record<string, unknown>;

		expect(evidence.ownerRuntime).toBe("detached");
		expect(evidence.ownerFallbackReason).toBe("tmux-unavailable");
		expect((result.state as Record<string, unknown>).ownerLive).toBe(true);
		await expect(access(path.join(root, sessionId, "owner-lifecycle", "generation.json"))).rejects.toThrow();
	});
	it("reaps the exact detached-owner child (no orphan) when it never becomes live", async () => {
		// missing-tmux routes to the direct detached-owner fallback; disabling SDK hosting makes the
		// spawned __owner child fail transport creation, so it never publishes a live lease. The
		// parent must not orphan that exact child: reap the PID it spawned and verify bounded exit
		// (exact-owner scoped, never a name-based broad kill, never a leftover daemon).
		const result = await runHarness(path.join(root, "missing-tmux"), 1, { GJC_SDK_DISABLE: "1" });
		const evidence = result.evidence as Record<string, unknown>;

		expect(evidence.ownerRuntime).toBe("detached");
		expect(evidence.ownerFallbackReason).toBe("tmux-unavailable");
		expect((result.state as Record<string, unknown>).ownerLive).toBe(false);
		const reaped = evidence.detachedOwnerReaped as { pid: number; verified: boolean };
		expect(reaped).toBeDefined();
		expect(Number.isSafeInteger(reaped.pid)).toBe(true);
		expect(reaped.pid).toBeGreaterThan(0);
		// `verified` derives from the child's authoritative exit promise (recycle-proof), proving
		// the exact spawned owner was reaped within the bounded grace before the parent returned.
		expect(reaped.verified).toBe(true);
	}, 60_000);
});
