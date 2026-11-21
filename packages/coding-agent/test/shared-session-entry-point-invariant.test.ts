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
 * New AgentSession seams are driven automatically (the operation inventory is
 * regenerated and checked for every public method). New slash commands fail the
 * classification test until they are added to {@link SLASH_COMMANDS}.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, SharedSessionMutationUnsupportedError } from "../src/session/session-manager";
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
};

/** Arguments resolved against the fixture working directory, so file outputs stay in the fixture. */
type SlashArgs = string | ((cwd: string) => string);
type SlashClassification = { readonly drive: true; readonly args?: SlashArgs } | { readonly skip: string };

/** Every builtin slash command. Unclassified commands fail the classification test. */
const SLASH_COMMANDS: Record<string, SlashClassification> = {
	aside: { skip: "spawns a side session runtime" },
	"import-session": { drive: true },
	notify: { drive: true },
	settings: { drive: true },
	language: { drive: true },
	theme: { drive: true },
	pet: { drive: true },
	goal: { drive: true },
	copy: { drive: true },
	tutorial: { drive: true },
	help: { drive: true },
	hotkeys: { drive: true },
	mcp: { drive: true },
	extensions: { drive: true },
	monitors: { drive: true },
	model: { drive: true },
	effort: { drive: true },
	fast: { drive: true },
	routing: { drive: true },
	export: { drive: true, args: cwd => path.join(cwd, "export.html") },
	dump: { drive: true },
	session: { drive: true },
	jobs: { drive: true },
	transcript: { drive: true },
	context: { drive: true },
	progress: { drive: true },
	usage: { drive: true },
	credential: { drive: true },
	changelog: { drive: true },
	tools: { drive: true },
	provider: { skip: "interactive credential setup against live providers" },
	ssh: { skip: "opens a remote shell" },
	clear: { drive: true },
	compact: { drive: true },
	handoff: { drive: true },
	"contribute-pr": { skip: "drives git and GitHub" },
	star: { drive: true },
	unstar: { drive: true },
	memory: { drive: true },
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
	btw: { drive: true },
	"btw-handoff": { drive: true },
	retry: { drive: true },
	background: { drive: true },
	debug: { drive: true },
	exit: { skip: "terminates the process" },
};

/** Seam arguments that keep file outputs inside the fixture; every other seam is driven with none. */
const SEAM_ARGS: Record<string, (cwd: string) => unknown[]> = {
	exportToHtml: cwd => [path.join(cwd, "export.html")],
};

const DRIVE_WINDOW_MS = 1_000;

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

beforeAll(instrumentSessionManager);
afterAll(restoreSessionManager);
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
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
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
	expect(manager.usesSharedPublication()).toBe(true);
	expect(manager.requiresSharedMutationAdmission()).toBe(true);
	refusals.length = 0;
	return { session, manager, cwd, file, destination };
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

/** No legacy writer refused, and no unclassified SharedSessionMutationUnsupportedError escaped. */
function expectNoLegacyPath(entryPoint: string, outcome: Settled, failClosedOperation?: string): void {
	const legacyPath = refusals.filter(refusal => refusal.via !== undefined);
	expect({ entryPoint, legacyPath }).toEqual({ entryPoint, legacyPath: [] });
	const unsupported = outcome.kind === "rejected" && outcome.error instanceof SharedSessionMutationUnsupportedError;
	if (failClosedOperation === undefined) {
		expect({ entryPoint, unsupported: unsupported ? describeOutcome(outcome) : false }).toEqual({
			entryPoint,
			unsupported: false,
		});
		return;
	}
	expect({ entryPoint, outcome: describeOutcome(outcome) }).toEqual({
		entryPoint,
		outcome: `SharedSessionMutationUnsupportedError: Shared session mutation requires transaction admission: ${failClosedOperation}`,
	});
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

async function driveSlash(name: string, slashArgs: SlashArgs) {
	const f = await admittedRootSession();
	const args = typeof slashArgs === "function" ? slashArgs(f.cwd) : slashArgs;
	const spec = slashSpec(name);
	const command = { name, args, text: args ? `/${name} ${args}` : `/${name}` };
	const outputs: string[] = [];
	const outcome = await drive(() =>
		spec.handle
			? spec.handle(command, {
					session: f.session,
					sessionManager: f.manager,
					settings: f.session.settings,
					cwd: f.cwd,
					output: text => {
						outputs.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				})
			: spec.handleTui?.(command, {
					ctx: tuiContext(f.session, f.manager) as never,
					handleBackgroundCommand: () => {},
				}),
	);
	return { ...f, outcome, outputs };
}

describe("shared session entry-point classification", () => {
	it("drives every AgentSession seam in the inventory unless it is a named non-mutation", () => {
		const prototypeMethods = Object.getOwnPropertyNames(AgentSession.prototype).filter(
			name => typeof Object.getOwnPropertyDescriptor(AgentSession.prototype, name)?.value === "function",
		);
		expect(prototypeMethods.filter(name => !inventorySeams.includes(name))).toEqual([]);
		const stale = [
			...Object.keys(NOT_DRIVEN_SEAMS),
			...Object.keys(FAIL_CLOSED_SEAMS),
			...Object.keys(SEAM_ARGS),
		].filter(name => !inventorySeams.includes(name));
		expect(stale).toEqual([]);
	});

	it("classifies every builtin slash command", () => {
		const registered = BUILTIN_SLASH_COMMANDS_INTERNAL.map(spec => spec.name);
		expect(registered.filter(name => !(name in SLASH_COMMANDS))).toEqual([]);
		expect(Object.keys(SLASH_COMMANDS).filter(name => !registered.includes(name))).toEqual([]);
		for (const name of registered) {
			const spec = slashSpec(name);
			expect({ name, runnable: spec.handle !== undefined || spec.handleTui !== undefined }).toEqual({
				name,
				runnable: true,
			});
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
			const seam = (f.session as unknown as Record<string, unknown>)[name];
			if (typeof seam !== "function") throw new Error(`${name} is not a method`);
			const args = SEAM_ARGS[name]?.(f.cwd) ?? [];
			const outcome = await drive(() => (seam as (...args: unknown[]) => unknown).apply(f.session, args));
			const failClosed = FAIL_CLOSED_SEAMS[name];
			expectNoLegacyPath(name, outcome, failClosed);
			if (failClosed !== undefined) {
				expect(await fs.readFile(f.file)).toEqual(bytes);
				expect(f.manager.getEntries()).toHaveLength(entries);
			}
		});
	}
});

describe("builtin slash commands on an admitted root shared session", () => {
	for (const [name, classification] of Object.entries(SLASH_COMMANDS)) {
		if ("skip" in classification) continue;
		it(`/${name} never reaches a refused legacy writer`, async () => {
			const { outcome } = await driveSlash(name, classification.args ?? "");
			expectNoLegacyPath(`/${name}`, outcome);
		});
	}

	it("/star and /unstar commit through shared publication as append-only header patches", async () => {
		const f = await driveSlash("star", "");
		expect(describeOutcome(f.outcome)).toBe("fulfilled");
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
		expect(describeOutcome(unstar)).toBe("fulfilled");
		expectNoLegacyPath("/unstar", unstar);
		const unstarredBytes = await fs.readFile(f.file);
		expect(unstarredBytes.subarray(0, starredBytes.length)).toEqual(starredBytes);
		const reopened = await SessionManager.open(f.file, f.destination);
		cleanups.push(() => reopened.closeStrict());
		expect(reopened.isSessionStarred()).toBe(false);
	});
});
