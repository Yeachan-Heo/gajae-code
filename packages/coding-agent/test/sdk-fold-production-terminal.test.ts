import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { logger, TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { __sessionStateSidecarTestHooks } from "../src/gjc-runtime/session-state-sidecar";
import { createAcpClientBridge } from "../src/modes/acp/acp-client-bridge";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { ArtifactManager } from "../src/session/artifacts";
import { AuthStorage } from "../src/session/auth-storage";
import type { ClientBridgeTerminalHandle } from "../src/session/client-bridge";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES, truncateHeadBytes } from "../src/session/streaming-output";
import {
	lookupOwnedRegistration,
	registerTerminalTurnScope,
	resetTerminalAbortRegistriesForTests,
} from "../src/session/terminal-abort";

let created: CreateAgentSessionResult | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;
let sessionManager: SessionManager | undefined;
const restoreSpies: Array<() => void> = [];
const terminalExits = new Set<PromiseWithResolvers<{ exitCode: number | null; signal: string | null }>>();

function trackSpy<T extends { mockRestore(): void }>(spy: T): T {
	restoreSpies.push(() => spy.mockRestore());
	return spy;
}

function spyOnWarnings() {
	const originalWarn = logger.warn.bind(logger);
	return trackSpy(
		spyOn(logger, "warn").mockImplementation((message, ...details) => originalWarn(message, ...details)),
	);
}

interface FoldedTerminal {
	exit: PromiseWithResolvers<{ exitCode: number | null; signal: string | null }>;
	jobGeneration: string;
	jobId: string;
	promptRun?: Promise<void>;
	releaseCalls: () => number;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for production ACP fold state");
}

async function createProductionSession(modelStartsBash = false, persist = true, bashRuns = 1) {
	if (created) throw new Error("Previous SDK fixture teardown has not settled.");
	const fixtureTempDir = TempDir.createSync("@gjc-sdk-fold-acp-");
	tempDir = fixtureTempDir;
	registerMockApi();
	const fixtureAuthStorage = await AuthStorage.create(`${fixtureTempDir.path()}/auth.db`);
	authStorage = fixtureAuthStorage;
	const bashResponses = Array.from({ length: bashRuns }, () => ({
		content: [{ type: "toolCall" as const, name: "bash", arguments: { command: "sleep 30" } }],
	}));
	const mock = createMockModel({
		responses: modelStartsBash
			? [...bashResponses, { content: ["wake complete"] }]
			: [{ content: ["wake complete"] }],
	});
	fixtureAuthStorage.setRuntimeApiKey(mock.model.provider, "test-key");
	const fixtureSessionManager = persist
		? SessionManager.create(
				fixtureTempDir.path(),
				SessionManager.managedDestination(fixtureTempDir.path(), fixtureTempDir.path()),
			)
		: SessionManager.inMemory(fixtureTempDir.path());
	sessionManager = fixtureSessionManager;
	if (persist) await fixtureSessionManager.ensureOnDisk();
	created = await createAgentSession({
		cwd: fixtureTempDir.path(),
		agentDir: fixtureTempDir.path(),
		sessionManager: fixtureSessionManager,
		authStorage: fixtureAuthStorage,
		settings: Settings.isolated({
			"async.enabled": true,
			"bash.autoBackground.enabled": false,
			"compaction.enabled": false,
			"tools.artifactTailBytes": 64,
		}),
		model: mock.model,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		sdkHostModeSupported: false,
		notificationHostModeSupported: false,
	});
	created.session.trackCoordinatorRuntimeStatePersistenceFailuresForTests();
	return mock;
}

async function foldClientTerminal(output: string, callId: string, modelStartsBash = false): Promise<FoldedTerminal> {
	if (!created) throw new Error("SDK session was not created");
	const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
	terminalExits.add(exit);
	let releaseCount = 0;
	const terminal: ClientBridgeTerminalHandle = {
		terminalId: `sdk-acp-fold-terminal-${callId}`,
		currentOutput: async () => ({ output, truncated: false }),
		waitForExit: () => exit.promise,
		kill: async () => {},
		release: async () => {
			releaseCount += 1;
		},
	};
	const connection = {
		createTerminal: async () => ({
			id: terminal.terminalId,
			currentOutput: terminal.currentOutput,
			waitForExit: terminal.waitForExit,
			kill: terminal.kill,
			release: terminal.release,
		}),
	} as unknown as AgentSideConnection;
	const bridge = createAcpClientBridge(connection, created.session.sessionId, {
		terminal: true,
	} as ClientCapabilities);
	created.session.setClientBridge(bridge);
	const bash = created.session.getToolForExecution("bash");
	if (!bash) throw new Error("expected SDK bash tool");
	if (modelStartsBash) created.session.setSdkPermissionMode("allow");
	const promptRun = modelStartsBash ? created.session.prompt(`run SDK fold command ${callId}`) : undefined;
	const run = modelStartsBash ? undefined : bash.execute(callId, { command: "sleep 30" }, undefined, () => {});
	await waitFor(() => created!.session.hasForegroundBashBackgroundRequestHandler());
	let jobId: string | undefined;
	if (!modelStartsBash) {
		expect(await created.session.requestForegroundBashBackground()).toBe(true);
		const foreground = await run;
		expect(foreground?.details?.async?.state).toBe("running");
		jobId = foreground?.details?.async?.jobId;
	} else {
		await waitFor(() => created!.session.foldCoordinator.resolveTarget()?.getJob() !== undefined);
		jobId = created.session.foldCoordinator.resolveTarget()?.jobId;
	}
	if (!jobId) throw new Error("expected folded SDK job id");
	const asyncManager = AsyncJobManager.forEndpoint(created.session.sessionId);
	const job = asyncManager?.getJob(jobId);
	if (!job) throw new Error("expected the folded job in the production async manager");
	return { exit, jobGeneration: job.generation, jobId, promptRun, releaseCalls: () => releaseCount };
}

