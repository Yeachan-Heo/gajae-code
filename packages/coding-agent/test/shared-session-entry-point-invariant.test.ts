/**
 * Behavioural invariant for the shared-session single write path (#7815, #7823, #7824).
 *
 * Every caller-reachable mutation entry point is driven on an admitted root shared
 * session: each AgentSession seam of the SDK operation inventory and each builtin
 * slash command (both its ACP `handle` and its TUI `handleTui`). An entry point must
 * either commit through shared publication or fail closed with a typed error. It must
 * never reach a SessionManager legacy writer that then refuses with
 * {@link SharedSessionMutationUnsupportedError}: that refusal means the caller picked
 * the legacy protocol on a session whose eligibility selects shared publication.
 *
 * A refusal raised by a legacy admission gate is attributed to the outermost
 * SessionManager method on the call path (tracked with AsyncLocalStorage). A refusal
 * reached through a SessionManager method is a legacy-path refusal and always fails.
 * A refusal raised by the AgentSession seam itself is a deliberate pre-effect fail-closed
 * decision and is accepted only for seams classified in {@link FAIL_CLOSED_SEAMS}.
 *
 * Every entry point is driven with valid arguments and must settle within the drive
 * window: it fulfills, or it rejects with the exact typed error pinned in
 * {@link EXPECTED_REJECTIONS} or {@link FAIL_CLOSED_SEAMS}. Any other rejection and any
 * pending result fails, so an unrelated exception can never mask a legacy path. Pinned
 * rejections must leave the transcript byte-identical. Slash commands are driven through
 * both their ACP `handle` and their TUI `handleTui`.
 *
 * New AgentSession seams are driven automatically (the operation inventory is
 * regenerated and checked for every public method). New slash commands fail the
 * classification test until they are added to {@link SLASH_COMMANDS}. The self-check
 * suite proves that a new seam or slash handler reaching a legacy writer fails.
 *
 * The fixture uses only the shared-session API that predates the single write path, so
 * reverting the source to dev fails per entry point instead of failing to load.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { hookFetch } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	type SessionDestination,
	SessionManager,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandSpec } from "../src/slash-commands/types";

interface InventoryRow {
	readonly sourceId: string;
	readonly sourceKind: string;
}

const inventory = (await Bun.file(
	path.join(import.meta.dirname, "../src/sdk/protocol/operation-inventory.generated.json"),
).json()) as InventoryRow[];
const inventorySeams = inventory
	.filter(row => row.sourceKind === "agent_session")
	.map(row => row.sourceId.slice("agent_session:".length));

/** Seams that are not driven, with the reason. Everything else in the inventory is driven. */
const NOT_DRIVEN_SEAMS: Record<string, string> = {
	constructor: "construction is the fixture itself",
	dispose: "teardown, not a transcript mutation",
	awaitDisposeCompletion: "teardown wait",
	closeWriterStrict: "teardown of the writer",
	prepareCloseIfIdle: "teardown probe",
	disposeChildSubprocesses: "teardown of child processes",
	waitForIdle: "wait only",
	awaitSessionSettlement: "wait only",
	restoreFromMemoryGuardCheckpoint: "inventory row for a non-prototype member",
	activeMidRunBarrierCountForTests: "test hook",
	activeMidRunMaintenanceCountForTests: "test hook",
};

/**
 * Seams with no shared protocol that refuse at the seam, before any live or durable
 * effect, with the typed {@link SharedSessionMutationUnsupportedError}. The value is the
 * refused operation.
 */
const FAIL_CLOSED_SEAMS: Record<string, string> = {
	fork: "prepare fork",
	assertConfiguredModelChainWritable: "set configured model chain",
	recordResumeDefaultModel: "record resume default model",
	setConfiguredModelChain: "set configured model chain",
	commitPreparedProfileModelSelection: "commit profile model selection",
	branch: "prepare branched session",
};

/** Arguments resolved against the fixture working directory, so file outputs stay in the fixture. */
type SlashArgs = string | ((cwd: string) => string);
type SlashClassification = { readonly drive: true; readonly args?: SlashArgs } | { readonly skip: string };

