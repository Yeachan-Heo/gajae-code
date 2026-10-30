import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const roots: string[] = [];
const sessions: Array<{ name: string; socket: string }> = [];
const createScript = path.join(import.meta.dir, "create.sh");
const postmortemScript = path.join(import.meta.dir, "postmortem.sh");
const harnessOwnerScript = path.join(import.meta.dir, "harness-tmux-owner-start.sh");

async function executable(file: string, content: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function worktree(root: string) {
	const dir = path.join(root, "worktree");
	await fs.mkdir(dir, { recursive: true });
	for (const command of [["git", "init"], ["git", "add", "."]]) {
		if (command[1] === "add") await Bun.write(path.join(dir, "README.md"), "fixture\n");
		expect(Bun.spawnSync(command, { cwd: dir }).exitCode).toBe(0);
	}
	expect(Bun.spawnSync(["git", "-c", "user.email=a@b.test", "-c", "user.name=Test", "commit", "-m", "fixture"], { cwd: dir }).exitCode).toBe(0);
	expect(Bun.spawnSync(["git", "checkout", "-b", "session-test"], { cwd: dir }).exitCode).toBe(0);
	return dir;
}

function env(overrides: Record<string, string>) {
	return { ...process.env, GJC_SESSION_MONITOR_DISABLE: "1", ...overrides };
}

async function fixture(root: string, mode = "direct", runner = "sleep 30") {
	const bin = path.join(root, "bin", "gjc");
	await executable(bin, `#!/usr/bin/env bash
set -euo pipefail
if [[ "${"$"}{1:-}" == --internal-tmux-owner-isolation ]]; then
  request=$(cat)
  if [[ -n "${"$"}{GJC_FIXTURE_ISOLATION_LOG:-}" ]]; then printf '%s\n' "$request" >>"${"$"}GJC_FIXTURE_ISOLATION_LOG"; fi
  python3 - "$request" "${mode}" "$0" <<'PY'
import json
import datetime
import os
import subprocess
import sys
request = json.loads(sys.argv[1])
mode = sys.argv[2]
bin_path = sys.argv[3]
if request["op"] == "publish_generation":
    generation_path = os.path.join(request["state_dir"], request["session_id"], "owner-lifecycle", "generation.json")
    if os.path.exists(generation_path):
        with open(generation_path, encoding="utf-8") as handle: current = {"state": "current", **json.load(handle)}
    else:
        current = {"state": "absent"}
    if current != request["baseline"]:
        raise SystemExit(6)
    published = {"schema_version":1,"generation":request["owner_generation"],"session_id":request["session_id"],"published_at":datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    temporary = f"{generation_path}.{os.getpid()}.tmp"
    with open(temporary, "x", encoding="utf-8") as handle: json.dump(published, handle, separators=(",", ":")); handle.write("\\n")
    os.replace(temporary, generation_path)
    print(json.dumps({"schema_version":1,"ok":True,"code":"generation_published","generation":request["owner_generation"]}, separators=(",", ":")))
elif request["op"] == "plan":
    execution = {"mode": "direct", "argv": request["tmux_argv"], "attempt_session": request["session_id"], "server_key": request["socket_key"], "server_absent_before": False}
    proof = subprocess.run([request["tmux_argv"][0], "-L", request["socket_key"], "display-message", "-p", "-t", f"={request['session_id']}:", "#{pid}\\t#{session_id}\\t#{session_name}"], text=True, capture_output=True, check=False)
    post_spawn = proof.returncode == 0

    if mode == "scoped" and not post_spawn:
        token = "123e4567-e89b-12d3-a456-426614174099"
        expected_scope = f"gjc-owner-{token}.scope"
        generation_path = os.path.join(request["state_dir"], request["session_id"], "owner-lifecycle", "generation.json")
        if os.path.exists(generation_path):
            with open(generation_path, encoding="utf-8") as handle: baseline = {"state": "current", **json.load(handle)}
        else:
            baseline = {"state": "absent"}
        attempt = {"token":token,"session_name":request["session_id"],"socket_key":request["socket_key"],"server_absent_before":True,"baseline":baseline,"expires_at":"2099-01-01T00:00:00.000Z"}
        with open(os.path.join(request["state_dir"], ".fixture-attempt.json"), "x", encoding="utf-8") as handle:
            json.dump(attempt, handle, separators=(",", ":"))
        bootstrap = {"schema_version":1,"op":"bootstrap","session_id":request["session_id"],"owner_generation":request["owner_generation"],"state_dir":request["state_dir"],"socket_key":request["socket_key"],"expected_scope":expected_scope,"tmux_argv":request["tmux_argv"],"attempt":attempt}
        stdin_line = json.dumps(bootstrap,separators=(",",":"))
        execution = {
            "mode": "scoped",
            "argv": ["systemd-run", "--user", "--scope", "--quiet", "--unit", expected_scope, bin_path, "--internal-tmux-owner-isolation"],
            "stdin_line": stdin_line,
            "expected_scope": expected_scope,
            "attempt": attempt,
            "attempt_session": request["session_id"],
            "server_key": request["socket_key"],
            "server_absent_before": True,
        }
    server_state = "absent" if mode == "scoped" and not post_spawn else "safe"
    classification = "unsafe_service" if mode == "scoped" and not post_spawn else "safe"
    code = "unsafe_scope_required" if mode == "scoped" and not post_spawn else "not_required"
    if post_spawn:
        receipt = proof.stdout.strip().split("\\t")
        server_pid, receipt_native_id, receipt_name = receipt
        with open(f"/proc/{server_pid}/stat", encoding="utf-8") as handle:
            server_start_time = handle.read().rsplit(")", 1)[1].strip().split()[19]
        server_start_time = os.environ.get("GJC_FIXTURE_POSTSPAWN_START_TIME", server_start_time)
        execution.update({"server_pid": int(server_pid), "server_start_time": server_start_time, "native_session_id": receipt_native_id, "attempt_session": receipt_name})
    print(json.dumps({"schema_version": 1, "ok": True, "code": code, "execution": execution, "server_state": server_state, "classification": {"classification": classification}}, separators=(",", ":")))
elif request["op"] == "bootstrap":
    attempt_path = os.path.join(request["state_dir"], ".fixture-attempt.json")
    with open(attempt_path, encoding="utf-8") as handle:
        persisted = json.load(handle)
    if persisted != request["attempt"]:
        raise SystemExit(3)
    generation_path = os.path.join(request["state_dir"], request["session_id"], "owner-lifecycle", "generation.json")
    if os.path.exists(generation_path):
        with open(generation_path, encoding="utf-8") as handle: current = {"state": "current", **json.load(handle)}
    else:
        current = {"state": "absent"}
    if current != request["attempt"]["baseline"]:
        raise SystemExit(4)
    os.unlink(attempt_path)
    if os.path.exists(generation_path):
        with open(generation_path, encoding="utf-8") as handle: current_after = {"state": "current", **json.load(handle)}
    else:
        current_after = {"state": "absent"}
    if current_after != request["attempt"]["baseline"]:
        raise SystemExit(5)
    launched = subprocess.run(request["tmux_argv"], text=True, capture_output=True, check=False)
    if launched.returncode != 0:
        raise SystemExit(launched.returncode)
    native_id = launched.stdout.strip()
    receipt = subprocess.run([request["tmux_argv"][0], "-L", request["socket_key"], "display-message", "-p", "-t", native_id, "#{pid}\\t#{session_id}\\t#{session_name}"], text=True, capture_output=True, check=True).stdout.strip().split("\\t")
    server_pid, receipt_native_id, session_name = receipt
    with open(f"/proc/{server_pid}/stat", encoding="utf-8") as handle:
        server_start_time = handle.read().rsplit(")", 1)[1].strip().split()[19]
    print(json.dumps({"schema_version":1,"ok":True,"code":"bootstrapped","native_session_id":receipt_native_id,"server_pid":int(server_pid),"server_start_time":server_start_time,"session_name":session_name}, separators=(",", ":")))
elif request["op"] == "observe_terminal":
    generation = request["owner_generation"]
    session = request["session_id"]
    dedupe = f"owner-loss:{session}:{generation}"
    verdict = {"schema_version":1,"generation":generation,"session_id":session,"server_key":request["socket_key"],"observed_at":request["observed_at"],"signal":request["signal"],"exit_code":request["exit_code"],"result":request["exit_kind"],"observer":request["observer"],"classification":"unexpected_owner_loss","reason":request["reason"],"dedupe_key":dedupe}
    root = os.path.join(request["state_dir"], session, "owner-lifecycle")
    with open(os.path.join(root, f"verdict-{generation}.json"), "w", encoding="utf-8") as handle: json.dump(verdict, handle, separators=(",", ":")); handle.write("\\n")
    incident = {"schema_version":1,"generation":generation,"session_id":session,"dedupe_key":dedupe,"created_at":request["observed_at"],"classification":"unexpected_owner_loss"}
    with open(os.path.join(root, f"incident-{generation}.json"), "w", encoding="utf-8") as handle: json.dump(incident, handle, separators=(",", ":")); handle.write("\\n")
    print(json.dumps(verdict, separators=(",", ":")))
else:
    raise SystemExit(2)
PY
  exit 0
fi
set +e
(
${runner}
)
runner_status=$?
sleep "${"$"}{GJC_SESSION_FIXTURE_HOLD_SECONDS:-1}"
exit "$runner_status"
`);
	return bin;
}

async function supervisorAdapter(root: string) {
	const bin = path.join(root, "bin", "gjc-supervisor-adapter");
	await executable(bin, `#!/usr/bin/env python3
import json
import os
import signal
import sys

if len(sys.argv) > 1 and sys.argv[1] == "--internal-tmux-owner-isolation":
    request = json.load(sys.stdin)
    session = os.environ["GJC_SESSION_NAME"]
    generation = os.environ["GJC_SESSION_OWNER_GENERATION"]
    server_key = os.environ["GJC_TMUX_OWNER_SERVER_KEY"]
    intent_path = os.path.join(os.environ["GJC_SESSION_STATE_DIR"], session, "owner-lifecycle", f"intent-{generation}.json")
    try:
        with open(intent_path, encoding="utf-8") as handle: intent_dispatch_id = json.load(handle).get("dispatch_id")
    except (OSError, ValueError, AttributeError):
        intent_dispatch_id = None
    record = {
        "operator_dispatch_id_present": isinstance(request.get("operator_dispatch_id"), str) and bool(request.get("operator_dispatch_id")),
        "operator_dispatch_id_matches_intent": request.get("operator_dispatch_id") == intent_dispatch_id,
        "matching_ids": request.get("session_id") == session and request.get("owner_generation") == generation and request.get("socket_key") == server_key,
        "expected_observation_classification": request.get("op") == "observe_terminal" and request.get("observer") == "raw_monitor" and request.get("signal") == "SIGTERM" and request.get("exit_kind") == "signal",
    }
    with open(os.environ["GJC_FIXTURE_SAFE_OBSERVATION_LOG"], "a", encoding="utf-8") as handle:
        json.dump(record, handle, separators=(",", ":")); handle.write("\\n")
    lifecycle = os.path.join(request["state_dir"], session, "owner-lifecycle")
    verdict = {"schema_version": 1, "generation": generation, "session_id": session, "server_key": server_key, "classification": "unexpected_owner_loss"}
    with open(os.path.join(lifecycle, f"verdict-{generation}.json"), "w", encoding="utf-8") as handle:
        json.dump(verdict, handle, separators=(",", ":")); handle.write("\\n")
    print(json.dumps(verdict, separators=(",", ":")))
    raise SystemExit(0)

open(os.environ["GJC_FIXTURE_RAW_READY"], "w", encoding="utf-8").close()
signal.signal(signal.SIGTERM, lambda _signum, _frame: raise_exit())
def raise_exit():
    raise SystemExit(0)
signal.pause()
`);
	return bin;
}

async function waitFor(file: string, timeout = 5000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await Bun.file(file).exists()) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${file}`);
}

afterEach(async () => {
	for (const { name, socket } of sessions.splice(0)) Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "pipe", stderr: "pipe" });
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("gjc-session create public owner lifecycle", () => {
	test("rejects missing binaries, directories, git worktrees, and detached branches", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-validation-")); roots.push(root);
		const legacyRoutingArgs = Bun.spawnSync(["bash", createScript, "x", root, "channel", "@mention"], { stderr: "pipe" });
		expect(legacyRoutingArgs.exitCode).toBe(2); expect(legacyRoutingArgs.stderr.toString()).toContain("<session-name> <worktree-path>");
		const missing = Bun.spawnSync(["bash", createScript, "x", root], { env: env({ GJC_BIN: "/definitely-not-a-gjc-executable" }), stderr: "pipe" });
		expect(missing.exitCode).toBe(1); expect(missing.stderr.toString()).toContain("gjc not found");
		const binary = await fixture(root);
		const nongit = Bun.spawnSync(["bash", createScript, "x", root], { env: env({ GJC_BIN: binary }), stderr: "pipe" });
		expect(nongit.exitCode).toBe(1); expect(nongit.stderr.toString()).toContain("not a git worktree");
		const absent = Bun.spawnSync(["bash", createScript, "x", path.join(root, "absent")], { env: env({ GJC_BIN: binary }), stderr: "pipe" });
		expect(absent.exitCode).toBe(1); expect(absent.stderr.toString()).toContain("directory not found");
		const detached = await worktree(path.join(root, "detached"));
		expect(Bun.spawnSync(["git", "checkout", "--detach"], { cwd: detached }).exitCode).toBe(0);
		const detachedResult = Bun.spawnSync(["bash", createScript, "detached", detached], { env: env({ GJC_BIN: binary }), stderr: "pipe" });
		expect(detachedResult.exitCode).toBe(1); expect(detachedResult.stderr.toString()).toContain("could not determine branch");
	});

	test("writes worktree baseline and public creation metadata before planning", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-metadata-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root);
		const name = `metadata-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
		const metadata = await Bun.file(path.join(state, "metadata.json")).json() as Record<string, unknown>;
		expect(metadata).toMatchObject({ session_id: name, workdir: dir, branch: "session-test", worktree_baseline_dirty: false });
		expect(await Bun.file(path.join(state, "creation-state.json")).json()).toMatchObject({ kind: "creation_started", session_id: name });
	});

	test("records an initially dirty worktree without claiming it as new recovery work", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-dirty-")); roots.push(root);
		const dir = await worktree(root); await Bun.write(path.join(dir, "README.md"), "dirty\n"); const state = path.join(root, "state"); const bin = await fixture(root);
		const name = `dirty-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
		expect(await Bun.file(path.join(state, "metadata.json")).json()).toMatchObject({ worktree_baseline_dirty: true });
	});

	test("accepts direct canonical plans, re-proves the isolated server, and tags the owner session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-direct-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const proofLog = path.join(root, "proof.log");
		const name = `direct-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
		const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_FIXTURE_ISOLATION_LOG: proofLog }), stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		expect(result.stdout.toString()).toContain(`created GJC session: ${name}`);
		expect(await Bun.file(path.join(state, "started.json")).json()).toMatchObject({ kind: "started", session_id: name });
		const generation = await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json() as Record<string, unknown>;
		expect(generation).toEqual({
			schema_version: 1,
			session_id: name,
			generation: expect.any(String),
			published_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
		});
		for (const [option, value] of [["@gjc-profile", "1"], ["@gjc-session-id", name], ["@gjc-session-state-file", path.join(state, "runtime-state.json")]] as const) {
			expect(Bun.spawnSync(["tmux", "-L", socket, "show-options", "-t", `=${name}:`, "-v", option], { stdout: "pipe" }).stdout.toString().trim()).toBe(value);
		}
		expect(Bun.spawnSync(["tmux", "-L", socket, "show-options", "-t", `=${name}:`, "-v", "@gjc-owner-generation"], { stdout: "pipe" }).stdout.toString().trim()).not.toBe("");
		expect(Bun.spawnSync(["tmux", "-L", socket, "show-options", "-t", `=${name}:`, "-v", "@gjc-owner-server-key"], { stdout: "pipe" }).stdout.toString().trim()).toBe(socket);
		const supervisor = await Bun.file(path.join(state, "supervisor.py")).text();
		expect(supervisor).toContain('signal.SIGTERM: "SIGTERM"');
		expect(supervisor).toContain('request["operator_dispatch_id"] = intent["dispatch_id"]');
		expect(supervisor).toContain("child.send_signal(signum)");
		expect(supervisor).toContain('isoformat(timespec="milliseconds")');
		expect(supervisor).toContain('canonical_path = os.path.join(lifecycle_dir, f"verdict-{generation}.json")');
		expect(supervisor).toContain("and verdict == canonical");
		expect(supervisor).toContain("gjc_session_publish_current_alias");
		expect(supervisor).not.toContain('verdict["owner_generation"] = generation');
		const planRequests = (await Bun.file(proofLog).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(planRequests.filter(request => request.op === "plan")).toHaveLength(2);
	});

	test("rejects a post-spawn server start-time mismatch before tagging or generation publication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-postspawn-start-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root);
		const name = `postspawn-start-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
		const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_FIXTURE_POSTSPAWN_START_TIME: "1" }), stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("post-spawn server proof rejected");
		expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `=${name}`], { stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
		const lifecycle = path.join(state, name, "owner-lifecycle");
		expect(await Bun.file(path.join(lifecycle, "generation.json")).exists()).toBe(false);
		expect((await fs.readdir(lifecycle)).some(file => file.startsWith("creation-failed-"))).toBe(true);
	});

	test("accepts scoped plans with exactly the owner bootstrap stdin line", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-scoped-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root, "scoped");
		const name = `scoped-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
		expect(await Bun.file(path.join(state, "started.json")).exists()).toBe(true);
	});

