import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDeepInterviewDraftCommand as runDeepInterviewDraftCommandRaw } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-draft";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

async function runDeepInterviewDraftCommand(input: string[], cwd: string) {
	return runDeepInterviewDraftCommandRaw([...input, "--json"], cwd);
}

async function seedState(cwd: string, session: string, revision = 1): Promise<void> {
	const statePath = modeStatePath(cwd, session, "deep-interview");
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await Bun.write(statePath, JSON.stringify({ state_revision: revision, state: { type: "greenfield" } }));
}
describe("deep-interview drafts", () => {
	it("requires standalone JSON output mode and rejects duplicate or valued flags", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			await seedState(cwd, "json-session");
			for (const input of [
				["create", "--for", "initialize-context", "--session-id", "json-session"],
				["edit"],
				["show"],
				["check"],
				["rebase"],
				["discard"],
				["show", "--draft-id", "x", "--json", "--null"],
				["create", "--for", "initialize-context", "--session-id", "json-session", "--json", "--json"],
				["create", "--for", "initialize-context", "--session-id", "json-session", "--json", "false"],
				["create", "--for", "initialize-context", "--session-id", "json-session", "--round-key", "--json"],
			]) {
				const result = await runDeepInterviewDraftCommandRaw(input, cwd);
				expect(result.stderr).toContain("DI_INVALID_ARGUMENT");
			}
			const standalone = await runDeepInterviewDraftCommandRaw(
				["create", "--for", "initialize-context", "--session-id", "json-session", "--json"],
				cwd,
			);
			expect(standalone.status).toBe(0);
			const routerNormalized = await runDeepInterviewDraftCommandRaw(
				["show", "--draft-id", JSON.parse(standalone.stdout!).draft.id, "--json", "true"],
				cwd,
			);
			expect(routerNormalized.status).toBe(0);
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rejects public internal-consume requests before parsing flags or mutating state", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			const session = "public-consume";
			await seedState(cwd, session);
			const created = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", session],
				cwd,
			);
			const draft = JSON.parse(created.stdout!).draft;
			const statePath = modeStatePath(cwd, session, "deep-interview");
			const stateBefore = await fs.readFile(statePath, "utf8");
			const rejected = await runDeepInterviewDraftCommandRaw(
				[
					"consume-internal",
					"--draft-id",
					draft.id,
					"--expected-draft-revision",
					String(draft.draft_revision),
					"--kind",
					"initialize-context",
					"--json",
				],
				cwd,
			);
			expect(rejected.status).toBe(2);
			expect(rejected.stderr).toContain("DI_UNKNOWN_COMMAND");
			expect(await fs.readFile(statePath, "utf8")).toBe(stateBefore);
			const shown = await runDeepInterviewDraftCommand(["show", "--draft-id", draft.id], cwd);
			expect(JSON.parse(shown.stdout!).draft).toMatchObject({ status: "active", draft_revision: 1 });
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("stores an editable draft outside the workspace and rejects unsafe paths", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			await seedState(cwd, "draft-session");
			const rejectedFlag = await runDeepInterviewDraftCommand(
				["create", "--invalid", "initialize-context", "--session-id", "draft-session"],
				cwd,
			);
			expect(rejectedFlag.stderr).toContain("DI_INVALID_ARGUMENT");
			const missingFor = await runDeepInterviewDraftCommand(["create", "--session-id", "draft-session"], cwd);
			expect(missingFor.stderr).toContain("DI_INVALID_ARGUMENT");
			const created = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "draft-session"],
				cwd,
			);
			const draft = JSON.parse(created.stdout!).draft;
			expect(draft.id).toMatch(/^[a-f0-9]{32}$/);
			const edited = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					draft.id,
					"--expected-draft-revision",
					"1",
					"--op",
					"set",
					"--path",
					"/type",
					"--value",
					"greenfield",
				],
				cwd,
			);
			expect(JSON.parse(edited.stdout!).draft.payload.type).toBe("greenfield");
			const unsafe = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					draft.id,
					"--expected-draft-revision",
					"2",
					"--op",
					"set",
					"--path",
					"/__proto__",
					"--value",
					"x",
				],
				cwd,
			);
			expect(unsafe.stderr).toContain("DI_DRAFT_INVALID_PATH");
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("coerces fresh scalar leaves and permits schema-scaffolded setup drafts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			const session = "schema-session";
			await fs.mkdir(path.dirname(modeStatePath(cwd, session, "deep-interview")), { recursive: true });
			await Bun.write(
				modeStatePath(cwd, session, "deep-interview"),
				JSON.stringify({ state_revision: 1, state: { type: "greenfield" } }),
			);
			const created = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", session],
				cwd,
			);
			const id = JSON.parse(created.stdout!).draft.id as string;
			let revision = 1;
			const edit = async (op: string, draftPath: string, value?: string) => {
				const command = [
					"edit",
					"--draft-id",
					id,
					"--expected-draft-revision",
					String(revision++),
					"--op",
					op,
					"--path",
					draftPath,
				];
				if (value !== undefined) command.push("--value", value);
				const response = await runDeepInterviewDraftCommand(command, cwd);
				expect(response.status).toBe(0);
			};
			await edit("set", "/type", "greenfield");
			await edit("set", "/threshold", "0.5");
			await edit("set", "/interview_id", "interview-1");
			await edit("set", "/initial_idea", "idea");
			await edit("set", "/initial_context_summary", "summary");
			await edit("set", "/codebase_context", "context");
			await edit("set", "/threshold_source", "manual");
			await edit("set", "/language", "en");
			await edit("set", "/trace_summary", "trace");
			await edit("append", "/challenge_modes_used", "challenge");
			await edit("append", "/trace", "entry");
			const checked = await runDeepInterviewDraftCommand(["check", "--draft-id", id], cwd);
			expect(checked.status).toBe(0);
			const invalid = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					id,
					"--expected-draft-revision",
					String(revision),
					"--op",
					"set",
					"--path",
					"/threshold",
					"--value",
					"nan",
				],
				cwd,
			);
			expect(invalid.stderr).toContain("DI_DRAFT_INVALID_VALUE");
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects sparse indexes, object values, and required field removal", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			await seedState(cwd, "answer-session");
			const created = await runDeepInterviewDraftCommand(
				[
					"create",
					"--for",
					"record-answer",
					"--session-id",
					"answer-session",
					"--round",
					"1",
					"--question-id",
					"question-1",
				],
				cwd,
			);
			const id = JSON.parse(created.stdout!).draft.id as string;
			const sparse = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					id,
					"--expected-draft-revision",
					"1",
					"--op",
					"set",
					"--path",
					"/answer/selected_options/0",
					"--value",
					"x",
				],
				cwd,
			);
			expect(sparse.stderr).toContain("DI_DRAFT_INVALID_PATH");
			const objectValue = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					id,
					"--expected-draft-revision",
					"1",
					"--op",
					"set",
					"--path",
					"/answer",
					"--value",
					"{}",
				],
				cwd,
			);
			expect(objectValue.stderr).toContain("DI_DRAFT_INVALID_PATH");
			const requiredRemoval = await runDeepInterviewDraftCommand(
				["edit", "--draft-id", id, "--expected-draft-revision", "1", "--op", "remove", "--path", "/question"],
				cwd,
			);
			expect(requiredRemoval.stderr).toContain("DI_DRAFT_INVALID_PATH");
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rejects symlinked storage and inputs, preserves expired drafts, and removes discarded drafts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		try {
			const linkedRoot = path.join(root, "linked-root");
			await fs.symlink(cwd, linkedRoot);
			process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = linkedRoot;
			const unsafeRoot = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "unsafe-root"],
				cwd,
			);
			expect(unsafeRoot.stderr).toContain("DI_DRAFT_UNSAFE_ROOT");

			process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
			await seedState(cwd, "safe-root");
			const created = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "safe-root"],
				cwd,
			);
			const id = JSON.parse(created.stdout!).draft.id as string;
			const draftDirectory = path.join(
				root,
				(await fs.readdir(root, { withFileTypes: true })).find(entry => entry.isDirectory())!.name,
			);
			const draftFile = path.join(draftDirectory, `${id}.json`);
			const secret = path.join(root, "secret");
			await Bun.write(secret, "exfiltration");
			await fs.unlink(draftFile);
			await fs.symlink(secret, draftFile);
			const symlinkDraft = await runDeepInterviewDraftCommand(["show", "--draft-id", id], cwd);
			expect(symlinkDraft.stderr).toContain("DI_DRAFT_CORRUPT");
			await fs.unlink(draftFile);

			await seedState(cwd, "expiry");
			const fresh = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "expiry"],
				cwd,
			);
			const freshId = JSON.parse(fresh.stdout!).draft.id as string;
			const freshFile = path.join(draftDirectory, `${freshId}.json`);
			const expired = JSON.parse(await fs.readFile(freshFile, "utf8"));
			expired.expires_at = new Date(Date.now() - 1).toISOString();
			await fs.writeFile(freshFile, JSON.stringify(expired), { mode: 0o600 });
			await fs.chmod(freshFile, 0o600);
			const expiredResult = await runDeepInterviewDraftCommand(["show", "--draft-id", freshId], cwd);
			expect(expiredResult.stderr).toContain("DI_DRAFT_EXPIRED");
			await expect(fs.lstat(freshFile)).resolves.toBeDefined();

			const discarded = await runDeepInterviewDraftCommand(
				["discard", "--draft-id", freshId, "--expected-draft-revision", "1"],
				cwd,
			);
			expect(discarded.stderr).toContain("DI_DRAFT_EXPIRED");
			expired.expires_at = new Date(Date.now() + 60_000).toISOString();
			await fs.writeFile(freshFile, JSON.stringify(expired), { mode: 0o600 });
			await fs.chmod(freshFile, 0o600);
			const discard = await runDeepInterviewDraftCommand(
				["discard", "--draft-id", freshId, "--expected-draft-revision", "1"],
				cwd,
			);
			expect(discard.status).toBe(0);
			await expect(fs.lstat(freshFile)).rejects.toBeDefined();
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rejects unsafe value files, storage quotas, and cleans locks after errors", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-workspace-"));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-deep-interview-draft-root-"));
		const prior = process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
		process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = root;
		try {
			await seedState(cwd, "limits");
			const created = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "limits"],
				cwd,
			);
			const id = JSON.parse(created.stdout!).draft.id as string;
			const directory = path.join(root, (await fs.readdir(root))[0]!);
			const source = path.join(root, "source");
			const linked = path.join(root, "linked-value");
			await Bun.write(source, "greenfield");
			await fs.symlink(source, linked);
			const unsafeValue = await runDeepInterviewDraftCommand(
				[
					"edit",
					"--draft-id",
					id,
					"--expected-draft-revision",
					"1",
					"--op",
					"set",
					"--path",
					"/type",
					"--value-file",
					linked,
				],
				cwd,
			);
			expect(unsafeValue.stderr).toContain("DI_DRAFT_INVALID_VALUE");
			await expect(fs.lstat(path.join(directory, ".lock"))).rejects.toBeDefined();

			for (let index = 0; index < 256; index++) await Bun.write(path.join(directory, `quota-${index}`), "x");
			const overQuota = await runDeepInterviewDraftCommand(
				["create", "--for", "initialize-context", "--session-id", "over-quota"],
				cwd,
			);
			expect(overQuota.stderr).toContain("DI_DRAFT_STORAGE_QUOTA");
		} finally {
			if (prior === undefined) delete process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT;
			else process.env.GJC_DEEP_INTERVIEW_DRAFT_ROOT = prior;
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