/** Every builtin slash command. Unclassified commands fail the classification test. */
const SLASH_COMMANDS: Record<string, SlashClassification> = {
	aside: { skip: "spawns a side session runtime" },
	"import-session": { drive: true },
	notify: { drive: true, args: "status" },
	settings: { drive: true },
	language: { drive: true, args: "en" },
	theme: { drive: true },
	pet: { drive: true, args: "off" },
	goal: { drive: true, args: "Ship the shared probe" },
	copy: { drive: true },
	tutorial: { drive: true },
	help: { drive: true },
	hotkeys: { drive: true },
	mcp: { drive: true, args: "status" },
	extensions: { drive: true },
	monitors: { drive: true },
	model: { drive: true, args: "anthropic/claude-sonnet-4-5" },
	effort: { drive: true, args: "high" },
	fast: { drive: true, args: "on" },
	routing: { drive: true, args: "status" },
	export: { drive: true, args: cwd => path.join(cwd, "export.html") },
	dump: { drive: true },
	session: { drive: true, args: "info" },
	jobs: { drive: true },
	transcript: { drive: true },
	context: { drive: true },
	progress: { drive: true },
	usage: { drive: true, args: "check" },
	credential: { drive: true },
	changelog: { drive: true, args: "full" },
	tools: { drive: true },
	provider: { skip: "interactive credential setup against live providers" },
	ssh: { skip: "opens a remote shell" },
	clear: { drive: true },
	compact: { drive: true, args: "Keep the probe" },
	handoff: { drive: true, args: "Keep the probe" },
	"contribute-pr": { skip: "drives git and GitHub" },
	star: { drive: true },
	unstar: { drive: true },
	memory: { drive: true, args: "view" },
	rename: { drive: true, args: "Shared rename" },
	move: { skip: "relocates the session working directory and reloads plugins" },
	tree: { drive: true },
	fork: { drive: true },
	login: { skip: "interactive OAuth" },
	logout: { skip: "removes stored credentials" },
	new: { drive: true },
	drop: { drive: true },
	resume: { drive: true },
	sessions: { drive: true },
	btw: { drive: true, args: "What changed?" },
	"btw-handoff": { drive: true },
	retry: { drive: true },
	background: { drive: true },
	debug: { drive: true },
	exit: { skip: "terminates the process" },
};

interface Fixture {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly cwd: string;
	readonly file: string;
	readonly destination: SessionDestination;
}

const MODEL_SELECTOR = "anthropic/claude-sonnet-4-5";
const model = () => {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Missing bundled model");
	return bundled;
};
const leafWithParent = (f: Fixture) => {
	const entry = f.manager.getBranch().findLast(candidate => candidate.type === "message" && candidate.parentId);
	if (!entry) throw new Error("Missing branchable entry");
	return entry.id;
};

/** A second persisted transcript in the fixture destination, for /resume-style switches. */
async function siblingTranscript(f: Fixture): Promise<string> {
	const sibling = SessionManager.create(f.cwd, f.destination);
	sibling.appendMessage(user("sibling"));
	await sibling.ensureOnDisk();
	await sibling.flush();
	const file = sibling.getSessionFile();
	await sibling.closeStrict();
	if (!file) throw new Error("Missing sibling transcript");
	return file;
}

/**
 * Valid arguments for every seam that takes any; seams absent here take none. Preparation
 * may run other seams to obtain a receipt; only the driven call is attributed.
 */