test("fails closed for malformed plans before creating an owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-invalid-plan-")); roots.push(root);
	const dir = await worktree(root); const bad = path.join(root, "bad-gjc"); const name = `invalid-plan-${Date.now()}`;
	await executable(bad, `#!/usr/bin/env python3
import json, os, sys
request = json.load(sys.stdin)
if request.get("op") == "publish_generation":
    target = os.path.join(request["state_dir"], request["session_id"], "owner-lifecycle", "generation.json")
    with open(target, "w", encoding="utf-8") as handle:
        json.dump({"schema_version":1,"generation":request["owner_generation"],"session_id":request["session_id"],"published_at":"2026-07-11T00:00:00.000Z"}, handle)
    print(json.dumps({"schema_version":1,"ok":True,"code":"generation_published","generation":request["owner_generation"]}))
else:
    print("{}")
`);
	const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bad }), stderr: "pipe" });
	expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("plan response rejected");
	expect(Bun.spawnSync(["tmux", "-L", `gjc-${name}`, "has-session", "-t", `=${name}`], { stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
});

	test("runner classifies terminal runtime completion as normal cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-completed-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state");
		const runner = `python3 - <<'PY'\nimport json, os\njson.dump({"session_id": os.environ["GJC_SESSION_NAME"], "cwd": os.environ["GJC_SESSION_WORKDIR"], "owner_generation": os.environ["GJC_SESSION_OWNER_GENERATION"], "state":"completed", "final_response":{"source":"agent_end"}}, open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w"))\nPY\nexit 0`;
		const bin = await fixture(root, "direct", runner); const name = `completed-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
		expect(await Bun.file(path.join(state, "final.json")).json()).toMatchObject({ owner_exit_reason: "terminal_runtime_cleanup", severity: "normal", runtime_terminal: true, runtime_terminal_state: "completed" });
	});

	test("runner ignores arbitrary runtime-state payload classifications", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-postmortem-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state");
		const hostile = "private runtime payload must never persist";
		const runner = `python3 - <<'PY'\nimport json, os\njson.dump({"session_id": os.environ["GJC_SESSION_NAME"], "cwd": os.environ["GJC_SESSION_WORKDIR"], "owner_generation": os.environ["GJC_SESSION_OWNER_GENERATION"], "state":"errored", "source":"${hostile}", "event":"${hostile}", "reason":"${hostile}", "previous_runtime_state":"${hostile}", "final_response":{"source":"${hostile}"}}, open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w"))\nPY\nexit 1`;
		const bin = await fixture(root, "direct", runner); const name = `postmortem-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
		const final = await Bun.file(path.join(state, "final.json")).text();
		expect(final).not.toContain(hostile);
		expect(JSON.parse(final)).toMatchObject({ owner_exit_reason: "terminal_runtime_cleanup", severity: "normal", runtime_terminal: true });
	});

test("runner ignores a stale prompt acceptance marker from another generation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-recovery-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); await fs.mkdir(state, { recursive: true });
	await Bun.write(path.join(state, "prompt-accepted.json"), JSON.stringify({ schema_version: 1, kind: "prompt_accepted", session_id: "other", owner_generation: "stale", worktreeBaselineDirty: false }));
	const bin = await fixture(root, "direct", "printf changed > README.md; exit 0"); const name = `recovery-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
	expect(await Bun.file(path.join(state, "final.json")).json()).toMatchObject({ owner_exit_reason: "owner_exited_before_prompt_acceptance", prompt_accepted: false, worktree_changed_since_baseline: true });
});