async function finishFoldedTerminal(folded: FoldedTerminal): Promise<void> {
	if (!created) throw new Error("SDK session was not created");
	folded.exit.resolve({ exitCode: 0, signal: null });
	await waitFor(() => folded.releaseCalls() === 1);
	await waitFor(() => created!.session.yieldQueue.has("async-result"));
}

async function deliverDuringFoldCapture(folded: FoldedTerminal, output: string): Promise<void> {
	if (!created) throw new Error("SDK session was not created");
	const coordinator = created.session.foldCoordinator;
	const adapter = coordinator.resolveTarget();
	if (!adapter) throw new Error("expected the SDK session's foreground fold adapter");
	const job = adapter.getJob();
	if (!job || job.id !== folded.jobId || job.generation !== folded.jobGeneration)
		throw new Error("expected the live production async job");
	expect(adapter.originatingTurn).toBe(true);
	const fold = created.session.requestForegroundBashBackgroundOutcome("chord", adapter);
	expect(coordinator.onDelivery(job, output)).toEqual({ kind: "parked" });
	expect(await fold).toMatchObject({ status: "folded", jobId: folded.jobId });
}

async function cancelFoldedTerminal(folded: FoldedTerminal): Promise<void> {
	if (!created) throw new Error("SDK session was not created");
	const manager = AsyncJobManager.forEndpoint(created.session.sessionId);
	if (!manager) throw new Error("expected the SDK fixture's original async job manager");
	manager.cancel(folded.jobId);
	folded.exit.resolve({ exitCode: 0, signal: null });
	await waitFor(() => folded.releaseCalls() === 1);
	await folded.promptRun;
	await manager.waitForAll();
	await created.session.awaitCoordinatorRuntimeStatePersistenceForTests();
}