const SEAM_ARGS: Record<string, (f: Fixture) => unknown[] | Promise<unknown[]>> = {
	exportToHtml: f => [path.join(f.cwd, "export.html")],
	setForcedToolChoice: f => {
		const active = f.session.getActiveToolNames()[0];
		if (!active) throw new Error("Missing active tool");
		return [active];
	},
	replaceNamedCustomTools: () => [[], []],
	buildForkContextSeed: () => [{ maxMessages: 10, maxTokens: 10_000 }],
	enqueueCustomMessageDisplay: () => ["queued display", "followUp"],
	withMcpControlAdmission: f => [f.session.sessionLifecycle.generation, async () => undefined],
	activateDiscoveredTools: () => [[]],
	setActiveToolsByName: f => [f.session.getActiveToolNames()],
	refreshMCPTools: () => [[], {}],
	continuePersistedHistory: f => {
		f.session.agent.replaceMessages([user("continue me")]);
		return [];
	},
	convertMessagesToLlm: () => [[user("convert")]],
	observeMainProviderStream: () => [
		model(),
		{ systemPrompt: [], messages: [] },
		undefined,
		() => new AssistantMessageEventStream(),
	],
	prepareSimpleStreamOptions: () => [{}],
	setCredentialPin: () => ["anthropic", { kind: "id", value: "1" }],
	invokeSkill: () => ["missing-skill"],
	setSdkPlanMode: () => [false],
	restoreSessionAgentModelOverrides: f => {
		const state = f.session.getSessionAgentModelOverrideState();
		return [state, state.revision];
	},
	setSessionAgentModelSelection: () => ["executor", model()],
	setSlashCommands: () => [[]],
	appendMessageForSession: () => [user("appended for session")],
	prompt: () => ["drive the prompt"],
	resolvePromptSkillInvocation: () => ["/skill:missing"],
	isLocallyHandledSlashCommand: () => ["/help"],
	promptCustomMessage: () => [{ customType: "probe", content: "prompted custom", display: false }],
	steer: () => ["steer the run"],
	followUp: () => ["follow up"],
	sendCustomMessage: () => [{ customType: "probe", content: "sent custom", display: false }],
	sendUserMessage: () => ["send user"],
	submitUserMessage: () => ["submit user", { deliverAs: "followUp", trackSubmission: true }],
	removeQueuedMessageForEditing: () => ["missing-queued-id"],
	moveQueuedMessageForEditing: () => ["missing-queued-id", "up"],
	setTodoPhases: () => [[{ name: "Todos", tasks: [{ content: "probe", status: "pending" }] }]],
	abortPromptAndWait: () => ["missing-handle", { graceMs: 0 }],
	generateAutoSessionTitle: () => ["first input"],
	setSessionName: () => ["Shared name", "user"],
	setModel: () => [model()],
	noteProfileInstalledOverrides: () => [[], [], model()],
	restoreProfileInstalledOverrideState: f => [f.session.getProfileInstalledOverrideState()],
	activateModelProfileForControl: () => ["missing-profile"],
	setDefaultModelProfileForControl: () => ["missing-profile"],
	withSdkControlMutation: () => [async () => undefined],
	setConfiguredModelChainForControl: () => ["default", [MODEL_SELECTOR], "modelRoles", undefined, true, () => true],
	setConfiguredModelChain: () => ["default", [MODEL_SELECTOR], "modelRoles"],
	installRecoveredDefaultFallbackChain: () => [[MODEL_SELECTOR], undefined, 0, []],
	seedDefaultFallbackResolution: () => [0, []],
	restoreDefaultFallbackRuntimeState: f => [f.session.getDefaultFallbackRuntimeState()],
	recordResumeDefaultModel: () => [MODEL_SELECTOR],
	setModelTemporary: () => [model()],
	prepareModelSelectionForProfileActivation: () => [model(), undefined],
	withModelProfilePublication: () => [() => {}, async () => undefined],
	appendModelProfileActivationForControl: () => [{}, () => true],
	publishCommittedModelProfileSessionState: async f => {
		const receipt = await f.session.appendModelProfileActivationForControl({}, () => true);
		return [{}, receipt];
	},
	commitPreparedProfileModelSelection: async f => [
		await f.session.prepareModelSelectionForProfileActivation(model(), undefined),
	],
	finishPreparedProfileModelSelection: async f => [
		await f.session.prepareModelSelectionForProfileActivation(model(), undefined),
	],
	setDefaultModelSelection: () => [model(), undefined],
	cycleRoleModels: () => [["default"]],
	executeBash: () => ["true"],
	recordBashResult: () => [
		"echo recorded",
		{
			output: "recorded",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 8,
			outputLines: 1,
			outputBytes: 8,
		},
	],
	trackEvalExecution: () => [Promise.resolve(undefined), new AbortController()],
	recordPythonResult: () => [
		"print('recorded')",
		{
			output: "recorded",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 8,
			outputLines: 1,
			outputBytes: 8,
		},
	],
	respondAsBackground: () => [{ from: "peer", message: "background ping", awaitReply: false }],
	emitSubagentSteerObservation: () => [{ from: "parent", to: "child", body: "steer", timestamp: 1 }],
	releaseBtwConversationScope: f => [f.session.createBtwConversationScope("side question")],
	runEphemeralTurn: () => [{ promptText: "ephemeral", signal: new AbortController().signal }],
	switchSession: async f => [await siblingTranscript(f)],
	branch: f => [leafWithParent(f)],
	navigateTree: f => {
		const first = f.manager.getBranch()[0];
		if (!first) throw new Error("Missing tree target");
		return [first.id];
	},
	compact: () => ["Keep the probe"],
	handoff: () => ["Keep the probe"],
};

