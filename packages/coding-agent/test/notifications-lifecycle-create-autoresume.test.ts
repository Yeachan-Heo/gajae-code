import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { setAgentDir } from "@gajae-code/utils";
import type { Args } from "../src/cli/args";
import { Settings } from "../src/config/settings";
import { createSessionManager } from "../src/main";
import { SessionManager } from "../src/session/session-manager";

const LIFECYCLE_ENV = ["GJC_LIFECYCLE_REQUEST_ID", "GJC_SESSION_ID"] as const;

afterEach(() => {
	for (const k of LIFECYCLE_ENV) delete process.env[k];
});

test("normal root launch creates a current SessionManager for root token logs", async () => {
	const agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-root-token-session-"));
	setAgentDir(agentDir);
	const cwd = path.join(agentDir, "repo");
	fs.mkdirSync(cwd, { recursive: true });

	const settings = Settings.isolated();
	settings.set("autoResume", false);

	const created = await createSessionManager({} as Args, cwd, settings);
	expect(created).toBeDefined();
	expect(created?.getSessionId()).toBeTruthy();
	expect(created?.getCwd()).toBe(cwd);

	await fsp.rm(agentDir, { recursive: true, force: true });
});

// Regression for the PR #1148 stage-17 blocker: a `/session_create` child is a
// bare `gjc` launch with GJC_SESSION_ID/GJC_LIFECYCLE_REQUEST_ID. With autoResume
// enabled and existing history in the cwd, the child must NOT auto-resume the old
// session (which would diverge the daemon/tmux id from the header id); it must
// create a fresh session that adopts the pre-allocated id.
test("lifecycle /session_create bypasses autoResume; normal launch still resumes", async () => {
	const agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-lc-autoresume-"));
	setAgentDir(agentDir);
	const cwd = path.join(agentDir, "repo");
	fs.mkdirSync(cwd, { recursive: true });

	const settings = Settings.isolated();
	settings.set("autoResume", true);

	// Seed a prior persisted session in cwd so autoResume has something to resume.
	const prior = SessionManager.create(cwd);
	const priorId = prior.getSessionId();
	await prior.ensureOnDisk();
	await prior.flush();

	// Control: a normal launch (no lifecycle env) auto-resumes the prior session.
	delete process.env.GJC_LIFECYCLE_REQUEST_ID;
	delete process.env.GJC_SESSION_ID;
	const resumed = await createSessionManager({} as Args, cwd, settings);
	expect(resumed?.getSessionId()).toBe(priorId);

	// Lifecycle create: the guard returns undefined (the SDK then creates a fresh
	// session that adopts the pre-allocated id), never auto-resuming the old one.
	process.env.GJC_LIFECYCLE_REQUEST_ID = "lc-autoresume-1";
	process.env.GJC_SESSION_ID = "s-prealloc-autoresume-1";
	const created = await createSessionManager({} as Args, cwd, settings);
	expect(created).toBeUndefined();

	// The freshly created SDK session under the same env adopts the pre-allocated id.
	const fresh = SessionManager.inMemory(cwd);
	expect(fresh.getSessionId()).toBe("s-prealloc-autoresume-1");

	await fsp.rm(agentDir, { recursive: true, force: true });
});
