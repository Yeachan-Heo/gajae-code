import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Coordinator managed-worktree roots are read from `GJC_WORKTREE_DIR` while
 * building the policy the serve command uses. A repository `.env` is merged
 * into that environment, so the refusal is only visible from a process whose
 * cwd is the project that declares the variable.
 */

const PROBE = path.join(import.meta.dir, "fixtures/coordinator-managed-root-trust-probe.ts");

setDefaultTimeout(60_000);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createRepo(): { root: string; repo: string; planted: string; operator: string; kept: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-coordinator-managed-root-"));
	tempDirs.push(root);
	const repo = path.join(root, "repo");
	const planted = path.join(root, "planted", "worktree-session");
	const operator = path.join(root, "operator", "worktree-session");
	const kept = path.join(repo, ".worktrees", "kept-session");
	fs.mkdirSync(planted, { recursive: true });
	fs.mkdirSync(path.join(planted, ".gjc"), { recursive: true });
	fs.mkdirSync(operator, { recursive: true });
	fs.mkdirSync(path.join(operator, ".gjc"), { recursive: true });
	fs.mkdirSync(kept, { recursive: true });
	fs.mkdirSync(path.join(kept, ".gjc"), { recursive: true });
	return { root, repo, planted, operator, kept };
}

function under(parent: string, child: string | undefined): boolean {
	if (!child) return false;
	const resolvedParent = path.resolve(parent);
	const resolvedChild = path.resolve(child);
	return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

interface ProbeResult {
	envValue: string | null;
	managed: string[];
	subjectWorkdir: { ok: true; value: string } | { ok: false; error: string };
	keptWorkdir: { ok: true; value: string } | { ok: false; error: string };
	subjectSession: { ok: true } | { ok: false; error: string };
}

async function resolveIn(
	repo: string,
	dotenv: string | undefined,
	options: {
		subject: string;
		kept: string;
		overrides?: Record<string, string>;
		drop?: "unlink" | "chdir";
		autoload?: boolean;
		dotenvName?: string;
		nodeEnv?: string | null;
	},
): Promise<ProbeResult> {
	if (dotenv !== undefined) fs.writeFileSync(path.join(repo, options.dotenvName ?? ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.GJC_WORKTREE_DIR;
	delete env.BUN_OPTIONS;
	if (options.nodeEnv === null) delete env.NODE_ENV;
	env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS = repo;
	env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_SUBJECT = options.subject;
	env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_KEPT = options.kept;
	if (options.drop) env.GJC_COORDINATOR_MANAGED_ROOT_PROBE_DROP = options.drop;
	Object.assign(env, options.overrides);

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr || stdout}`);
	return JSON.parse(stdout.trim()) as ProbeResult;
}

describe("coordinator managed worktree root project dotenv trust", () => {
	it("rejects a project .env managed root and still allows the default in-repo worktree", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, { subject: planted, kept });
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.managed[0])).toBe(true);
		expect(under(path.dirname(planted), resolved.managed[0])).toBe(false);
		expect(resolved.subjectWorkdir).toEqual({
			ok: false,
			error: `coordinator_workdir_outside_allowed_roots:${planted}`,
		});
		expect(resolved.subjectSession.ok).toBe(false);
		if (!resolved.subjectSession.ok) {
			expect(resolved.subjectSession.error).toBe("coordinator_workdir_outside_allowed_roots");
		}
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("keeps an operator managed root the project does not declare", async () => {
		const { repo, operator, kept } = createRepo();
		const resolved = await resolveIn(repo, "OTHER=1\n", {
			subject: operator,
			kept,
			overrides: { GJC_WORKTREE_DIR: operator },
		});
		expect(resolved.envValue).toBe(operator);
		expect(under(path.dirname(operator), resolved.managed[0])).toBe(true);
		expect(resolved.subjectWorkdir).toEqual({ ok: true, value: operator });
		expect(resolved.subjectSession).toEqual({ ok: true });
	});

	it("ignores a dynamic project declaration without authorizing the expanded root", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, "GJC_WORKTREE_DIR=$GJC_PLANTED_BUCKET\n", {
			subject: planted,
			kept,
			overrides: { GJC_PLANTED_BUCKET: planted },
			autoload: true,
		});
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.managed[0])).toBe(true);
		expect(resolved.subjectWorkdir.ok).toBe(false);
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("still rejects a project root after the dotenv file is removed", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			subject: planted,
			kept,
			drop: "unlink",
		});
		expect(resolved.envValue).toBe(planted);
		expect(resolved.subjectWorkdir.ok).toBe(false);
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("still rejects a project root after the process cwd changes", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			subject: planted,
			kept,
			drop: "chdir",
		});
		expect(resolved.envValue).toBe(planted);
		expect(resolved.subjectWorkdir.ok).toBe(false);
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("keeps an operator root when the project declares a different static root", async () => {
		const { repo, planted, operator, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			subject: operator,
			kept,
			overrides: { GJC_WORKTREE_DIR: operator },
		});
		expect(resolved.envValue).toBe(operator);
		expect(under(path.dirname(operator), resolved.managed[0])).toBe(true);
		expect(under(path.dirname(planted), resolved.managed[0])).toBe(false);
		expect(resolved.subjectWorkdir).toEqual({ ok: true, value: operator });
	});

	it("rejects a quoted project managed root", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR="${planted}"\n`, { subject: planted, kept });
		expect(resolved.envValue).toBe(planted);
		expect(resolved.subjectWorkdir.ok).toBe(false);
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("rejects a project .env.local managed root", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			subject: planted,
			kept,
			dotenvName: ".env.local",
			nodeEnv: null,
		});
		expect(resolved.envValue).toBe(planted);
		expect(resolved.subjectWorkdir.ok).toBe(false);
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});

	it("rejects a development-layer managed root when NODE_ENV is unset", async () => {
		const { repo, planted, kept } = createRepo();
		const resolved = await resolveIn(repo, `GJC_WORKTREE_DIR=${planted}\n`, {
			subject: planted,
			kept,
			dotenvName: ".env.development",
			nodeEnv: null,
			autoload: true,
		});
		expect(resolved.envValue).toBe(planted);
		expect(under(path.join(repo, ".worktrees"), resolved.managed[0])).toBe(true);
		expect(resolved.subjectWorkdir).toEqual({
			ok: false,
			error: `coordinator_workdir_outside_allowed_roots:${planted}`,
		});
		expect(resolved.subjectSession).toEqual({ ok: false, error: "coordinator_workdir_outside_allowed_roots" });
		expect(resolved.keptWorkdir).toEqual({ ok: true, value: kept });
	});
});
