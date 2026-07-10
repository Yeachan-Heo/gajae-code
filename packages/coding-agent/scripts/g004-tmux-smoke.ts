// G004 real-tmux smoke: exercises forceCloseGjcTmuxSession refusal boundaries
// against live tmux sessions. Generation-bound successful TERM/verdict/cleanup is
// covered by the issue evidence harness; this smoke proves incomplete and non-GJC
// live owners are never hard-killed.
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	resolveGjcTmuxCommand,
} from "../src/gjc-runtime/tmux-common";
import { forceCloseGjcTmuxSession, removeGjcTmuxSession, statusGjcTmuxSession } from "../src/gjc-runtime/tmux-sessions";

const runId = randomUUID().slice(0, 8);
const suffix = `${process.pid}-${runId}`;
const privateTmpdir = mkdtempSync(path.join(tmpdir(), "g4-"));
chmodSync(privateTmpdir, 0o700);
const socket = `g4-${runId}`;
const wrapper = path.join(privateTmpdir, "tmux-private.sh");
const scopeUnit = `gjc-g004-${suffix}.scope`;
const tmuxBootstrapEnv: NodeJS.ProcessEnv = {
	...process.env,
	TMUX: "",
	TMUX_PANE: "",
	TMUX_TMPDIR: privateTmpdir,
};
const tmuxBinary = resolveGjcTmuxCommand(tmuxBootstrapEnv);
const privateEnv: NodeJS.ProcessEnv = {
	...tmuxBootstrapEnv,
	GJC_TMUX_COMMAND: wrapper,
};
let scopeRunner: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bounded(value: string): string {
	return value.trim().slice(0, 512) || "no diagnostic";
}

