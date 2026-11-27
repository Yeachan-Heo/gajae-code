import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecoveryFsRoot } from "@gajae-code/natives";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../src/sdk/session-directory";
import type { MemoryGuardSessionManagerCheckpointV1 } from "../src/session/memory-guard-checkpoint-participant";
import {
	listProjectSessionTranscriptFiles,
	resolveResumableSession,
	type SessionDestinationInput,
	SessionManager,
} from "../src/session/session-manager";
import { isStagedSessionPath, SESSION_STAGING_DIRNAME } from "../src/session/session-staging-paths";
import { trackTempDirs } from "./helpers/tracked-temp-dirs";

const tempDirs = trackTempDirs();

async function makeTranscript(filePath: string, cwd: string, id: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(
		filePath,
		`${JSON.stringify({ type: "session", version: 5, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("staged session discovery exclusion", () => {
	it("hides staged project transcripts while retaining a sibling transcript", async () => {
		const cwd = await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-discovery-cwd-"));
		const agentDir = await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-discovery-agent-"));
		const scope = path.join(cwd, ".gjc", "sessions", "scope");
		const staged = path.join(scope, SESSION_STAGING_DIRNAME, "attempt.jsonl");
		const sibling = path.join(scope, "sibling.jsonl");
		await makeTranscript(staged, cwd, "staged-id");
		await makeTranscript(sibling, cwd, "sibling-id");

		const sessions = await SessionManager.listManagedForResumePickerReadOnly(cwd, agentDir);
		expect(sessions.map(session => session.path)).toContain(sibling);
		expect(sessions.map(session => session.path)).not.toContain(staged);
		const resumed = await resolveResumableSession("sibling-id", cwd, undefined, undefined, agentDir);
		expect(resumed?.session.path).toBe(sibling);
		const stagedResume = await resolveResumableSession("staged-id", cwd, undefined, undefined, agentDir);
		expect(stagedResume).toBeUndefined();
	});

	it("recognizes staging segments independently of session-layer imports", async () => {
		const stagedPath = path.join("/tmp", "agent-session", SESSION_STAGING_DIRNAME, "attempt.jsonl");
		expect(isStagedSessionPath(stagedPath)).toBe(true);
		expect(isStagedSessionPath(path.join("/tmp", "agent-session", "sibling.jsonl"))).toBe(false);
		expect(isStagedSessionPath(path.join("/srv", SESSION_STAGING_DIRNAME, "gjc-sessions", "session.jsonl"))).toBe(
			false,
		);
		const child = Bun.spawnSync({
			cmd: [
				process.execPath,
				"--eval",
				`
				const identities = JSON.parse(process.argv[1]).map(file => require.resolve(file));
				const loaded = () => identities.map(file => Object.hasOwn(require.cache, file));
				const cold = loaded();
				const leaf = require(identities[0]);
				const afterImport = loaded();
				const results = JSON.parse(process.argv[2]).map(file => leaf.isStagedSessionPath(file));
				const afterUse = loaded();
				// Positive control: the same loader must expose the real session layer
				// and its transitive artifact dependency, but only after the leaf observation.
				require(identities[1]);
				process.stdout.write(JSON.stringify({ cold, afterImport, results, afterUse, control: loaded() }));
				`,
				JSON.stringify(
					["session-staging-paths.ts", "session-manager.ts", "artifacts.ts"].map(file =>
						path.resolve(import.meta.dir, "../src/session", file),
					),
				),
				JSON.stringify([
					stagedPath,
					path.join("/tmp", "agent-session", "sibling.jsonl"),
					path.join("/srv", SESSION_STAGING_DIRNAME, "gjc-sessions", "session.jsonl"),
				]),
			],
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
			killSignal: "SIGKILL",
		});
		expect(new TextDecoder().decode(child.stderr)).toBe("");
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
			cold: [false, false, false],
			afterImport: [true, false, false],
			results: [true, false, false],
			afterUse: [true, false, false],
			control: [true, true, true],
		});
	});

	it("excludes sessions/<cwd>/.staging and agent-session/.staging from all four readers individually", async () => {
		const cwd = await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-four-reader-cwd-"));
		const projectScope = path.join(cwd, ".gjc", "sessions", "cwd-scope");
		const agentSessionScope = path.join(cwd, ".gjc", "agent-session");
		const projectStaged = path.join(projectScope, SESSION_STAGING_DIRNAME, "project-staged.jsonl");
		const agentSessionStaged = path.join(agentSessionScope, SESSION_STAGING_DIRNAME, "agent-staged.jsonl");
		const projectSibling = path.join(projectScope, "project-sibling.jsonl");
		const agentSessionSibling = path.join(agentSessionScope, "agent-sibling.jsonl");
		await makeTranscript(projectStaged, cwd, "project-staged-id");
		await makeTranscript(agentSessionStaged, cwd, "agent-staged-id");
		await makeTranscript(projectSibling, cwd, "project-sibling-id");
		await makeTranscript(agentSessionSibling, cwd, "agent-sibling-id");

		// Reader 1: the direct project transcript walk must skip both staging subtrees.
		const walked = listProjectSessionTranscriptFiles(cwd);
		expect(walked).toContain(projectSibling);
		expect(walked).toContain(agentSessionSibling);
		expect(walked).not.toContain(projectStaged);
		expect(walked).not.toContain(agentSessionStaged);

		// Reader 2: explicit resume-picker listing must skip a staged project scope.
		const projectPicker = await SessionManager.listForResumePickerReadOnly(cwd, projectScope);
		expect(projectPicker.map(session => session.id)).toEqual(["project-sibling-id"]);
		const agentSessionPicker = await SessionManager.listForResumePickerReadOnly(cwd, agentSessionScope);
		expect(agentSessionPicker.map(session => session.id)).toEqual(["agent-sibling-id"]);

		// Reader 3: managed picker/inventory must reject a managed .staging child.
		const managedCwd = await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-cwd-"));
		const managedAgentDir = await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-four-reader-managed-agent-"));
		const managedDestination = SessionManager.managedDestination(managedCwd, managedAgentDir);
		const managedParent = SessionManager.create(managedCwd, managedDestination);
		await managedParent.flush();
		const managedStaged = path.join(managedDestination.directory, SESSION_STAGING_DIRNAME, "managed-staged.jsonl");
		await makeTranscript(managedStaged, managedCwd, "managed-staged-id");
		const managedPicker = await SessionManager.listManagedForResumePickerReadOnly(managedCwd, managedAgentDir);
		expect(managedPicker.map(session => session.id)).not.toContain("managed-staged-id");

		// Reader 4: global managed inventory and --continue resolution both reject it.
		const managedInventory = await SessionManager.listAll(undefined, managedAgentDir);
		expect(managedInventory.map(session => session.id)).not.toContain("managed-staged-id");
		const stagedContinue = await resolveResumableSession(
			"managed-staged-id",
			managedCwd,
			undefined,
			undefined,
			managedAgentDir,
		);
		expect(stagedContinue).toBeUndefined();
		const localContinue = await resolveResumableSession("project-staged-id", cwd, projectScope);
		expect(localContinue).toBeUndefined();
	});
});

describe("memory-guard restore staging transcript exclusion", () => {
	const originalAgentDir = getAgentDir();
	const originalTmux = process.env.TMUX;
	const originalTmuxPane = process.env.TMUX_PANE;
	const openManagers: SessionManager[] = [];

	const useFreshTerminal = (): void => {
		process.env.TMUX = "/tmp/gjc-staged-restore-listing-tmux,1,0";
		process.env.TMUX_PANE = `%staged-restore-listing-${Date.now()}-${Math.random()}`;
	};

	beforeEach(async () => {
		// Append locks live under the trusted home (resolved from os.homedir() at call
		// time), not the agent dir; keep them out of the real home.
		const home = fs.realpathSync(await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-staged-restore-home-")));
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(await tempDirs.mkdtemp(path.join(tmpdir(), "gjc-staged-restore-agent-")), "agent"));
		useFreshTerminal();
	});

	afterEach(async () => {
		for (const manager of openManagers.splice(0)) await manager.close().catch(() => {});
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
	});

	type Fixture = {
		cwd: string;
		destination: SessionDestinationInput;
		originals: string[];
		restoredOriginal: string;
		sessionId: string;
		staged: string;
		listed(): Promise<string[]>;
		cleanup(): Promise<void>;
	};

	async function makeFixture(kind: "managed" | "explicit", state: "live" | "crashed"): Promise<Fixture> {
		const root = await tempDirs.mkdtemp(path.join(tmpdir(), `gjc-staged-restore-${kind}-`));
		const cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		const destination =
			kind === "managed" ? SessionManager.managedDestination(cwd, getAgentDir()) : path.join(root, "sessions");
		const originals: string[] = [];
		let checkpoint: MemoryGuardSessionManagerCheckpointV1 | undefined;
		const now = Date.now() / 1000;
		for (const ordinal of [0, 1, 2]) {
			const manager = SessionManager.create(cwd, destination);
			try {
				// A transcript is persisted once it has an assistant reply; ending on a
				// user message keeps it resumable for --continue.
				manager.appendMessage({ role: "user", content: `original ${ordinal}`, timestamp: ordinal });
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `reply ${ordinal}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: ordinal,
				});
				manager.appendMessage({ role: "user", content: `follow-up ${ordinal}`, timestamp: ordinal });
				await manager.flush();
				// The newest original is the one a crashed memory-guard restore recovers.
				if (ordinal === 2) {
					const lease = manager.acquireMemoryGuardParticipantIngressLease();
					try {
						checkpoint = await manager.createMemoryGuardCheckpoint({
							ingressLease: lease,
							checkpointRoot: path.join(root, "checkpoint"),
						});
					} finally {
						lease.release();
					}
				}
				originals.push(manager.getSessionFile()!);
			} finally {
				await manager.close();
			}
			fs.utimesSync(originals[ordinal]!, now - 300 + ordinal * 100, now - 300 + ordinal * 100);
		}
		const directory = path.dirname(originals[0]!);
		const checkpointRoot = path.join(root, "checkpoint");
		const restored = await SessionManager.restoreMemoryGuardCheckpoint({
			incidentAuthority: {
				readManaged(relativePath: string) {
					try {
						return { ok: true, data: new Uint8Array(fs.readFileSync(path.join(checkpointRoot, relativePath))) };
					} catch {
						return { ok: false };
					}
				},
			} as RecoveryFsRoot,
			participant: {
				ordinal: 0,
				checkpoint: checkpoint!.blob_authority,
				revisions: checkpoint!.revisions,
				session_id: checkpoint!.session_id,
				session_name: checkpoint!.session_name,
				transcript: checkpoint!.transcript,
			},
			checkpoint: checkpoint!,
			destination,
		});
		if (restored.kind !== "staged") throw new Error(`Expected staged recovery, got ${restored.reason}`);
		// "crashed" models the restoring process dying before promotion or cleanup:
		// nothing removes the hidden staged transcript from the destination directory.
		if (state === "crashed") await restored.manager.close();
		const staged = restored.manager.getSessionFile()!;
		expect(path.dirname(staged)).toBe(directory);
		expect(path.basename(staged)).toStartWith(`.${checkpoint!.session_id}.memory-guard.`);
		expect(fs.existsSync(staged)).toBe(true);
		// Any dot-prefixed transcript is hidden, not only memory-guard staging copies.
		await makeTranscript(path.join(directory, ".foo.jsonl"), cwd, "hidden-generic-id");
		return {
			cwd,
			destination,
			originals,
			restoredOriginal: originals[2]!,
			sessionId: checkpoint!.session_id,
			staged,
			async listed() {
				const sessions =
					kind === "managed"
						? await SessionManager.listManagedForResumePickerReadOnly(cwd, getAgentDir())
						: await SessionManager.listForResumePickerReadOnly(cwd, directory);
				return sessions.map(session => session.path).sort();
			},
			cleanup: state === "live" ? restored.cleanup : async () => {},
		};
	}

	for (const kind of ["managed", "explicit"] as const) {
		for (const state of ["live", "crashed"] as const) {
			it(`keeps a ${state} ${kind} staged restore transcript out of the picker and --continue`, async () => {
				const fixture = await makeFixture(kind, state);
				try {
					const listed = await fixture.listed();
					// A new terminal has no breadcrumb, so --continue picks from the inventory.
					useFreshTerminal();
					const continued = await SessionManager.continueRecent(fixture.cwd, fixture.destination);
					openManagers.push(continued);
					expect({ listed, continued: continued.getSessionFile() }).toEqual({
						listed: [...fixture.originals].sort(),
						continued: fixture.restoredOriginal,
					});
				} finally {
					await fixture.cleanup();
				}
			});
		}
	}

	it("keeps a crashed managed staged restore transcript out of every managed inventory and delete authority", async () => {
		const fixture = await makeFixture("managed", "crashed");
		const all = await SessionManager.listAll(undefined, getAgentDir());
		const resolved = await resolveManagedSessionScope({ cwd: fixture.cwd, agentDir: getAgentDir() });
		if (resolved.kind !== "resolved") throw new Error(`Expected a resolved scope, got ${resolved.code}`);
		const sdk = await listManagedSessionCandidates({ scope: resolved.scope });
		if (sdk.kind !== "complete") throw new Error(`Expected a complete listing, got ${sdk.code}`);
		expect({
			all: all.map(session => session.path).sort(),
			sdkForRestoredId: sdk.owned.filter(candidate => candidate.sessionId === fixture.sessionId).map(c => c.path),
			sdkPaths: sdk.owned.map(candidate => candidate.path).sort(),
		}).toEqual({
			all: [...fixture.originals].sort(),
			sdkForRestoredId: [fixture.restoredOriginal],
			sdkPaths: [...fixture.originals].sort(),
		});
		await expect(SessionManager.deleteManagedCandidate(fixture.staged)).rejects.toThrow(
			"Session is not an authorized managed candidate.",
		);
		expect(fs.existsSync(fixture.staged)).toBe(true);
	});
});
