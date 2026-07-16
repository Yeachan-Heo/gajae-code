import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type PlanRequest, planTmuxOwnerIsolationSync } from "../../src/gjc-runtime/tmux-owner-isolation";
import { resolveOwner } from "../../src/harness-control-plane/owner";
import { createHarnessCliEnvWithFixtureBroker, type HarnessCliBrokerFixture } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const SID = "d";

function gitInit(dir: string): void {
	const run = (args: string[]): void => {
		const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
	};
	run(["init"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "Test"]);
	run(["commit", "--allow-empty", "-m", "init"]);
}

let root: string;
let workspace: string;
let tmuxCommand: string;

let cliEnv: HarnessCliBrokerFixture;

let sdkServer: ReturnType<typeof Bun.serve>;
let disableSdkHost = false;

async function startSdkFixture(): Promise<void> {
	sdkServer = Bun.serve<{ token: string }>({
		port: 0,
		fetch(req, server) {
			if (server.upgrade(req, { data: { token: "test-token" } })) return undefined;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ type: "hello", connectionId: "fixture" }));
			},
			message(ws, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				const id = frame.id as string;
				if (frame.type === "query_request") {
					const item =
						frame.query === "session.metadata"
							? { sessionId: SID, name: "Fixture", cwd: workspace, kind: "main" }
							: frame.query === "session.last_assistant"
								? { text: "" }
								: { usage: {}, isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
					ws.send(
						JSON.stringify({
							type: "query_response",
							id,
							ok: true,
							page: { items: [item], complete: true, revision: "1" },
						}),
					);
					return;
				}
				if (frame.type === "event_replay") {
					ws.send(
						JSON.stringify({ type: "event_replay_result", id, ok: true, events: [], generation: 1, lastSeq: 0 }),
					);
					return;
				}
				if (frame.type === "control_request") {
					ws.send(
						JSON.stringify({
							type: "control_response",
							id,
							ok: true,
							result: { commandId: "fixture-command", accepted: true },
						}),
					);
					for (const type of ["agent_start", "tool_execution_start", "agent_end"])
						ws.send(JSON.stringify({ type: "event", payload: { type } }));
				}
			},
		},
	});
	await mkdir(path.join(workspace, ".gjc", "state", "sdk"), { recursive: true });
	await writeFile(
		path.join(workspace, ".gjc", "state", "sdk", `${SID}.json`),
		JSON.stringify({ url: `ws://127.0.0.1:${sdkServer.port}`, token: "test-token" }),
	);
}

async function createFakeTmuxBin(rootDir: string, options: { skipOwnerLaunch?: boolean } = {}): Promise<string> {
	const binDir = path.join(rootDir, ".test-bin");
	const tmuxPath = path.join(binDir, "tmux");
	const logPath = path.join(rootDir, "tmux.log");
	const serverStateDir = path.join(rootDir, "tmux-servers");
	const lastServerStatePath = path.join(rootDir, "tmux-server.pid");
	await mkdir(binDir, { recursive: true });
	await mkdir(serverStateDir, { recursive: true });
	await Bun.write(
		tmuxPath,
		`#!/usr/bin/env bash
	echo "$@" >> ${JSON.stringify(logPath)}
	[ "${"$"}{1:-}" = "-L" ] || exit 9
	[ "${"$"}#" -ge 3 ] || exit 9
	socket="${"$"}2"
	case "$socket" in ""|default) exit 9 ;; esac
	shift 2
	state=${JSON.stringify(serverStateDir)}/"$socket.pid"
	case "${"$"}{1:-}" in
	  display-message|list-sessions)
	    if [ -f "$state" ]; then
	      server_pid="$(cat "$state")"
      if kill -0 "$server_pid" 2>/dev/null; then
        if [[ "${"$"}{!#}" == *'#{session_id}'*'#{session_name}'* ]]; then
          printf '%s\\t%s\n' '${"$"}1' 'gajae_code_harness_d'
        else
          printf '%s\n' "$server_pid"
        fi
        exit 0
      fi
    fi
    printf '%s\n' 'no server running on private test socket' >&2
	    exit 1
	    ;;
	  new-session)
	    cwd="$PWD"
	    for ((i=1; i<=${"$"}#; i++)); do
	      if [ "${"$"}{!i}" = "-c" ]; then
	        next=$((i + 1))
	        cwd="${"$"}{!next}"
	      fi
	    done
	    cmd="${"$"}{@: -1}"
    ${options.skipOwnerLaunch ? "sleep 2 >/dev/null 2>&1 &" : '(cd "$cwd" && bash -lc "$cmd") >/dev/null 2>&1 &'}

    printf '%s\n' "${"$"}!" > "$state"
    printf '%s\n' "${"$"}!" > ${JSON.stringify(lastServerStatePath)}
	    native_receipt='$1'; printf '%s\n' "\${GJC_HARNESS_TEST_NATIVE_RECEIPT-$native_receipt}"
	    exit 0
	    ;;
	  if-shell)
	    [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
	    printf '%s\n' '__gjc_harness_cleanup_ok__'
	    exit 0
	    ;;
	  kill-session)
	    [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null || true
	    exit 0
	    ;;
	  *)
	    exit 0
	    ;;
	esac
	`,
	);
	await chmod(tmuxPath, 0o755);
	return tmuxPath;
}