function sh(args: string[]): { code: number; out: string; err: string } {
	try {
		const r = Bun.spawnSync([wrapper, ...args], { env: privateEnv, stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
	} catch (error) {
		return { code: -1, out: "", err: bounded(String(error)) };
	}
}

function makeRawSession(name: string): void {
	const r = sh(["new-session", "-d", "-s", name, "sleep 600"]);
	if (r.code !== 0) throw new Error(`failed to create private tmux session ${name}: ${bounded(r.err)}`);
}

function tagAsGjc(name: string, sessionId?: string): void {
	const target = buildGjcTmuxExactOptionTarget(name, { env: privateEnv });
	for (const cmd of buildGjcTmuxProfileCommands(target, privateEnv, { sessionId })) {
		const r = sh(cmd.args);
		if (r.code !== 0) throw new Error(`failed to tag ${name} (${cmd.description}): ${bounded(r.err)}`);
	}
}

function exists(name: string): boolean {
	return sh(["has-session", "-t", buildGjcTmuxExactSessionTarget(name, { env: privateEnv })]).code === 0;
}

function isPrivateSessionAbsent(name: string): boolean {
	const result = sh(["has-session", "-t", buildGjcTmuxExactSessionTarget(name, { env: privateEnv })]);
	return result.code !== 0 && /(?:no server running|can't find session|no sessions)/i.test(result.err);
}

function privateServerPid(session: string): number | null {
	const result = sh([
		"display-message",
		"-p",
		"-t",
		buildGjcTmuxExactOptionTarget(session, { env: privateEnv }),
		"#{pid}",
	]);
	const pid = Number.parseInt(result.out, 10);
	return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function scopeIsActive(): boolean {
	return (
		Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", scopeUnit], { stdout: "ignore", stderr: "ignore" })
			.exitCode === 0
	);
}

function serverIsProvenInScope(session: string): boolean {
	const pid = privateServerPid(session);
	if (pid == null) return false;
	const controlGroup = Bun.spawnSync(
		["systemctl", "--user", "show", scopeUnit, "--property=ControlGroup", "--value"],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const group = controlGroup.stdout.toString().trim();
	if (controlGroup.exitCode !== 0 || !group.startsWith("/")) return false;
	try {
		return readFileSync(`/proc/${pid}/cgroup`, "utf8")
			.split("\n")
			.some(line => line.endsWith(group));
	} catch {
		return false;
	}
}

async function makeFirstPrivateSession(name: string): Promise<void> {
	if (process.platform !== "linux") {
		makeRawSession(name);
		return;
	}
	try {
		scopeRunner = Bun.spawn(
			[
				"systemd-run",
				"--user",
				"--quiet",
				"--collect",
				`--setenv=TMUX_TMPDIR=${privateTmpdir}`,
				"--scope",
				`--unit=${scopeUnit}`,
				wrapper,
				"new-session",
				"-d",
				"-s",
				name,
				"sleep 600",
			],
			{ env: privateEnv, stdout: "ignore", stderr: "pipe" },
		);
	} catch (error) {
		throw new Error(`failed to provision private user scope ${scopeUnit}: ${bounded(String(error))}`);
	}
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (scopeIsActive() && exists(name) && serverIsProvenInScope(name)) return;
		await Bun.sleep(50);
	}
	throw new Error(`failed to provision a proven private user scope ${scopeUnit}`);
}

async function cleanupOwnedResources(names: string[]): Promise<void> {
	const failures: string[] = [];
	for (const name of names) {
		const result = sh(["kill-session", "-t", buildGjcTmuxExactSessionTarget(name, { env: privateEnv })]);
		if (result.code !== 0 && !isPrivateSessionAbsent(name)) failures.push(`session ${name}: ${bounded(result.err)}`);
	}
	const server = sh(["kill-server"]);
	if (server.code !== 0) {
		const probe = sh(["list-sessions"]);
		if (!/(?:no server running|failed to connect to server|error connecting to)/i.test(probe.err))
			failures.push(`server: ${bounded(server.err)}`);
	}
	if (process.platform === "linux") {
		const stop = Bun.spawnSync(["systemctl", "--user", "stop", scopeUnit], { stdout: "pipe", stderr: "pipe" });
		const state = Bun.spawnSync(
			["systemctl", "--user", "show", scopeUnit, "--property=ActiveState", "--property=LoadState", "--value"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const states = state.stdout.toString().trim().split("\n");
		const scopeAbsent = state.exitCode === 0 && (states.includes("inactive") || states.includes("not-found"));
		if (stop.exitCode !== 0 && !scopeAbsent) failures.push(`scope stop: ${bounded(stop.stderr.toString())}`);
		if (!scopeAbsent)
			failures.push(`scope remains present: ${bounded(state.stderr.toString() || state.stdout.toString())}`);
		if (scopeRunner != null) {
			const exited = await Promise.race([scopeRunner.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
			if (!exited) {
				try {
					scopeRunner.kill();
				} catch (error) {
					failures.push(`scope runner: ${bounded(String(error))}`);
				}
				const killed = await Promise.race([
					scopeRunner.exited.then(() => true),
					Bun.sleep(1_000).then(() => false),
				]);
				if (!killed) failures.push("scope runner did not exit after scope cleanup");
			}
		}
	}
	try {
		rmSync(privateTmpdir, { recursive: true });
	} catch (error) {
		if (existsSync(privateTmpdir)) failures.push(`temporary directory: ${bounded(String(error))}`);
	}
	if (existsSync(privateTmpdir)) failures.push("temporary directory remains present");
	if (failures.length > 0) throw new Error(`g004 cleanup incomplete: ${failures.join("; ")}`);
}

const live = `gjc_g004live_${suffix}`;
const raw = `g004raw_${suffix}`;
const mism = `gjc_g004mism_${suffix}`;
const cleanup = [live, raw, mism];

try {
	writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(tmuxBinary)} -L ${shellQuote(socket)} "$@"\n`, { mode: 0o700 });
	chmodSync(wrapper, 0o700);

	// 1. Incompletely tagged LIVE session: remove refuses and force-close fails closed.
	await makeFirstPrivateSession(live);
	tagAsGjc(live, "sess-g004");
	const status = statusGjcTmuxSession(live, privateEnv);
	assert.equal(status.profile, "1", "session must be recognized as GJC-managed");
	assert.ok(status.panePids.length > 0, "session must have a live pane (sleep)");
	process.stdout.write(`[g004] incomplete GJC session up: ${live} panePids=${status.panePids.length}\n`);

	let removeRefused = false;
	try {
		removeGjcTmuxSession(live, privateEnv);
	} catch (e) {
		removeRefused = /gjc_tmux_session_live/.test(String(e));
	}
	assert.ok(removeRefused, "removeGjcTmuxSession must REFUSE a live pane");

	let ownerUnverifiable = false;
	try {
		await forceCloseGjcTmuxSession(live, privateEnv, "sess-g004");
	} catch (e) {
		ownerUnverifiable = /gjc_tmux_owner_unverifiable/.test(String(e));
	}
	assert.ok(ownerUnverifiable, "force-close must refuse incomplete owner provenance");
	assert.ok(exists(live), "incompletely tagged session must be left untouched");
	process.stdout.write("[g004] force-close refused incomplete owner provenance (expected)\n");

	// 2. Non-GJC (untagged) session: force-close must refuse.
	makeRawSession(raw);
	let notManaged = false;
	try {
		await forceCloseGjcTmuxSession(raw, privateEnv);
	} catch (e) {
		notManaged = /gjc_tmux_session_(not_managed|not_found|untagged)/.test(String(e));
	}
	assert.ok(notManaged, "force-close must refuse a non-GJC tmux session");
	assert.ok(exists(raw), "non-GJC session must be left untouched");
	process.stdout.write("[g004] force-close refused + preserved non-GJC session (expected)\n");

	// 3. GJC session with a MISMATCHED expected session id: must refuse.
	makeRawSession(mism);
	tagAsGjc(mism, "sess-real");
	let idMismatch = false;
	try {
		await forceCloseGjcTmuxSession(mism, privateEnv, "sess-WRONG");
	} catch (e) {
		idMismatch = /gjc_tmux_session_id_mismatch/.test(String(e));
	}
	assert.ok(idMismatch, "force-close must refuse on session-id mismatch");
	assert.ok(exists(mism), "mismatched session must be left untouched");
	process.stdout.write("[g004] force-close refused on session-id mismatch (expected)\n");
} finally {
	await cleanupOwnedResources(cleanup);
}

process.stdout.write("[g004] PASS: forceCloseGjcTmuxSession refusal boundaries verified against live tmux\n");
