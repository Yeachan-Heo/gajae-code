import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-state-handoff-"));
	// Most tests assume root-scoped state; clear GJC_SESSION_ID so the
	// runtime's env-default fallback does not leak the host shell's session
	// id into temp-dir scenarios. Individual tests that target the env
	// default restore GJC_SESSION_ID inside their own setup.
	const priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return null;
		throw err;
	}
}

describe("gjc state handoff", () => {
	it("transitions caller -> callee atomically across mode-state and active-state", async () => {
		await withTempCwd(async cwd => {
			const callerPath = path.join(cwd, ".gjc/state/deep-interview-state.json");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				updated_at: "2026-01-01T00:00:00.000Z",
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);
			const payload = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
			expect(payload.from).toBe("deep-interview");
			expect(payload.to).toBe("ralplan");
			expect(typeof payload.handoff_at).toBe("string");
			const handoffAt = payload.handoff_at as string;

			const caller = await readJson(callerPath);
			expect(caller?.active).toBe(false);
			expect(caller?.current_phase).toBe("handoff");
			expect(caller?.handoff_to).toBe("ralplan");
			expect(caller?.handoff_at).toBe(handoffAt);

			const callee = await readJson(path.join(cwd, ".gjc/state/ralplan-state.json"));
			expect(callee?.active).toBe(true);
			expect(callee?.handoff_from).toBe("deep-interview");
			expect(callee?.handoff_at).toBe(handoffAt);

			const activeState = await readJson(path.join(cwd, ".gjc/state/skill-active-state.json"));
			const activeSkills = (activeState?.active_skills as Array<Record<string, unknown>>) ?? [];
			// Handoff demotes the caller to active:false with handoff_to lineage so
			// downstream readers can audit the transition; HUD readers filter on
			// active!==false so the demoted entry stays out of the visible bar.
			const ralplan = activeSkills.find(e => e.skill === "ralplan");
			const di = activeSkills.find(e => e.skill === "deep-interview");
			expect(ralplan?.active).toBe(true);
			expect(ralplan?.handoff_from).toBe("deep-interview");
			expect(typeof ralplan?.handoff_at).toBe("string");
			expect(di?.active).toBe(false);
			expect(di?.handoff_to).toBe("ralplan");
			expect(di?.handoff_at).toBe(handoffAt);
		});
	});

	it("writes callee mode-state before caller mode-state (HUD-coherent ordering)", async () => {
		await withTempCwd(async cwd => {
			const callerPath = path.join(cwd, ".gjc/state/deep-interview-state.json");
			const calleePath = path.join(cwd, ".gjc/state/ralplan-state.json");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});

			// Spy on writes by chmod-ing the dir to readonly partway through is too invasive.
			// Instead, verify ordering by stat mtime: write callee first, then caller. The
			// callee file MUST exist when the caller is rewritten, and its mtime must be
			// less-than-or-equal to the caller's mtime.
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);

			const calleeStat = await fs.stat(calleePath);
			const callerStat = await fs.stat(callerPath);
			expect(calleeStat.mtimeMs).toBeLessThanOrEqual(callerStat.mtimeMs);
		});
	});

	it("rejects missing --to", async () => {
		await withTempCwd(async cwd => {
			await writeJson(path.join(cwd, ".gjc/state/deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			const result = await runNativeStateCommand(["handoff", "--mode", "deep-interview", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("--to");
		});
	});

	it("rejects unknown callee skill", async () => {
		await withTempCwd(async cwd => {
			await writeJson(path.join(cwd, ".gjc/state/deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "made-up-skill", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("unknown --mode");
		});
	});

	it("rejects --to equal to caller", async () => {
		await withTempCwd(async cwd => {
			await writeJson(path.join(cwd, ".gjc/state/ralplan-state.json"), {
				skill: "ralplan",
				version: 1,
				active: true,
				current_phase: "planning",
			});
			const result = await runNativeStateCommand(["handoff", "--mode", "ralplan", "--to", "ralplan", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("must differ from caller");
		});
	});

	it("rejects handoff when caller mode-state file does not exist", async () => {
		await withTempCwd(async cwd => {
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("caller is not active");
		});
	});

	it("supports backward chain ultragoal -> ralplan", async () => {
		await withTempCwd(async cwd => {
			await writeJson(path.join(cwd, ".gjc/state/ultragoal-state.json"), {
				skill: "ultragoal",
				version: 1,
				active: true,
				current_phase: "goal-planning",
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "ultragoal", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);
			const ultragoal = await readJson(path.join(cwd, ".gjc/state/ultragoal-state.json"));
			expect(ultragoal?.active).toBe(false);
			expect(ultragoal?.current_phase).toBe("handoff");
			expect(ultragoal?.handoff_to).toBe("ralplan");
			const ralplan = await readJson(path.join(cwd, ".gjc/state/ralplan-state.json"));
			expect(ralplan?.active).toBe(true);
			expect(ralplan?.handoff_from).toBe("ultragoal");
		});
	});
	it("handoffs session-scoped state when --session-id is forwarded", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-G007";
			const encodedSession = encodeURIComponent(sessionId).replaceAll(".", "%2E");
			const sessionDir = path.join(cwd, ".gjc/state/sessions", encodedSession);
			await writeJson(path.join(sessionDir, "deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
				cwd,
			);
			expect(result.status).toBe(0);

			// Session-scoped caller mode-state demoted; root mode-state untouched.
			const caller = JSON.parse(
				await fs.readFile(path.join(sessionDir, "deep-interview-state.json"), "utf-8"),
			) as Record<string, unknown>;
			expect(caller.active).toBe(false);
			expect(caller.current_phase).toBe("handoff");

			const callee = JSON.parse(await fs.readFile(path.join(sessionDir, "ralplan-state.json"), "utf-8")) as Record<
				string,
				unknown
			>;
			expect(callee.active).toBe(true);
			expect(callee.handoff_from).toBe("deep-interview");

			// Root state files were NOT mutated for this session-scoped handoff.
			await expect(fs.access(path.join(cwd, ".gjc/state/deep-interview-state.json"))).rejects.toThrow();

			// Session-scoped active-state has callee active and carries lineage.
			const sessionActive = JSON.parse(
				await fs.readFile(path.join(sessionDir, "skill-active-state.json"), "utf-8"),
			) as { active_skills?: Array<Record<string, unknown>> };
			const ralplanEntry = sessionActive.active_skills?.find(e => e.skill === "ralplan");
			expect(ralplanEntry?.handoff_from).toBe("deep-interview");
			expect(typeof ralplanEntry?.handoff_at).toBe("string");
		});
	});
	it("propagates strict sync failure when active-state write fails after mode-state writes succeed", async () => {
		await withTempCwd(async cwd => {
			const callerPath = path.join(cwd, ".gjc/state/deep-interview-state.json");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			// Pre-create the root active-state path AS A DIRECTORY so writing it
			// fails *after* both mode-state writes have already succeeded. This
			// exercises the strict active-state path, not the pre-sync mode-state
			// path, and proves the CLI returns non-zero status when the atomic
			// transaction cannot complete.
			await fs.mkdir(path.join(cwd, ".gjc/state/skill-active-state.json"), { recursive: true });

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toBeDefined();
			// Mode-state writes happen before the active-state sync, so the caller
			// mode-state is already demoted. The recoverable contract is: mode-state
			// reflects intent, and a subsequent retry (or explicit `gjc state
			// <caller> handoff --to <callee>`) can re-apply the active-state sync
			// without corrupting either mode-state file.
			const caller = JSON.parse(await fs.readFile(callerPath, "utf-8")) as Record<string, unknown>;
			expect(caller.current_phase).toBe("handoff");
			expect(caller.active).toBe(false);
			const callee = JSON.parse(
				await fs.readFile(path.join(cwd, ".gjc/state/ralplan-state.json"), "utf-8"),
			) as Record<string, unknown>;
			expect(callee.active).toBe(true);
			expect(callee.handoff_from).toBe("deep-interview");
		});
	});

	it("treats corrupt active-state JSON as a strict failure", async () => {
		await withTempCwd(async cwd => {
			await writeJson(path.join(cwd, ".gjc/state/deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			await fs.mkdir(path.join(cwd, ".gjc/state"), { recursive: true });
			await fs.writeFile(path.join(cwd, ".gjc/state/skill-active-state.json"), "{ not valid json");

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toBeDefined();
		});
	});

	it("preserves earlier inactive lineage across successive handoffs (D->R->U keeps di's handoff_to in active_skills)", async () => {
		await withTempCwd(async cwd => {
			const stateDir = path.join(cwd, ".gjc/state");
			await writeJson(path.join(stateDir, "deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});

			// Step 1: D -> R.
			const step1 = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(step1.status).toBe(0);

			// Bridge state for step 2: ralplan must look ready-to-hand-off.
			await fs.writeFile(
				path.join(stateDir, "ralplan-state.json"),
				JSON.stringify(
					{
						...(JSON.parse(await fs.readFile(path.join(stateDir, "ralplan-state.json"), "utf-8")) as Record<
							string,
							unknown
						>),
						current_phase: "handoff",
					},
					null,
					2,
				),
			);

			// Step 2: R -> U.
			const step2 = await runNativeStateCommand(
				["handoff", "--mode", "ralplan", "--to", "ultragoal", "--json", "--force"],
				cwd,
			);
			expect(step2.status).toBe(0);

			// Assert all three lineage records are present in active_skills.
			const activeState = (await readJson(path.join(stateDir, "skill-active-state.json"))) as {
				active_skills?: Array<Record<string, unknown>>;
			};
			const skills = activeState?.active_skills ?? [];
			const di = skills.find(e => e.skill === "deep-interview");
			const rp = skills.find(e => e.skill === "ralplan");
			const ug = skills.find(e => e.skill === "ultragoal");
			expect(di?.active).toBe(false);
			expect(di?.handoff_to).toBe("ralplan");
			expect(rp?.active).toBe(false);
			expect(rp?.handoff_to).toBe("ultragoal");
			expect(rp?.handoff_from).toBe("deep-interview");
			expect(ug?.active).toBe(true);
			expect(ug?.handoff_from).toBe("ralplan");
		});
	});
	it("defaults session-id from GJC_SESSION_ID env var when no --session-id flag is passed", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-env-default";
			const encodedSession = encodeURIComponent(sessionId).replaceAll(".", "%2E");
			const sessionDir = path.join(cwd, ".gjc/state/sessions", encodedSession);
			await writeJson(path.join(sessionDir, "deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const prior = process.env.GJC_SESSION_ID;
			process.env.GJC_SESSION_ID = sessionId;
			try {
				// No --session-id flag; runtime must pick the env var.
				const result = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				expect(result.status).toBe(0);
				// Session-scoped mode-state demoted (proves env default was applied).
				const caller = JSON.parse(
					await fs.readFile(path.join(sessionDir, "deep-interview-state.json"), "utf-8"),
				) as Record<string, unknown>;
				expect(caller.active).toBe(false);
				expect(caller.current_phase).toBe("handoff");
			} finally {
				if (prior === undefined) delete process.env.GJC_SESSION_ID;
				else process.env.GJC_SESSION_ID = prior;
			}
		});
	});

	it("supports the documented agent flow: write current_phase=handoff via env-defaulted session, then handoff CLI from skill tool", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-docs-flow";
			const encodedSession = encodeURIComponent(sessionId).replaceAll(".", "%2E");
			const sessionDir = path.join(cwd, ".gjc/state/sessions", encodedSession);
			// Bootstrap: an active deep-interview session-scoped state exists.
			await writeJson(path.join(sessionDir, "deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const prior = process.env.GJC_SESSION_ID;
			process.env.GJC_SESSION_ID = sessionId;
			try {
				// Step 1 (agent shell): documented prep write — no --session-id flag, env picks it up.
				const writeResult = await runNativeStateCommand(
					["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "handoff" }), "--json"],
					cwd,
				);
				expect(writeResult.status).toBe(0);
				const di1 = JSON.parse(
					await fs.readFile(path.join(sessionDir, "deep-interview-state.json"), "utf-8"),
				) as Record<string, unknown>;
				expect(di1.current_phase).toBe("handoff");
				expect(di1.active).toBe(true); // write does NOT demote; only handoff verb does

				// Step 2 (skill tool path): handoff verb without --session-id; env defaults it.
				const handoffResult = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				expect(handoffResult.status).toBe(0);
				const di2 = JSON.parse(
					await fs.readFile(path.join(sessionDir, "deep-interview-state.json"), "utf-8"),
				) as Record<string, unknown>;
				expect(di2.active).toBe(false);
				expect(di2.handoff_to).toBe("ralplan");
				const rp = JSON.parse(await fs.readFile(path.join(sessionDir, "ralplan-state.json"), "utf-8")) as Record<
					string,
					unknown
				>;
				expect(rp.active).toBe(true);
				expect(rp.handoff_from).toBe("deep-interview");
			} finally {
				if (prior === undefined) delete process.env.GJC_SESSION_ID;
				else process.env.GJC_SESSION_ID = prior;
			}
		});
	});
});