test("ships only human-visible tmux lifecycle helpers", async () => {
	const [create, postmortem, harnessOwner] = await Promise.all([
		Bun.file(createScript).text(),
		Bun.file(postmortemScript).text(),
		Bun.file(harnessOwnerScript).text(),
	]);
	expect(await Bun.file(path.join(import.meta.dir, "prompt.sh")).exists()).toBe(false);
	expect(await Bun.file(path.join(import.meta.dir, "tail.sh")).exists()).toBe(false);
	for (const forbidden of ["load-buffer", "paste-buffer", "send-keys", "capture-pane", "pipe-pane", "turnEvidence", "TURN_EVIDENCE", "pane-text"]) {
		expect(create).not.toContain(forbidden);
		expect(postmortem).not.toContain(forbidden);
		expect(harnessOwner).not.toContain(forbidden);
	}
	for (const forbidden of ["clawhip", "router", "GJC_SESSION_ROUTER", "GJC_SESSION_CHANNEL", "GJC_SESSION_KEYWORDS", "tmux watch", "--channel", "--mention", "--keywords"]) {
		expect(create).not.toContain(forbidden);
	}
	expect(create).toContain("Usage: $0 <session-name> <worktree-path>");
	expect(create).toContain('"op": "plan"');
	expect(create).toContain('"op":"observe_terminal"');
	expect(postmortem).toContain("gjc_session_write_public_marker");
	expect(harnessOwner).toContain("MACHINE_CONTROL=Coordinator MCP, ACP, or Gajae-Code SDK");
});

test("passes branch and coordinator identity to the raw owner without private lifecycle payloads", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-owner-env-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state");
	const runner = `python3 - <<'PY'
import json, os
json.dump({key: os.environ.get(key) for key in ["GJC_COORDINATOR_SESSION_ID", "GJC_COORDINATOR_SESSION_BRANCH", "GJC_COORDINATOR_SESSION_STATE_FILE", "GJC_SESSION_STATE_DIR"]}, open(os.path.join(os.environ["GJC_SESSION_STATE_DIR"], "owner-env.json"), "w"))
PY
sleep 2`;
	const bin = await fixture(root, "direct", runner); const name = `owner-env-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	await waitFor(path.join(state, "owner-env.json"));
	expect(await Bun.file(path.join(state, "owner-env.json")).json()).toEqual({ GJC_COORDINATOR_SESSION_ID: name, GJC_COORDINATOR_SESSION_BRANCH: "session-test", GJC_COORDINATOR_SESSION_STATE_FILE: path.join(state, "runtime-state.json"), GJC_SESSION_STATE_DIR: state });
});


test("records one generation-bound recovery only after a prior incident replacement is started", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-replacement-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root);
	const name = `replacement-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	await fs.mkdir(state, { recursive: true });
	await fs.mkdir(path.join(state, name, "owner-lifecycle"), { recursive: true });
	await Bun.write(path.join(state, name, "owner-lifecycle", "incident-prior-generation.json"), JSON.stringify({ schema_version: 1, session_id: name, generation: "prior-generation", dedupe_key: `owner-loss:${name}:prior-generation`, classification: "unexpected_owner_loss" }));
	await Bun.write(path.join(state, "incident.json"), JSON.stringify({ schema_version: 1, kind: "owner_incident", session_id: name, owner_generation: "prior-generation", incident_dedupe: `${name}:prior-generation` }));
	const created = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), stderr: "pipe" });
	if (created.exitCode !== 0) throw new Error(created.stderr.toString());
	const recovery = await Bun.file(path.join(state, "recovery.json")).json() as Record<string, string>;
	expect(recovery).toMatchObject({ kind: "owner_recovered", session_id: name, prior_owner_generation: "prior-generation", prior_incident_dedupe: `${name}:prior-generation` });
	expect(recovery.owner_generation).not.toBe("prior-generation");
});

test("reconciles an immediately replaced missing owner before publishing the next generation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-immediate-replace-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `immediate-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	const lifecycle = path.join(state, name, "owner-lifecycle"); const prior = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
	expect(Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", name], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
	const replacement = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), stdout: "pipe", stderr: "pipe" });
	if (replacement.exitCode !== 0) throw new Error(replacement.stderr.toString());
	const current = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
	expect(current).not.toBe(prior);
	expect(await Bun.file(path.join(lifecycle, `verdict-${prior}.json`)).json()).toMatchObject({ session_id: name, generation: prior, signal: expect.stringMatching(/^(SIGHUP|UNKNOWN)$/), classification: "unexpected_owner_loss" });
	expect(await Bun.file(path.join(lifecycle, `incident-${prior}.json`)).json()).toMatchObject({ session_id: name, generation: prior, dedupe_key: `owner-loss:${name}:${prior}` });
	expect(await Bun.file(path.join(lifecycle, `recovery-${current}.json`)).exists()).toBe(true);
	expect(await Bun.file(path.join(state, "recovery.json")).json()).toMatchObject({ owner_generation: current, prior_owner_generation: prior });
});

test("publishes one coherent generation-bound creation failure and removes stale completion aliases", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-failure-receipt-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const name = `failure-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	const bin = path.join(root, "bin", "gjc");
	await executable(bin, `#!/usr/bin/env python3
import datetime, json, os, sys
if "--internal-tmux-owner-isolation" not in sys.argv: raise SystemExit(0)
request = json.load(sys.stdin)
if request["op"] == "publish_generation":
 target = os.path.join(request["state_dir"], request["session_id"], "owner-lifecycle", "generation.json")
 published = {"schema_version":1,"generation":request["owner_generation"],"session_id":request["session_id"],"published_at":datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
 with open(target, "w", encoding="utf-8") as handle: json.dump(published, handle)
 print(json.dumps({"schema_version":1,"ok":True,"code":"generation_published","generation":request["owner_generation"]}))
 raise SystemExit(0)
if request["op"] != "plan": raise SystemExit(2)
if __import__("os").path.exists(__import__("os").environ["GJC_FIXTURE_POSTSPAWN"]): print("{}")
else:
 open(__import__("os").environ["GJC_FIXTURE_POSTSPAWN"], "w").close()
 print(json.dumps({"schema_version":1,"ok":True,"code":"not_required","execution":{"mode":"direct","argv":request["tmux_argv"],"attempt_session":request["session_id"],"server_key":request["socket_key"],"server_absent_before":False},"server_state":"safe","classification":{"classification":"safe"}}))
`);
	await fs.mkdir(state, { recursive: true });
	for (const alias of ["started.json", "prompt-accepted.json", "terminal.json", "final.json", "recovery.json"]) await Bun.write(path.join(state, alias), JSON.stringify({ schema_version: 1, session_id: name, owner_generation: "stale" }));
	const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_FIXTURE_POSTSPAWN: path.join(root, "postspawn") }), stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode).toBe(1);
	const lifecycle = path.join(state, name, "owner-lifecycle");
	const failureName = (await fs.readdir(lifecycle)).find(file => file.startsWith("creation-failed-"))!;
	const generation = failureName.slice("creation-failed-".length, -".json".length);
	const failed = await Bun.file(path.join(lifecycle, failureName)).json() as Record<string, unknown>;
	expect(failed).toMatchObject({ kind: "creation_failed", session_id: name, owner_generation: generation, boundary: "postspawn" });
	expect(await Bun.file(path.join(lifecycle, "generation.json")).exists()).toBe(false);
	expect(await Bun.file(path.join(state, "creation-state.json")).exists()).toBe(false);
	expect(await Bun.file(path.join(state, "metadata.json")).exists()).toBe(false);
	for (const alias of ["started.json", "prompt-accepted.json", "terminal.json", "final.json", "recovery.json"]) expect(await Bun.file(path.join(state, alias)).exists()).toBe(false);
});

test("retries a generation-bound failed create without synthesizing owner loss or recovery", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-failed-retry-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `failed-retry-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	const failingTmux = path.join(root, "tmux-fail");
	await executable(failingTmux, `#!/usr/bin/env bash\nfor arg in "$@"; do [[ "$arg" == new-session ]] && exit 23; done\nexec tmux "$@"\n`);
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_SESSION_TMUX_BIN: failingTmux }) }).exitCode).toBe(1);
	const lifecycle = path.join(state, name, "owner-lifecycle");
	const failureName = (await fs.readdir(lifecycle)).find(file => file.startsWith("creation-failed-"))!;
	const failedGeneration = failureName.slice("creation-failed-".length, -".json".length);
	expect(await Bun.file(path.join(lifecycle, failureName)).exists()).toBe(true);
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	expect(await Bun.file(path.join(lifecycle, `verdict-${failedGeneration}.json`)).exists()).toBe(false);
	expect(await Bun.file(path.join(lifecycle, `incident-${failedGeneration}.json`)).exists()).toBe(false);
	expect(await Bun.file(path.join(state, "recovery.json")).exists()).toBe(false);
});

