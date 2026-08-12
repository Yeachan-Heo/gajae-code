import { describe, expect, it, spyOn } from "bun:test";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FallbackTriggerClass } from "@gajae-code/ai/utils/fallback-transport";
import { getTerminalId } from "@gajae-code/tui";
import { getTerminalSessionsDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import * as sdkModule from "../src/sdk";
import { ArtifactManager } from "../src/session/artifacts";
import { ManagedTreeMoveOutcomeError } from "../src/session/internal/managed-session-storage";
import { resolveResumableSession, SessionManager } from "../src/session/session-manager";
import {
	type AutoroutingPreflightFailure,
	classifyAutoroutingPreflightFailure,
	runSubprocess,
	runSubprocessOnce,
} from "../src/task/executor";
import {
	type AutoroutingAttempt,
	type AutoroutingAttemptCode,
	assertRoutingEvidenceInvariant,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	type TaskRoutingEvidence,
} from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

const agent = {
	name: "task",
	description: "test agent",
	systemPrompt: "test",
	source: "bundled" as const,
};

const routing: TaskRoutingEvidence = {
	tier: "balanced",
	source: "tiers",
	requestedSelector: "anthropic/model",
	effectiveModel: "anthropic/model",
	substitutions: [],
};

type ProbePhase = { kind: "pass" } | { kind: "failure"; failure: AutoroutingPreflightFailure };

type DurablePhase =
	| { kind: "accepted" }
	| { kind: "failure"; failure: AutoroutingPreflightFailure }
	| { kind: "prepare_throw"; failure: AutoroutingPreflightFailure }
	| { kind: "post_fence"; class: FallbackTriggerClass }
	| { kind: "rename_failure" }
	| { kind: "uncertain_publish" }
	| { kind: "reservation_failure" };

type CandidateScript = {
	selector: string;
	probe: ProbePhase;
	durable: DurablePhase;
};

type ResidueSnapshot = {
	finalBytes: string | null;
	breadcrumbBytes: string | null;
	listing: string[];
	artifactTree: string;
	allocatedIds: readonly string[];
	agentUris: string[];
	resumeVisible: boolean;
};

type LedgerRun = {
	attempts: AutoroutingAttempt[];
	failedSnapshots: Array<{ before: ResidueSnapshot; after: ResidueSnapshot }>;
	finalPath: string;
	artifactRoot: string;
	stagingRoot: string;
	finalExists: boolean;
	finalText: string | null;
	artifactTree: string;
	stagingTree: string;
	listing: string[];
	parentListing: string[];
	allocatedIds: readonly string[];
	agentUris: string[];
	sessionInitCount: number;
	liveHandles: number;
	lifecycleStarts: number;
	modelFallbackSwitched: number;
	parentModelSubstitution: boolean;
	resumeVisible: boolean;
	terminal: "preflight_exhausted" | "post_acceptance_failure" | "accepted" | undefined;
	managed: boolean;
	uncertainArtifactId: string | undefined;
};

type HarnessContext = {
	root: string;
	cwd: string;
	agentDir: string;
	finalPath: string;
	artifactRoot: string;
	stagingRoot: string;
	parentArtifacts: ArtifactManager;
	parentManager?: SessionManager;
	managed: boolean;
};

const fallbackClasses: FallbackTriggerClass[] = ["rate_limit", "quota", "auth", "server", "unknown", "other"];

function retryCode(failure: AutoroutingPreflightFailure): AutoroutingAttemptCode {
	if (failure.kind === "local" && failure.op === "auth_resolve") return "credential_unavailable";
	if (
		failure.kind === "local" &&
		(failure.op === "session_open" || failure.op === "tool_bootstrap") &&
		failure.transient
	)
		return "spawn_transient_retry";
	if (failure.kind === "local" && (failure.op === "preflight_validation" || !failure.transient))
		return "config_invalid_terminal";
	return "unclassified_terminal";
}

async function snapshotTree(root: string, skipStaging = false): Promise<string> {
	const entries: string[] = [];
	const walk = async (directory: string, relative: string): Promise<void> => {
		let children: Dirent[];
		try {
			children = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
			if (/^\.gjc-(?:exact-(?:replace-destination|unlink-placeholder)|receipt-remove)-/.test(child.name)) continue;
			if (skipStaging && child.isDirectory() && child.name === ".staging") continue;
			const childPath = path.join(directory, child.name);
			const childRelative = path.join(relative, child.name);
			if (child.isDirectory()) {
				await walk(childPath, childRelative);
				continue;
			}
			if (child.isFile()) entries.push(`${childRelative}\0${(await readFile(childPath)).toString("base64")}`);
		}
	};
	await walk(root, "");
	return JSON.stringify(entries.sort());
}

async function bytesOrNull(filePath: string): Promise<string | null> {
	try {
		return (await readFile(filePath)).toString("base64");
	} catch {
		return null;
	}
}

async function breadcrumbBytes(): Promise<string | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;
	return bytesOrNull(path.join(getTerminalSessionsDir(), terminalId));
}

async function enumerateAgentUris(root: string): Promise<string[]> {
	let names: string[] = [];
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	return names
		.filter(name => /^(\d+)\.[^.]+\.log$/u.test(name))
		.map(name => `agent://${name.slice(0, name.indexOf("."))}`)
		.sort();
}

