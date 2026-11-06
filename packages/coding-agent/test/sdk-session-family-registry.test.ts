import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { SESSION_FAMILY_FORK_OPERATION } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";
import {
	type RegisterExistingSessionFamilyInput,
	type SessionFamilyReference,
	SessionFamilyRegistry,
} from "../src/sdk/session-family-registry";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
async function fixture() {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-registry-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	const sourceDirectory = path.join(root, "sessions");
	const authority = path.join(root, "authority");
	await fs.mkdir(workspace);
	await fs.mkdir(sourceDirectory);
	const sessionFile = path.join(sourceDirectory, "source.jsonl");
	const header = {
		type: "session",
		version: 5,
		id: "source",
		cwd: workspace,
		timestamp: "2026-01-01T00:00:00Z",
		parentSession: "untrusted-legacy-parent",
	};
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n`);
	const input: RegisterExistingSessionFamilyInput = {
		sessionFile,
		sourceDirectory,
		expectedSessionId: "source",
		expectedCwd: workspace,
		storage: "explicit",
	};
	return { root, workspace, authority, header, input, registry: new SessionFamilyRegistry(authority) };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test.each([
	"accepted",
	"effect_started",
	"awaiting_ready",
	"terminal_ok",
	"terminal_error",
	"terminal_uncertain",
] as const)("a reserved child in %s cannot be registered as an unrelated root", async phase => {
	const { registry, input, authority } = await fixture();
	const index = new SessionIndex(authority);
	await index.updateFamilyOwnershipWithLifecycle(async (_state, ledger) => {
		await ledger.begin("fork-operation", "source-head-destination", {
			operationKey: `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`,
			fingerprint: "source-head-destination",
			intendedSessionId: input.expectedSessionId,
		});
		if (phase !== "accepted") {
			await ledger.transition("fork-operation", phase, {
				...(phase === "terminal_ok" || phase === "terminal_error"
					? { response: { ok: phase === "terminal_ok" } }
					: {}),
				...(phase === "terminal_ok" ? { resultSessionId: input.expectedSessionId } : {}),
			});
		}
	});
	const before = await Bun.file(input.sessionFile).text();
	const familyFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	const stateBefore = await Bun.file(familyFile).text();
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
	expect(await registry.getBranch(input.expectedSessionId)).toBeUndefined();
	expect(await Bun.file(input.sessionFile).text()).toBe(before);
	expect(await Bun.file(familyFile).text()).toBe(stateBefore);
	const observed = await new SessionIndex(authority).readFamilyOwnershipWithLifecycle(async (_state, ledger) =>
		ledger.findFamilyForkBySessionId(input.expectedSessionId),
	);
	expect(observed?.state).toBe(phase);
});

test("independent index transactions reload the original key instead of reserving another child", async () => {
	const { authority } = await fixture();
	const operationKey = `${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`;
	const results = await Promise.all(
		["first", "second"].map(candidate =>
			new SessionIndex(authority).updateFamilyOwnershipWithLifecycle(async (_state, ledger) =>
				ledger.begin(candidate, candidate, {
					operationKey,
					fingerprint: candidate,
					intendedSessionId: `${candidate}-child`,
				}),
			),
		),
	);
	expect(results.filter(result => result.kind === "new")).toHaveLength(1);
	expect(results.filter(result => result.kind === "idempotency_conflict")).toHaveLength(1);
	const winner = results.find(result => result.kind === "new");
	if (winner?.kind !== "new") throw new Error("Missing reservation winner");
	const index = new SessionIndex(authority);
	const before = await index.readFamilyOwnership(async state => state.revision);
	const observed = await index.readFamilyOwnershipWithLifecycle(async (_state, ledger) =>
		ledger.findAnyByOperationKey(operationKey),
	);
	expect(observed).toEqual(winner.entry);
	expect(await index.readFamilyOwnership(async state => state.revision)).toBe(before);
});

test("two processes cannot reserve different children for the same original key", async () => {
	const { root, authority } = await fixture();
	const home = path.join(root, "home");
	await fs.mkdir(home);
	const modulePath = url.fileURLToPath(new URL("../src/sdk/broker/session-index.ts", import.meta.url));
	const code = `import { SessionIndex } from ${JSON.stringify(modulePath)};
const start = Promise.withResolvers();
process.once("message", () => start.resolve());
process.send("ready");
await start.promise;
const candidate = process.env.FAMILY_FIXTURE_CANDIDATE;
const result = await new SessionIndex(process.env.FAMILY_FIXTURE_AUTHORITY).updateFamilyOwnershipWithLifecycle(
  async (_state, ledger) => ledger.begin(candidate, candidate, {
    operationKey: ${JSON.stringify(`${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`)},
    fingerprint: candidate,
    intendedSessionId: candidate + "-child",
  }),
);
process.stdout.write(JSON.stringify(result));
process.disconnect();`;
	const readiness = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const children = ["first", "second"].map((candidate, index) => {
		const ready = readiness[index];
		const child = Bun.spawn([process.execPath, "--eval", code], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				GJC_CONFIG_DIR: ".gjc",
				PI_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				PI_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"),
				XDG_STATE_HOME: path.join(home, "state"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				FAMILY_FIXTURE_AUTHORITY: authority,
				FAMILY_FIXTURE_CANDIDATE: candidate,
			},
			stdout: "pipe",
			stderr: "pipe",
			ipc(message) {
				if (message === "ready") ready.resolve();
			},
		});
		void child.exited.then(() => ready.reject(new Error("Reservation fixture exited before admission")));
		return child;
	});
	try {
		await Promise.all(readiness.map(ready => ready.promise));
		for (const child of children) child.send("start");
		const results = await Promise.all(
			children.map(async child => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				return JSON.parse(stdout) as { kind: string; entry?: { intendedSessionId: string } };
			}),
		);
		expect(results.filter(result => result.kind === "new")).toHaveLength(1);
		expect(results.filter(result => result.kind === "idempotency_conflict")).toHaveLength(1);
		const winner = results.find(result => result.kind === "new");
		if (!winner?.entry) throw new Error("Missing durable reservation winner");
		const observed = await new SessionIndex(authority).readFamilyOwnershipWithLifecycle(async (_state, ledger) =>
			ledger.findAnyByOperationKey(`${SESSION_FAMILY_FORK_OPERATION}\u0000original-key`),
		);
		expect(observed).toMatchObject({ state: "accepted", intendedSessionId: winner.entry.intendedSessionId });
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all(children.map(child => child.exited));
	}
});

test("registration refuses unknown reservation history without rewriting a private transcript", async () => {
	const { registry, input, authority } = await fixture();
	await new SessionIndex(authority).updateFamilyOwnership(async () => undefined);
	await Bun.write(path.join(authority, "sdk", "lifecycle-ledger.jsonl"), "{invalid}\n");
	const before = await Bun.file(input.sessionFile).text();
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "io_error" });
	expect(await registry.getBranch(input.expectedSessionId)).toBeUndefined();
	expect(await Bun.file(input.sessionFile).text()).toBe(before);
});

test("registration is idempotent across concurrent instances and preserves original bytes and physical metadata", async () => {
	const { registry, input, authority } = await fixture();
	const before = await fs.stat(input.sessionFile, { bigint: true });
	const bytes = await Bun.file(input.sessionFile).text();
	const [first, second] = await Promise.all([
		registry.registerExisting(input),
		new SessionFamilyRegistry(authority).registerExisting(input),
	]);
	expect(second).toEqual(first);
	expect(first).toMatchObject({
		familyId: "source",
		branchId: "source",
		parentBranchId: null,
		anchor: null,
		device: String(before.dev),
		inode: String(before.ino),
	});
	expect(first.resourceId).not.toBe(first.branchId);
	expect(await registry.getBranch("source")).toEqual(first);
	expect(await new SessionFamilyRegistry(authority).listFamily("source")).toEqual([first]);
	expect(await registry.listForWorkspace(input.expectedCwd)).toEqual([first]);
	const after = await fs.stat(input.sessionFile, { bigint: true });
	expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs, after.size]).toEqual([
		before.dev,
		before.ino,
		before.mtimeNs,
		before.ctimeNs,
		before.size,
	]);
	expect(await Bun.file(input.sessionFile).text()).toBe(bytes);
});

test("symlink-directory and hardlink aliases return the original reference", async () => {
	const { root, registry, input } = await fixture();
	const alias = path.join(root, "alias");
	await fs.symlink(input.sourceDirectory, alias, "dir");
	const hardlink = path.join(input.sourceDirectory, "hardlink.jsonl");
	await fs.link(input.sessionFile, hardlink);
	const first = await registry.registerExisting(input);
	expect(
		await registry.registerExisting({
			...input,
			sourceDirectory: alias,
			sessionFile: path.join(alias, "source.jsonl"),
		}),
	).toEqual(first);
	expect(await registry.registerExisting({ ...input, sessionFile: hardlink })).toEqual(first);
	expect(await registry.listFamily(first.familyId)).toEqual([first]);
});

test("read-only alias capture cannot grant writable capture and detects mutation and replacement", async () => {
	const { input } = await fixture();
	const alias = path.join(input.sourceDirectory, "alias.jsonl");
	await fs.link(input.sessionFile, alias);
	expect(SessionManager.captureTranscriptStrict(input.sessionFile).kind).toBe("error");
	const captured = SessionManager.captureTranscriptReadOnly(alias);
	if (captured.kind !== "captured") throw new Error("Missing read-only capture");
	try {
		expect(Object.keys(captured.snapshot).sort()).toEqual(["close", "forEachLine", "identity", "revalidate"]);
		expect(captured.snapshot.revalidate()).toEqual({ kind: "valid" });
		await fs.appendFile(
			input.sessionFile,
			`${JSON.stringify({ type: "header_patch", patch: { title: "changed" } })}\n`,
		);
		expect(captured.snapshot.revalidate().kind).toBe("error");
	} finally {
		captured.snapshot.close();
	}
	const replacementCapture = SessionManager.captureTranscriptReadOnly(alias);
	if (replacementCapture.kind !== "captured") throw new Error("Missing replacement capture");
	try {
		const replacement = path.join(input.sourceDirectory, "replacement.jsonl");
		await Bun.write(replacement, await Bun.file(alias).text());
		await fs.rename(replacement, alias);
		expect(replacementCapture.snapshot.revalidate().kind).toBe("error");
	} finally {
		replacementCapture.snapshot.close();
	}
});

test("a symlink escaping the trusted source directory is rejected", async () => {
	const { root, registry, input } = await fixture();
	const outside = path.join(root, "outside.jsonl");
	await fs.rename(input.sessionFile, outside);
	await fs.symlink(outside, input.sessionFile);
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
});

test("same logical ID at a different physical file and same-path replacement are rejected", async () => {
	const { registry, input } = await fixture();
	const first = await registry.registerExisting(input);
	const copy = path.join(input.sourceDirectory, "copy.jsonl");
	await Bun.write(copy, await Bun.file(input.sessionFile).text());
	await expect(registry.registerExisting({ ...input, sessionFile: copy })).rejects.toMatchObject({
		code: "identity_conflict",
	});
	await fs.rename(copy, input.sessionFile);
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
	expect(await registry.getBranch(first.branchId)).toEqual(first);
});

test("validated header ID and exact canonical cwd must agree with caller expectations", async () => {
	const { root, registry, input } = await fixture();
	const sibling = path.join(root, "sibling");
	await fs.mkdir(sibling);
	await expect(registry.registerExisting({ ...input, expectedSessionId: "caller-id" })).rejects.toMatchObject({
		code: "identity_conflict",
	});
	await expect(registry.registerExisting({ ...input, expectedCwd: sibling })).rejects.toMatchObject({
		code: "identity_conflict",
	});
	const alias = path.join(root, "workspace-alias");
	await fs.symlink(input.expectedCwd, alias, "dir");
	expect((await registry.registerExisting({ ...input, expectedCwd: alias })).cwd).toBe(input.expectedCwd);
});

test("last valid header cwd patch is honored without inferring legacy ancestry", async () => {
	const { root, header, registry, input } = await fixture();
	const next = path.join(root, "next");
	await fs.mkdir(next);
	await Bun.write(
		input.sessionFile,
		`${[
			header,
			{ type: "header_patch", patch: { cwd: "/unavailable-intermediate-cwd" } },
			{ type: "header_patch", patch: { cwd: next } },
		]
			.map(record => JSON.stringify(record))
			.join("\n")}\n`,
	);
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
	const record = await registry.registerExisting({ ...input, expectedCwd: next });
	expect(record.cwd).toBe(next);
	expect(record.parentBranchId).toBeNull();
});

test("legacy headers ignore cwd patches and invalid or future metadata fails closed", async () => {
	const { header, registry, input } = await fixture();
	await Bun.write(
		input.sessionFile,
		`${JSON.stringify({ ...header, version: 3 })}\n${JSON.stringify({ type: "header_patch", patch: { cwd: "/unavailable-legacy-patch" } })}\n`,
	);
	expect((await registry.registerExisting(input)).cwd).toBe(input.expectedCwd);
	for (const records of [
		[{ ...header, version: 999 }],
		[header, { type: "header_patch", patch: { cwd: 42 } }],
		[header, { type: "header_patch", patch: { cwd: input.expectedCwd, unknown: true } }],
		[header, header],
	]) {
		await Bun.write(input.sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
		await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "invalid_transcript" });
	}
});

test("metadata survives deleted transcripts and reconstructed registries", async () => {
	const { registry, input, authority } = await fixture();
	const reference = await registry.registerExisting(input);
	await fs.unlink(input.sessionFile);
	const reconstructed = new SessionFamilyRegistry(authority);
	expect(await reconstructed.listFamily(reference.familyId)).toEqual([reference]);
	expect(await reconstructed.getBranch(reference.branchId)).toEqual(reference);
	expect(await reconstructed.listForWorkspace(input.expectedCwd)).toEqual([reference]);
});

test("malformed, future, invalid and duplicate state records are not reset", async () => {
	const { registry, input, authority } = await fixture();
	const reference = await registry.registerExisting(input);
	const stateFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	for (const contents of [
		"{broken",
		JSON.stringify({ version: 2, revision: 0, roots: [], branches: [] }),
		JSON.stringify({ version: 1, revision: 0, roots: [], branches: [{ ...reference, inode: "invalid" }] }),
		JSON.stringify({ version: 1, revision: 0, roots: [], branches: [reference, reference] }),
	]) {
		await Bun.write(stateFile, contents);
		await expect(registry.getBranch("source")).rejects.toMatchObject({ code: "invalid_state" });
		await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "invalid_state" });
		expect(await Bun.file(stateFile).text()).toBe(contents);
	}
});

test("missing branch inventory fails closed without changing root transaction API", async () => {
	const { registry, authority } = await fixture();
	const index = new SessionIndex(authority);
	await index.updateFamilyOwnership(async state => {
		expect(state.branches).toEqual([]);
	});
	const stateFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	await Bun.write(stateFile, JSON.stringify({ version: 1, revision: 7, roots: [] }));
	await expect(registry.listFamily("absent")).rejects.toMatchObject({ code: "invalid_state" });
	await expect(index.updateFamilyOwnership(async () => {})).rejects.toMatchObject({ code: "invalid_state" });
	expect(await Bun.file(stateFile).json()).toEqual({ version: 1, revision: 7, roots: [] });
});

test("child lineage requires an anchored acyclic chain to its own retained root", async () => {
	const { registry, input, authority } = await fixture();
	const root = await registry.registerExisting(input);
	const child: SessionFamilyReference = {
		...root,
		branchId: "child",
		resourceId: "child-resource",
		sessionFile: path.join(input.sourceDirectory, "child.jsonl"),
		inode: "999999991",
		parentBranchId: root.branchId,
		anchor: { entryId: null, capturedDigest: "a".repeat(64), inclusionMode: "complete-committed-snapshot" },
	};
	const grandchild = {
		...child,
		branchId: "grandchild",
		resourceId: "grandchild-resource",
		sessionFile: path.join(input.sourceDirectory, "grandchild.jsonl"),
		inode: "999999992",
		parentBranchId: child.branchId,
	};
	const stateFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	const valid = { version: 1, revision: 1, roots: [], branches: [root, child, grandchild] };
	await Bun.write(stateFile, JSON.stringify(valid));
	expect(await registry.listFamily(root.familyId)).toEqual(valid.branches);
	for (const branches of [
		[root, { ...child, anchor: null }],
		[root, { ...child, parentBranchId: child.branchId }],
		[root, { ...child, parentBranchId: "missing" }],
		[child],
		[root, { ...child, familyId: "missing-family" }],
		[root, { ...child, parentBranchId: grandchild.branchId }, grandchild],
		[
			root,
			{ ...child, familyId: "other-root", parentBranchId: root.branchId },
			{
				...root,
				branchId: "other-root",
				familyId: "other-root",
				resourceId: "other-resource",
				sessionFile: path.join(input.sourceDirectory, "other.jsonl"),
				inode: "999999993",
			},
		],
	]) {
		const contents = JSON.stringify({ ...valid, branches });
		await Bun.write(stateFile, contents);
		await expect(registry.listFamily(root.familyId)).rejects.toMatchObject({ code: "invalid_state" });
		expect(await Bun.file(stateFile).text()).toBe(contents);
	}
});

test("workspace overlap queries do not rewrite stored family metadata", async () => {
	const { registry, input, authority } = await fixture();
	const reference = await registry.registerExisting(input);
	const nested = path.join(input.expectedCwd, "nested");
	await fs.mkdir(nested);
	const stateFile = path.join(authority, "sdk", "sessions", "family-ownership.json");
	const bytes = await Bun.file(stateFile).text();
	const before = await fs.stat(stateFile, { bigint: true });
	expect(await registry.listForWorkspace(nested)).toEqual([reference]);
	expect(await registry.listFamily(reference.familyId)).toEqual([reference]);
	expect(await registry.getBranch(reference.branchId)).toEqual(reference);
	expect(await registry.getBranch("missing")).toBeUndefined();
	const after = await fs.stat(stateFile, { bigint: true });
	expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
	expect(await Bun.file(stateFile).text()).toBe(bytes);
});

test("managed provenance is canonical metadata, never inferred from explicit registration", async () => {
	const { root, registry, input } = await fixture();
	const managedAgentDir = path.join(root, "agent");
	await fs.mkdir(managedAgentDir);
	await expect(registry.registerExisting({ ...input, storage: "managed" })).rejects.toMatchObject({
		code: "invalid_input",
	});
	await expect(registry.registerExisting({ ...input, managedAgentDir })).rejects.toMatchObject({
		code: "invalid_input",
	});
	const reference = await registry.registerExisting({ ...input, storage: "managed", managedAgentDir });
	expect(reference).toMatchObject({ storage: "managed", managedAgentDir });
	await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
});

test("failed captured-source revalidation prevents publication and capture always closes", async () => {
	const { registry, input } = await fixture();
	const original = SessionManager.captureTranscriptReadOnly;
	let closed = false;
	// A method spy preserves the real bounded capture and changes only the revalidation boundary.
	const spy = spyOn(SessionManager, "captureTranscriptReadOnly").mockImplementation((...args) => {
		const result = original(...args);
		if (result.kind === "captured") {
			const close = result.snapshot.close.bind(result.snapshot);
			result.snapshot.close = () => {
				closed = true;
				close();
			};
			result.snapshot.revalidate = () => ({ kind: "error", reason: "identity-mismatch" });
		}
		return result;
	});
	try {
		await expect(registry.registerExisting(input)).rejects.toMatchObject({ code: "identity_conflict" });
		expect(closed).toBe(true);
		expect(await registry.listFamily("source")).toEqual([]);
	} finally {
		spy.mockRestore();
	}
});