test("does not recover an incident again in a third generation when a canonical recovery exists", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-third-recovery-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root);
	const name = `third-recovery-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` }); const lifecycle = path.join(state, name, "owner-lifecycle");
	await fs.mkdir(lifecycle, { recursive: true });
	await Bun.write(path.join(lifecycle, "incident-first.json"), JSON.stringify({ schema_version: 1, session_id: name, generation: "first", dedupe_key: `owner-loss:${name}:first`, classification: "unexpected_owner_loss" }));
	await Bun.write(path.join(state, "incident.json"), JSON.stringify({ schema_version: 1, kind: "owner_incident", session_id: name, owner_generation: "first", incident_dedupe: `${name}:first` }));
	await Bun.write(path.join(lifecycle, "recovery-second.json"), JSON.stringify({ schema_version: 1, kind: "owner_recovered", session_id: name, owner_generation: "second", prior_owner_generation: "first", prior_incident_dedupe: `${name}:first` }));
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	expect(await Bun.file(path.join(state, "recovery.json")).exists()).toBe(false);
	expect(await Bun.file(path.join(state, "incident.json")).exists()).toBe(false);
});

	test("does not accept a terminal runtime record from another session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-mismatch-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state");
		const runner = `python3 - <<'PY'\nimport json, os\njson.dump({"session_id":"other", "state":"completed"}, open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w"))\nPY\nexit 0`;
		const bin = await fixture(root, "direct", runner); const name = `mismatch-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
		expect(await Bun.file(path.join(state, "final.json")).json()).toMatchObject({ owner_exit_reason: "owner_exited_before_prompt_acceptance", runtime_terminal: false });
	});

	test("does not classify a stale terminal runtime receipt as a replacement generation cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-stale-runtime-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); await fs.mkdir(state, { recursive: true });
		const name = `stale-runtime-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		const runtime = path.join(state, "runtime-state.json"); await Bun.write(runtime, JSON.stringify({ session_id: name, state: "completed" }));
		await fs.utimes(runtime, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
		const bin = await fixture(root, "direct", "exit 0");
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
		expect(await Bun.file(path.join(state, "final.json")).json()).toMatchObject({ owner_exit_reason: "owner_exited_before_prompt_acceptance", runtime_terminal: false });
	});

	test("writes terminal lifecycle state even when the runner exits unsuccessfully", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-terminal-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root, "direct", "exit 23");
		const name = `terminal-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "terminal.json"));
		expect(await Bun.file(path.join(state, "terminal.json")).json()).toMatchObject({ kind: "terminal", session_id: name, exit_code: 23 });
		const generation = (await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string };
		const terminalAlias = await Bun.file(path.join(state, "terminal.json")).json();
		expect(await Bun.file(path.join(state, name, "owner-lifecycle", `terminal-${generation.generation}.json`)).json()).toEqual(terminalAlias);
		expect(await Bun.file(path.join(state, name, "owner-lifecycle", `final-${generation.generation}.json`)).exists()).toBe(true);
	});

	test("monitor consumes one absolute seven-second recovery budget across polling and publication", async () => {
		const create = await Bun.file(createScript).text();
		expect(create).toContain('last_seen_ms="$(date +%s%3N)"');
		expect(create).toContain('deadline_at_ms=$((last_seen_ms + 7000))');
		expect(create).toContain('timeout "${remaining_seconds}s" "$GJC_SESSION_GJC_BIN"');
		expect(create).toContain('within_recovery_deadline || exit 1');
		expect(create).not.toContain('deadline=$((SECONDS + 7))');
	});

	test("anchors recovery to the pre-probe timestamp and rejects a crossed publication deadline", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-monitor-deadline-"));
		roots.push(root);
		const source = await Bun.file(createScript).text();
		const monitorBody = /cat >"\$STATE_DIR\/monitor\.sh" <<'MONITOR'\n([\s\S]*?)\nMONITOR/.exec(source)?.[1];
		expect(monitorBody).toBeDefined();
		const monitor = path.join(root, "monitor.sh");
		await executable(monitor, `#!/usr/bin/env bash\n${monitorBody}`);
		const clockCount = path.join(root, "clock-count");
		await executable(
			path.join(root, "date"),
			`#!/usr/bin/env bash
if [[ "${"$"}1" == -u ]]; then printf '2026-07-11T00:00:00Z\\n'; exit 0; fi
count=0; [[ -f "${clockCount}" ]] && count="$(<"${clockCount}")"; count=$((count + 1)); printf '%s' "$count" >"${clockCount}"
case "$count" in 1) printf '1000\\n' ;; 2) printf '2000\\n' ;; *) printf '9001\\n' ;; esac
`,
		);
		await executable(path.join(root, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
		const probeCount = path.join(root, "probe-count");
		const tmux = path.join(root, "tmux");
		await executable(
			tmux,
			`#!/usr/bin/env bash
count=0; [[ -f "${probeCount}" ]] && count="$(<"${probeCount}")"; count=$((count + 1)); printf '%s' "$count" >"${probeCount}"
[[ "$count" -eq 1 ]] && exit 0
exit 1
`,
		);
		const adapter = path.join(root, "gjc");
		await executable(adapter, "#!/usr/bin/env bash\nprintf '{\"ok\":true}\\n'\n");
		const postmortem = path.join(root, "postmortem.sh");
		await executable(
			postmortem,
			`#!/usr/bin/env bash
gjc_session_publish_current_alias() { cp "$1" "$2"; }
gjc_session_validate_raw_verdict() { return 0; }
gjc_session_write_vanished_json() { : >"$1"; }
`,
		);
		const state = path.join(root, "state");
		const name = "deadline-session";
		const lifecycle = path.join(state, name, "owner-lifecycle");
		await fs.mkdir(lifecycle, { recursive: true });
		const result = Bun.spawnSync(["bash", monitor], {
			env: {
				...process.env,
				PATH: `${root}:${process.env.PATH}`,
				GJC_SESSION_MONITOR_INTERVAL: "1",
				GJC_SESSION_POSTMORTEM_SH: postmortem,
				GJC_SESSION_TMUX_BIN: tmux,
				GJC_SESSION_SOCKET_KEY: "private-socket",
				GJC_SESSION_NAME: name,
				GJC_SESSION_OWNER_GENERATION: "11111111-1111-4111-8111-111111111111",
				GJC_SESSION_STATE_DIR: state,
				GJC_SESSION_GJC_BIN: adapter,
				GJC_SESSION_VERDICT_CANONICAL_JSON: path.join(lifecycle, "verdict.json"),
				GJC_SESSION_GENERATION_JSON: path.join(lifecycle, "generation.json"),
				GJC_SESSION_VERDICT_JSON: path.join(state, "verdict.json"),
				GJC_SESSION_WORKDIR: root,
				GJC_SESSION_VANISHED_CANONICAL_JSON: path.join(lifecycle, "vanished.json"),
				GJC_SESSION_VANISHED_JSON: path.join(state, "vanished.json"),
				GJC_SESSION_INCIDENT_CANONICAL_JSON: path.join(lifecycle, "incident.json"),
				GJC_SESSION_INCIDENT_JSON: path.join(state, "incident.json"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(await Bun.file(path.join(state, "monitor-failure.json")).exists()).toBe(true);
		expect(await Bun.file(clockCount).text()).toBe("5");
	});

	test("monitor writes immutable verdict and incident markers after owner loss without claiming recovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-monitor-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root);
		const name = `monitor-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: { ...env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), GJC_SESSION_MONITOR_DISABLE: "0", GJC_SESSION_MONITOR_INTERVAL: "1" } }).exitCode).toBe(0);
		Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", name], { stdout: "pipe", stderr: "pipe" });
		await waitFor(path.join(state, "incident.json"), 8_000);
		expect(await Bun.file(path.join(state, "verdict.json")).json()).toMatchObject({ classification: "unexpected_owner_loss" });
		const incidentAlias = (await Bun.file(path.join(state, "incident.json")).json()) as { owner_generation: string; incident_dedupe: string };
		expect(incidentAlias.incident_dedupe).toBe(`${name}:${incidentAlias.owner_generation}`);
		expect(await Bun.file(path.join(state, "vanished.json")).json()).toMatchObject({ reason: "tmux_session_missing", phase: "owner_lost" });
		const generation = (await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string };
		expect(await Bun.file(path.join(state, name, "owner-lifecycle", `vanished-${generation.generation}.json`)).json()).toMatchObject({
			generation: generation.generation,
			dedupe_key: `owner-loss:${name}:${generation.generation}`,
		});
		expect(await Bun.file(path.join(state, "recovery.json")).exists()).toBe(false);
		const recovered = Bun.spawnSync(["bash", createScript, name, dir], {
			env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (recovered.exitCode !== 0) throw new Error(recovered.stderr.toString());
		expect(await Bun.file(path.join(state, "recovery.json")).json()).toMatchObject({
			kind: "owner_recovered",
			session_id: name,
			prior_owner_generation: generation.generation,
		});
		const recoveredGeneration = (await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string };
		expect(recoveredGeneration.generation).not.toBe(generation.generation);
		expect(await Bun.file(path.join(state, name, "owner-lifecycle", `metadata-${generation.generation}.json`)).exists()).toBe(true);
		expect(await Bun.file(path.join(state, name, "owner-lifecycle", `metadata-${recoveredGeneration.generation}.json`)).exists()).toBe(true);
		expect(await Bun.file(path.join(state, "metadata.json")).json()).toMatchObject({ owner_generation: recoveredGeneration.generation });
	}, 10_000);

test("serializes current aliases and refuses a stale generation overwrite", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-alias-generation-")); roots.push(root);
	const lifecycle = path.join(root, "session", "owner-lifecycle");
	await fs.mkdir(lifecycle, { recursive: true });
	const generationPath = path.join(lifecycle, "generation.json");
	const canonicalPath = path.join(lifecycle, "verdict-old.json");
	const aliasPath = path.join(root, "verdict.json");
	const currentAlias = { schema_version: 1, session_id: "session", generation: "current", owner_generation: "current" };
	await Bun.write(generationPath, JSON.stringify({ schema_version: 1, session_id: "session", generation: "current" }));
	await Bun.write(canonicalPath, JSON.stringify({ schema_version: 1, session_id: "session", generation: "old", classification: "unexpected_owner_loss" }));
	await Bun.write(aliasPath, JSON.stringify(currentAlias));
	const stale = Bun.spawnSync(
		[
			"bash",
			"-c",
			'source "$1"; gjc_session_publish_current_alias "$2" "$3" "$4" "$5" "$6"',
			"gjc-alias-test",
			postmortemScript,
			canonicalPath,
			aliasPath,
			generationPath,
			"session",
			"old",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(stale.exitCode).not.toBe(0);
	expect(await Bun.file(aliasPath).json()).toEqual(currentAlias);
});

test("keeps creation-cleanup and monitor failure canonicals immutable and rejects stale aliases", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-failure-publication-")); roots.push(root);
	const lifecycle = path.join(root, "session", "owner-lifecycle"); await fs.mkdir(lifecycle, { recursive: true });
	const generationPath = path.join(lifecycle, "generation.json"); const aliasPath = path.join(root, "creation-cleanup-failure.json");
	await Bun.write(generationPath, JSON.stringify({ schema_version: 1, session_id: "session", generation: "current" }));
	const canonicalPath = path.join(lifecycle, "creation-cleanup-failure-old.json"); const canonical = { schema_version: 1, kind: "creation_cleanup_failed", session_id: "session", owner_generation: "old", exit_code: 1, rollback_failures: [], failure_publication_failed: false };
	await Bun.write(canonicalPath, JSON.stringify(canonical)); await Bun.write(aliasPath, JSON.stringify({ ...canonical, owner_generation: "current" }));
	const stale = Bun.spawnSync(["bash", "-c", 'source "$1"; gjc_session_publish_current_alias "$2" "$3" "$4" "$5" "$6" creation_cleanup_failed', "gjc-cleanup-alias-test", postmortemScript, canonicalPath, aliasPath, generationPath, "session", "old"], { stdout: "pipe", stderr: "pipe" });
	expect(stale.exitCode).not.toBe(0);
	expect(await Bun.file(aliasPath).json()).toEqual({ ...canonical, owner_generation: "current" });
	const monitorCanonicalPath = path.join(lifecycle, "monitor-failure-old.json"); const monitorAliasPath = path.join(root, "monitor-failure.json");
	const monitorCanonical = { schema_version: 1, kind: "monitor_failure", session_id: "session", owner_generation: "old", reason: "observer_timeout_or_failure" };
	await Bun.write(monitorCanonicalPath, JSON.stringify(monitorCanonical)); await Bun.write(monitorAliasPath, JSON.stringify({ ...monitorCanonical, owner_generation: "current" }));
	const staleMonitor = Bun.spawnSync(["bash", "-c", 'source "$1"; gjc_session_publish_current_alias "$2" "$3" "$4" "$5" "$6" monitor_failure', "gjc-monitor-alias-test", postmortemScript, monitorCanonicalPath, monitorAliasPath, generationPath, "session", "old"], { stdout: "pipe", stderr: "pipe" });
	expect(staleMonitor.exitCode).not.toBe(0);
	expect(await Bun.file(monitorAliasPath).json()).toEqual({ ...monitorCanonical, owner_generation: "current" });
	const create = await Bun.file(createScript).text();
	expect(create).toContain('creation-cleanup-failure-$OWNER_GENERATION.json');
	expect(create).toContain('monitor-failure-$GJC_SESSION_OWNER_GENERATION.json');
	expect(create).toContain('os.link(temporary, canonical)');
	expect(create).toContain('gjc_session_publish_current_alias "$monitor_failure_canonical"');
});

test("keeps canonical generation receipts immutable while aliases publish the current generation", async () => {
	const [create, postmortem] = await Promise.all([Bun.file(createScript).text(), Bun.file(postmortemScript).text()]);
	expect(create).toContain('verdict-$OWNER_GENERATION.json');
	expect(create).toContain('incident-$OWNER_GENERATION.json');
	expect(create).toContain('recovery-$OWNER_GENERATION.json');
	expect(create).toContain("GJC_SESSION_GENERATION_JSON");
	expect(postmortem).toContain("gjc_session_publish_current_alias");
	expect(postmortem).toContain("os.link(temporary, path)");
});

test("rejects a non-UUID prior generation before reconciliation or alias publication", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-invalid-generation-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `invalid-generation-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	const lifecycle = path.join(state, name, "owner-lifecycle"); const generation = "not-a-canonical-uuid";
	await fs.mkdir(lifecycle, { recursive: true });
	await Bun.write(path.join(lifecycle, "generation.json"), JSON.stringify({ schema_version: 1, session_id: name, generation }));
	await Bun.write(path.join(lifecycle, `started-${generation}.json`), JSON.stringify({ schema_version: 1, kind: "started", session_id: name, owner_generation: generation }));
	const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("invalid existing generation lifecycle state");
	for (const alias of ["verdict.json", "incident.json", "vanished.json", "terminal.json", "final.json"]) expect(await Bun.file(path.join(state, alias)).exists()).toBe(false);
	for (const canonical of ["verdict", "incident", "vanished", "terminal", "final"]) expect(await Bun.file(path.join(lifecycle, `${canonical}-${generation}.json`)).exists()).toBe(false);
});

test("validates expected raw verdicts only against the matching consumed intent", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-consumed-intent-"));
	roots.push(root);
	const session = "session";
	const generation = "123e4567-e89b-42d3-a456-426614174000";
	const serverKey = "private-socket";
	const generationPath = path.join(root, "generation.json");
	const intentPath = path.join(root, `intent-${generation}.json`);
	const verdictPath = path.join(root, `verdict-${generation}.json`);
	const intent = {
		schema_version: 1,
		intent_id: "intent-id",
		generation,
		session_id: session,
		server_key: serverKey,
		expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
		dispatch_id: "dispatch-id",
		created_at: "2026-07-11T00:00:00.000Z",
		expires_at: "2026-07-11T00:00:01.000Z",
		state: "pending",
	};
	const verdict = {
		schema_version: 1,
		generation,
		session_id: session,
		server_key: serverKey,
		observed_at: "2026-07-11T00:00:00.100Z",
		signal: "SIGTERM",
		exit_code: null,
		result: "owner_term_then_session_cleanup",
		observer: "raw_monitor",
		classification: "expected_operator_shutdown",
		reason: "terminal_observation",
		intent_id: "intent-id",
		dedupe_key: `owner-loss:${session}:${generation}`,
	};
	await Bun.write(generationPath, JSON.stringify({ schema_version: 1, session_id: session, generation }));
	await Bun.write(`${intentPath}.consumed`, JSON.stringify(intent));
	await Bun.write(verdictPath, JSON.stringify(verdict));
	const validate = () =>
		Bun.spawnSync(
			[
				"bash",
				"-c",
				'source "$1"; gjc_session_validate_raw_verdict "$2" "$3" "$4" "$5" "$6" "$7"',
				"validate-consumed-intent",
				postmortemScript,
				verdictPath,
				generationPath,
				session,
				generation,
				serverKey,
				intentPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
	expect(validate().exitCode).toBe(0);
	await fs.rename(`${intentPath}.consumed`, intentPath);
	expect(validate().exitCode).not.toBe(0);
});

test("accepts only canonical UTC calendar timestamps for raw expected and unexpected verdicts", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-raw-verdict-timestamps-")); roots.push(root);
	const session = "timestamp-session", generation = "123e4567-e89b-42d3-a456-426614174000", serverKey = "private-socket";
	const generationPath = path.join(root, "generation.json"), intentPath = path.join(root, `intent-${generation}.json`), verdictPath = path.join(root, `verdict-${generation}.json`);
	const intent = { schema_version: 1, intent_id: "intent-id", generation, session_id: session, server_key: serverKey, expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" }, dispatch_id: "dispatch-id", created_at: "2026-07-11T00:00:00.000Z", expires_at: "2026-07-11T00:00:01.000Z", state: "pending" };
	const expected = { schema_version: 1, generation, session_id: session, server_key: serverKey, observed_at: "2026-07-11T00:00:00.100Z", signal: "SIGTERM", exit_code: null, result: "owner_term_then_session_cleanup", observer: "raw_monitor", classification: "expected_operator_shutdown", reason: "terminal_observation", intent_id: "intent-id", dedupe_key: `owner-loss:${session}:${generation}` };
	const unexpected = { schema_version: 1, generation, session_id: session, server_key: serverKey, observed_at: "2026-07-11T00:00:00.100Z", signal: "UNKNOWN", exit_code: null, result: "owner_lost", observer: "raw_monitor", classification: "unexpected_owner_loss", reason: "terminal_observation", dedupe_key: `owner-loss:${session}:${generation}` };
	await Bun.write(generationPath, JSON.stringify({ schema_version: 1, session_id: session, generation })); await Bun.write(`${intentPath}.consumed`, JSON.stringify(intent));
	const validate = () => Bun.spawnSync(["bash", "-c", 'source "$1"; gjc_session_validate_raw_verdict "$2" "$3" "$4" "$5" "$6" "$7"', "validate-raw-timestamp", postmortemScript, verdictPath, generationPath, session, generation, serverKey, intentPath], { stdout: "pipe", stderr: "pipe" });
	const cases: Array<[string, boolean]> = [["2026-07-11T00:00:00Z", true], ["2026-07-11T00:00:00.100Z", true], ["2026-07-11", false], ["2026-07-11T00:00:00", false], ["2026-07-11T00:00:00+00:00", false], ["2026-02-30T00:00:00Z", false], ["not-a-timestamp", false]];
	for (const verdict of [expected, unexpected]) for (const [observedAt, accepted] of cases) {
		await Bun.write(verdictPath, JSON.stringify({ ...verdict, observed_at: observedAt }));
		expect(validate().exitCode).toBe(accepted ? 0 : 1);
		if (!accepted) for (const alias of ["verdict.json", "incident.json", "vanished.json"]) expect(await Bun.file(path.join(root, alias)).exists()).toBe(false);
	}
});

test("forwards SIGTERM dispatch only for an exact live owner intent receipt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-supervisor-intent-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const setupBin = await fixture(root);
	const name = `intent-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: setupBin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	const generation = ((await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string }).generation;
	const adapter = await supervisorAdapter(root); const observationLog = path.join(root, "safe-observations.jsonl"); const ready = path.join(root, "raw-ready");
	const receipt = (overrides: Record<string, unknown> = {}) => ({
		schema_version: 1, intent_id: "intent-id", generation, session_id: name, server_key: socket,
		expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" }, dispatch_id: "dispatch-id",
		created_at: "2000-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", state: "pending", ...overrides,
	});
	const cases: Array<[string, Record<string, unknown>]> = [
		["exact", receipt()], ["extra", { ...receipt(), extra: true }], ["missing", (() => { const value: Record<string, unknown> = receipt(); delete value.intent_id; return value; })()],
		["session", receipt({ session_id: "other" })], ["generation", receipt({ generation: "other" })], ["server", receipt({ server_key: "other" })],
		["bad timestamp", receipt({ created_at: "not-a-timestamp" })], ["created null", receipt({ created_at: null })], ["created number", receipt({ created_at: 1 })],
		["expires null", receipt({ expires_at: null })], ["expires object", receipt({ expires_at: {} })], ["expired", receipt({ expires_at: "2000-01-01T00:00:00Z" })], ["future", receipt({ created_at: "2099-01-01T00:00:00Z" })],
		["state", receipt({ state: "completed" })], ["terminal", receipt({ expected_terminal: { signal: "SIGTERM", result: "other" } })],
	];
	for (const [, intent] of cases) {
		await Bun.write(path.join(state, name, "owner-lifecycle", `intent-${generation}.json`), JSON.stringify(intent));
		await fs.rm(ready, { force: true });
		const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: socket, GJC_SESSION_GJC_BIN: adapter, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: "/bin/true", GJC_FIXTURE_RAW_READY: ready, GJC_FIXTURE_SAFE_OBSERVATION_LOG: observationLog }, stdout: "pipe", stderr: "pipe" });
		await Promise.race([
			waitFor(ready),
			supervisor.exited.then(async exitCode => {
				const stderr = await new Response(supervisor.stderr).text();
				throw new Error(`supervisor exited before readiness (${exitCode}): ${stderr.trim()}`);
			}),
		]);
		expect(Bun.spawnSync(["kill", "-TERM", String(supervisor.pid)]).exitCode).toBe(0);
		expect(await supervisor.exited).toBe(0);
	}
	const observations = (await Bun.file(observationLog).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, boolean>);
	expect(observations).toHaveLength(cases.length);
	expect(observations.map(record => record.operator_dispatch_id_present)).toEqual([true, ...cases.slice(1).map(() => false)]);
	expect(observations.map(record => record.operator_dispatch_id_matches_intent)).toEqual([true, ...cases.slice(1).map(() => false)]);
	for (const record of observations) expect(record).toMatchObject({ matching_ids: true, expected_observation_classification: true });
}, 20_000);


test("records a nonzero terminal observer adapter failure while forwarding SIGTERM", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-supervisor-adapter-failure-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const setupBin = await fixture(root); const name = `adapter-failure-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: setupBin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	const generation = ((await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string }).generation;
	const adapter = path.join(root, "adapter-failure.py"), ready = path.join(root, "ready");
	await executable(adapter, `#!/usr/bin/env python3
import os, signal, sys
if "--internal-tmux-owner-isolation" in sys.argv: raise SystemExit(23)
open(os.environ["GJC_FIXTURE_RAW_READY"], "w").close()
signal.signal(signal.SIGTERM, lambda *_: raise_exit())
def raise_exit(): raise SystemExit(0)
signal.pause()
`);
	const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: adapter, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: "/bin/true", GJC_FIXTURE_RAW_READY: ready }, stdout: "pipe", stderr: "pipe" });
	await waitFor(ready);
	expect(Bun.spawnSync(["kill", "-TERM", String(supervisor.pid)]).exitCode).toBe(0);
	expect(await supervisor.exited).toBe(0);
	expect(await Bun.file(path.join(state, "supervisor-failure.json")).json()).toMatchObject({ kind: "supervisor_failure", session_id: name, owner_generation: generation });
});