async function createHarnessContext(managed: boolean): Promise<HarnessContext> {
	const root = await mkdtemp(path.join(tmpdir(), managed ? "gjc-preflight-managed-" : "gjc-preflight-"));
	const cwd = path.join(root, "cwd");
	const agentDir = path.join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	if (managed) {
		const parentManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		await parentManager.flush();
		const parentArtifacts = parentManager.getArtifactManager();
		if (!parentArtifacts) throw new Error("managed parent artifact manager unavailable");
		await parentArtifacts.save("parent-sibling", "tool");
		const finalPath = path.join(parentArtifacts.dir, "candidate.jsonl");
		return {
			root,
			cwd,
			agentDir,
			finalPath,
			artifactRoot: parentArtifacts.dir,
			stagingRoot: path.join(parentArtifacts.dir, ".staging"),
			parentArtifacts,
			parentManager,
			managed,
		};
	}
	const finalPath = path.join(root, "candidate.jsonl");
	const parentArtifacts = new ArtifactManager(path.join(root, "candidate"));
	await parentArtifacts.save("parent-sibling", "tool");
	return {
		root,
		cwd,
		agentDir,
		finalPath,
		artifactRoot: parentArtifacts.dir,
		stagingRoot: path.join(root, ".staging"),
		parentArtifacts,
		managed,
	};
}

async function listContext(ctx: HarnessContext): Promise<string[]> {
	const sessions = ctx.managed
		? await SessionManager.listManagedForResumePickerReadOnly(ctx.cwd, ctx.agentDir)
		: await SessionManager.listForResumePickerReadOnly(ctx.cwd, path.dirname(ctx.finalPath));
	return sessions.map(session => `${session.id}:${session.path}`).sort();
}

async function residueSnapshot(ctx: HarnessContext): Promise<ResidueSnapshot> {
	const sessionArg = path.basename(ctx.finalPath, ".jsonl");
	const resume = ctx.managed
		? await resolveResumableSession(sessionArg, ctx.cwd, undefined, undefined, ctx.agentDir)
		: await resolveResumableSession(sessionArg, ctx.cwd, path.dirname(ctx.finalPath));
	return {
		finalBytes: await bytesOrNull(ctx.finalPath),
		breadcrumbBytes: await breadcrumbBytes(),
		listing: await listContext(ctx),
		artifactTree: await snapshotTree(ctx.artifactRoot),
		allocatedIds: ctx.parentArtifacts.getAllocatedIds(),
		agentUris: await enumerateAgentUris(ctx.artifactRoot),
		resumeVisible: resume !== undefined,
	};
}

async function openStagedCandidate(ctx: HarnessContext, attemptId: string): Promise<SessionManager> {
	if (!ctx.managed) return SessionManager.openStaged(ctx.finalPath, undefined, attemptId);
	const store = ctx.parentArtifacts.getManagedStore();
	if (!store) throw new Error("managed artifact store unavailable");
	const destination = SessionManager.nestedManagedDestination(store, ctx.parentArtifacts.dir);
	return SessionManager.openStagedNestedManaged(ctx.finalPath, destination, store, undefined, attemptId);
}

/**
 * Scripted lifecycle harness: provider transport and AgentSession callbacks are not injectable
 * through the public executor seam, so phases are typed here while every session/artifact,
 * publication, discard, listing, and rollback assertion uses the real runtime APIs.
 */