/**
 * Seams whose valid drive on this fixture rejects with a typed precondition before any
 * effect. The value is the exact `Name: message` the seam must reject with; a pattern
 * only where the message embeds environment-dependent detail.
 */
const EXPECTED_REJECTIONS: Record<string, string | RegExp> = {
	// The fixture is not a recovery-hydrated session.
	promoteRecoveryHydrationAfterOwnershipReadyFence:
		"Error: Agent session is not awaiting recovery hydration promotion.",
	// A forged prepared-session receipt; only newSession() mints a live one.
	buildPreparedDisplaySessionContext: "Error: Prepared session is no longer available.",
	// The fixture authenticates with a runtime API key, which overrides OAuth pins.
	setCredentialPin:
		"OAuthCredentialSelectorError: Credential selector id:1 cannot be used for anthropic while an API-key override is active; remove the override or choose AUTO",
	// No skills are installed in the fixture.
	invokeSkill: "Error: Skill missing-skill was not found.",
	// Plan mode is owned by a host lifecycle the fixture does not attach.
	setSdkPlanMode: "Error: mode.plan.set requires an active host plan-mode lifecycle.",
	// The fixture session is not built by the configuration-reload-capable SDK path.
	validateConfiguration: "ConfigurationReloadError: Configuration reload is unavailable for this session.",
	reloadConfiguration: "ConfigurationReloadError: Configuration reload is unavailable for this session.",
	// Profile resolution refuses an unknown name before activation starts.
	activateModelProfileForControl: /^Error: Unknown model profile "missing-profile"\. Available profiles: /,
	setDefaultModelProfileForControl: /^Error: Unknown model profile "missing-profile"\. Available profiles: /,
	// Two short messages are below the compaction floor.
	compact: "Error: Nothing to compact (session too small)",
};

const DRIVE_WINDOW_MS = 5_000;

interface GateRefusal {
	readonly operation: string;
	/** Outermost SessionManager method on the path; undefined when the seam called the gate itself. */
	readonly via: string | undefined;
}

const GATES = ["assertLegacyMutationAllowed", "assertLegacyAppendAllowed"] as const;
const callPath = new AsyncLocalStorage<string>();
const refusals: GateRefusal[] = [];
const originals = new Map<string, PropertyDescriptor>();

/** Attribute every gate refusal to the outermost SessionManager method that reached it. */
function instrumentSessionManager(): void {
	const prototype = SessionManager.prototype as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(SessionManager.prototype)) {
		const descriptor = Object.getOwnPropertyDescriptor(SessionManager.prototype, name);
		if (!descriptor || typeof descriptor.value !== "function" || name === "constructor") continue;
		// Callback-scoped helpers run caller code inside them; attributing that code to the
		// helper would hide whether the caller or a writer reached the gate.
		if (name.startsWith("with")) continue;
		const original = descriptor.value as (this: SessionManager, ...args: unknown[]) => unknown;
		originals.set(name, descriptor);
		const gate = (GATES as readonly string[]).includes(name);
		prototype[name] = function (this: SessionManager, ...args: unknown[]): unknown {
			if (gate) {
				try {
					return original.apply(this, args);
				} catch (error) {
					if (error instanceof SharedSessionMutationUnsupportedError)
						refusals.push({ operation: String(args[0]), via: callPath.getStore() });
					throw error;
				}
			}
			const outer = callPath.getStore();
			return outer === undefined ? callPath.run(name, () => original.apply(this, args)) : original.apply(this, args);
		};
	}
}

function restoreSessionManager(): void {
	for (const [name, descriptor] of originals) Object.defineProperty(SessionManager.prototype, name, descriptor);
	originals.clear();
}

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