test("records finalizer failure without replacing the owner exit status", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-finalizer-failure-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const setupBin = await fixture(root); const name = `finalizer-failure-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: setupBin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	const generation = ((await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string }).generation;
	const child = path.join(root, "owner-exit"), finalizer = path.join(root, "finalizer-fail");
	await executable(child, "#!/usr/bin/env bash\nexit 23\n");
	await executable(finalizer, "#!/usr/bin/env bash\nexit 24\n");
	const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: child, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: finalizer }, stdout: "pipe", stderr: "pipe" });
	expect(await supervisor.exited).toBe(23);
	expect(await Bun.file(path.join(state, "finalization-failure.json")).json()).toMatchObject({ kind: "finalization_failed", session_id: name, owner_generation: generation, owner_exit_code: 23, finalizer_exit_code: 24 });
});

test("records rollback failures and immutable collision faults", async () => {
	for (const kind of ["rollback", "probe", "canonical-collision"] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-creation-cleanup-${kind}-`)); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `creation-cleanup-${kind}-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		const tmux = path.join(root, "tmux-fault");
		await executable(tmux, `#!/usr/bin/env bash
if [[ "$*" == *"set-option"* ]]; then
  if [[ "${"$"}{GJC_FIXTURE_CLEANUP_KIND}" == canonical-collision ]]; then generation="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "${"$"}{GJC_FIXTURE_STATE}/${"$"}{GJC_FIXTURE_SESSION}/owner-lifecycle/generation.json")"; canonical="${"$"}{GJC_FIXTURE_STATE}/${"$"}{GJC_FIXTURE_SESSION}/owner-lifecycle/creation-cleanup-failure-${"$"}{generation}.json"; alias="${"$"}{GJC_FIXTURE_STATE}/creation-cleanup-failure.json"; printf '{"schema_version":1,"kind":"creation_cleanup_failed","session_id":"%s","owner_generation":"%s","exit_code":99,"rollback_failures":["owner_session"],"failure_publication_failed":false}\n' "${"$"}{GJC_FIXTURE_SESSION}" "${"$"}{generation}" >"${"$"}{canonical}"; printf '{"schema_version":1,"kind":"creation_cleanup_failed","session_id":"%s","owner_generation":"%s","exit_code":98,"rollback_failures":["owner_session"],"failure_publication_failed":false}\n' "${"$"}{GJC_FIXTURE_SESSION}" "${"$"}{generation}" >"${"$"}{alias}"; fi
  touch "${"$"}{GJC_FIXTURE_PROBE_MARKER}"
  exit 23
