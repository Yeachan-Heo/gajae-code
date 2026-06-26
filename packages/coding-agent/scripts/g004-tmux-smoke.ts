// G004 real-tmux smoke: exercises forceCloseGjcTmuxSession against LIVE tmux
// sessions (tmux 3.6a). Proves the wrapper hard-kills GJC-managed live panes
// (where remove refuses), refuses non-GJC sessions, and enforces session-id
// matching. Produces durable evidence; not part of the unit suite.
import assert from "node:assert";

import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
	resolveGjcTmuxCommand,
} from "../src/gjc-runtime/tmux-common";
import { forceCloseGjcTmuxSession, removeGjcTmuxSession, statusGjcTmuxSession } from "../src/gjc-runtime/tmux-sessions";

const tmux = resolveGjcTmuxCommand(process.env);

function sh(args: string[]): { code: number; err: string } {
	const r = Bun.spawnSync([tmux, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode, err: r.stderr.toString().trim() };
}

function makeRawSession(name: string): void {
	const r = sh(["new-session", "-d", "-s", name, "sleep 600"]);
	if (r.code !== 0) throw new Error(`failed to create tmux session ${name}: ${r.err}`);
}

function tagAsGjc(name: string, sessionId?: string): void {
	const target = buildGjcTmuxExactOptionTarget(name);
	for (const cmd of buildGjcTmuxProfileCommands(target, process.env, { sessionId })) {
		const r = sh(cmd.args);
		if (r.code !== 0) throw new Error(`failed to tag ${name} (${cmd.description}): ${r.err}`);
	}
}

function exists(name: string): boolean {
	return sh(["has-session", "-t", `=${name}`]).code === 0;
}

function killQuiet(name: string): void {
	sh(["kill-session", "-t", `=${name}`]);
}

const suffix = `${process.pid}-${Date.now()}`;
const live = `gjc_g004live_${suffix}`;
const raw = `g004raw_${suffix}`;
const mism = `gjc_g004mism_${suffix}`;
const cleanup: string[] = [live, raw, mism];

try {
	// 1. GJC-managed LIVE session: remove refuses, force-close hard-kills.
	makeRawSession(live);
	tagAsGjc(live, "sess-g004");
	const status = statusGjcTmuxSession(live);
	assert.equal(status.profile, "1", "session must be recognized as GJC-managed");
	assert.ok(status.panePids.length > 0, "session must have a live pane (sleep)");
	console.log(`[g004] live GJC session up: ${live} panePids=${status.panePids.length}`);

	let removeRefused = false;
	try {
		removeGjcTmuxSession(live);
	} catch (e) {
		removeRefused = /gjc_tmux_session_live/.test(String(e));
	}
	assert.ok(removeRefused, "removeGjcTmuxSession must REFUSE a live pane");
	console.log("[g004] remove refused live session (expected)");

	const closed = forceCloseGjcTmuxSession(live, process.env, "sess-g004");
	assert.equal(closed.name, live);
	assert.ok(!exists(live), "force-close must hard-kill the live GJC session");
	console.log("[g004] force-close hard-killed the live GJC session (id-matched)");

	// 2. Non-GJC (untagged) session: force-close must refuse.
	makeRawSession(raw);
	let notManaged = false;
	try {
		forceCloseGjcTmuxSession(raw, process.env);
	} catch (e) {
		notManaged = /gjc_tmux_session_(not_managed|not_found)/.test(String(e));
	}
	assert.ok(notManaged, "force-close must refuse a non-GJC tmux session");
	assert.ok(exists(raw), "non-GJC session must be left untouched");
	killQuiet(raw);
	console.log("[g004] force-close refused + preserved non-GJC session (expected)");

	// 3. GJC session with a MISMATCHED expected session id: must refuse.
	makeRawSession(mism);
	tagAsGjc(mism, "sess-real");
	let idMismatch = false;
	try {
		forceCloseGjcTmuxSession(mism, process.env, "sess-WRONG");
	} catch (e) {
		idMismatch = /gjc_tmux_session_id_mismatch/.test(String(e));
	}
	assert.ok(idMismatch, "force-close must refuse on session-id mismatch");
	assert.ok(exists(mism), "mismatched session must be left untouched");
	console.log("[g004] force-close refused on session-id mismatch (expected)");

	console.log("[g004] PASS: forceCloseGjcTmuxSession verified against live tmux");
} finally {
	for (const name of cleanup) killQuiet(name);
}