async function runScriptedLedger(scripts: CandidateScript[], managed = false): Promise<LedgerRun> {
	const ctx = await createHarnessContext(managed);
	let uncertainArtifactId: string | undefined;
	const attempts: AutoroutingAttempt[] = [];
	const failedSnapshots: Array<{ before: ResidueSnapshot; after: ResidueSnapshot }> = [];
	const consumed = new Set<string>();
	let terminal: LedgerRun["terminal"];
	let liveHandles = 0;
	let lifecycleStarts = 0;
	let modelFallbackSwitched = 0;
	const parentModelSubstitution = false;
	for (const script of scripts) {
		if (consumed.size >= 3 || consumed.has(script.selector)) continue;
		consumed.add(script.selector);
		if (script.probe.kind === "failure") {
			const code = retryCode(script.probe.failure);
			attempts.push({ selector: script.selector, phase: "probe", code });
			if (code !== "spawn_transient_retry" && code !== "credential_unavailable") {
				terminal = "preflight_exhausted";
				break;
			}
			continue;
		}
		attempts.push({ selector: script.selector, phase: "probe", code: "probe_passed" });
		if (script.durable.kind === "rename_failure") await writeFile(ctx.finalPath, "pre-existing-final-bytes");
		const before = await residueSnapshot(ctx);
		let manager: SessionManager | undefined;
		try {
			if (script.durable.kind === "prepare_throw") throw script.durable.failure;
			manager = await openStagedCandidate(ctx, `attempt-${consumed.size}`);
		} catch (error) {
			await manager?.discardStaged();
			await manager?.discardStaged();
			const failure =
				script.durable.kind === "prepare_throw"
					? script.durable.failure
					: classifyAutoroutingPreflightFailure(error, "session_open");
			const code = retryCode(failure);
			attempts.push({ selector: script.selector, phase: "durable", code });
			const after = await residueSnapshot(ctx);
			failedSnapshots.push({ before, after });
			if (code !== "spawn_transient_retry" && code !== "credential_unavailable") {
				terminal = "preflight_exhausted";
				break;
			}
			continue;
		}
		const durable = script.durable;
		let stagedId: string | undefined;
		if (!ctx.managed) {
			stagedId = await manager.saveArtifact(`candidate-${script.selector}`, "tool");
			if (stagedId !== undefined)
				manager.appendMessage({ role: "user", content: `artifact://${stagedId}`, timestamp: Date.now() });
		}
		if (ctx.managed && durable.kind === "rename_failure") {
			await manager.flush();
			await manager.discardStaged();
			await manager.discardStaged();
			attempts.push({ selector: script.selector, phase: "durable", code: "post_acceptance_failure" });
			const after = await residueSnapshot(ctx);
			failedSnapshots.push({ before, after });
			terminal = "post_acceptance_failure";
			break;
		}
		if (ctx.managed && durable.kind === "uncertain_publish") {
			manager.appendSessionInit({ systemPrompt: "test", task: script.selector, tools: [] });
			const uncertainArtifact = await manager.saveArtifact(`candidate-${script.selector}`, "tool");
			await manager.flush();
			const store = ctx.parentArtifacts.getManagedStore();
			if (!store) throw new Error("managed artifact store unavailable");
			const realMove = store.moveFileNoReplace.bind(store);
			// Native completes the rename and still fails to prove durability/identity.
			const move = spyOn(store, "moveFileNoReplace").mockImplementation((source, destination, expected, options) => {
				realMove(source, destination, expected, options);
				throw new ManagedTreeMoveOutcomeError("managed_publish_fsync_failed", false);
			});
			try {
				await expect(manager.commitStagedNestedManaged()).rejects.toThrow(/committed without proof/);
			} finally {
				move.mockRestore();
			}
			// Mirror the executor's full compensation: post-fence rollback, then the
			// pre-fence discard its `finally` always runs when the fence never opened.
			await manager.rollbackCommittedStaged();
			await manager.discardStaged();
			await manager.discardStaged();
			uncertainArtifactId = uncertainArtifact;
			attempts.push({ selector: script.selector, phase: "durable", code: "post_acceptance_failure" });
			const after = await residueSnapshot(ctx);
			failedSnapshots.push({ before, after });
			terminal = "post_acceptance_failure";
			break;
		}
		if (ctx.managed && durable.kind === "accepted") {
			manager.appendSessionInit({ systemPrompt: "test", task: script.selector, tools: [] });
			await manager.commitStagedNestedManaged();
			await manager.flush();
			liveHandles++;
			lifecycleStarts++;
			attempts.push({ selector: script.selector, phase: "durable", code: "accepted" });
			terminal = "accepted";
			break;
		}
		if (durable.kind === "failure") {
			await manager.flush();
			await manager.discardStaged();
			await manager.discardStaged();
			const code = retryCode(durable.failure);
			attempts.push({ selector: script.selector, phase: "durable", code });
			const after = await residueSnapshot(ctx);
			failedSnapshots.push({ before, after });
			if (code !== "spawn_transient_retry" && code !== "credential_unavailable") {
				terminal = "preflight_exhausted";
				break;
			}
			continue;
		}
		if (durable.kind === "rename_failure") {
			await expect(manager.commitStaged()).rejects.toThrow();
			await manager.discardStaged();
			attempts.push({ selector: script.selector, phase: "durable", code: "post_acceptance_failure" });
			const after = await residueSnapshot(ctx);
			failedSnapshots.push({ before, after });
			terminal = "post_acceptance_failure";
			break;
		}
		if (durable.kind === "reservation_failure") {
			const stagedArtifacts = manager.getArtifactManager();
			if (!stagedArtifacts) throw new Error("staged artifact manager unavailable");
			(stagedArtifacts as unknown as { listFiles: () => Promise<string[]> }).listFiles = async () => {
				throw new Error("injected reservation failure");
			};
			await expect(manager.commitStaged()).rejects.toThrow("injected reservation failure");
			await manager.discardStaged();
			attempts.push({ selector: script.selector, phase: "durable", code: "post_acceptance_failure" });
			terminal = "post_acceptance_failure";
			break;
		}
		if (durable.kind === "post_fence") {
			await manager.commitStaged();
			manager.appendSessionInit({ systemPrompt: "test", task: script.selector, tools: [] });
			await manager.flush();
			modelFallbackSwitched += 0;
			attempts.push({ selector: script.selector, phase: "durable", code: "post_acceptance_failure" });
			terminal = "post_acceptance_failure";
			break;
		}
		await manager.commitStaged();
		manager.appendSessionInit({ systemPrompt: "test", task: script.selector, tools: [] });
		await manager.flush();
		liveHandles++;
		lifecycleStarts++;
		attempts.push({ selector: script.selector, phase: "durable", code: "accepted" });
		terminal = "accepted";
		break;
	}
	if (!terminal && consumed.size >= 3) terminal = "preflight_exhausted";
	const finalText = await bytesOrNull(ctx.finalPath);
	const decodedFinalText = finalText === null ? null : Buffer.from(finalText, "base64").toString("utf8");
	const sessionInitCount = decodedFinalText?.match(/"type":"session_init"/gu)?.length ?? 0;
	const parentListing = await listContext(ctx);
	const finalResume = ctx.managed
		? await resolveResumableSession(
				path.basename(ctx.finalPath, ".jsonl"),
				ctx.cwd,
				undefined,
				undefined,
				ctx.agentDir,
			)
		: await resolveResumableSession(path.basename(ctx.finalPath, ".jsonl"), ctx.cwd, path.dirname(ctx.finalPath));
	return {
		attempts,
		failedSnapshots,
		finalPath: ctx.finalPath,
		artifactRoot: ctx.artifactRoot,
		stagingRoot: ctx.stagingRoot,
		finalExists: finalText !== null,
		finalText: decodedFinalText,
		artifactTree: await snapshotTree(ctx.artifactRoot),
		stagingTree: await snapshotTree(ctx.stagingRoot),
		listing: parentListing,
		parentListing,
		allocatedIds: ctx.parentArtifacts.getAllocatedIds(),
		agentUris: await enumerateAgentUris(ctx.artifactRoot),
		resumeVisible: finalResume !== undefined,
		sessionInitCount,
		liveHandles,
		lifecycleStarts,
		modelFallbackSwitched,
		parentModelSubstitution,
		terminal,
		managed,
		uncertainArtifactId,
	};
}