fi
if [[ ( "${"$"}{GJC_FIXTURE_CLEANUP_KIND}" == rollback || "${"$"}{GJC_FIXTURE_CLEANUP_KIND}" == canonical-collision ) && "$*" == *"kill-session"* ]]; then exit 24; fi
if [[ "${"$"}{GJC_FIXTURE_CLEANUP_KIND}" == probe && -e "${"$"}{GJC_FIXTURE_PROBE_MARKER}" && "$*" == *"if-shell"* ]]; then exit 25; fi
exec tmux "$@"
`);
		const created = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_SESSION_TMUX_BIN: tmux, GJC_FIXTURE_CLEANUP_KIND: kind, GJC_FIXTURE_STATE: state, GJC_FIXTURE_SESSION: name, GJC_FIXTURE_PROBE_MARKER: path.join(root, "rollback-probe") }), stdout: "pipe", stderr: "pipe" });
		expect(created.exitCode).not.toBe(0);
		const lifecycle = path.join(state, name, "owner-lifecycle");
		const cleanupName = (await fs.readdir(lifecycle)).find(file => file.startsWith("creation-cleanup-failure-") && file !== "creation-cleanup-failure-.json");
		if (!cleanupName) throw new Error(`missing cleanup receipt for ${kind}: ${created.stderr.toString()}`);
		const failure = await Bun.file(path.join(lifecycle, cleanupName!)).json() as Record<string, unknown>;
		expect(failure).toMatchObject({ kind: "creation_cleanup_failed", rollback_failures: ["owner_session_rollback_indeterminate"], failure_publication_failed: false });
		if (kind === "canonical-collision")
			expect(await Bun.file(path.join(state, "creation-cleanup-failure.json")).json()).toMatchObject({ owner_generation: "", rollback_failures: ["owner_session"] });
		else
			expect(await Bun.file(path.join(state, "creation-cleanup-failure.json")).exists()).toBe(false);
	}
});

test("refuses rollback after same-name replacement of the captured native owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-creation-replacement-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `creation-replacement-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	const tmux = path.join(root, "tmux-replacement");
	await executable(tmux, `#!/usr/bin/env bash
if [[ "$*" == *"set-option"* ]] && [[ ! -e "${"$"}{GJC_FIXTURE_REPLACED}" ]]; then
  touch "${"$"}{GJC_FIXTURE_REPLACED}"
  tmux -L "${"$"}{GJC_FIXTURE_SOCKET}" kill-session -t "=${"$"}{GJC_FIXTURE_SESSION}"
  tmux -L "${"$"}{GJC_FIXTURE_SOCKET}" new-session -d -s "${"$"}{GJC_FIXTURE_SESSION}" 'sleep 30'
  exit 23
fi
exec tmux "$@"
`);
	const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_SESSION_TMUX_BIN: tmux, GJC_FIXTURE_REPLACED: path.join(root, "replaced"), GJC_FIXTURE_SOCKET: socket, GJC_FIXTURE_SESSION: name }), stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode).toBe(1);
	expect(Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", `=${name}`], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
	const lifecycle = path.join(state, name, "owner-lifecycle");
	const cleanupName = (await fs.readdir(lifecycle)).find(file => file.startsWith("creation-cleanup-failure-"));
	expect(cleanupName).toBeDefined();
	const failure = await Bun.file(path.join(lifecycle, cleanupName!)).json() as Record<string, unknown>;
	expect(failure).toMatchObject({ kind: "creation_cleanup_failed", rollback_failures: ["owner_session_rollback_refused"] });
	expect(await Bun.file(path.join(state, "creation-cleanup-failure.json")).exists()).toBe(false);
});
test("holds stale publishers behind replacement creation and preserves every current alias", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-alias-transition-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `transition-${Date.now()}`; const socket = `gjc-${name}`; sessions.push({ name, socket });
	expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
	const lifecycle = path.join(state, name, "owner-lifecycle"); const oldGeneration = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
	expect(Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", name], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
	const release = path.join(root, "release"); const gate = path.join(root, "replacement-gate"); expect(Bun.spawnSync(["mkfifo", release]).exitCode).toBe(0);
	const tmux = path.join(root, "tmux-gate");
	await executable(tmux, `#!/usr/bin/env bash
if [[ "$*" == *"new-session"* ]]; then touch "${"$"}{GJC_FIXTURE_TRANSITION_GATE}"; read -r <"${"$"}{GJC_FIXTURE_TRANSITION_RELEASE}"; fi
exec tmux "$@"
`);
	const replacement = Bun.spawn(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state, GJC_SESSION_TMUX_BIN: tmux, GJC_FIXTURE_TRANSITION_GATE: gate, GJC_FIXTURE_TRANSITION_RELEASE: release }), stdout: "pipe", stderr: "pipe" });
	await waitFor(gate);
	const generationAtSpawn = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
	expect(generationAtSpawn).toBe(oldGeneration);
	const staleAliases: Record<string, Record<string, unknown>> = {
		"metadata.json": { schema_version: 1, session_id: name, owner_generation: oldGeneration },
		"creation-state.json": { schema_version: 1, kind: "creation_started", session_id: name, owner_generation: oldGeneration },
		"started.json": { schema_version: 1, kind: "started", session_id: name, owner_generation: oldGeneration },
	};
	for (const [alias, record] of Object.entries(staleAliases)) await Bun.write(path.join(state, alias), JSON.stringify(record));
	for (const [alias, record] of Object.entries(staleAliases)) {
		await Bun.write(path.join(lifecycle, `${alias.replace(".json", "")}-${oldGeneration}.json`), JSON.stringify(record));
	}
	const publisherStarted = path.join(root, "publisher-started"); const publisherDone = path.join(root, "publisher-done");
	const publisher = Bun.spawn(["bash", "-c", 'source "$1"; lifecycle="$2"; state="$3"; generation_path="$4"; session="$5"; generation="$6"; started="$7"; done_marker="$8"; touch "$started"; status=0; for pair in "metadata metadata.json" "creation-state creation-state.json" "started started.json"; do set -- $pair; gjc_session_publish_current_alias "$lifecycle/$1-$generation.json" "$state/$2" "$generation_path" "$session" "$generation" || status=1; done; touch "$done_marker"; exit "$status"', "publisher", postmortemScript, lifecycle, state, path.join(lifecycle, "generation.json"), name, oldGeneration, publisherStarted, publisherDone], { stdout: "pipe", stderr: "pipe" });
	await waitFor(publisherStarted);
	expect(await Bun.file(publisherDone).exists()).toBe(false);
	const releaseWriter = Bun.spawn(["bash", "-c", 'printf "release\\n" > "$1"', "release-writer", release], { stdout: "pipe", stderr: "pipe" });
	expect(await releaseWriter.exited).toBe(0);
	expect(await replacement.exited).toBe(0);
	const replacementGeneration = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
	expect(replacementGeneration).not.toBe(oldGeneration);
	expect(await publisher.exited).not.toBe(0);
	await waitFor(publisherDone);
	for (const alias of Object.keys(staleAliases)) {
		const current = await Bun.file(path.join(state, alias)).json() as Record<string, unknown>;
		expect(current.owner_generation).toBe(replacementGeneration);
	}
}, 20_000);

