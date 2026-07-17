import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
import {
	listManagedSessionCandidates,
	resolveManagedSessionScope,
	SESSION_DIRECTORY_API_VERSION,
} from "../src/sdk/session-directory";
import { computeManagedScopeDigest } from "../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("managed session directory SDK", () => {
	it("uses the configured agent layout for the default sessions root", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-layout-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-layout-cwd-"));
		temporaryDirectories.push(agentDir, cwd);

		const resolved = await resolveManagedSessionScope({ cwd, agentDir });

		expect(resolved).toMatchObject({ kind: "resolved", scope: { sessionsRoot: getSessionsDir(agentDir) } });
	});

	it.skipIf(process.platform !== "linux")(
		"honors XDG data layout for the configured default agent directory",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-xdg-"));
			const xdgData = path.join(root, "data");
			const agentDir = path.join(os.homedir(), ".gjc", "agent");
			const cwd = path.join(root, "workspace");
			temporaryDirectories.push(root);
			await fs.mkdir(path.join(xdgData, "gjc"), { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			const previousAgentDir = getAgentDir();
			const previousXdgData = process.env.XDG_DATA_HOME;
			try {
				process.env.XDG_DATA_HOME = xdgData;
				setAgentDir(agentDir);
				const resolved = await resolveManagedSessionScope({ cwd, agentDir });
				expect(resolved).toMatchObject({
					kind: "resolved",
					scope: { sessionsRoot: path.join(xdgData, "gjc", "sessions") },
				});
			} finally {
				if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
				else process.env.XDG_DATA_HOME = previousXdgData;
				setAgentDir(previousAgentDir);
			}
		},
	);
	it("pins the v2 digest wire format", () => {
		expect(computeManagedScopeDigest("posix", "/workspace/a-b/c")).toBe(
			"ckdstvtkkadas65jsj3gvlcstjat5o5yuwifaq2p3qrc5lmran5q",
		);
	});
	it("uses distinct fixed-width v2 components for legacy collision vectors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const first = path.join(root, "a-b", "c");
		const second = path.join(root, "a", "b-c");
		const third = path.join(root, "a--b", "c");
		const fourth = path.join(root, "a", "b--c");
		await Promise.all([
			fs.mkdir(first, { recursive: true }),
			fs.mkdir(second, { recursive: true }),
			fs.mkdir(third, { recursive: true }),
			fs.mkdir(fourth, { recursive: true }),
		]);

		const [left, right, doubleDashLeft, doubleDashRight] = await Promise.all([
			resolveManagedSessionScope({ cwd: first, agentDir, sessionsRoot: path.join(agentDir, "sessions") }),
			resolveManagedSessionScope({ cwd: second, agentDir, sessionsRoot: path.join(agentDir, "sessions") }),
			resolveManagedSessionScope({ cwd: third, agentDir, sessionsRoot: path.join(agentDir, "sessions") }),
			resolveManagedSessionScope({ cwd: fourth, agentDir, sessionsRoot: path.join(agentDir, "sessions") }),
		]);

		expect(SESSION_DIRECTORY_API_VERSION).toBe(1);
		expect(left.kind).toBe("resolved");
		expect(right.kind).toBe("resolved");
		expect(doubleDashLeft.kind).toBe("resolved");
		expect(doubleDashRight.kind).toBe("resolved");
		if (
			left.kind !== "resolved" ||
			right.kind !== "resolved" ||
			doubleDashLeft.kind !== "resolved" ||
			doubleDashRight.kind !== "resolved"
		)
			return;
		expect(left.scope.directoryName).toMatch(/^v2-[a-z2-7]{52}$/);
		expect(left.scope.directoryName).toHaveLength(55);
		expect(left.scope.directoryName).not.toBe(right.scope.directoryName);
		expect(doubleDashLeft.scope.directoryName).not.toBe(doubleDashRight.scope.directoryName);
	});

	it("fails closed when an existing v2 binding identifies another workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		const sessionsRoot = path.join(agentDir, "sessions");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
		const resolved = await resolveManagedSessionScope({ cwd, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		await fs.mkdir(resolved.scope.directoryPath, { mode: 0o700 });
		await fs.writeFile(
			path.join(resolved.scope.directoryPath, ".gjc-managed-session-scope.v2.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				layoutVersion: 2,
				identityVersion: 1,
				platform: process.platform === "win32" ? "win32" : "posix",
				canonicalPath: path.join(root, "other-workspace"),
				identityDigest: resolved.scope.directoryName.slice(3),
			})}\n`,
			{ mode: 0o600 },
		);

		const conflict = await resolveManagedSessionScope({ cwd, agentDir, sessionsRoot });
		expect(conflict).toMatchObject({ kind: "error", code: "binding_conflict" });
	});

	it("lists readonly candidates without creating the absent managed root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const resolved = await resolveManagedSessionScope({ cwd, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		const listed = await listManagedSessionCandidates({ scope: resolved.scope });
		expect(listed).toMatchObject({ kind: "complete", owned: [], invalid: [], foreignCount: 0 });
		await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("maps an alias to the same v2 component while preserving its legacy lexical encoding", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-"));
		temporaryDirectories.push(root);
		const workspace = path.join(root, "workspace", "nested");
		const alias = path.join(root, "workspace-alias");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(workspace, { recursive: true });
		await fs.symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");

		const [direct, viaAlias] = await Promise.all([
			resolveManagedSessionScope({ cwd: workspace, agentDir }),
			resolveManagedSessionScope({ cwd: alias, agentDir }),
		]);
		expect(viaAlias).toMatchObject({
			kind: "resolved",
			scope: {
				canonicalCwd: direct.kind === "resolved" ? direct.scope.canonicalCwd : undefined,
				directoryPath: direct.kind === "resolved" ? direct.scope.directoryPath : undefined,
				legacyLexicalCwd: path.resolve(alias),
			},
		});
		if (viaAlias.kind !== "resolved") return;
		const sessionsRoot = getSessionsDir(agentDir);
		const legacyDirectory = path.join(
			sessionsRoot,
			`--${path
				.resolve(alias)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`,
		);
		await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
		await fs.writeFile(
			path.join(legacyDirectory, "alias-legacy.jsonl"),
			`${JSON.stringify({ type: "session", id: "alias-legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: alias })}\n`,
		);
		const listed = await listManagedSessionCandidates({ scope: viaAlias.scope });
		expect(listed).toMatchObject({
			kind: "complete",
			owned: [expect.objectContaining({ sessionId: "alias-legacy", provenance: "legacy" })],
		});
	});

	it("returns validated legacy candidates without exposing mutable internal identities", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		const cwd = path.join(root, "workspace");
		await Promise.all([
			fs.mkdir(cwd, { recursive: true }),
			fs.mkdir(path.join(root, "other-workspace"), { recursive: true }),
			fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 }),
		]);
		const resolved = await resolveManagedSessionScope({ cwd, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;

		const legacyDirectory = path.join(sessionsRoot, `--${cwd.slice(1).replace(/[\\/]/g, "-")}--`);
		await fs.mkdir(legacyDirectory, { mode: 0o700 });
		await Promise.all([
			fs.writeFile(
				path.join(legacyDirectory, "owned.jsonl"),
				`${JSON.stringify({ type: "session", id: "owned", cwd })}\n`,
				{ mode: 0o600 },
			),
			fs.writeFile(
				path.join(legacyDirectory, "owned-second.jsonl"),
				`${JSON.stringify({ type: "session", id: "owned-second", cwd })}\n`,
				{ mode: 0o600 },
			),
			fs.writeFile(
				path.join(legacyDirectory, "foreign.jsonl"),
				`${JSON.stringify({ type: "session", id: "foreign", cwd: path.join(root, "other-workspace") })}\n`,
				{ mode: 0o600 },
			),
		]);

		const first = await listManagedSessionCandidates({ scope: resolved.scope });
		expect(first).toMatchObject({ kind: "complete", foreignCount: 1 });
		if (first.kind !== "complete") return;
		expect(first.owned).toHaveLength(2);
		const owned = first.owned.find(candidate => candidate.sessionId === "owned");
		const ownedSecond = first.owned.find(candidate => candidate.sessionId === "owned-second");
		expect(owned).toMatchObject({
			provenance: "legacy",
			migrationState: "legacy_unmigrated",
		});
		expect(ownedSecond).toBeDefined();
		if (!owned || !ownedSecond) return;
		const exposed = owned as { identity: { sessionId: string } };
		exposed.identity.sessionId = "mutated";
		expect(ownedSecond.identity.sessionId).toBe("owned-second");

		const second = await listManagedSessionCandidates({ scope: resolved.scope });
		expect(second).toMatchObject({ kind: "complete" });
		if (second.kind !== "complete") return;
		expect(second.owned.find(candidate => candidate.sessionId === "owned")?.identity.sessionId).toBe("owned");
	});
});