/** One Anthropic streaming reply; every provider request in this file is served offline. */
function anthropicReply(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_probe",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Probe reply" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let offlineFetch: Disposable | undefined;
beforeAll(() => {
	instrumentSessionManager();
	offlineFetch = hookFetch(async () => anthropicReply());
});
afterAll(() => {
	offlineFetch?.[Symbol.dispose]();
	restoreSessionManager();
});
afterEach(async () => {
	vi.restoreAllMocks();
	refusals.length = 0;
	for (const cleanup of cleanups.splice(0).reverse())
		await Promise.resolve()
			.then(cleanup)
			.catch(() => undefined);
});

/** A root interactive session whose logical session already publishes through shared admission. */
async function admittedRootSession() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-entry-points-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	cleanups.push(() => manager.closeStrict());
	manager.appendMessage(user("first"));
	await manager.ensureOnDisk();
	await manager.flush();
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	cleanups.push(() => auth.close());
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	cleanups.push(() => registry.dispose());
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const probeTool = {
		name: "probe_tool",
		label: "Probe",
		description: "Probe tool",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text" as const, text: "probe" }] }),
	} as unknown as AgentTool;
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [probeTool], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "startup.networkPrewarm": false }),
		modelRegistry: registry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Rebuilt"] }),
		rootInteractiveSharedAppend: true,
	});
	cleanups.push(() => session.dispose());
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	const peer = await SessionManager.open(file, destination);
	cleanups.push(() => peer.closeStrict());
	if ((await peer.appendMessageSharingSession(user("peer"))).kind !== "committed") throw new Error("peer append");
	if ((await manager.appendMessageSharingSession(user("local"))).kind !== "committed") throw new Error("local append");
	// Only the pre-single-write-path API: a source revert must fail per entry point.
	expect(manager.requiresSharedMutationAdmission()).toBe(true);
	refusals.length = 0;
	return { session, manager, cwd, file, destination } satisfies Fixture;
}

type Settled = { readonly kind: "fulfilled" | "pending" } | { readonly kind: "rejected"; readonly error: unknown };

async function drive(run: () => unknown): Promise<Settled> {
	const settled = Promise.resolve()
		.then(run)
		.then(
			(): Settled => ({ kind: "fulfilled" }),
			(error: unknown): Settled => ({ kind: "rejected", error }),
		);
	return Promise.race([settled, Bun.sleep(DRIVE_WINDOW_MS).then((): Settled => ({ kind: "pending" }))]);
}

function describeOutcome(outcome: Settled): string {
	if (outcome.kind !== "rejected") return outcome.kind;
	const error = outcome.error;
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Every way a drive breaks the invariant: a refused legacy writer on the call path, an
 * unsettled result, or a rejection other than the exact pinned one.
 */
function violations(outcome: Settled, expectedRejection?: string | RegExp): string[] {
	const found = refusals
		.filter(refusal => refusal.via !== undefined)
		.map(refusal => `legacy writer ${refusal.via} refused: ${refusal.operation}`);
	if (outcome.kind === "pending") found.push(`did not settle within ${DRIVE_WINDOW_MS}ms`);
	const settled = describeOutcome(outcome);
	if (expectedRejection === undefined) {
		if (outcome.kind === "rejected") found.push(`unexpected rejection: ${settled}`);
	} else if (
		typeof expectedRejection === "string" ? settled !== expectedRejection : !expectedRejection.test(settled)
	) {
		found.push(`expected rejection ${expectedRejection}, got ${settled}`);
	}
	return found;
}

function expectNoViolations(entryPoint: string, outcome: Settled, expectedRejection?: string | RegExp): void {
	expect({ entryPoint, violations: violations(outcome, expectedRejection) }).toEqual({ entryPoint, violations: [] });
}

const failClosed = (operation: string) =>
	`SharedSessionMutationUnsupportedError: Shared session mutation requires transaction admission: ${operation}`;

/** AgentSession prototype methods the inventory does not drive or classify. */
function unclassifiedSeams(): string[] {
	return Object.getOwnPropertyNames(AgentSession.prototype).filter(
		name =>
			typeof Object.getOwnPropertyDescriptor(AgentSession.prototype, name)?.value === "function" &&
			!inventorySeams.includes(name),
	);
}

/** A recording stand-in for the interactive mode context: real session state, inert UI. */
function tuiContext(session: AgentSession, manager: SessionManager): unknown {
	const real: Record<string, unknown> = { session, sessionManager: manager, settings: session.settings };
	const inert: ProxyHandler<() => unknown> = {
		get: (_target, property) => (property === "then" ? undefined : inertValue),
		apply: () => inertValue,
	};
	const inertValue: unknown = new Proxy(() => undefined, inert);
	return new Proxy(real, {
		get: (target, property) => {
			if (typeof property === "string" && property in target) return target[property];
			return property === "then" ? undefined : inertValue;
		},
	});
}

function slashSpec(name: string): SlashCommandSpec {
	const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`Missing slash command ${name}`);
	return spec;
}

