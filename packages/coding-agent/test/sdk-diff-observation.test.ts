import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	createSdkDiffObservation,
	isSdkDiffObservationOperation,
	readSdkWorkingTreeDiff,
	SDK_DIFF_LIMITS,
	type SdkDiffObservation,
	SdkDiffObservationError,
} from "@gajae-code/coding-agent/sdk/diff-observation";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { collectSdkStoredSecrets } from "../src/sdk/credential-secrets";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${stderr}`);
	return stdout;
}
function failure(action: () => unknown, code: SdkDiffObservationError["code"]): void {
	try {
		action();
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(SdkDiffObservationError);
		if (!(error instanceof SdkDiffObservationError)) throw error;
		expect(error.code).toBe(code);
	}
}

describe("SDK shared working-tree diff engine", () => {
	let dir: TempDir;
	let cwd: string;
	beforeEach(async () => {
		dir = TempDir.createSync("@sdk-diff-engine-");
		cwd = path.join(dir.path(), "repo");
		await fs.mkdir(cwd);
		await git(cwd, "init", "-q");
		await git(cwd, "config", "user.email", "sdk-fixture@example.invalid");
		await git(cwd, "config", "user.name", "SDK fixture");
	});
	afterEach(() => dir.removeSync());

	it("reads staged, unstaged, and untracked files in an absolute repository without any commits", async () => {
		expect(path.isAbsolute(cwd)).toBe(true);
		await Bun.write(path.join(cwd, "both.txt"), "staged before first commit\n");
		await Bun.write(path.join(cwd, "staged.txt"), "staged only\n");
		await git(cwd, "add", "--", "both.txt", "staged.txt");
		await Bun.write(path.join(cwd, "both.txt"), "unstaged before first commit\n");
		await Bun.write(path.join(cwd, "untracked.txt"), "untracked before first commit\n");
		const indexBefore = await Bun.file(path.join(cwd, ".git/index")).arrayBuffer();
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(result.files).toHaveLength(3);
		const both = result.files.find(row => row.path === "both.txt")!;
		expect(both).toMatchObject({ status: "AM", withheld: false, truncated: false });
		expect(both.body).toContain("+staged before first commit");
		expect(both.body).toContain("-staged before first commit");
		expect(both.body).toContain("+unstaged before first commit");
		expect(result.files.find(row => row.path === "staged.txt")).toMatchObject({
			status: "A ",
			body: expect.stringContaining("+staged only"),
		});
		expect(result.files.find(row => row.path === "untracked.txt")).toMatchObject({
			status: "??",
			body: expect.stringContaining("+untracked before first commit"),
		});
		expect(await Bun.file(path.join(cwd, ".git/index")).arrayBuffer()).toEqual(indexBefore);
	});

	it("includes staged, unstaged, and untracked changes, including both layers of one file", async () => {
		await Bun.write(path.join(cwd, "both.txt"), "base\n");
		await git(cwd, "add", "--", "both.txt");
		await git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
		await Bun.write(path.join(cwd, "both.txt"), "staged\n");
		await git(cwd, "add", "--", "both.txt");
		await Bun.write(path.join(cwd, "both.txt"), "unstaged\n");
		await Bun.write(path.join(cwd, "new.txt"), "untracked body\n");
		const indexBefore = await Bun.file(path.join(cwd, ".git/index")).arrayBuffer();
		const configBefore = await Bun.file(path.join(cwd, ".git/config")).text();
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(result.files.find(row => row.path === "both.txt")).toMatchObject({
			status: "MM",
			withheld: false,
			truncated: false,
		});
		const body = result.files.find(row => row.path === "both.txt")!.body;
		expect(body).toContain("-base");
		expect(body).toContain("+staged");
		expect(body).toContain("-staged");
		expect(body).toContain("+unstaged");
		expect(result.files.find(row => row.path === "new.txt")).toMatchObject({ status: "??", withheld: false });
		expect(result.files.find(row => row.path === "new.txt")!.body).toContain("+untracked body");
		expect(await Bun.file(path.join(cwd, ".git/index")).arrayBuffer()).toEqual(indexBefore);
		expect(await Bun.file(path.join(cwd, ".git/config")).text()).toBe(configBefore);
	});

	it("parses NUL-delimited rename pairs and preserves leading-dash, Unicode, newline and literal pathspec names", async () => {
		const oldName = "old name\n한글.txt";
		const newName = "-renamed 한글\nname.txt";
		await Bun.write(path.join(cwd, oldName), "rename baseline\n");
		await git(cwd, "add", "--", oldName);
		await git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", "rename base");
		await git(cwd, "mv", "--", oldName, newName);
		await Bun.write(path.join(cwd, newName), "rename baseline\nunstaged rename content\n");
		const names = ["-dash.txt", "한글😀.txt", "line\nbreak.txt", ":[literal].txt"];
		for (const name of names) await Bun.write(path.join(cwd, name), `body for ${name}\n`);
		const result = await readSdkWorkingTreeDiff(cwd);
		const renamed = result.files.find(row => row.path === newName);
		expect(renamed?.status).toBe("RM");
		expect(renamed?.body).toContain("rename from");
		expect(renamed?.body).toContain("+unstaged rename content");
		expect(result.files.map(row => row.path)).not.toContain(oldName);
		for (const name of names) {
			const row = result.files.find(item => item.path === name);
			expect(row?.withheld).toBe(false);
			expect(row?.body).toContain(`+body for ${name.split("\n")[0]}`);
		}
	});

	it("never invokes configured textconv or external diff programs", async () => {
		const script = path.join(dir.path(), "forbidden.sh");
		const marker = path.join(dir.path(), "executed");
		await Bun.write(script, `printf executed > '${marker}'\nprintf converted\n`);
		await git(cwd, "config", "diff.fixture.textconv", `sh '${script}'`);
		await git(cwd, "config", "diff.external", `sh '${script}'`);
		await Bun.write(path.join(cwd, ".gitattributes"), "*.txt diff=fixture\n");
		await Bun.write(path.join(cwd, "tracked.txt"), "baseline\n");
		await git(cwd, "add", "--", ".gitattributes", "tracked.txt");
		await git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", "driver base");
		await Bun.write(path.join(cwd, "tracked.txt"), "staged raw\n");
		await git(cwd, "add", "--", "tracked.txt");
		await Bun.write(path.join(cwd, "tracked.txt"), "unstaged raw\n");
		await Bun.write(path.join(cwd, "untracked.txt"), "untracked raw\n");
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(result.files.find(row => row.path === "tracked.txt")?.body).toContain("+staged raw");
		expect(result.files.find(row => row.path === "tracked.txt")?.body).toContain("+unstaged raw");
		expect(result.files.find(row => row.path === "untracked.txt")?.body).toContain("+untracked raw");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("redacts known secrets and shared credential patterns before applying UTF-8 file bounds", async () => {
		const secret = `opaque-${"s".repeat(300)}`;
		const content = "x".repeat(SDK_DIFF_LIMITS.fileBytes - 180) + secret + "끝".repeat(5000);
		await Bun.write(path.join(cwd, "large.txt"), content);
		await Bun.write(path.join(cwd, "credentials-in-code.txt"), `token = sk-ant-api03-${"a".repeat(90)}`);
		const result = await readSdkWorkingTreeDiff(cwd, { knownSecrets: [secret] });
		const row = result.files.find(file => file.path === "large.txt")!;
		expect(row.truncated).toBe(true);
		expect(row.body).toContain("[REDACTED]");
		expect(row.body).not.toContain("opaque-");
		expect(row.body).not.toContain("�");
		expect(Buffer.byteLength(row.body)).toBeLessThanOrEqual(SDK_DIFF_LIMITS.fileBytes);
		expect(JSON.stringify(result)).not.toContain(`sk-ant-api03-${"a".repeat(90)}`);
		expect(result.truncationReasons).toContain("file_bytes");
	});

	it("withholds environment, credential-store, renamed credential, and symlink bodies", async () => {
		await Bun.write(path.join(cwd, ".env.original"), "hidden original value\n");
		await fs.symlink("hidden old target", path.join(cwd, "deleted-link"));
		await git(cwd, "add", "--", ".env.original", "deleted-link");
		await git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", "sensitive base");
		await git(cwd, "mv", "--", ".env.original", "innocent.txt");
		await git(cwd, "rm", "--", "deleted-link");
		for (const name of [".env", ".env.production", "auth.db", "auth.db-wal", "credentials.json", "private.key"]) {
			await Bun.write(path.join(cwd, name), "must never appear\n");
		}
		const outside = path.join(dir.path(), "outside.txt");
		await Bun.write(outside, "outside body must never appear\n");
		await fs.symlink(outside, path.join(cwd, "linked.txt"));
		await fs.symlink(dir.path(), path.join(cwd, "linked-directory"));
		const result = await readSdkWorkingTreeDiff(cwd);
		for (const row of result.files) {
			expect(row.withheld).toBe(true);
			expect(row.body).toBe("");
		}
		expect(result.files.map(row => row.path)).toContain("innocent.txt");
		expect(result.files.map(row => row.path)).toContain("deleted-link");
		expect(JSON.stringify(result)).not.toContain("outside body must never appear");
	});

	it("withholds SDK endpoint credentials and runtime state in both runtime directories", async () => {
		const files = [
			".gjc/state/sdk/endpoint.json",
			".gjc/sdk/master.key",
			".gjc/sdk/broker.json",
			".pi/state/sdk/endpoint.json",
			".pi/sdk/master.key",
			".pi/sdk/auth.json",
		];
		for (const file of files)
			await Bun.write(
				path.join(cwd, file),
				'{"token":"opaque-endpoint-capability","key":"opaque-sdk-signing-material"}\n',
			);
		await git(cwd, "add", "--", files[0]!, files[3]!);
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(result.files).toHaveLength(files.length);
		for (const file of files)
			expect(result.files.find(row => row.path === file)).toMatchObject({ withheld: true, body: "" });
		expect(JSON.stringify(result)).not.toContain("opaque-endpoint-capability");
		expect(JSON.stringify(result)).not.toContain("opaque-sdk-signing-material");
	});

	it("caps file count with exact omission metadata without opening sensitive bodies", async () => {
		for (let index = 0; index < SDK_DIFF_LIMITS.files + 5; index++)
			await Bun.write(path.join(cwd, `.env.${index}`), "hidden");
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(result.files).toHaveLength(SDK_DIFF_LIMITS.files);
		expect(result.omittedFiles).toBe(5);
		expect(result.truncated).toBe(true);
		expect(result.truncationReasons).toContain("file_count");
	});

	it("bounds aggregate serialized output and reports omitted rows", async () => {
		for (let index = 0; index < 40; index++)
			await Bun.write(path.join(cwd, `large-${index}.txt`), "z".repeat(31_000));
		const result = await readSdkWorkingTreeDiff(cwd);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(SDK_DIFF_LIMITS.responseBytes);
		expect(result.omittedFiles).toBeGreaterThan(0);
		expect(result.omittedFiles + result.files.length).toBe(40);
		expect(result.truncationReasons).toContain("total_bytes");
	});

	it("returns only fixed safe failures for non-repositories, corrupt Git data, and excessive reads", async () => {
		await expect(readSdkWorkingTreeDiff(dir.path())).rejects.toMatchObject({
			code: "not_git_repository",
			message: "Diff queries require a Git working tree.",
		});
		await Bun.write(path.join(cwd, "oversized.txt"), "x".repeat(SDK_DIFF_LIMITS.commandBytes + 1000));
		await expect(readSdkWorkingTreeDiff(cwd)).rejects.toMatchObject({
			code: "diff_too_large",
			message: "The diff exceeds its read or time budget.",
		});
		await Bun.write(path.join(cwd, ".git/index"), "private-corruption-detail");
		await expect(readSdkWorkingTreeDiff(cwd)).rejects.toMatchObject({
			code: "git_failure",
			message: "The Git diff could not be read.",
		});
	});
});

describe("SDK diff snapshot authority", () => {
	let dir: TempDir;
	let cwd: string;
	let auth: AuthStorage;
	let session: AgentSession;
	let observation: SdkDiffObservation;
	const restores: Array<() => void> = [];
	beforeEach(async () => {
		dir = TempDir.createSync("@sdk-diff-service-");
		cwd = path.join(dir.path(), "repo");
		await fs.mkdir(cwd);
		await git(cwd, "init", "-q");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing fixture model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
		});
		observation = createSdkDiffObservation(session);
		await Bun.write(path.join(cwd, "fixture.txt"), "original snapshot\n");
	});
	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		observation.dispose();
		await session.dispose();
		auth.close();
		dir.removeSync();
	});

	it("advertises only working-tree scope and dispatches closed inputs", async () => {
		expect(await observation.dispatch("diff.scopes", {})).toEqual({
			scopes: [{ id: "working-tree", label: "Working tree (staged, unstaged, and untracked)" }],
		});
		for (const input of [{ scope: "branch" }, { scope: "working-tree", cwd: "/other" }, {}, null]) {
			await expect(observation.dispatch("diff.summary", input)).rejects.toMatchObject({ code: "invalid_input" });
		}
		for (const input of [{ ref: "path", path: "fixture.txt" }, { path: "fixture.txt" }, { ref: 1 }, []])
			failure(() => observation.file(input), "invalid_input");
		failure(() => observation.scopes({ extra: true }), "invalid_input");
		const getter = {
			get scope(): string {
				throw new Error("getter must not execute");
			},
		};
		await expect(observation.summary(getter)).rejects.toMatchObject({ code: "invalid_input" });
		expect(isSdkDiffObservationOperation("diff.file")).toBe(true);
		expect(isSdkDiffObservationOperation("diff.write")).toBe(false);
	});

	it("serves isolated snapshot copies by opaque refs and retires prior refs on refresh", async () => {
		const summary = await observation.summary({ scope: "working-tree" });
		const ref = summary.files.find(row => row.path === "fixture.txt")!.ref;
		expect(ref).not.toContain("fixture.txt");
		await Bun.write(path.join(cwd, "fixture.txt"), "later workspace\n");
		summary.files[0]!.path = "caller mutation";
		const file = observation.file({ ref });
		expect(file.body).toContain("+original snapshot");
		expect(file.path).toBe("fixture.txt");
		file.body = "caller mutation";
		expect(observation.file({ ref }).body).toContain("+original snapshot");
		failure(() => observation.file({ ref: "fixture.txt" }), "stale_ref");
		const next = await observation.summary({ scope: "working-tree" });
		expect(next.snapshotId).not.toBe(summary.snapshotId);
		failure(() => observation.file({ ref }), "stale_ref");
		expect(observation.file({ ref: next.files[0]!.ref }).body).toContain("+later workspace");
	});

	it("collects every stored API key and OAuth token without resolving, refreshing, or returning credentials", async () => {
		const first = "opaque-first-credential";
		const second = "opaque-second-credential";
		const access = "opaque-oauth-access";
		const refresh = "opaque-oauth-refresh";
		const structuredToken = "opaque-structured-token";
		const structured = JSON.stringify({ token: structuredToken });
		await auth.set("anthropic", [
			{ type: "api_key", key: first },
			{ type: "api_key", key: second },
		]);
		await auth.set("openai-codex", { type: "oauth", access, refresh, expires: Date.now() + 100_000 });
		await auth.set("sdk-structured", { type: "api_key", key: structured });
		const resolve = spyOn(auth, "getApiKey");
		restores.push(() => resolve.mockRestore());
		expect(new Set(collectSdkStoredSecrets(auth))).toEqual(
			new Set([first, second, access, refresh, structured, structuredToken]),
		);
		await Bun.write(
			path.join(cwd, "fixture.txt"),
			[first, second, access, refresh, structured, structuredToken].join("\n"),
		);
		const summary = await observation.summary({ scope: "working-tree" });
		const file = observation.file({ ref: summary.files[0]!.ref });
		for (const secret of [first, second, access, refresh, structured, structuredToken]) {
			expect(JSON.stringify(summary)).not.toContain(secret);
			expect(JSON.stringify(file)).not.toContain(secret);
		}
		expect(file.body).toContain("[REDACTED]");
		expect(resolve).toHaveBeenCalledTimes(0);
	});

	it("admits only one backend read per session without superseding its snapshot", async () => {
		const spawn = spyOn(Bun, "spawn");
		restores.push(() => spawn.mockRestore());
		const peer = createSdkDiffObservation(session);
		try {
			const pending = observation.summary({ scope: "working-tree" });
			const duplicate = observation.summary({ scope: "working-tree" });
			const otherService = peer.summary({ scope: "working-tree" });
			expect(spawn).toHaveBeenCalledTimes(1);
			await expect(duplicate).rejects.toMatchObject({ code: "busy" });
			await expect(otherService).rejects.toMatchObject({ code: "busy" });
			const summary = await pending;
			expect(observation.file({ ref: summary.files[0]!.ref }).body).toContain("+original snapshot");
			expect((await peer.summary({ scope: "working-tree" })).files).toHaveLength(1);
		} finally {
			peer.dispose();
		}
	});

	it("aborts disposed reads and keeps session admission occupied through subprocess settlement and recreation", async () => {
		const spawn = spyOn(Bun, "spawn");
		restores.push(() => spawn.mockRestore());
		const pending = observation.summary({ scope: "working-tree" });
		const child = spawn.mock.results[0]?.value as Bun.Subprocess | undefined;
		const signal = spawn.mock.calls[0]?.[1]?.signal;
		if (!child || !signal) throw new Error("Missing real Git subprocess or cancellation signal");
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});
		observation.dispose();
		expect(signal.aborted).toBe(true);
		const replacement = createSdkDiffObservation(session);
		try {
			const duplicate = replacement.summary({ scope: "working-tree" });
			expect(spawn).toHaveBeenCalledTimes(1);
			await expect(duplicate).rejects.toMatchObject({ code: "busy" });
			await expect(pending).rejects.toMatchObject({ code: "disposed" });
			expect(exited).toBe(true);
			expect((await replacement.summary({ scope: "working-tree" })).files).toHaveLength(1);
		} finally {
			replacement.dispose();
		}
	});

	it("aborts pending Git subprocesses when transition cleanup retires their owner", async () => {
		const registration = spyOn(session, "registerToolSessionTransitionCleanup");
		const bound = createSdkDiffObservation(session);
		const cleanup = registration.mock.calls[0]?.[0];
		registration.mockRestore();
		if (!cleanup) throw new Error("Missing transition cleanup");
		const spawn = spyOn(Bun, "spawn");
		restores.push(() => spawn.mockRestore());
		const pending = bound.summary({ scope: "working-tree" });
		const child = spawn.mock.results[0]?.value as Bun.Subprocess | undefined;
		const signal = spawn.mock.calls[0]?.[1]?.signal;
		if (!child || !signal) throw new Error("Missing real Git subprocess or cancellation signal");
		const retirement = cleanup();
		expect(signal.aborted).toBe(true);
		await retirement;
		await expect(pending).rejects.toMatchObject({ code: "stale_session" });
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
		failure(() => bound.scopes({}), "stale_session");
		expect((await observation.summary({ scope: "working-tree" })).files).toHaveLength(1);
	});

	it("rejects transitioning sessions without retiring a still-current identity", async () => {
		const lifecycle = session.sessionLifecycle;
		Object.defineProperty(session, "sessionLifecycle", {
			configurable: true,
			get: () => ({ ...lifecycle, transitioning: true }),
		});
		try {
			failure(() => observation.scopes({}), "session_transitioning");
			await expect(observation.summary({ scope: "working-tree" })).rejects.toMatchObject({
				code: "session_transitioning",
			});
		} finally {
			Reflect.deleteProperty(session, "sessionLifecycle");
		}
		expect((await observation.summary({ scope: "working-tree" })).files).toHaveLength(1);
	});

	it("fences manager identity-generation replacement even at the same cwd", async () => {
		const generation = session.sessionManager.getSessionIdentityGeneration();
		const pending = observation.summary({ scope: "working-tree" });
		const changed = spyOn(session.sessionManager, "getSessionIdentityGeneration").mockReturnValue(generation + 1);
		restores.push(() => changed.mockRestore());
		await expect(pending).rejects.toMatchObject({ code: "stale_session" });
		changed.mockRestore();
		failure(() => observation.scopes({}), "stale_session");
	});

	it("fences pending Git reads and permanently retires refs after cwd replacement", async () => {
		const summary = await observation.summary({ scope: "working-tree" });
		const pending = observation.summary({ scope: "working-tree" });
		const changed = spyOn(session.sessionManager, "getCwd").mockReturnValue(path.join(cwd, "other"));
		restores.push(() => changed.mockRestore());
		await expect(pending).rejects.toMatchObject({ code: "stale_session" });
		changed.mockRestore();
		failure(() => observation.file({ ref: summary.files[0]!.ref }), "stale_session");
	});

	it("fences lifecycle-generation changes while a Git read is pending", async () => {
		const lifecycle = session.sessionLifecycle;
		const pending = observation.summary({ scope: "working-tree" });
		Object.defineProperty(session, "sessionLifecycle", {
			configurable: true,
			get: () => ({ ...lifecycle, generation: lifecycle.generation + 1 }),
		});
		try {
			await expect(pending).rejects.toMatchObject({ code: "stale_session" });
		} finally {
			Reflect.deleteProperty(session, "sessionLifecycle");
		}
		failure(() => observation.scopes({}), "stale_session");
	});

	it("rejects manager replacement and transition cleanup even if the original identity is restored", async () => {
		const original = session.sessionManager;
		const replacement = SessionManager.inMemory(cwd);
		try {
			session.sessionManager = replacement;
			failure(() => observation.scopes({}), "stale_session");
		} finally {
			session.sessionManager = original;
			await replacement.close();
		}
		failure(() => observation.scopes({}), "stale_session");
		const registration = spyOn(session, "registerToolSessionTransitionCleanup");
		const bound = createSdkDiffObservation(session);
		const cleanup = registration.mock.calls[0]?.[0];
		registration.mockRestore();
		if (!cleanup) throw new Error("Missing transition cleanup");
		await cleanup();
		failure(() => bound.scopes({}), "stale_session");
		bound.dispose();
	});

	it("retires published refs and rejects queries after the owning AgentSession finishes disposal", async () => {
		const summary = await observation.summary({ scope: "working-tree" });
		const ref = summary.files.find(row => row.path === "fixture.txt")!.ref;
		expect(observation.file({ ref }).body).toContain("+original snapshot");
		await session.dispose();
		expect(session.sessionLifecycle.disposed).toBe(true);
		expect(observation.disposed).toBe(true);
		await expect(observation.summary({ scope: "working-tree" })).rejects.toMatchObject({ code: "disposed" });
		failure(() => observation.scopes({}), "disposed");
		failure(() => observation.file({ ref }), "disposed");
	});

	it("cancels externally aborted engine reads before spawning or after real Git subprocess admission", async () => {
		const spawn = spyOn(Bun, "spawn");
		restores.push(() => spawn.mockRestore());
		const cancelled = new AbortController();
		cancelled.abort(new Error("private external abort detail"));
		await expect(readSdkWorkingTreeDiff(cwd, { signal: cancelled.signal })).rejects.toMatchObject({
			code: "git_failure",
			message: "The Git diff could not be read.",
		});
		expect(spawn).toHaveBeenCalledTimes(0);
		const controller = new AbortController();
		const pending = readSdkWorkingTreeDiff(cwd, { signal: controller.signal });
		const child = spawn.mock.results[0]?.value as Bun.Subprocess | undefined;
		const signal = spawn.mock.calls[0]?.[1]?.signal;
		if (!child || !signal) throw new Error("Missing real Git subprocess or cancellation signal");
		controller.abort(new Error("private external abort detail"));
		expect(signal.aborted).toBe(true);
		await expect(pending).rejects.toMatchObject({ code: "git_failure", message: "The Git diff could not be read." });
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("rejects pending results after disposal and contains credential-store failures", async () => {
		const failing = spyOn(auth, "getAll").mockImplementation(() => {
			throw new Error("secret storage failure");
		});
		restores.push(() => failing.mockRestore());
		await expect(observation.summary({ scope: "working-tree" })).rejects.toMatchObject({
			code: "git_failure",
			message: "The Git diff could not be read.",
		});
		failing.mockRestore();
		const pending = observation.summary({ scope: "working-tree" });
		observation.dispose();
		await expect(pending).rejects.toMatchObject({ code: "disposed" });
		failure(() => observation.scopes({}), "disposed");
	});
});
