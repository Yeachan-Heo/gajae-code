import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionFamilyOwnership, type SessionFamilyRootGrant } from "../src/sdk/session-family-ownership";

const roots: string[] = [];
async function fixture(): Promise<{
	root: string;
	workspace: string;
	authority: string;
	ownership: SessionFamilyOwnership;
}> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-owner-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	const authority = path.join(root, "authority");
	await fs.mkdir(workspace);
	return { root, workspace, authority, ownership: new SessionFamilyOwnership(authority) };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("default process profiles share family authority across config and XDG roots", async () => {
	const { root, workspace } = await fixture();
	const home = path.join(root, "home");
	await fs.mkdir(home);
	await Promise.all(
		[".gjc", ".alternate"].map(config => fs.mkdir(path.join(home, `${config}-state`, "gjc"), { recursive: true })),
	);
	const modulePath = fileURLToPath(new URL("../src/sdk/session-family-ownership.ts", import.meta.url));
	const code = `import { SessionFamilyOwnership, resolveSessionFamilyAuthorityDirectory } from ${JSON.stringify(modulePath)};
try {
  const directory = resolveSessionFamilyAuthorityDirectory();
  const owner = new SessionFamilyOwnership(directory);
  const grant = await owner.acquireRoot(process.env.FAMILY_FIXTURE_WORKSPACE);
  if (process.env.FAMILY_FIXTURE_HOLD === "1") {
    const release = Promise.withResolvers();
    process.once("message", () => release.resolve());
    process.send({ kind: "ready", directory });
    await release.promise;
    await owner.releaseAfterTeardown(grant, async () => {});
    process.disconnect();
  } else {
    await owner.releaseAfterTeardown(grant, async () => {});
    process.stdout.write(JSON.stringify({ kind: "ready", directory }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: "refused", code: error.code }));
}`;
	const envFor = (config: string): Record<string, string | undefined> => ({
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GJC_CONFIG_DIR: config,
		PI_CONFIG_DIR: config,
		GJC_CODING_AGENT_DIR: path.join(home, config, "agent"),
		PI_CODING_AGENT_DIR: path.join(home, config, "agent"),
		XDG_STATE_HOME: path.join(home, `${config}-state`),
		FAMILY_FIXTURE_WORKSPACE: workspace,
	});
	const ready = Promise.withResolvers<{ kind: string; directory: string }>();
	const holder = Bun.spawn([process.execPath, "--eval", code], {
		env: { ...envFor(".gjc"), FAMILY_FIXTURE_HOLD: "1" },
		stdout: "pipe",
		stderr: "pipe",
		ipc(message) {
			if (
				message &&
				typeof message === "object" &&
				"directory" in message &&
				typeof message.directory === "string"
			) {
				ready.resolve({ kind: "ready", directory: message.directory });
			}
		},
	});
	void holder.exited.then(() => ready.reject(new Error("Authority fixture exited before admission")));
	try {
		expect(await ready.promise).toEqual({ kind: "ready", directory: path.join(home, ".gjc", "session-families") });
		const contender = Bun.spawn([process.execPath, "--eval", code], {
			env: envFor(".alternate"),
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(contender.stdout).text();
		expect(await contender.exited).toBe(0);
		expect(JSON.parse(output)).toEqual({ kind: "refused", code: "busy_workspace" });
		const isolated = Bun.spawn([process.execPath, "--eval", code], {
			env: {
				...envFor(".gjc"),
				GJC_CODING_AGENT_DIR: path.join(home, "private-profile"),
				PI_CODING_AGENT_DIR: path.join(home, "private-profile"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const refusal = await new Response(isolated.stdout).text();
		expect(await isolated.exited).toBe(0);
		expect(JSON.parse(refusal)).toEqual({ kind: "refused", code: "unsupported" });
		await expect(fs.lstat(path.join(home, "private-profile"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (holder.exitCode === null) holder.send({ release: true });
		await holder.exited;
	}
}, 10000);

test("simultaneous fresh-index admissions have exactly one workspace owner", async () => {
	const { workspace, authority, ownership } = await fixture();
	const competitor = new SessionFamilyOwnership(authority);
	const results = await Promise.allSettled([ownership.acquireRoot(workspace), competitor.acquireRoot(workspace)]);
	const winners = results.filter(result => result.status === "fulfilled");
	const losers = results.filter(result => result.status === "rejected");
	expect(winners).toHaveLength(1);
	expect(losers).toHaveLength(1);
	expect(losers[0]?.reason).toMatchObject({ code: "busy_workspace" });
	const winner = winners[0];
	if (winner?.status !== "fulfilled") throw new Error("Missing admission winner");
	await ownership.releaseAfterTeardown(winner.value, async () => {});
});

test("an owned child and grandchild do not reacquire the root workspace lock", async () => {
	const { workspace, authority, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	const child = await ownership.reserveChild(root);
	await ownership.activateChild(child);
	const grandchild = await ownership.reserveChild(child);
	await ownership.activateChild(grandchild);
	await expect(new SessionFamilyOwnership(authority).acquireRoot(workspace)).rejects.toMatchObject({
		code: "busy_workspace",
	});
	await ownership.completeChild(grandchild, "closed");
	await ownership.completeChild(child, "closed");
	await ownership.releaseAfterTeardown(root, async () => {});
	const successor = await ownership.acquireRoot(workspace, root.sessionId);
	expect(successor.sessionId).toBe(root.sessionId);
	expect(successor.generation).toBeGreaterThan(root.generation);
	await ownership.releaseAfterTeardown(successor, async () => {});
});

test("an incomplete subordinate prevents root release and survives coordinator reconstruction", async () => {
	const { workspace, authority, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	const child = await ownership.reserveChild(root);
	await ownership.activateChild(child);
	await expect(ownership.releaseAfterTeardown(root, async () => {})).rejects.toMatchObject({ code: "uncertain" });
	await expect(new SessionFamilyOwnership(authority).acquireRoot(workspace)).rejects.toMatchObject({
		code: "uncertain",
	});
});

test("cleanup uncertainty cannot be erased by a delayed child completion", async () => {
	const { workspace, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	const child = await ownership.reserveChild(root);
	await ownership.activateChild(child);
	await ownership.completeChild(child, "uncertain");
	await expect(ownership.completeChild(child, "closed")).rejects.toMatchObject({ code: "uncertain" });
	await expect(ownership.releaseAfterTeardown(root, async () => {})).rejects.toMatchObject({ code: "uncertain" });
	await expect(ownership.acquireRoot(workspace)).rejects.toMatchObject({ code: "uncertain" });
});

test("failed runtime teardown preserves its original error and fences successors", async () => {
	const { workspace, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	const failure = new Error("synthetic strict-close uncertainty");
	await expect(
		ownership.releaseAfterTeardown(root, async () => {
			throw failure;
		}),
	).rejects.toBe(failure);
	await expect(ownership.acquireRoot(workspace)).rejects.toMatchObject({ code: "uncertain" });
});

test("serialized grant identifiers and child grants cannot release a root", async () => {
	const { workspace, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	const child = await ownership.reserveChild(root);
	const copied: SessionFamilyRootGrant = structuredClone(root);
	await expect(ownership.releaseAfterTeardown(copied, async () => {})).rejects.toMatchObject({
		code: "stale_reference",
	});
	await expect(
		ownership.releaseAfterTeardown(child as unknown as SessionFamilyRootGrant, async () => {}),
	).rejects.toMatchObject({ code: "unsupported" });
	await ownership.completeChild(child, "closed");
	await ownership.releaseAfterTeardown(root, async () => {});
});

test("stale release cannot remove the next runtime's workspace claim", async () => {
	const { workspace, ownership } = await fixture();
	const first = await ownership.acquireRoot(workspace);
	await ownership.releaseAfterTeardown(first, async () => {});
	const second = await ownership.acquireRoot(workspace);
	await ownership.releaseAfterTeardown(first, async () => {
		throw new Error("A completed teardown must not run again");
	});
	await expect(ownership.acquireRoot(workspace)).rejects.toMatchObject({ code: "busy_workspace" });
	await ownership.releaseAfterTeardown(second, async () => {});
});

test("branch writer uniqueness also applies to subordinate sessions", async () => {
	const { workspace, ownership } = await fixture();
	const root = await ownership.acquireRoot(workspace);
	await expect(ownership.reserveChild(root, root.sessionId)).rejects.toMatchObject({ code: "busy_branch" });
	const child = await ownership.reserveChild(root);
	await expect(ownership.reserveChild(root, child.sessionId)).rejects.toMatchObject({ code: "busy_branch" });
	await ownership.completeChild(child, "closed");
	await ownership.releaseAfterTeardown(root, async () => {});
});

test("nested directories conflict while non-overlapping independent roots can run", async () => {
	const { root: directory, workspace, ownership } = await fixture();
	const nested = path.join(workspace, "nested");
	const independent = path.join(directory, "independent");
	await fs.mkdir(nested);
	await fs.mkdir(independent);
	const root = await ownership.acquireRoot(workspace);
	await expect(ownership.acquireRoot(nested)).rejects.toMatchObject({ code: "busy_workspace" });
	const other = await ownership.acquireRoot(independent);
	await ownership.releaseAfterTeardown(other, async () => {});
	await ownership.releaseAfterTeardown(root, async () => {});
});

test("a subordinate cannot expand its own grant into another workspace", async () => {
	const { root: directory, workspace, ownership } = await fixture();
	const outside = path.join(directory, "outside");
	await fs.mkdir(outside);
	const root = await ownership.acquireRoot(workspace);
	const child = await ownership.reserveChild(root);
	await ownership.activateChild(child);
	await expect(ownership.reserveChild(child, Bun.randomUUIDv7(), outside)).rejects.toMatchObject({
		code: "unsupported",
	});
	await ownership.completeChild(child, "closed");
	await ownership.releaseAfterTeardown(root, async () => {});
});

test("corrupt ownership metadata is not reset to an empty registry", async () => {
	const { workspace, authority, ownership } = await fixture();
	await ownership.acquireRoot(workspace);
	const file = path.join(authority, "sdk", "sessions", "family-ownership.json");
	await Bun.write(file, '{"version":999,"roots":[]}');
	await expect(new SessionFamilyOwnership(authority).acquireRoot(workspace)).rejects.toMatchObject({
		code: "uncertain",
	});
	expect(await Bun.file(file).text()).toBe('{"version":999,"roots":[]}');
});

test("parent process death never reclaims a durable runtime claim", async () => {
	const { workspace, authority, ownership } = await fixture();
	const modulePath = fileURLToPath(new URL("../src/sdk/session-family-ownership.ts", import.meta.url));
	const ready = Promise.withResolvers<void>();
	const code = `import { SessionFamilyOwnership } from ${JSON.stringify(modulePath)};
const owner = new SessionFamilyOwnership(process.env.FAMILY_FIXTURE_AUTHORITY);
await owner.acquireRoot(process.env.FAMILY_FIXTURE_WORKSPACE);
process.send({ ready: true });
await Bun.sleep(60000);`;
	const child = Bun.spawn([process.execPath, "--eval", code], {
		env: { ...process.env, FAMILY_FIXTURE_AUTHORITY: authority, FAMILY_FIXTURE_WORKSPACE: workspace },
		stdout: "ignore",
		stderr: "pipe",
		ipc(message) {
			if (typeof message === "object" && message !== null && "ready" in message) ready.resolve();
		},
	});
	void child.exited.then(() => ready.reject(new Error("Fixture exited before acquiring ownership")));
	try {
		await ready.promise;
		await expect(ownership.acquireRoot(workspace)).rejects.toMatchObject({ code: "busy_workspace" });
		child.kill("SIGKILL");
		await child.exited;
		await expect(ownership.acquireRoot(workspace)).rejects.toMatchObject({ code: "uncertain" });
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}, 10000);