test("rejects a noncanonical prior generation before owner creation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-create-prestart-")); roots.push(root);
	const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `prestart-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
	const lifecycle = path.join(state, name, "owner-lifecycle"); await fs.mkdir(lifecycle, { recursive: true });
	await Bun.write(path.join(lifecycle, "generation.json"), JSON.stringify({ schema_version: 1, session_id: name, generation: "interrupted" }));
	const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), stderr: "pipe" });
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("generation baseline capture failed");
	expect(await Bun.file(path.join(lifecycle, "verdict-interrupted.json")).exists()).toBe(false);
	expect(await Bun.file(path.join(lifecycle, "incident-interrupted.json")).exists()).toBe(false);
});


test("fails closed and byte-preserves malformed, corrupt, or mismatched current generation state", async () => {
	for (const [label, body] of [
		["malformed", "{not json"],
		["invalid-utf8", Buffer.from([0x7b, 0x22, 0x67, 0x65, 0x6e, 0x22, 0x3a, 0xff, 0x7d])],
		["schema", JSON.stringify({ schema_version: 2, session_id: "placeholder", generation: "prior" })],
		["session", JSON.stringify({ schema_version: 1, session_id: "other", generation: "prior" })],
		["empty", JSON.stringify({ schema_version: 1, session_id: "placeholder", generation: "" })],
		["traversal", JSON.stringify({ schema_version: 1, session_id: "placeholder", generation: "../outside" })],
	] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-generation-${label}-`)); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `generation-${label}-${Date.now()}-${Math.random()}`; sessions.push({ name, socket: `gjc-${name}` });
		const lifecycle = path.join(state, name, "owner-lifecycle"); await fs.mkdir(lifecycle, { recursive: true });
		const bytes = typeof body === "string" && (label === "schema" || label === "empty" || label === "traversal") ? body.replace("placeholder", name) : body;
		const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		await Bun.write(path.join(lifecycle, "generation.json"), expected);
		const result = Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }), stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("invalid existing generation lifecycle state");
		expect(Buffer.compare(await fs.readFile(path.join(lifecycle, "generation.json")), expected)).toBe(0);
		expect((await fs.readdir(lifecycle)).sort()).toEqual(["generation.json", "generation.transition.lock"]);
	}
});