async function runHarness(
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; json: Record<string, unknown> | null }> {
	const proc = Bun.spawn(["bun", cliEntry, "harness", ...args], {
		cwd: workspace,
		env: {
			...cliEnv.env,
			GJC_HARNESS_STATE_ROOT: root,
			// The fake tmux server is a child of this test process, not a real systemd scope.
			// Keep normal lifecycle cases independent of the runner's caller cgroup; the scoped
			// bootstrap failure case below explicitly overrides this fixture value.
			GJC_HARNESS_TEST_CALLER_CGROUP: "/\n",
			GJC_HARNESS_TEST_SERVER_CGROUP: "/\n",

			GJC_TMUX_COMMAND: tmuxCommand,
			...(disableSdkHost ? { GJC_SDK_DISABLE: "1" } : {}),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(out.trim()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { code, json };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function retireLiveFixtureOwner(): Promise<void> {
	let owner = await resolveOwner(root, SID);
	if (!owner.live) return;
	const retired = await runHarness(["retire", "--session", SID]);
	if (retired.code !== 0 || (retired.json?.evidence as Record<string, unknown>).retired !== true)
		throw new Error("Fixture owner retirement failed; preserving fixture roots for retry.");
	for (let i = 0; i < 80 && owner.live; i++) {
		await sleep(50);
		owner = await resolveOwner(root, SID);
	}
	if (owner.live) throw new Error("Fixture owner remained live after retirement; preserving fixture roots for retry.");
}

beforeEach(async () => {
	// Short paths keep the AF_UNIX socket path under the sun_path limit.
	root = await mkdtemp(path.join(tmpdir(), "h"));
	workspace = await mkdtemp(path.join(tmpdir(), "hw"));
	cliEnv = await createHarnessCliEnvWithFixtureBroker(repoRoot, root);
	tmuxCommand = await createFakeTmuxBin(root);

	disableSdkHost = false;
	await startSdkFixture();
});

afterEach(async () => {
	try {
		await retireLiveFixtureOwner();
		sdkServer.stop(true);
		await cliEnv.cleanup();
		await rm(workspace, { recursive: true, force: true });
	} catch (error) {
		sdkServer.stop(true);
		throw error;
	}
});

describe.skipIf(process.platform !== "linux")("gjc harness start --detach (detached owner lifecycle, B1)", () => {
	it("spawns a tmux-resident owner; submit + finalize route to it cross-process; retire stops it", async () => {
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(0);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("tmux");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		const handle = evidence.handle as { viewportHandle?: { tmuxSessionName?: string | null } };
		expect(handle.viewportHandle?.tmuxSessionName).toBe(`gajae_code_harness_${SID}`);
		expect(evidence.tmuxOwnerSocketKey).toBeUndefined();
		const firstCalls = (await readFile(path.join(root, "tmux.log"), "utf8")).trim().split("\n").filter(Boolean);
		const firstRoutedCalls = firstCalls.filter(call => call !== "-V" && call !== "--version");
		const socket = firstRoutedCalls.map(call => call.match(/(?:^|\s)-L\s+(\S+)/)?.[1]).find(Boolean);
		expect(socket).toMatch(/^gjc-owner-[0-9a-f]{48}$/);
		const assertOnlyOwnerSocket = async (): Promise<void> => {
			const calls = (await readFile(path.join(root, "tmux.log"), "utf8"))
				.trim()
				.split("\n")
				.filter(call => Boolean(call) && call !== "-V" && call !== "--version");
			expect(calls).not.toHaveLength(0);
			expect(calls.filter(call => !call.startsWith(`-L ${socket} `))).toEqual([]);
		};
		await assertOnlyOwnerSocket();

		// A separate stateless CLI invocation re-grabs and drives the background session.
		const promptPath = path.join(workspace, "prompt.txt");
		await writeFile(promptPath, "go", "utf8");
		const sub = await runHarness(["submit", "--session", SID, "--prompt-file", promptPath]);
		expect((sub.json?.evidence as Record<string, unknown>).accepted).toBe(true);
		expect((sub.json?.state as Record<string, unknown>).lifecycle).toBe("observing");
		await assertOnlyOwnerSocket();

		// AC-9: the detached owner maps the real RPC frame stream -> observe surfaces tool-call -> completed.
		let signals: string[] = [];
		for (let i = 0; i < 40; i++) {
			const o = await runHarness(["observe", "--session", SID]);
			signals =
				((o.json?.evidence as Record<string, unknown>)?.observation as { observedSignals?: string[] })
					?.observedSignals ?? [];
			if (signals.includes("completed")) break;
			await sleep(50);
		}
		expect(signals).toContain("tool-call");
		expect(signals).toContain("completed");

		// Owner-backed finalize: the evidence gate HONESTLY refuses without real commit/PR/tests
		// (no fake completion evidence in shipped code).
		const fin = await runHarness(["finalize", "--session", SID]);
		const finEvidence = (fin.json?.evidence as Record<string, unknown>).finalize as Record<string, unknown>;
		expect(finEvidence).toBeTruthy();
		expect(finEvidence.completed).toBe(false);
		expect((finEvidence.blockers as unknown[]).length).toBeGreaterThan(0);

		// Retire stops the owner and releases the lease.
		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
		await assertOnlyOwnerSocket();

		let after = await resolveOwner(root, SID);
		for (let i = 0; i < 80 && after.live; i++) {
			await sleep(50);
			after = await resolveOwner(root, SID);
		}
		expect(after.live).toBe(false);
	}, 60_000);

	it("blocks without a detached fallback when tmux starts but never routes the owner", async () => {
		tmuxCommand = await createFakeTmuxBin(root, { skipOwnerLaunch: true });
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(1);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("manual");
		expect(evidence.ownerFallbackReason).toBe(
			"tmux new-session owner endpoint not routable; exact cleanup or reconciliation uncertain",
		);
		expect(evidence.reason).toBe("tmux-owner-endpoint-cleanup-uncertain");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(false);
		expect((started.json?.state as Record<string, unknown>).blockers).toContain(
			"tmux-owner-endpoint-cleanup-uncertain",
		);
		const lifecycle = path.join(root, SID, "owner-lifecycle");
		const generation = (await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string };
		expect(await Bun.file(path.join(lifecycle, `verdict-${generation.generation}.json`)).exists()).toBe(false);
	}, 60_000);

	it("reports blocked only after detached owner endpoint remains unavailable", async () => {
		tmuxCommand = path.join(root, "missing-tmux");
		disableSdkHost = true;
		await rm(path.join(workspace, ".gjc", "state", "sdk", `${SID}.json`), { force: true });
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true }),
		]);
		expect(started.code).toBe(1);
		expect(started.json?.ok).toBe(false);
		const state = started.json?.state as Record<string, unknown>;
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(state.lifecycle).toBe("blocked");
		expect(state.ownerLive).toBe(false);
		expect(state.blockers).toContain("detached-owner-not-live");
		expect(evidence.ownerRuntime).toBe("detached");
		expect(evidence.reason).toBe("detached-owner-not-live");

		const submit = await runHarness(["submit", "--session", SID, "--input", JSON.stringify({ prompt: "go" })]);
		expect(submit.code).toBe(1);
		expect(submit.json?.ok).toBe(false);
		expect((submit.json?.state as Record<string, unknown>).ownerLive).toBe(false);
		expect((submit.json?.evidence as Record<string, unknown>).accepted).toBe(false);
		expect((submit.json?.evidence as Record<string, unknown>).reason).toBe("owner-not-live");
		expect(submit.json?.nextAllowedActions).toContainEqual({
			verb: "submit",
			available: false,
			reason: "lifecycle-blocked",
		});
	}, 60_000);
	it("fails closed without detached fallback when scoped bootstrap fails", async () => {
		const systemdRun = path.join(root, ".test-bin", "systemd-run");
		await writeFile(systemdRun, "#!/usr/bin/env bash\nexit 9\n", "utf8");
		await chmod(systemdRun, 0o755);
		const started = await runHarness(
			["start", "--input", JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID, detach: true })],
			{
				GJC_HARNESS_TEST_CALLER_CGROUP: "/system.slice/caller.service\n",
				PATH: `${path.dirname(systemdRun)}:${process.env.PATH ?? ""}`,
			},
		);
		expect(started.code).toBe(1);
		const evidence = started.json?.evidence as Record<string, unknown>;
		expect(evidence.ownerRuntime).toBe("manual");
		expect(evidence.ownerFallbackReason).toBe("tmux-owner-scope_bootstrap_failed:tmux-owner-cleanup_uncertain");
		expect(evidence.reason).toBe("tmux-owner-isolation-failed");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(false);
	}, 60_000);
	it("recover bootstraps an owner for a started session whose owner was never spawned (#421)", async () => {
		gitInit(workspace);
		// start WITHOUT --detach persists a `started` session with no owner lease/endpoint.
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID }),
		]);
		expect(started.code).toBe(0);
		expect((started.json?.state as Record<string, unknown>).lifecycle).toBe("started");
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(false);
		expect((started.json?.evidence as Record<string, unknown>).ownerRuntime).toBe("manual");

		// recover must bootstrap a fresh owner instead of deadlocking on the missing prior endpoint.
		const recovered = await runHarness(["recover", "--session", SID]);
		expect(recovered.code).toBe(0);
		const evidence = recovered.json?.evidence as Record<string, unknown>;
		expect(evidence.bootstrappedOwner).toBe(true);
		expect(evidence.restoredOwner).toBeUndefined();
		expect(evidence.vanishReceiptId).toBeUndefined();
		expect((recovered.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		expect((recovered.json?.state as Record<string, unknown>).lifecycle).toBe("observing");

		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
	}, 60_000);
	it("recover bootstraps a never-started owner even when the workspace is not a git repo (#421)", async () => {
		// No gitInit: a bare workspace reports git delta `unknown`, so the vanish classifier
		// returns `human-check` / `ownerRequired: false`. Bootstrap must not be gated on that.
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID }),
		]);
		expect(started.code).toBe(0);
		expect((started.json?.state as Record<string, unknown>).lifecycle).toBe("started");

		const recovered = await runHarness(["recover", "--session", SID]);
		expect(recovered.code).toBe(0);
		const evidence = recovered.json?.evidence as Record<string, unknown>;
		expect(evidence.bootstrappedOwner).toBe(true);
		expect(evidence.vanishReceiptId).toBeUndefined();
		expect((evidence.decision as Record<string, unknown>).ownerRequired).toBe(false);
		expect((recovered.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		expect((recovered.json?.state as Record<string, unknown>).lifecycle).toBe("observing");

		const ret = await runHarness(["retire", "--session", SID]);
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
	}, 60_000);
	it("recover bootstraps a never-started owner in a dirty worktree without a vanish receipt and preserves the delta (#421)", async () => {
		gitInit(workspace);
		// Pre-existing uncommitted work makes the git delta `dirty` (classifier:
		// restart-preserve-delta, ownerRequired:true). A never-started owner never touched this
		// work, so bootstrapping it is by-design NOT a vanish — no receipt, no stash/reset.
		const dirtyFile = path.join(workspace, "uncommitted.txt");
		await writeFile(dirtyFile, "user-work", "utf8");

		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ harness: "gajae-code", workspace, sessionId: SID }),
		]);
		expect(started.code).toBe(0);
		expect((started.json?.state as Record<string, unknown>).lifecycle).toBe("started");

		const recovered = await runHarness(["recover", "--session", SID]);
		expect(recovered.code).toBe(0);
		const evidence = recovered.json?.evidence as Record<string, unknown>;
		expect(evidence.bootstrappedOwner).toBe(true);
		// By design: a never-started owner is not a vanish, so no vanish receipt is written
		// even though the worktree is dirty.
		expect(evidence.vanishReceiptId).toBeUndefined();
		const decision = evidence.decision as Record<string, unknown>;
		expect(decision.classification).toBe("restart-preserve-delta");
		expect(decision.ownerRequired).toBe(true);
		expect((evidence.observation as Record<string, unknown>).gitDelta).toBe("dirty");
		expect((recovered.json?.state as Record<string, unknown>).ownerLive).toBe(true);
		expect((recovered.json?.state as Record<string, unknown>).lifecycle).toBe("observing");
		// The pre-existing uncommitted work is left untouched (never stashed or reset).
		expect(await readFile(dirtyFile, "utf8")).toBe("user-work");

		const ret = await runHarness(["retire", "--session", SID]);
		// retire routes to the live owner, which stops cleanly without mutating the worktree.
		expect((ret.json?.evidence as Record<string, unknown>).retired).toBe(true);
		expect(await readFile(dirtyFile, "utf8")).toBe("user-work");
	}, 60_000);
});