function registerOrdinarySdkJob(output: string, label: string) {
	if (!created || !tempDir) throw new Error("SDK session fixture unavailable");
	const manager = AsyncJobManager.forEndpoint(created.session.sessionId);
	if (!manager) throw new Error("expected the SDK session's production async job manager");
	const cwd = tempDir.path();
	const jobId = manager.register("bash", label, async () => {
		const child = Bun.spawn([process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Bun async job exited with ${exitCode}: ${stderr}`);
		return stdout;
	});
	const job = manager.getJob(jobId);
	if (!job) throw new Error("expected the ordinary SDK job in its production async manager");
	if (job.ownerId !== undefined) throw new Error("expected an unowned ordinary SDK async job");
	return { jobId, manager };
}

type OrdinaryPublicationRefusal = "symlink" | "replacement" | "contended" | "unavailable";

async function assertOrdinaryPublicationRefusal(scenario: OrdinaryPublicationRefusal): Promise<void> {
	const mock = await createProductionSession(false, scenario !== "unavailable");
	if (!sessionManager || !created || !tempDir) throw new Error("SDK session fixture unavailable");
	const warning = spyOnWarnings();
	const originalSaveArtifact = SessionManager.prototype.saveArtifact;
	const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
	const allocateArtifactPath = trackSpy(spyOn(SessionManager.prototype, "allocateArtifactPath"));
	let saveCompleted = false;
	let savedArtifactId: string | undefined;
	let destinationPath: string | undefined;
	let publicationError: unknown;
	const externalTarget = path.join(tempDir.path(), "ordinary-symlink-target.txt");
	if (scenario === "symlink") await Bun.write(externalTarget, "protected external bytes");

	if (scenario === "unavailable") {
		saveArtifact.mockImplementation(function (this: SessionManager, content: string, toolType: string) {
			const saving = originalSaveArtifact.call(this, content, toolType);
			this.retireEphemeralArtifactsAfterTransition();
			return saving.then(artifactId => {
				saveCompleted = true;
				savedArtifactId = artifactId;
				return artifactId;
			});
		});
	} else {
		const originalAllocatePath = ArtifactManager.prototype.allocatePath;
		trackSpy(spyOn(ArtifactManager.prototype, "allocatePath")).mockImplementation(async function (
			this: ArtifactManager,
			toolType: string,
		) {
			const allocation = await originalAllocatePath.call(this, toolType);
			if (toolType === "async" && allocation.id) {
				destinationPath = path.join(this.dir, `${allocation.id}.async.log`);
				if (scenario === "symlink") fs.symlinkSync(externalTarget, destinationPath);
				if (scenario === "replacement") await Bun.write(destinationPath, "replacement bytes");
			}
			return allocation;
		});
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		trackSpy(spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync")).mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath: string,
			bytes: Uint8Array,
		) {
			if (!relativePath.endsWith(".async.log")) return originalPublish.call(this, relativePath, bytes);
			destinationPath = path.join(this.dir, relativePath);
			if (scenario === "contended")
				originalPublish.call(this, relativePath, Buffer.from("contending publisher bytes"));
			try {
				return originalPublish.call(this, relativePath, bytes);
			} catch (error) {
				publicationError = error;
				throw error;
			}
		});
	}

	const queue = created.session.yieldQueue;
	const originalEnqueue = queue.enqueue;
	const queuedResults: string[] = [];
	trackSpy(spyOn(queue, "enqueue")).mockImplementation(function <P>(this: typeof queue, kind: string, entry: P) {
		if (kind === "async-result" && typeof entry === "object" && entry !== null && "result" in entry) {
			const result = entry.result;
			if (typeof result === "string") queuedResults.push(result);
		}
		return originalEnqueue.call(this, kind, entry);
	});

	const output = `${`${scenario} ordinary refused output `.repeat(1_000)}${scenario.toUpperCase()}-ORDINARY-MARKER`;
	const warningsBeforeCompletion = warning.mock.calls.length;
	const callsBeforeCompletion = mock.calls.length;
	const { jobId, manager } = registerOrdinarySdkJob(output, `ordinary ${scenario} refusal`);
	if (manager.getJob(jobId)?.ownerId !== undefined) throw new Error("ordinary refusal job unexpectedly has an owner");
	await waitFor(() =>
		warning.mock.calls
			.slice(warningsBeforeCompletion)
			.some(([message]) => message === "Async job completion delivery failed"),
	);

	expect(saveArtifact).toHaveBeenCalledWith(
		expect.stringContaining(`${scenario.toUpperCase()}-ORDINARY-MARKER`),
		"async",
	);
	expect(allocateArtifactPath).not.toHaveBeenCalled();
	expect(queuedResults).toEqual([]);
	expect(queue.has("async-result")).toBe(false);
	const failureWarning = warning.mock.calls
		.slice(warningsBeforeCompletion)
		.find(([message]) => message === "Async job completion delivery failed");
	if (!failureWarning) throw new Error("expected ordinary async callback publication refusal warning");
	if (scenario === "unavailable") {
		expect(saveCompleted).toBe(true);
		expect(savedArtifactId).toBeUndefined();
		expect(sessionManager.getArtifactManager()).toBeNull();
		expect(JSON.stringify(failureWarning)).toContain("Artifact storage unavailable for async follow-up output.");
	} else {
		if (!(publicationError instanceof Error)) throw new Error("expected secure artifact publication refusal");
		expect(JSON.stringify(failureWarning)).toContain(publicationError.message);
		if (!destinationPath) throw new Error("expected refused ordinary artifact destination");
		if (scenario === "symlink") {
			expect(await Bun.file(externalTarget).text()).toBe("protected external bytes");
			expect(fs.lstatSync(destinationPath).isSymbolicLink()).toBe(true);
		}
		if (scenario === "replacement") expect(await Bun.file(destinationPath).text()).toBe("replacement bytes");
		if (scenario === "contended") expect(await Bun.file(destinationPath).text()).toBe("contending publisher bytes");
	}
	await queue.flush("idle");
	expect(mock.calls.length).toBe(callsBeforeCompletion);
}

async function disposeProductionSession(): Promise<void> {
	const failures: unknown[] = [];
	let teardownSettled = created === undefined;
	for (const exit of terminalExits) exit.resolve({ exitCode: 0, signal: null });
	try {
		if (created) {
			try {
				await created.session.dispose();
			} catch (error) {
				failures.push(error);
			}
			try {
				await created.session.awaitDisposeCompletion();
				teardownSettled = true;
			} catch (error) {
				if (!failures.includes(error)) failures.push(error);
			}
		}
		if (!teardownSettled) throw new AggregateError(failures, "SDK fixture retained teardown failed.");
		authStorage?.close();
		tempDir?.removeSync();
	} finally {
		if (teardownSettled) {
			created = undefined;
			authStorage = undefined;
			tempDir = undefined;
			sessionManager = undefined;
			terminalExits.clear();
			AsyncJobManager.resetForTests();
			resetTerminalAbortRegistriesForTests();
			for (const restore of restoreSpies.splice(0)) restore();
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "SDK fixture bounded disposal failed.");
}

describe("SDK production async completion paths", () => {
	afterEach(async () => {
		await disposeProductionSession();
	});

	test("retains fixture resources until teardown settles and preserves the bounded disposal failure", async () => {
		await createProductionSession();
		if (!created || !authStorage || !tempDir) throw new Error("SDK session fixture unavailable");
		const fixtureSession = created.session;
		const fixtureAuthStorage = authStorage;
		const fixtureTempDir = tempDir;
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const boundedFailure = Promise.withResolvers<unknown>();
		const previousHook = __sessionStateSidecarTestHooks.beforePersistFromEvent;
		let held = false;
		__sessionStateSidecarTestHooks.beforePersistFromEvent = async (eventType, cwd) => {
			await previousHook?.(eventType, cwd);
			if (!held && cwd === fixtureTempDir.path()) {
				held = true;
				writeStarted.resolve();
				await releaseWrite.promise;
			}
		};
		const originalDispose = fixtureSession.dispose.bind(fixtureSession);
		trackSpy(
			spyOn(fixtureSession, "dispose").mockImplementation(options =>
				originalDispose(options).catch(error => {
					boundedFailure.resolve(error);
					throw error;
				}),
			),
		);
		let cleanup: Promise<unknown> | undefined;
		let cleanupSettled = false;
		try {
			await fixtureSession.prompt("complete a genuine SDK turn before fixture disposal");
			await writeStarted.promise;
			cleanup = disposeProductionSession().then(
				() => {
					cleanupSettled = true;
					return undefined;
				},
				error => {
					cleanupSettled = true;
					return error;
				},
			);
			const failure = await boundedFailure.promise;
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) throw new Error("expected the genuine bounded disposal error");
			expect(failure.message).toContain("Session disposal exceeded its bounded caller deadline");
			expect(cleanupSettled).toBe(false);
			expect(created?.session).toBe(fixtureSession);
			expect(authStorage).toBe(fixtureAuthStorage);
			expect(tempDir).toBe(fixtureTempDir);
			expect(fs.existsSync(fixtureTempDir.path())).toBe(true);
			releaseWrite.resolve();
			expect(await cleanup).toBe(failure);
			expect(created).toBeUndefined();
			expect(authStorage).toBeUndefined();
			expect(tempDir).toBeUndefined();
			expect(fs.existsSync(fixtureTempDir.path())).toBe(false);
		} finally {
			releaseWrite.resolve();
			await cleanup;
			__sessionStateSidecarTestHooks.beforePersistFromEvent = previousHook;
		}
	}, 30_000);

	test("creates, folds, wakes, and releases through the SDK ToolSession and ACP adapter", async () => {
		const mock = await createProductionSession(false, false);
		if (!created) throw new Error("SDK session fixture unavailable");
		const folded = await foldClientTerminal("folded output\n", "sdk-fold-call");
		const callsBeforeWake = mock.calls.length;
		await finishFoldedTerminal(folded);
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBeGreaterThan(callsBeforeWake);
		expect(mock.calls.length).toBe(callsBeforeWake + 1);
		expect(folded.releaseCalls()).toBe(1);
		const wakeMessages = JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages);
		expect(wakeMessages).toContain("folded output");
		expect(wakeMessages).toContain("folded client-terminal wait");
	});

	test("publishes long output from an ordinary SDK-managed Bun job through SessionManager", async () => {
		const mock = await createProductionSession(false);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const fullOutput = `${"ordinary SDK Bun output\n".repeat(800)}ORDINARY-OUTPUT-MARKER`;
		expect(fullOutput.length).toBeGreaterThan(12_000);
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const allocateArtifactPath = trackSpy(spyOn(SessionManager.prototype, "allocateArtifactPath"));
		const callsBeforeWake = mock.calls.length;
		registerOrdinarySdkJob(fullOutput, "ordinary SDK artifact publication");
		await waitFor(() => created!.session.yieldQueue.has("async-result"));
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBe(callsBeforeWake + 1);
		const wakeMessages = mock.calls[mock.calls.length - 1]?.context.messages
			.filter(message => message.role === "user")
			.flatMap(message =>
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
			)
			.join("\n");
		if (wakeMessages === undefined) throw new Error("expected ordinary async-job model wake");
		expect(wakeMessages).toContain(fullOutput.slice(0, 4_000));
		expect(saveArtifact).toHaveBeenCalledWith(fullOutput, "async");
		expect(allocateArtifactPath).not.toHaveBeenCalled();
		const uri = wakeMessages.match(/artifact:\/\/(\d+)/u)?.[0];
		if (!uri) throw new Error("expected ordinary async-job artifact URI in model wake");
		expect(wakeMessages).toContain(`Saved completion output: ${uri}`);
		const artifactPath = await sessionManager.getArtifactPath(uri.slice("artifact://".length));
		if (!artifactPath) throw new Error("expected resolvable ordinary async-job artifact");
		expect(await Bun.file(artifactPath).text()).toBe(fullOutput);
	});

	test("does not label a bounded ordinary SDK completion artifact as full output", async () => {
		const mock = await createProductionSession(false);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const fullOutput = `ORDINARY-CAPPED-HEAD\n${"h".repeat(40_000)}\nOMITTED-MIDDLE\n${"t".repeat(40_000)}\nORDINARY-CAPPED-TAIL`;
		const expectedPayload = `${fullOutput.slice(0, 32 * 1024)}\n\n[async delivery output truncated from ${Buffer.byteLength(fullOutput, "utf8")} bytes]\n\n${fullOutput.slice(-32 * 1024)}`;
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const callsBeforeWake = mock.calls.length;
		registerOrdinarySdkJob(fullOutput, "ordinary SDK bounded delivery");
		await waitFor(() => created!.session.yieldQueue.has("async-result"));
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBe(callsBeforeWake + 1);
		const wakeMessages = mock.calls[mock.calls.length - 1]?.context.messages
			.filter(message => message.role === "user")
			.flatMap(message =>
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap(content => (content.type === "text" ? [content.text] : [])),
			)
			.join("\n");
		if (wakeMessages === undefined) throw new Error("expected bounded ordinary async-job model wake");
		expect(wakeMessages).not.toContain("Full output");
		const uri = wakeMessages.match(/artifact:\/\/(\d+)/u)?.[0];
		if (!uri) throw new Error("expected bounded ordinary async-job artifact URI");
		expect(wakeMessages).toContain(`Saved completion output: ${uri}`);
		expect(saveArtifact).toHaveBeenCalledTimes(1);
		const publication = saveArtifact.mock.calls[0];
		if (!publication) throw new Error("expected genuine bounded completion publication");
		expect(publication[1]).toBe("async");
		const callbackOutput = publication[0];
		expect(callbackOutput).toBe(expectedPayload);
		const artifactPath = await sessionManager.getArtifactPath(uri.slice("artifact://".length));
		if (!artifactPath) throw new Error("expected resolvable bounded completion artifact");
		expect(await Bun.file(artifactPath).text()).toBe(expectedPayload);
	});

	for (const scenario of ["symlink", "replacement", "contended", "unavailable"] as const) {
		test(`refuses ordinary SDK async publication after ${scenario} failure without queuing success`, async () => {
			await assertOrdinaryPublicationRefusal(scenario);
		});
	}

	test("publishes parked long output through SessionManager and wakes with its resolvable artifact URI", async () => {
		const mock = await createProductionSession(true);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const fullOutput = `${"folded output ".repeat(2_000)}FINAL-OUTPUT-MARKER`;
		const folded = await foldClientTerminal(fullOutput, "sdk-fold-long-output", true);
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const allocateArtifactPath = trackSpy(spyOn(SessionManager.prototype, "allocateArtifactPath"));
		const callsBeforeWake = mock.calls.length;
		await deliverDuringFoldCapture(folded, fullOutput);
		await waitFor(() => created!.session.yieldQueue.has("async-result"));
		await folded.promptRun;
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBe(callsBeforeWake + 1);
		const wakeMessages = JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages);
		expect(wakeMessages).toContain(fullOutput.slice(0, 4_000));
		expect(wakeMessages).toContain("folded client-terminal wait");
		expect(saveArtifact).toHaveBeenCalledWith(expect.stringContaining("FINAL-OUTPUT-MARKER"), "async");
		expect(allocateArtifactPath).not.toHaveBeenCalled();
		const uri = wakeMessages.match(/artifact:\/\/(\d+)/u)?.[0];
		if (!uri) throw new Error("expected folded-output artifact URI in model wake");
		const artifactPath = await sessionManager.getArtifactPath(uri.slice("artifact://".length));
		if (!artifactPath) throw new Error("expected resolvable saved artifact");
		const savedOutput = await Bun.file(artifactPath).text();
		expect(savedOutput).toContain(fullOutput);
		expect(savedOutput.length).toBeGreaterThan(12_000);
		await cancelFoldedTerminal(folded);
	});

	test("reports exact artifact completeness across byte-cap and UTF-8 boundaries", async () => {
		const cases = [
			{
				label: "exact-cap",
				output: () => "a".repeat(DEFAULT_ARTIFACT_MAX_BYTES),
				complete: true,
				expectedOmittedBytes: 0,
			},
			{
				label: "one-byte-over",
				output: () => "b".repeat(DEFAULT_ARTIFACT_MAX_BYTES + 1),
				complete: false,
				expectedOmittedBytes: 1,
			},
			{
				label: "multibyte-over-with-fewer-characters-than-cap",
				output: () => "€".repeat(Math.floor(DEFAULT_ARTIFACT_MAX_BYTES / 3) + 1),
				complete: false,
				expectedOmittedBytes: 3,
			},
			{
				label: "multibyte-codepoint-straddles-byte-cap",
				output: () => `${"c".repeat(DEFAULT_ARTIFACT_MAX_BYTES - 1)}€`,
				complete: false,
				expectedOmittedBytes: 3,
			},
		] as const;

		for (const [index, scenario] of cases.entries()) {
			const mock = await createProductionSession(true);
			if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
			const output = scenario.output();
			const fullBytes = Buffer.byteLength(output, "utf8");
			const retained = truncateHeadBytes(output, DEFAULT_ARTIFACT_MAX_BYTES);
			const folded = await foldClientTerminal(output, `sdk-fold-artifact-cap-${index}`, true);
			const callsBeforeWake = mock.calls.length;
			await deliverDuringFoldCapture(folded, output);
			await waitFor(() => created!.session.yieldQueue.has("async-result"));
			await folded.promptRun;
			await created.session.yieldQueue.flush("idle");
			expect(mock.calls.length).toBe(callsBeforeWake + 1);

			const wakeMessages = JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages);
			const uri = wakeMessages.match(/artifact:\/\/(\d+)/u)?.[0];
			if (!uri) throw new Error(`expected artifact URI for ${scenario.label}`);
			const artifactPath = await sessionManager.getArtifactPath(uri.slice("artifact://".length));
			if (!artifactPath) throw new Error(`expected saved artifact for ${scenario.label}`);
			const saved = await Bun.file(artifactPath).text();
			expect(saved.startsWith(retained.text)).toBe(true);
			expect(Buffer.byteLength(retained.text, "utf8")).toBe(retained.bytes);
			expect(retained.bytes).toBeLessThanOrEqual(DEFAULT_ARTIFACT_MAX_BYTES);

			if (scenario.complete) {
				expect(fullBytes).toBe(DEFAULT_ARTIFACT_MAX_BYTES);
				expect(wakeMessages).toContain(`Saved completion output: ${uri}`);
				expect(wakeMessages).not.toContain("Saved output artifact (truncated;");
				expect(saved).toBe(output);
			} else {
				const omittedBytes = fullBytes - retained.bytes;
				expect(omittedBytes).toBe(scenario.expectedOmittedBytes);
				expect(fullBytes).toBeGreaterThan(DEFAULT_ARTIFACT_MAX_BYTES);
				expect(wakeMessages).toContain(
					`Saved output artifact (truncated; omitted ${omittedBytes} UTF-8 bytes): ${uri}`,
				);
				expect(wakeMessages).not.toContain(`Full output: ${uri}`);
				expect(saved).toContain(`omitted at least ${omittedBytes} bytes`);
			}
			if (scenario.label === "multibyte-over-with-fewer-characters-than-cap") {
				expect(output.length).toBeLessThan(DEFAULT_ARTIFACT_MAX_BYTES);
				expect(fullBytes).toBeGreaterThan(DEFAULT_ARTIFACT_MAX_BYTES);
			}
			if (scenario.label === "multibyte-codepoint-straddles-byte-cap") {
				expect(saved.startsWith(`${"c".repeat(DEFAULT_ARTIFACT_MAX_BYTES - 1)}`)).toBe(true);
				expect(saved.startsWith(`${"c".repeat(DEFAULT_ARTIFACT_MAX_BYTES - 1)}€`)).toBe(false);
			}
			await cancelFoldedTerminal(folded);
			await disposeProductionSession();
		}
	}, 30_000);

	test("keeps short folded output inline without saving an artifact", async () => {
		const mock = await createProductionSession(true);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const folded = await foldClientTerminal("short folded output", "sdk-fold-inline-output", true);
		const callsBeforeWake = mock.calls.length;
		await deliverDuringFoldCapture(folded, "short folded output");
		await waitFor(() => created!.session.yieldQueue.has("async-result"));
		await folded.promptRun;
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBe(callsBeforeWake + 1);
		expect(JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages)).toContain("short folded output");
		expect(saveArtifact).not.toHaveBeenCalled();
		await cancelFoldedTerminal(folded);
	});

	test("keeps owned-scope denied output as a preview without publishing it", async () => {
		const mock = await createProductionSession(true);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const callId = "sdk-fold-owned-denied";
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const output = `${"denied long output ".repeat(1_000)}DENIED-OUTPUT-MARKER`;
		const folded = await foldClientTerminal(output, callId, true);
		const registration = lookupOwnedRegistration(folded.jobId, folded.jobGeneration, sessionManager.getSessionId());
		expect(registration).toBeDefined();
		if (!registration) throw new Error("expected owned completion registration for the SDK tool call");
		registerTerminalTurnScope({
			lineageIdHash: registration.lineageIdHash,
			promptAttemptEpoch: registration.promptAttemptEpoch,
			ownedCompletionPolicy: "disabled",
		});
		const queue = created.session.yieldQueue;
		const originalEnqueue = queue.enqueue;
		let queuedResult: string | undefined;
		trackSpy(spyOn(queue, "enqueue")).mockImplementation(function <P>(this: typeof queue, kind: string, entry: P) {
			if (kind === "async-result" && typeof entry === "object" && entry !== null && "result" in entry) {
				const result = entry.result;
				if (typeof result === "string") queuedResult = result;
			}
			return originalEnqueue.call(this, kind, entry);
		});
		const callsBeforeCompletion = mock.calls.length;
		await deliverDuringFoldCapture(folded, output);
		await waitFor(() => queuedResult !== undefined);
		expect(queuedResult).toContain(output.slice(0, 4_000));
		expect(queuedResult).toContain("[Output truncated. Showing first 4,000 characters.]");
		expect(queuedResult).not.toContain("artifact://");
		await folded.promptRun;
		await created.session.yieldQueue.flush("idle");
		expect(saveArtifact).not.toHaveBeenCalled();
		expect(mock.calls.length).toBe(callsBeforeCompletion);
		const artifactFiles = await sessionManager.getArtifactManager()?.listFiles();
		expect(artifactFiles?.some(file => file.endsWith(".async.log"))).toBe(false);
		await cancelFoldedTerminal(folded);
	});

	test("reports final symlink, replacement, and no-replace contention refusals without queuing previews", async () => {
		const mock = await createProductionSession(true, true, 3);
		if (!sessionManager || !created || !tempDir) throw new Error("SDK session fixture unavailable");
		const warning = spyOnWarnings();
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const allocateArtifactPath = trackSpy(spyOn(SessionManager.prototype, "allocateArtifactPath"));
		const siblingArtifactId = await sessionManager.saveArtifact("legitimate sibling bytes", "async");
		if (!siblingArtifactId) throw new Error("expected a legitimate sibling artifact");
		const siblingArtifactPath = await sessionManager.getArtifactPath(siblingArtifactId);
		if (!siblingArtifactPath) throw new Error("expected a resolvable sibling artifact");
		const siblingArtifactBytes = await Bun.file(siblingArtifactPath).text();
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		let scenario: "symlink" | "replacement" | "contended" | undefined;
		let destinationPath: string | undefined;
		let publicationError: unknown;
		const externalTarget = path.join(tempDir.path(), "symlink-target.txt");
		await Bun.write(externalTarget, "protected external bytes");
		const originalAllocatePath = ArtifactManager.prototype.allocatePath;
		trackSpy(spyOn(ArtifactManager.prototype, "allocatePath")).mockImplementation(async function (
			this: ArtifactManager,
			toolType: string,
		) {
			const allocation = await originalAllocatePath.call(this, toolType);
			if (scenario && toolType === "async" && allocation.id) {
				destinationPath = path.join(this.dir, `${allocation.id}.async.log`);
				if (scenario === "symlink") fs.symlinkSync(externalTarget, destinationPath);
				if (scenario === "replacement") await Bun.write(destinationPath, "replacement bytes");
			}
			return allocation;
		});
		trackSpy(spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync")).mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath: string,
			bytes: Uint8Array,
		) {
			if (!scenario || !relativePath.endsWith(".async.log")) return originalPublish.call(this, relativePath, bytes);
			destinationPath = path.join(this.dir, relativePath);
			if (scenario === "contended")
				originalPublish.call(this, relativePath, Buffer.from("contending publisher bytes"));
			try {
				return originalPublish.call(this, relativePath, bytes);
			} catch (error) {
				publicationError = error;
				throw error;
			}
		});

		for (const nextScenario of ["symlink", "replacement", "contended"] as const) {
			scenario = nextScenario;
			destinationPath = undefined;
			publicationError = undefined;
			const output = `${`${nextScenario} refused output `.repeat(1_000)}${nextScenario.toUpperCase()}-OUTPUT-MARKER`;
			const folded = await foldClientTerminal(output, `sdk-fold-${nextScenario}-refusal`, true);
			const callsBeforeCompletion = mock.calls.length;
			const warningsBeforeCompletion = warning.mock.calls.length;
			await deliverDuringFoldCapture(folded, output);
			await folded.promptRun;
			await waitFor(() =>
				warning.mock.calls
					.slice(warningsBeforeCompletion)
					.some(([message]) => message === "Parked folded delivery formatting failed"),
			);
			expect(publicationError).toBeDefined();
			expect(destinationPath).toBeDefined();
			expect(saveArtifact).toHaveBeenCalledWith(
				expect.stringContaining(`${nextScenario.toUpperCase()}-OUTPUT-MARKER`),
				"async",
			);
			expect(
				warning.mock.calls
					.slice(warningsBeforeCompletion)
					.some(
						([message, details]) =>
							message === "Parked folded delivery formatting failed" &&
							JSON.stringify(details)?.includes(String(publicationError)) === true,
					),
			).toBe(true);
			expect(allocateArtifactPath).not.toHaveBeenCalled();
			expect(created.session.yieldQueue.has("async-result")).toBe(false);
			await created.session.yieldQueue.flush("idle");
			expect(mock.calls.length).toBe(callsBeforeCompletion);
			if (nextScenario === "symlink") expect(await Bun.file(externalTarget).text()).toBe("protected external bytes");
			if (nextScenario === "replacement") expect(await Bun.file(destinationPath!).text()).toBe("replacement bytes");
			if (nextScenario === "contended")
				expect(await Bun.file(destinationPath!).text()).toBe("contending publisher bytes");
			expect(await Bun.file(siblingArtifactPath).text()).toBe(siblingArtifactBytes);
			await cancelFoldedTerminal(folded);
			if (destinationPath && fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
		}
	});

	test("reports unavailable when a parked output's ephemeral artifact manager retires during initialization", async () => {
		const mock = await createProductionSession(true, false);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const warning = spyOnWarnings();
		const originalSaveArtifact = SessionManager.prototype.saveArtifact;
		let saveCompleted = false;
		let savedArtifactId: string | undefined;
		trackSpy(spyOn(SessionManager.prototype, "saveArtifact")).mockImplementation(function (
			this: SessionManager,
			content: string,
			toolType: string,
		) {
			const saving = originalSaveArtifact.call(this, content, toolType);
			this.retireEphemeralArtifactsAfterTransition();
			return saving.then(artifactId => {
				saveCompleted = true;
				savedArtifactId = artifactId;
				return artifactId;
			});
		});
		const output = `${"ephemeral manager transition output ".repeat(1_000)}EPHEMERAL-TRANSITION-MARKER`;
		const folded = await foldClientTerminal(output, "sdk-fold-ephemeral-unavailable", true);
		const callsBeforeCompletion = mock.calls.length;
		await deliverDuringFoldCapture(folded, output);
		await waitFor(() =>
			warning.mock.calls.some(([message]) => message === "Parked folded delivery formatting failed"),
		);
		await folded.promptRun;
		expect(saveCompleted).toBe(true);
		expect(savedArtifactId).toBeUndefined();
		expect(sessionManager.getArtifactManager()).toBeNull();
		expect(created.session.yieldQueue.has("async-result")).toBe(false);
		expect(
			warning.mock.calls.some(
				([message, details]) =>
					message === "Parked folded delivery formatting failed" &&
					JSON.stringify(details)?.includes("Artifact storage unavailable for async follow-up output.") === true,
			),
		).toBe(true);
		await created.session.yieldQueue.flush("idle");
		expect(mock.calls.length).toBe(callsBeforeCompletion);
		await cancelFoldedTerminal(folded);
	});

	test("rejects a lifecycle transition held across artifact allocation without publishing or waking", async () => {
		const mock = await createProductionSession(true);
		if (!sessionManager || !created) throw new Error("SDK session fixture unavailable");
		const warning = spyOnWarnings();
		const saveArtifact = trackSpy(spyOn(SessionManager.prototype, "saveArtifact"));
		const allocateArtifactPath = trackSpy(spyOn(SessionManager.prototype, "allocateArtifactPath"));
		const originalAllocatePath = ArtifactManager.prototype.allocatePath;
		const allocationEntered = Promise.withResolvers<void>();
		const releaseAllocation = Promise.withResolvers<void>();
		let allocatedId: string | undefined;
		let allocatedPath: string | undefined;
		let predecessorArtifactDirectory: string | undefined;
		trackSpy(spyOn(ArtifactManager.prototype, "allocatePath")).mockImplementation(async function (
			this: ArtifactManager,
			toolType: string,
		) {
			const allocation = await originalAllocatePath.call(this, toolType);
			if (toolType === "async") {
				allocatedId = allocation.id;
				allocatedPath = allocation.path;
				predecessorArtifactDirectory = this.dir;
				allocationEntered.resolve();
				await releaseAllocation.promise;
			}
			return allocation;
		});
		let folded: FoldedTerminal | undefined;
		let originalAsyncManager: AsyncJobManager | undefined;
		try {
			folded = await foldClientTerminal(
				`${"transition held output ".repeat(1_000)}TRANSITION-MARKER`,
				"sdk-fold-transition",
				true,
			);
			const callsBeforeCompletion = mock.calls.length;
			originalAsyncManager = AsyncJobManager.forEndpoint(created.session.sessionId);
			const originalJob = originalAsyncManager?.getJob(folded.jobId);
			if (!originalAsyncManager || !originalJob) throw new Error("expected original transition execution");
			await deliverDuringFoldCapture(folded, `${"transition held output ".repeat(1_000)}TRANSITION-MARKER`);
			await allocationEntered.promise;
			await sessionManager.newSession();
			releaseAllocation.resolve();
			await waitFor(() =>
				warning.mock.calls.some(([message]) => message === "Parked folded delivery formatting failed"),
			);
			expect(originalAsyncManager.getJob(folded.jobId)).toBe(originalJob);
			originalAsyncManager.cancel(folded.jobId);
			folded.exit.resolve({ exitCode: 0, signal: null });
			await waitFor(() => folded!.releaseCalls() === 1);
			await folded.promptRun;
			expect(allocatedId).toBeDefined();
			expect(allocatedPath).toBeUndefined();
			expect(saveArtifact).toHaveBeenCalledWith(expect.stringContaining("TRANSITION-MARKER"), "async");
			expect(allocateArtifactPath).not.toHaveBeenCalled();
			expect(predecessorArtifactDirectory).toBeDefined();
			expect(created.session.yieldQueue.has("async-result")).toBe(false);
			await created.session.yieldQueue.flush("idle");
			expect(mock.calls.length).toBe(callsBeforeCompletion);
			expect(fs.existsSync(path.join(predecessorArtifactDirectory!, `${allocatedId}.async.log`))).toBe(false);
			expect(
				warning.mock.calls.some(
					([message, details]) =>
						message === "Parked folded delivery formatting failed" &&
						JSON.stringify(details)?.includes("Session artifact continuation is no longer authorized.") === true,
				),
			).toBe(true);
			await created.session.yieldQueue.flush("idle");
		} finally {
			releaseAllocation.resolve();
			if (folded) {
				originalAsyncManager?.cancel(folded.jobId);
				folded.exit.resolve({ exitCode: 0, signal: null });
				await folded.promptRun;
			}
		}
	});
});