function transientSessionFailure(): AutoroutingPreflightFailure {
	return { kind: "local", op: "session_open", transient: true };
}

function invalidConfigFailure(): AutoroutingPreflightFailure {
	return { kind: "local", op: "preflight_validation", transient: false };
}

describe("autorouting preflight contract", () => {
	it("publishes no durable candidate through the real executor/event bus before the acceptance fence", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-real-preflight-fence-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const eventBus = new EventBus();
		const lifecycle: SubagentLifecyclePayload[] = [];
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			lifecycle.push(payload as SubagentLifecyclePayload);
		});
		const jobs = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(jobs);
		const model = {
			provider: "test",
			id: "model",
			name: "model",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 128_000,
			maxTokens: 4_096,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			headers: {},
			compat: {},
		} as never;
		const result = await runSubprocessOnce({
			cwd: root,
			agent,
			task: "real preflight",
			assignment: "real preflight",
			index: 0,
			id: "real-preflight",
			modelOverride: ["test/model"],
			settings: Settings.isolated(),
			modelRegistry: {
				authStorage: {},
				getAvailable: () => [model],
				getApiKey: async () => "key",
			} as never,
			preflightDurable: true,
			autoroutingAttemptId: "../escaped",
			sessionFile: finalPath,
			eventBus,
		});
		expect(result.preflightFenceCrossed).toBe(false);
		expect(result.preflightFailure).toEqual({ kind: "local", op: "session_open", transient: false });
		expect(jobs.getLiveHandle("real-preflight")).toBeUndefined();
		expect(lifecycle).toEqual([]);
		await expect(stat(finalPath)).rejects.toThrow();
	});

	it("fails closed to terminal when the pre-fence discard cleanup itself fails", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-real-preflight-discard-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const jobs = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(jobs);
		const model = {
			provider: "test",
			id: "model",
			name: "model",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 128_000,
			maxTokens: 4_096,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			headers: {},
			compat: {},
		} as never;
		// A transient tool-bootstrap failure would normally ADVANCE to the next candidate. When the
		// pre-fence discard cleanup also fails, candidate-owned staging residue may survive, so the
		// zero-residue guarantee no longer holds and the attempt must fail closed instead.
		const bootstrapSpy = spyOn(sdkModule, "createAgentSession").mockRejectedValue(
			Object.assign(new Error("transient bootstrap"), { transient: true }),
		);
		const discardSpy = spyOn(SessionManager.prototype, "discardStaged").mockRejectedValue(
			new Error("discard-cleanup-failed"),
		);
		try {
			const result = await runSubprocessOnce({
				cwd: root,
				agent,
				task: "discard cleanup failure",
				assignment: "discard cleanup failure",
				index: 0,
				id: "discard-cleanup",
				modelOverride: ["test/model"],
				settings: Settings.isolated(),
				modelRegistry: {
					authStorage: {},
					getAvailable: () => [model],
					getApiKey: async () => "key",
				} as never,
				preflightDurable: true,
				autoroutingAttemptId: "discard-cleanup",
				sessionFile: finalPath,
			});
			expect(result.preflightFenceCrossed).toBe(false);
			expect(result.preflightFailure).toEqual({ kind: "local", op: "preflight_validation", transient: false });
			expect(result.error ?? "").toContain("Cleanup failure");
		} finally {
			discardSpy.mockRestore();
			bootstrapSpy.mockRestore();
		}
	});

	it("stops the public runSubprocess ledger and preserves the cleanup diagnostic on failed pre-fence discard", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-real-preflight-ledger-"));
		const jobs = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(jobs);
		const model = {
			provider: "test",
			id: "model",
			name: "model",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 128_000,
			maxTokens: 4_096,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			headers: {},
			compat: {},
		} as never;
		// A NON-transient bootstrap failure must terminalize the ledger immediately: the recorded
		// code is config_invalid_terminal and no further candidate may be attempted. Before the fix,
		// any returned attempt code was treated as "advance", so terminal codes still advanced.
		const bootstrapSpy = spyOn(sdkModule, "createAgentSession").mockRejectedValue(
			new Error("non-transient bootstrap failure"),
		);
		try {
			const result = await runSubprocess({
				cwd: root,
				agent,
				task: "ledger stop",
				assignment: "ledger stop",
				index: 0,
				id: "ledger-stop",
				runMode: "initial",
				settings: Settings.isolated(),
				modelRegistry: {
					authStorage: {},
					getAvailable: () => [model],
					getApiKey: async () => "key",
				} as never,
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/model", "test/second", "test/third"],
				routing,
				sessionFile: path.join(root, "candidate.jsonl"),
			});
			// A terminal classification must stop the ledger: exactly one candidate is attempted even
			// though three were offered.
			const attempted = new Set((result.routing?.attempts ?? []).map(attempt => attempt.selector));
			expect(attempted).toEqual(new Set(["test/model"]));
			expect(result.routing?.attempts?.some(attempt => attempt.code === "config_invalid_terminal")).toBe(true);
			expect(result.routing?.terminal).toBe("preflight_exhausted");
			// The last candidate's diagnostic must survive terminalization onto the user-facing surface.
			expect(result.error ?? "").toContain("Last candidate diagnostic");
			expect(result.setupFailure?.summary ?? "").toContain("Last candidate diagnostic");
		} finally {
			bootstrapSpy.mockRestore();
		}
	});

	it("terminalizes the ledger when the credential lookup itself throws, instead of advancing as if credentials were absent", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-real-preflight-credential-error-"));
		const jobs = new AsyncJobManager({ maxRunningJobs: 2, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(jobs);
		const model = {
			provider: "test",
			id: "model",
			name: "model",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			contextWindow: 128_000,
			maxTokens: 4_096,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			headers: {},
			compat: {},
		} as never;
		// getApiKey throwing (keychain access denied, corrupted store) is NOT the same as returning
		// undefined (no credential configured). Only the latter is the deliberate "advance" signal;
		// the former must fail closed on the very first candidate.
		const result = await runSubprocess({
			cwd: root,
			agent,
			task: "credential lookup error",
			assignment: "credential lookup error",
			index: 0,
			id: "credential-lookup-error",
			runMode: "initial",
			settings: Settings.isolated(),
			modelRegistry: {
				authStorage: {},
				getAvailable: () => [model],
				getApiKey: async () => {
					throw new Error("keychain access denied");
				},
			} as never,
			autoroutingPreflight: true,
			autoroutingCandidates: ["test/model", "test/second"],
			routing,
			sessionFile: path.join(root, "candidate.jsonl"),
		});
		// Only the first candidate is attempted; the ledger did not advance past the credential
		// lookup error as though it were a plain missing-credential skip.
		const attempted = new Set((result.routing?.attempts ?? []).map(attempt => attempt.selector));
		expect(attempted).toEqual(new Set(["test/model"]));
		expect(result.routing?.attempts?.some(attempt => attempt.code === "credential_unavailable")).toBe(false);
		expect(result.routing?.terminal).toBe("preflight_exhausted");
	});

	it("preserves terminal evidence when every candidate is skipped before execution", async () => {
		const result = await runSubprocess({
			cwd: process.cwd(),
			agent,
			task: "test",
			assignment: "test",
			index: 0,
			id: "preflight",
			runMode: "initial",
			autoroutingPreflight: true,
			autoroutingCandidates: [],
			autoroutingSkips: [{ selector: "anthropic/model", code: "credential_unavailable" }],
			routing,
		});
		expect(result.exitCode).toBe(1);
		expect(result.routing).toMatchObject({ terminal: "all_candidates_skipped", notExecuted: true });
		expect(result.routing?.skips).toEqual([{ selector: "anthropic/model", code: "credential_unavailable" }]);
	});

	it("uses typed local and transport facts without parsing error text", () => {
		expect(classifyAutoroutingPreflightFailure({ transient: false }, "session_open")).toEqual({
			kind: "local",
			op: "session_open",
			transient: false,
		});
		expect(
			classifyAutoroutingPreflightFailure(
				{ transportFailure: { kind: "transport", status: 429 } },
				"preflight_validation",
			),
		).toMatchObject({ kind: "transport", class: "rate_limit" });
	});

	it("only the explicit missing-credential signal advances at auth_resolve; an unmarked lookup error fails closed", () => {
		// The deliberate "no credential for this candidate" throw carries credentialMissing: true.
		expect(
			classifyAutoroutingPreflightFailure(
				Object.assign(new Error("autorouting credential unavailable"), {
					transient: false,
					credentialMissing: true,
				}),
				"auth_resolve",
			),
		).toEqual({ kind: "local", op: "auth_resolve", transient: false });
		// An unrelated exception the credential lookup itself throws (keychain access denied,
		// corrupted store, I/O failure) must NOT be reclassified as the deliberate signal just
		// because it happened during the auth_resolve window -- it must fail closed like every
		// other unclassified local error.
		const unexpected = classifyAutoroutingPreflightFailure(new Error("keychain access denied"), "auth_resolve");
		expect(unexpected.kind).toBe("local");
		expect(unexpected).not.toMatchObject({ op: "auth_resolve" });
		expect(unexpected).toMatchObject({ transient: false });
	});

	it("enforces phase/code pairing and bounded attempt evidence", () => {
		const valid: TaskRoutingEvidence = {
			...routing,
			attempts: [
				{ selector: "anthropic/model", phase: "probe", code: "probe_passed" },
				{ selector: "anthropic/model", phase: "durable", code: "accepted" },
			],
		};
		expect(() => assertRoutingEvidenceInvariant(valid)).not.toThrow();
		expect(() =>
			assertRoutingEvidenceInvariant({
				...routing,
				attempts: [{ selector: "anthropic/model", phase: "probe", code: "accepted" }],
			}),
		).toThrow();
	});

	it("reserves and remaps attempt-scoped artifact IDs without mutating siblings", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gjc-artifact-ledger-"));
		const parent = new ArtifactManager(path.join(root, "parent"));
		await parent.save("sibling", "tool");
		const staged = parent.createAttemptStaging("attempt");
		const oldId = await staged.save("candidate", "tool");
		const map = await parent.commitAttemptStaging(staged, "attempt");
		expect(map.get(String(oldId))).toBe("1");
		expect(() => (map as Map<string, string>).set("x", "y")).toThrow();
		expect(await parent.exists("0")).toBe(true);
		expect(await parent.exists("1")).toBe(true);
	});

	it("T1 transient durable retry advances once and accepts candidate 2 with zero failed-attempt residue", async () => {
		const run = await runScriptedLedger([
			{
				selector: "provider/candidate-1",
				probe: { kind: "pass" },
				durable: { kind: "failure", failure: transientSessionFailure() },
			},
			{ selector: "provider/candidate-2", probe: { kind: "pass" }, durable: { kind: "accepted" } },
		]);
		expect(run.attempts).toEqual([
			{ selector: "provider/candidate-1", phase: "probe", code: "probe_passed" },
			{ selector: "provider/candidate-1", phase: "durable", code: "spawn_transient_retry" },
			{ selector: "provider/candidate-2", phase: "probe", code: "probe_passed" },
			{ selector: "provider/candidate-2", phase: "durable", code: "accepted" },
		]);
		expect(run.sessionInitCount).toBe(1);
		expect(run.liveHandles).toBe(1);
		expect(run.lifecycleStarts).toBe(1);
		expect(run.failedSnapshots).toHaveLength(1);
		expect(run.failedSnapshots[0]?.after).toEqual(run.failedSnapshots[0]?.before);
		expect(run.finalExists).toBe(true);
		expect(run.stagingTree).toBe("[]");
		expect(run.finalText).toContain("artifact://1");
		expect(run.finalText).not.toContain("artifact://0");
		expect(run.agentUris).toContain("agent://0");
		expect(run.artifactTree).toContain("1.tool.log");
		expect(run.artifactTree).not.toContain(".staging");
	});

	it("T1b preparation-throw before manager return is idempotently discarded and advances", async () => {
		const run = await runScriptedLedger([
			{
				selector: "provider/preparation-throw",
				probe: { kind: "pass" },
				durable: { kind: "prepare_throw", failure: transientSessionFailure() },
			},
			{ selector: "provider/accepted", probe: { kind: "pass" }, durable: { kind: "accepted" } },
		]);
		expect(run.attempts).toEqual([
			{ selector: "provider/preparation-throw", phase: "probe", code: "probe_passed" },
			{ selector: "provider/preparation-throw", phase: "durable", code: "spawn_transient_retry" },
			{ selector: "provider/accepted", phase: "probe", code: "probe_passed" },
			{ selector: "provider/accepted", phase: "durable", code: "accepted" },
		]);
		expect(run.failedSnapshots[0]?.after).toEqual(run.failedSnapshots[0]?.before);
		expect(run.sessionInitCount).toBe(1);
		expect(run.stagingTree).toBe("[]");
	});

	it("T1m managed transient retry leaves store inventory and registration untouched, then publishes exactly once", async () => {
		const run = await runScriptedLedger(
			[
				{
					selector: "provider/managed-1",
					probe: { kind: "pass" },
					durable: { kind: "failure", failure: transientSessionFailure() },
				},
				{ selector: "provider/managed-2", probe: { kind: "pass" }, durable: { kind: "accepted" } },
			],
			true,
		);
		expect(run.managed).toBe(true);
		expect(run.attempts.at(-1)).toEqual({ selector: "provider/managed-2", phase: "durable", code: "accepted" });
		expect(run.failedSnapshots[0]?.after).toEqual(run.failedSnapshots[0]?.before);
		expect(run.sessionInitCount).toBe(1);
		expect(run.stagingTree).toBe("[]");
		expect(run.finalExists).toBe(true);
		expect(run.finalText).toContain('"type":"session_init"');
		expect(run.artifactTree).not.toContain(".staging/attempt-2.jsonl");
	});

	it("T2 post-fence terminal denies every FallbackTriggerClass without advancement or model fallback events", async () => {
		for (const failureClass of fallbackClasses) {
			const run = await runScriptedLedger([
				{
					selector: `provider/post-fence-${failureClass}`,
					probe: { kind: "pass" },
					durable: { kind: "post_fence", class: failureClass },
				},
				{ selector: "provider/never-advanced", probe: { kind: "pass" }, durable: { kind: "accepted" } },
			]);
			expect(run.attempts).toEqual([
				{ selector: `provider/post-fence-${failureClass}`, phase: "probe", code: "probe_passed" },
				{ selector: `provider/post-fence-${failureClass}`, phase: "durable", code: "post_acceptance_failure" },
			]);
			expect(run.modelFallbackSwitched).toBe(0);
			expect(run.finalExists).toBe(true);
		}
	});

	it("T2 commit rename-failure and reservation-failure rollback preserve parent bytes, reservations, siblings, and staging", async () => {
		const rename = await runScriptedLedger([
			{ selector: "provider/rename-failure", probe: { kind: "pass" }, durable: { kind: "rename_failure" } },
		]);
		expect(rename.terminal).toBe("post_acceptance_failure");
		expect(rename.finalText).toBe("pre-existing-final-bytes");
		expect(rename.stagingTree).toBe("[]");
		expect(rename.agentUris).toEqual(["agent://0"]);

		expect(rename.failedSnapshots[0]?.after).toEqual(rename.failedSnapshots[0]?.before);
		const root = await mkdtemp(path.join(tmpdir(), "gjc-reservation-failure-"));
		const parent = new ArtifactManager(path.join(root, "parent"));
		await parent.save("sibling", "tool");
		const staged = parent.createAttemptStaging("reservation");
		await staged.save("candidate", "tool");
		const before = { tree: await snapshotTree(parent.dir, true), ids: parent.getAllocatedIds() };
		(staged as unknown as { listFiles: () => Promise<string[]> }).listFiles = async () => {
			throw new Error("reservation failure");
		};
		await expect(parent.commitAttemptStaging(staged, "reservation")).rejects.toThrow("reservation failure");
		await staged.discardAttemptStaging();
		expect(await snapshotTree(parent.dir, true)).toBe(before.tree);
		expect(parent.getAllocatedIds()).toEqual(before.ids);
		expect(await parent.exists("0")).toBe(true);
	});

	it("T2m managed adoption-failure and reservation-failure rollback preserve managed inventory and sibling artifacts", async () => {
		const run = await runScriptedLedger(
			[
				{
					selector: "provider/managed-adoption-failure",
					probe: { kind: "pass" },
					durable: { kind: "rename_failure" },
				},
			],
			true,
		);
		expect(run.managed).toBe(true);
		expect(run.terminal).toBe("post_acceptance_failure");
		expect(run.stagingTree).toBe("[]");
		expect(run.agentUris).toEqual(["agent://0"]);
		expect(run.failedSnapshots[0]?.after).toEqual(run.failedSnapshots[0]?.before);

		const root = await mkdtemp(path.join(tmpdir(), "gjc-managed-reservation-failure-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		const parentManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		await parentManager.flush();
		const parent = parentManager.getArtifactManager();
		if (!parent) throw new Error("managed parent artifacts unavailable");
		await parent.save("sibling", "tool");
		const staged = parent.createAttemptStaging("managed-reservation");
		await staged.save("candidate", "tool");
		const before = { tree: await snapshotTree(parent.dir, true), ids: parent.getAllocatedIds() };
		(staged as unknown as { listFiles: () => Promise<string[]> }).listFiles = async () => {
			throw new Error("managed reservation failure");
		};
		await expect(parent.commitAttemptStaging(staged, "managed-reservation")).rejects.toThrow(
			"managed reservation failure",
		);
		await staged.discardAttemptStaging();
		expect(await snapshotTree(parent.dir, true)).toBe(before.tree);
		expect(parent.getAllocatedIds()).toEqual(before.ids);
	});

	it("T3 cross-phase exhaustion consumes three unique candidates and leaves no final, breadcrumb, staging, or discovery residue", async () => {
		const run = await runScriptedLedger(
			[1, 2, 3, 4].map(index => ({
				selector: `provider/exhausted-${index}`,
				probe: { kind: "pass" as const },
				durable: { kind: "failure" as const, failure: transientSessionFailure() },
			})),
		);
		expect(run.attempts).toHaveLength(6);
		expect(new Set(run.attempts.map(attempt => attempt.selector))).toEqual(
			new Set(["provider/exhausted-1", "provider/exhausted-2", "provider/exhausted-3"]),
		);
		expect(run.terminal).toBe("preflight_exhausted");
		expect(run.finalExists).toBe(false);
		expect(run.stagingTree).toBe("[]");
		expect(run.listing).toEqual([]);
		expect(run.resumeVisible).toBe(false);
	});

	it("T3m managed exhaustion preserves the managed store inventory byte-for-byte", async () => {
		const run = await runScriptedLedger(
			[1, 2, 3].map(index => ({
				selector: `provider/managed-exhausted-${index}`,
				probe: { kind: "pass" as const },
				durable: { kind: "failure" as const, failure: transientSessionFailure() },
			})),
			true,
		);
		expect(run.terminal).toBe("preflight_exhausted");
		expect(run.finalExists).toBe(false);
		expect(run.stagingTree).toBe("[]");
		expect(run.listing.filter(pathname => pathname.includes("managed-exhausted"))).toEqual([]);
		expect(run.resumeVisible).toBe(false);
		expect(
			run.failedSnapshots.every(
				snapshot =>
					snapshot.after === snapshot.before || JSON.stringify(snapshot.after) === JSON.stringify(snapshot.before),
			),
		).toBe(true);
		expect(run.artifactTree).toContain("0.tool.log");
	});

	it("deny-table cases on both sides of each fence never retry 401/403/quota/invalid-config, while resume/message bypass preflight and parent substitution", async () => {
		const denyCases: Array<{ label: "401" | "403" | "quota"; failure: AutoroutingPreflightFailure }> = [
			{ label: "401", failure: { kind: "transport", class: "auth" } },
			{ label: "403", failure: { kind: "transport", class: "auth" } },
			{ label: "quota", failure: { kind: "transport", class: "quota" } },
		];
		for (const denyCase of denyCases) {
			const failure = denyCase.failure;
			const preFence = await runScriptedLedger([
				{
					selector: `provider/pre-${denyCase.label}`,
					probe: { kind: "pass" },
					durable: { kind: "failure", failure },
				},
				{ selector: "provider/not-retried", probe: { kind: "pass" }, durable: { kind: "accepted" } },
			]);
			expect(preFence.attempts.at(-1)?.code).toBe("unclassified_terminal");
			const postFence = await runScriptedLedger([
				{
					selector: `provider/post-${denyCase.label}`,
					probe: { kind: "pass" },
					durable: { kind: "post_fence", class: failure.kind === "transport" ? failure.class : "other" },
				},
				{ selector: "provider/not-retried", probe: { kind: "pass" }, durable: { kind: "accepted" } },
			]);
			expect(postFence.attempts.at(-1)?.code).toBe("post_acceptance_failure");
		}
		const invalid = await runScriptedLedger([
			{
				selector: "provider/invalid-config",
				probe: { kind: "pass" },
				durable: { kind: "failure", failure: invalidConfigFailure() },
			},
			{ selector: "provider/not-retried", probe: { kind: "pass" }, durable: { kind: "accepted" } },
		]);
		expect(invalid.attempts.at(-1)?.code).toBe("config_invalid_terminal");
		for (const runMode of ["resume", "message"] as const) {
			const result = await runSubprocess({
				cwd: process.cwd(),
				agent,
				task: "bypass",
				index: 0,
				id: `bypass-${runMode}`,
				runMode,
				autoroutingPreflight: true,
				autoroutingCandidates: ["provider/should-not-probe"],
				parentActiveModelPattern: "provider/parent-model",
				signal: AbortSignal.abort(),
				routing,
			});
			expect(result.routing?.attempts).toBeUndefined();
		}
		const noSubstitution = await runScriptedLedger([
			{ selector: "provider/accepted", probe: { kind: "pass" }, durable: { kind: "accepted" } },
		]);
		expect(noSubstitution.parentModelSubstitution).toBe(false);
		expect(noSubstitution.attempts.at(-1)?.selector).toBe("provider/accepted");
	});
});