test("requires every terminal runtime identity receipt field", async () => {
	for (const missing of ["session_id", "cwd", "owner_generation"] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-runtime-${missing}-`)); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const name = `runtime-${missing}-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		const runner = `python3 - <<'PY'\nimport json, os\nrecord={"session_id":os.environ["GJC_SESSION_NAME"],"cwd":os.environ["GJC_SESSION_WORKDIR"],"owner_generation":os.environ["GJC_SESSION_OWNER_GENERATION"],"state":"completed"}\ndel record["${missing}"]\njson.dump(record, open(os.environ["GJC_COORDINATOR_SESSION_STATE_FILE"], "w"))\nPY\nexit 0`;
		const bin = await fixture(root, "direct", runner);
		Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }); await waitFor(path.join(state, "final.json"));
		expect(await Bun.file(path.join(state, "final.json")).json()).toMatchObject({ runtime_terminal: false, owner_exit_reason: "owner_exited_before_prompt_acceptance" });
	}
}, 20_000);

test("does not reconcile malformed or unknown canonical verdicts into incidents", async () => {
	for (const verdict of [
		{ schema_version: 1, generation: "prior", session_id: "placeholder", classification: "unexpected_owner_loss", dedupe_key: "bad" },
		{ schema_version: 1, generation: "prior", session_id: "placeholder", classification: "unknown", dedupe_key: "bad" },
		{ observed_at: "not-a-timestamp" },
	]) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-verdict-invalid-")); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const bin = await fixture(root); const name = `invalid-${Date.now()}-${Math.random()}`; sessions.push({ name, socket: `gjc-${name}` });
		const lifecycle = path.join(state, name, "owner-lifecycle"); await fs.mkdir(lifecycle, { recursive: true });
		await Bun.write(path.join(lifecycle, "generation.json"), JSON.stringify({ schema_version: 1, session_id: name, generation: "prior" }));
		await Bun.write(path.join(lifecycle, "started-prior.json"), JSON.stringify({ schema_version: 1, kind: "started", session_id: name, owner_generation: "prior" }));
		const storedVerdict = "observed_at" in verdict
			? { schema_version: 1, generation: "prior", session_id: name, server_key: `gjc-${name}`, observed_at: verdict.observed_at, signal: "UNKNOWN", exit_code: null, result: "owner_lost", observer: "replacement_reconciler", classification: "unexpected_owner_loss", reason: "tmux_session_missing", dedupe_key: `owner-loss:${name}:prior` }
			: { ...verdict, session_id: name, dedupe_key: verdict.classification === "unexpected_owner_loss" ? `owner-loss:${name}:prior` : verdict.dedupe_key };
		await Bun.write(path.join(lifecycle, "verdict-prior.json"), JSON.stringify(storedVerdict));
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: bin, GJC_SESSION_STATE_DIR: state }) }).exitCode).not.toBe(0);
		expect(await Bun.file(path.join(lifecycle, "incident-prior.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(state, "incident.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(lifecycle, "generation.json")).json()).toEqual({ schema_version: 1, session_id: name, generation: "prior" });
	}
});


test("keeps owner status while exposing injected supervisor and finalization receipt publication failures", async () => {
	for (const kind of ["supervisor_failure", "finalization_failure"] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-receipt-publication-${kind}-`)); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const setupBin = await fixture(root); const name = `receipt-${kind}-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: setupBin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
		const generation = ((await Bun.file(path.join(state, name, "owner-lifecycle", "generation.json")).json()) as { generation: string }).generation;
		const owner = path.join(root, "owner"), finalizer = path.join(root, "finalizer");
		if (kind === "supervisor_failure") {
			await executable(owner, `#!/usr/bin/env python3\nimport os, signal, sys\nif "--internal-tmux-owner-isolation" in sys.argv: raise SystemExit(23)\nopen(os.environ["GJC_FIXTURE_RAW_READY"], "w").close()\nsignal.signal(signal.SIGTERM, lambda *_: raise_exit())\ndef raise_exit(): raise SystemExit(0)\nsignal.pause()\n`);
			const ready = path.join(root, "ready"); const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: owner, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: "/bin/true", GJC_FIXTURE_RAW_READY: ready, GJC_SESSION_TEST_FAIL_RECEIPT_WRITE: kind }, stdout: "pipe", stderr: "pipe" });
			await waitFor(ready); expect(Bun.spawnSync(["kill", "-TERM", String(supervisor.pid)]).exitCode).toBe(0); expect(await supervisor.exited).toBe(0);
		} else {
			await executable(owner, "#!/usr/bin/env bash\nexit 23\n"); await executable(finalizer, "#!/usr/bin/env bash\nexit 24\n");
			const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: owner, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: finalizer, GJC_SESSION_TEST_FAIL_RECEIPT_WRITE: kind }, stdout: "pipe", stderr: "pipe" });
			expect(await supervisor.exited).toBe(23);
		}
		const publication = await Bun.file(path.join(state, name, "owner-lifecycle", `failure-publication-${generation}-${kind}.json`)).json() as Record<string, unknown>;
		expect(publication).toMatchObject({ kind: "failure_publication_failed", session_id: name, owner_generation: generation, boundary: kind });
		expect(await Bun.file(path.join(state, kind === "supervisor_failure" ? "supervisor-failure.json" : "finalization-failure.json")).exists()).toBe(false);
	}
}, 20_000);

test("keeps owner status while exposing canonical-collision and alias publication faults", async () => {
	for (const kind of ["supervisor_failure", "finalization_failure"] as const) for (const fault of ["canonical-collision", "alias"] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-receipt-${kind}-${fault}-`)); roots.push(root);
		const dir = await worktree(root); const state = path.join(root, "state"); const setupBin = await fixture(root); const name = `receipt-${kind}-${fault}-${Date.now()}`; sessions.push({ name, socket: `gjc-${name}` });
		expect(Bun.spawnSync(["bash", createScript, name, dir], { env: env({ GJC_BIN: setupBin, GJC_SESSION_STATE_DIR: state }) }).exitCode).toBe(0);
		const lifecycle = path.join(state, name, "owner-lifecycle"); const generation = ((await Bun.file(path.join(lifecycle, "generation.json")).json()) as { generation: string }).generation;
		const owner = path.join(root, "owner"); const finalizer = path.join(root, "finalizer");
		const canonical = path.join(lifecycle, `${kind === "supervisor_failure" ? "supervisor-failure" : "finalization-failure"}-${generation}.json`);
		if (fault === "canonical-collision") await Bun.write(canonical, JSON.stringify({ collision: true }));
		const injected = fault === "alias" ? `${kind}_alias` : undefined;
		const receiptKind = kind === "supervisor_failure" ? "supervisor_failure" : "finalization_failed";
		if (kind === "supervisor_failure") {
			await executable(owner, `#!/usr/bin/env python3\nimport os, signal, sys\nif "--internal-tmux-owner-isolation" in sys.argv: raise SystemExit(23)\nopen(os.environ["GJC_FIXTURE_RAW_READY"], "w").close()\nsignal.signal(signal.SIGTERM, lambda *_: raise_exit())\ndef raise_exit(): raise SystemExit(0)\nsignal.pause()\n`);
			const ready = path.join(root, "ready"); const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: owner, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: "/bin/true", GJC_FIXTURE_RAW_READY: ready, ...(injected ? { GJC_SESSION_TEST_FAIL_RECEIPT_WRITE: injected } : {}) }, stdout: "pipe", stderr: "pipe" });
			await waitFor(ready); expect(Bun.spawnSync(["kill", "-TERM", String(supervisor.pid)]).exitCode).toBe(0); expect(await supervisor.exited).toBe(0);
		} else {
			await executable(owner, "#!/usr/bin/env bash\nexit 23\n"); await executable(finalizer, "#!/usr/bin/env bash\nexit 24\n");
			const supervisor = Bun.spawn(["python3", path.join(state, "supervisor.py")], { env: { ...process.env, GJC_SESSION_NAME: name, GJC_SESSION_WORKDIR: dir, GJC_SESSION_STATE_DIR: state, GJC_SESSION_OWNER_GENERATION: generation, GJC_TMUX_OWNER_SERVER_KEY: `gjc-${name}`, GJC_SESSION_GJC_BIN: owner, GJC_SESSION_POSTMORTEM_SH: postmortemScript, GJC_SESSION_RUNNER_SH: finalizer, ...(injected ? { GJC_SESSION_TEST_FAIL_RECEIPT_WRITE: injected } : {}) }, stdout: "pipe", stderr: "pipe" });
			expect(await supervisor.exited).toBe(23);
		}
		const publication = await Bun.file(path.join(lifecycle, `failure-publication-${generation}-${kind}.json`)).json() as Record<string, unknown>;
		expect(publication).toMatchObject({ kind: "failure_publication_failed", session_id: name, owner_generation: generation, boundary: kind });
		if (fault === "canonical-collision") expect(await Bun.file(canonical).json()).toEqual({ collision: true });
		else expect(await Bun.file(canonical).json()).toMatchObject({ kind: receiptKind, session_id: name, owner_generation: generation });
		expect(await Bun.file(path.join(state, kind === "supervisor_failure" ? "supervisor-failure.json" : "finalization-failure.json")).exists()).toBe(false);
	}
}, 20_000);

});