describe("portable detached-owner isolation seams", () => {
	const nonLinuxPlan: PlanRequest = {
		schema_version: 1,
		op: "plan",
		platform: "darwin" as NodeJS.Platform,
		session_id: "session",
		owner_generation: "generation",
		baseline: { state: "absent" },
		cwd: "/portable",
		state_dir: "/portable/state",
		socket_key: "private-socket",
		tmux_argv: ["tmux", "new-session", "-d", "-s", "gajae_code_session"],
	};

	it("accepts explicit non-Linux not_applicable proof without cgroup or systemd access", () => {
		const result = planTmuxOwnerIsolationSync(nonLinuxPlan, {
			readCallerCgroup: () => {
				throw new Error("non-Linux must not read /proc");
			},
			probeServer: () => ({
				state: "safe",
				pid: 1,
				startTime: "not_applicable",
				cgroup: { classification: "not_applicable" },
			}),
			recordAttempt: () => {
				throw new Error("non-Linux must not bootstrap systemd");
			},
		});
		expect(result).toMatchObject({
			ok: true,
			code: "not_required",
			server_state: "safe",
			classification: { classification: "not_applicable" },
		});
	});

	it("refuses non-Linux detached ownership without explicit not_applicable server proof", () => {
		const result = planTmuxOwnerIsolationSync(nonLinuxPlan, {
			readCallerCgroup: () => {
				throw new Error("non-Linux must not read /proc");
			},
			probeServer: () => ({ state: "unverifiable" }),
			recordAttempt: () => {
				throw new Error("non-Linux must not bootstrap systemd");
			},
		});
		expect(result).toMatchObject({ ok: false, code: "server_unverifiable" });
	});
});