describe("managed staged publication certainty", () => {
	it("keeps the durable preflight lifecycle non-destructive when a publish commits without proof", async () => {
		const run = await runScriptedLedger(
			[{ selector: "provider/uncertain", probe: { kind: "pass" }, durable: { kind: "uncertain_publish" } }],
			true,
		);
		expect(run.terminal).toBe("post_acceptance_failure");
		expect(run.attempts.at(-1)).toEqual({
			selector: "provider/uncertain",
			phase: "durable",
			code: "post_acceptance_failure",
		});
		// The transcript really did land, so nothing it references may be reclaimed.
		expect(run.finalExists).toBe(true);
		expect(run.uncertainArtifactId).toBeDefined();
		// snapshotTree stores base64 contents, so assert the payloads themselves survived.
		expect(run.artifactTree).toContain(Buffer.from("candidate-provider/uncertain").toString("base64"));
		expect(run.artifactTree).toContain(Buffer.from("parent-sibling").toString("base64"));
		// No live handle or lifecycle start may leak from a publication that never proved itself.
		expect(run.liveHandles).toBe(0);
		expect(run.lifecycleStarts).toBe(0);
	});

	it("keeps staged evidence when the destination probe cannot prove absence", async () => {
		const ctx = await createHarnessContext(true);
		const manager = await openStagedCandidate(ctx, "attempt-unreadable");
		manager.appendSessionInit({ systemPrompt: "test", task: "unreadable-probe", tools: [] });
		const stagedArtifactId = await manager.saveArtifact("candidate-unreadable-probe", "tool");
		expect(stagedArtifactId).toBeDefined();
		await manager.flush();

		const store = ctx.parentArtifacts.getManagedStore();
		if (!store) throw new Error("managed artifact store unavailable");
		const stagedName = `${path.basename(ctx.finalPath, ".jsonl")}`;
		expect(stagedName.length).toBeGreaterThan(0);
		const realRead = store.readExpected.bind(store);
		const finalName = path.basename(ctx.finalPath);
		// The move reports a possibly-committed failure and the destination cannot be read,
		// so absence is unproven and every compensation must fail closed.
		const move = spyOn(store, "moveFileNoReplace").mockImplementation(() => {
			throw new ManagedTreeMoveOutcomeError("managed_publish_identity_unknown", false);
		});
		const read = spyOn(store, "readExpected").mockImplementation((relativePath: string) => {
			if (relativePath === finalName) throw new Error("managed_read_failed");
			return realRead(relativePath);
		});

		try {
			await expect(manager.commitStagedNestedManaged()).rejects.toThrow(/committed without proof/);
			// Executor compensation: post-fence rollback then the pre-fence discard.
			await manager.rollbackCommittedStaged();
			await manager.discardStaged();
		} finally {
			read.mockRestore();
			move.mockRestore();
		}

		// The staged transcript never moved, and nothing proved it safe to reclaim.
		const stagingTree = await snapshotTree(ctx.stagingRoot);
		expect(stagingTree).toContain("attempt-unreadable.jsonl");
		const artifactTree = await snapshotTree(ctx.artifactRoot);
		expect(artifactTree).toContain(Buffer.from("candidate-unreadable-probe").toString("base64"));
		expect(artifactTree).toContain(Buffer.from("parent-sibling").toString("base64"));
	});

	it("preserves owned artifacts when a managed publish commits without proof", async () => {
		const ctx = await createHarnessContext(true);
		const manager = await openStagedCandidate(ctx, "attempt-uncertain");
		manager.appendSessionInit({ systemPrompt: "test", task: "uncertain-publish", tools: [] });
		const stagedArtifactId = await manager.saveArtifact("candidate-owned-artifact", "tool");
		expect(stagedArtifactId).toBeDefined();
		await manager.flush();

		const store = ctx.parentArtifacts.getManagedStore();
		if (!store) throw new Error("managed artifact store unavailable");
		const realMove = store.moveFileNoReplace.bind(store);
		// Native can complete the rename and still fail to prove durability or terminal
		// identity. stagingCleanupSafe=false is the signal that the mutation may have landed.
		const move = spyOn(store, "moveFileNoReplace").mockImplementation((source, destination, expected, options) => {
			realMove(source, destination, expected, options);
			throw new ManagedTreeMoveOutcomeError("managed_publish_fsync_failed", false);
		});

		try {
			await expect(manager.commitStagedNestedManaged()).rejects.toThrow(/committed without proof/);
		} finally {
			move.mockRestore();
		}

		// The transcript really is published, so the artifacts it references must survive.
		expect(store.readExpected(path.basename(ctx.finalPath))).not.toBeNull();
		const artifactTree = await snapshotTree(ctx.artifactRoot);
		expect(stagedArtifactId).toBeDefined();
		expect(artifactTree).toContain(Buffer.from("candidate-owned-artifact").toString("base64"));
	});
});