type SlashSurface = "acp" | "tui";

async function driveSlash(spec: SlashCommandSpec, surface: SlashSurface, slashArgs: SlashArgs) {
	const f = await admittedRootSession();
	const args = typeof slashArgs === "function" ? slashArgs(f.cwd) : slashArgs;
	const command = { name: spec.name, args, text: args ? `/${spec.name} ${args}` : `/${spec.name}` };
	const outputs: string[] = [];
	const bytes = await fs.readFile(f.file);
	const outcome = await drive(() => {
		if (surface === "acp") {
			if (!spec.handle) throw new Error(`/${spec.name} has no ACP handler`);
			return spec.handle(command, {
				session: f.session,
				sessionManager: f.manager,
				settings: f.session.settings,
				cwd: f.cwd,
				output: text => {
					outputs.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
		}
		if (!spec.handleTui) throw new Error(`/${spec.name} has no TUI handler`);
		return spec.handleTui(command, {
			ctx: tuiContext(f.session, f.manager) as never,
			handleBackgroundCommand: () => {},
		});
	});
	return { ...f, outcome, outputs, bytes };
}

function slashSurfaces(spec: SlashCommandSpec): SlashSurface[] {
	return [...(spec.handle ? (["acp"] as const) : []), ...(spec.handleTui ? (["tui"] as const) : [])];
}

/** Drive one seam with its valid arguments; preparation is not attributed to the seam. */
async function driveSeam(f: Fixture, name: string): Promise<Settled> {
	const seam = (f.session as unknown as Record<string, unknown>)[name];
	if (typeof seam !== "function") throw new Error(`${name} is not a method`);
	const args = (await SEAM_ARGS[name]?.(f)) ?? [];
	refusals.length = 0;
	return drive(() => (seam as (...args: unknown[]) => unknown).apply(f.session, args));
}

describe("shared session entry-point classification", () => {
	it("drives every AgentSession seam in the inventory unless it is a named non-mutation", () => {
		expect(unclassifiedSeams()).toEqual([]);
		const stale = [
			...Object.keys(NOT_DRIVEN_SEAMS),
			...Object.keys(FAIL_CLOSED_SEAMS),
			...Object.keys(SEAM_ARGS),
			...Object.keys(EXPECTED_REJECTIONS),
		].filter(name => !inventorySeams.includes(name));
		expect(stale).toEqual([]);
		const doublyClassified = Object.keys(EXPECTED_REJECTIONS).filter(
			name => name in FAIL_CLOSED_SEAMS || name in NOT_DRIVEN_SEAMS,
		);
		expect(doublyClassified).toEqual([]);
	});

	it("classifies every builtin slash command", () => {
		const registered = BUILTIN_SLASH_COMMANDS_INTERNAL.map(spec => spec.name);
		expect(registered.filter(name => !(name in SLASH_COMMANDS))).toEqual([]);
		expect(Object.keys(SLASH_COMMANDS).filter(name => !registered.includes(name))).toEqual([]);
		for (const name of registered) {
			expect({ name, surfaces: slashSurfaces(slashSpec(name)).length > 0 }).toEqual({ name, surfaces: true });
		}
	});
});

describe("AgentSession seams on an admitted root shared session", () => {
	for (const name of inventorySeams) {
		if (name in NOT_DRIVEN_SEAMS || name.endsWith("ForTests")) continue;
		it(`${name} never reaches a refused legacy writer`, async () => {
			const f = await admittedRootSession();
			const bytes = await fs.readFile(f.file);
			const entries = f.manager.getEntries().length;
			const failClosedOperation = FAIL_CLOSED_SEAMS[name];
			const expected =
				failClosedOperation !== undefined ? failClosed(failClosedOperation) : EXPECTED_REJECTIONS[name];
			const outcome = await driveSeam(f, name);
			expectNoViolations(name, outcome, expected);
			if (expected !== undefined) {
				expect(await fs.readFile(f.file)).toEqual(bytes);
				expect(f.manager.getEntries()).toHaveLength(entries);
			}
		});
	}
});

describe("builtin slash commands on an admitted root shared session", () => {
	for (const [name, classification] of Object.entries(SLASH_COMMANDS)) {
		if ("skip" in classification) continue;
		const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(candidate => candidate.name === name);
		for (const surface of spec ? slashSurfaces(spec) : []) {
			it(`/${name} (${surface}) never reaches a refused legacy writer`, async () => {
				const { outcome } = await driveSlash(slashSpec(name), surface, classification.args ?? "");
				expectNoViolations(`/${name} (${surface})`, outcome);
			});
		}
	}

	it("/star and /unstar commit through shared publication as append-only header patches", async () => {
		const f = await driveSlash(slashSpec("star"), "acp", "");
		expectNoViolations("/star", f.outcome);
		expect(f.outputs).toEqual(["Session starred."]);
		expect(f.manager.isSessionStarred()).toBe(true);
		const starredBytes = await fs.readFile(f.file);
		expect(
			starredBytes.toString().endsWith(`${JSON.stringify({ type: "header_patch", patch: { starred: true } })}\n`),
		).toBe(true);
		const unstar = await drive(() =>
			slashSpec("unstar").handle?.(
				{ name: "unstar", args: "", text: "/unstar" },
				{
					session: f.session,
					sessionManager: f.manager,
					settings: f.session.settings,
					cwd: f.cwd,
					output: () => {},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				},
			),
		);
		expectNoViolations("/unstar", unstar);
		const unstarredBytes = await fs.readFile(f.file);
		expect(unstarredBytes.subarray(0, starredBytes.length)).toEqual(starredBytes);
		const reopened = await SessionManager.open(f.file, f.destination);
		cleanups.push(() => reopened.closeStrict());
		expect(reopened.isSessionStarred()).toBe(false);
	});
});

describe("invariant self-check", () => {
	const probe = "legacyWriterProbeForInvariant";

	it("fails a new AgentSession seam that reaches a legacy writer", async () => {
		Object.defineProperty(AgentSession.prototype, probe, {
			configurable: true,
			writable: true,
			value(this: AgentSession) {
				this.sessionManager.appendCustomEntry("probe", { value: 1 });
			},
		});
		try {
			expect(unclassifiedSeams()).toEqual([probe]);
			const f = await admittedRootSession();
			const found = violations(await driveSeam(f, probe));
			expect(found).toContain("legacy writer appendCustomEntry refused: append entry");
		} finally {
			delete (AgentSession.prototype as unknown as Record<string, unknown>)[probe];
		}
		expect(unclassifiedSeams()).toEqual([]);
	});

	it("fails a slash handler that reaches a legacy writer on either surface", async () => {
		const legacy = async (sessionManager: SessionManager) => {
			sessionManager.appendCustomEntry("probe", { value: 1 });
		};
		const spec = {
			name: "legacy-probe",
			description: "probe",
			handle: async (_command: unknown, runtime: { sessionManager: SessionManager }) =>
				legacy(runtime.sessionManager),
			handleTui: async (_command: unknown, runtime: { ctx: { sessionManager: SessionManager } }) =>
				legacy(runtime.ctx.sessionManager),
		} as unknown as SlashCommandSpec;
		for (const surface of ["acp", "tui"] as const) {
			const { outcome } = await driveSlash(spec, surface, "");
			expect({ surface, found: violations(outcome) }).toMatchObject({
				surface,
				found: expect.arrayContaining(["legacy writer appendCustomEntry refused: append entry"]),
			});
		}
	});

	it("fails an unrelated rejection, a wrong pinned rejection, and an unsettled result", () => {
		refusals.length = 0;
		const rejected: Settled = { kind: "rejected", error: new TypeError("boom") };
		expect(violations(rejected)).toEqual(["unexpected rejection: TypeError: boom"]);
		expect(violations(rejected, failClosed("prepare fork"))).toEqual([
			`expected rejection ${failClosed("prepare fork")}, got TypeError: boom`,
		]);
		expect(violations({ kind: "fulfilled" }, failClosed("prepare fork"))).toEqual([
			`expected rejection ${failClosed("prepare fork")}, got fulfilled`,
		]);
		expect(violations({ kind: "pending" })).toEqual([`did not settle within ${DRIVE_WINDOW_MS}ms`]);
	});
});
