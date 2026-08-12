import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import type { LoadContext } from "../src/capability/types";
import {
	applyExecutionPreset,
	type ExecutionPresetApplyReceipt,
	type ExecutionPresetInput,
	type ExecutionPresetScope,
	ExecutionPresetStore,
	previewExecutionPreset,
} from "../src/config/execution-preset";
import {
	type ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationService,
} from "../src/config/scoped-configuration-mutation";
import {
	ExecutionPresetSelectorComponent,
	type ExecutionPresetSelectorSource,
} from "../src/modes/components/execution-preset-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import { DEFAULT_TASK_EXECUTION_POLICY, TaskExecutionPolicyController } from "../src/task/execution-policy";

export const EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA: "gjc.execution-preset.visual-capture" =
	"gjc.execution-preset.visual-capture";
export const EXECUTION_PRESET_VISUAL_CAPTURE_VERSION: 1 = 1;
export const EXECUTION_PRESET_VISUAL_CAPTURE_COUNT: 48 = 48;
export const EXECUTION_PRESET_CAPTURE_TIMESTAMP: "1970-01-01T00:00:00.000Z" = "1970-01-01T00:00:00.000Z";
export const EXECUTION_PRESET_CAPTURE_LOCALE: "en-US" = "en-US";
export const EXECUTION_PRESET_CAPTURE_TIMEZONE: "UTC" = "UTC";
export const EXECUTION_PRESET_CAPTURE_SEED: "g005-execution-preset-seed-v1" = "g005-execution-preset-seed-v1";
export const EXECUTION_PRESET_CAPTURE_THEME: "red-claw" = "red-claw";
export const EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT: ".gjc/qa/G005-execution-preset" = ".gjc/qa/G005-execution-preset";
export const EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export const EXECUTION_PRESET_SOURCE_CLOSURE_FILES: readonly string[] = Object.freeze([
	"packages/coding-agent/src/modes/components/execution-preset-selector.ts",
	"packages/coding-agent/src/config/execution-preset.ts",
	"packages/coding-agent/src/task/execution-policy.ts",
	"packages/coding-agent/src/task/index.ts",
	"packages/coding-agent/src/task/executor.ts",
	"packages/coding-agent/src/sdk/session.ts",
	"packages/coding-agent/src/cursor.ts",
	"packages/coding-agent/src/session/agent-session.ts",
	"packages/coding-agent/src/modes/interactive-mode.ts",
	"packages/coding-agent/src/modes/controllers/selector-controller.ts",
	"packages/coding-agent/src/slash-commands/builtin-registry.ts",
	"packages/coding-agent/src/config/scoped-configuration-mutation.ts",
	"packages/coding-agent/src/config/atomic-yaml-patch.ts",
	"packages/coding-agent/src/config/file-lock.ts",
	"packages/coding-agent/src/modes/components/dynamic-border.ts",
	"packages/coding-agent/src/modes/theme/theme.ts",
	"packages/coding-agent/src/modes/theme/defaults/index.ts",
	"packages/coding-agent/src/modes/theme/defaults/red-claw.json",
	"packages/coding-agent/scripts/capture-execution-preset-showcase.ts",
	"packages/coding-agent/scripts/verify-execution-preset-showcase.ts",
	"packages/coding-agent/test/cursor-exec-handlers.test.ts",
	"packages/coding-agent/test/execution-preset-visual-capture.test.ts",
]);

export const EXECUTION_PRESET_CAPTURE_FILES: readonly string[] = Object.freeze([
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
	"manifest.json",
]);

export type ExecutionPresetVisualStateId =
	| "list-session"
	| "list-project"
	| "list-user"
	| "preview-secure"
	| "preview-fast"
	| "preview-isolated"
	| "scope-cycle"
	| "apply-session"
	| "apply-project-committed"
	| "apply-user-degraded"
	| "apply-conflict"
	| "stale-preview"
	| "custom-cjk"
	| "custom-redacted"
	| "delete-confirm"
	| "no-color-disposed";

export const EXECUTION_PRESET_VISUAL_STATE_IDS: readonly ExecutionPresetVisualStateId[] = Object.freeze([
	"list-session",
	"list-project",
	"list-user",
	"preview-secure",
	"preview-fast",
	"preview-isolated",
	"scope-cycle",
	"apply-session",
	"apply-project-committed",
	"apply-user-degraded",
	"apply-conflict",
	"stale-preview",
	"custom-cjk",
	"custom-redacted",
	"delete-confirm",
	"no-color-disposed",
]);

type ExecutionPresetViewport = Readonly<{
	readonly id: "80x24" | "120x36" | "160x48";
	readonly columns: 80 | 120 | 160;
	readonly rows: 24 | 36 | 48;
}>;

export const EXECUTION_PRESET_VIEWPORTS: readonly ExecutionPresetViewport[] = Object.freeze([
	Object.freeze({ id: "80x24", columns: 80, rows: 24 }),
	Object.freeze({ id: "120x36", columns: 120, rows: 36 }),
	Object.freeze({ id: "160x48", columns: 160, rows: 48 }),
]);

export const EXECUTION_PRESET_VISUAL_KEYS: readonly string[] = Object.freeze([
	"list-session/80x24",
	"list-session/120x36",
	"list-session/160x48",
	"list-project/80x24",
	"list-project/120x36",
	"list-project/160x48",
	"list-user/80x24",
	"list-user/120x36",
	"list-user/160x48",
	"preview-secure/80x24",
	"preview-secure/120x36",
	"preview-secure/160x48",
	"preview-fast/80x24",
	"preview-fast/120x36",
	"preview-fast/160x48",
	"preview-isolated/80x24",
	"preview-isolated/120x36",
	"preview-isolated/160x48",
	"scope-cycle/80x24",
	"scope-cycle/120x36",
	"scope-cycle/160x48",
	"apply-session/80x24",
	"apply-session/120x36",
	"apply-session/160x48",
	"apply-project-committed/80x24",
	"apply-project-committed/120x36",
	"apply-project-committed/160x48",
	"apply-user-degraded/80x24",
	"apply-user-degraded/120x36",
	"apply-user-degraded/160x48",
	"apply-conflict/80x24",
	"apply-conflict/120x36",
	"apply-conflict/160x48",
	"stale-preview/80x24",
	"stale-preview/120x36",
	"stale-preview/160x48",
	"custom-cjk/80x24",
	"custom-cjk/120x36",
	"custom-cjk/160x48",
	"custom-redacted/80x24",
	"custom-redacted/120x36",
	"custom-redacted/160x48",
	"delete-confirm/80x24",
	"delete-confirm/120x36",
	"delete-confirm/160x48",
	"no-color-disposed/80x24",
	"no-color-disposed/120x36",
	"no-color-disposed/160x48",
]);

if (
	EXECUTION_PRESET_VISUAL_STATE_IDS.length !== 16 ||
	EXECUTION_PRESET_VIEWPORTS.length !== 3 ||
	EXECUTION_PRESET_VISUAL_KEYS.length !== EXECUTION_PRESET_VISUAL_CAPTURE_COUNT
) {
	throw new Error("Execution preset showcase matrix must contain exactly 48 keys.");
}

export type ExecutionPresetSourceClosure = Readonly<{ files: readonly string[]; sha256: string }>;
export type ExecutionPresetReceiptEvidence = Readonly<{
	status: string | null;
	reason: string | null;
	timing: string | null;
	durability: string | null;
	mutationStatus: string | null;
	mutationReason: string | null;
	mutationDurability: string | null;
	controllerRevision: number;
	controllerFingerprint: string;
}>;

type ExecutionPresetFlags = Readonly<{
	noColor: boolean;
	cjk: boolean;
	redacted: boolean;
	disposal: boolean;
}>;

type ExecutionPresetRenderTrace = Readonly<{
	component: "ExecutionPresetSelectorComponent";
	theme: typeof EXECUTION_PRESET_CAPTURE_THEME;
	productionRender: true;
	noColorDisposition: "ansi_stripped" | "native_color";
	beforeInteractionSha256: string;
	afterInteractionSha256: string;
	interactionChanged: boolean;
	beforeDisposalSha256: string | null;
	callbackCountBeforeDisposal: number | null;
	callbackCountAfterDisposal: number | null;
	statusCountBeforeDisposal: number | null;
	statusCountAfterDisposal: number | null;
	requestRenderCountBeforeDisposal: number | null;
	requestRenderCountAfterDisposal: number | null;
	disposition: "none" | "late_apply_cancelled";

	postDisposalSha256: string | null;
	postDisposalChanged: boolean;
	controllerRevision: number;
	controllerFingerprint: string;
	receiptSemanticHash: string;
}>;

export type ExecutionPresetVisualCaptureEntry = Readonly<{
	key: string;
	stateId: ExecutionPresetVisualStateId;
	semanticStateId: ExecutionPresetVisualStateId;
	semanticStatus: string;
	semanticRows: readonly string[];
	semanticDetailHash: string;
	viewport: ExecutionPresetViewport;
	flags: ExecutionPresetFlags;
	lineStart: number;
	lineCount: number;
	lineWidths: readonly number[];
	plainSha256: string;
	ansiSha256: string;
	productionRender: true;
	component: "ExecutionPresetSelectorComponent";
	theme: typeof EXECUTION_PRESET_CAPTURE_THEME;
	renderTrace: ExecutionPresetRenderTrace;
	renderTraceHash: string;
	receipt: ExecutionPresetReceiptEvidence;
	actions: readonly string[];
}>;

export type ExecutionPresetVisualCaptureMetadata = Readonly<{
	schema: typeof EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA;
	version: typeof EXECUTION_PRESET_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	captureTimestamp: string;
	locale: typeof EXECUTION_PRESET_CAPTURE_LOCALE;
	timezone: typeof EXECUTION_PRESET_CAPTURE_TIMEZONE;
	seed: typeof EXECUTION_PRESET_CAPTURE_SEED;
	theme: typeof EXECUTION_PRESET_CAPTURE_THEME;
	hostMatrix: Readonly<{ captureHost: "VirtualTerminal"; livePty: false; network: false }>;
	fontRenderingAssumptions: string;
	wrappingPolicy: string;
	ansiControlSemantics: string;
	sourceClosure: ExecutionPresetSourceClosure;
	expectedKeyCount: typeof EXECUTION_PRESET_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	entries: readonly ExecutionPresetVisualCaptureEntry[];
	hashes: Readonly<Record<"terminal.txt" | "terminal-ansi.txt" | "terminal.html", string>>;
}>;

export type ExecutionPresetVisualCaptureManifest = Readonly<{
	schema: typeof EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA;
	version: typeof EXECUTION_PRESET_VISUAL_CAPTURE_VERSION;
	sourceHash: string;
	sourceClosure: ExecutionPresetSourceClosure;
	expectedKeyCount: typeof EXECUTION_PRESET_VISUAL_CAPTURE_COUNT;
	keys: readonly string[];
	files: Readonly<
		Record<
			"terminal.txt" | "terminal-ansi.txt" | "terminal.html" | "metadata.json",
			Readonly<{ sha256: string; byteLength: number }>
		>
	>;
	entries: readonly ExecutionPresetVisualCaptureEntry[];
}>;

export type ExecutionPresetVisualCaptureOptions = Readonly<{
	repoRoot?: string;
	sourceHash?: string;
	timestamp?: string;
}>;

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const safeHash = (value: string | undefined, fallback: string): string => {
	const candidate = value?.trim() || fallback;
	if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)) throw new Error("Invalid execution preset source hash.");
	return candidate;
};
const safeTimestamp = (value: string | undefined): string => {
	const candidate = value?.trim() || EXECUTION_PRESET_CAPTURE_TIMESTAMP;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate))
		throw new Error("Invalid execution preset capture timestamp.");
	return candidate;
};

export async function computeExecutionPresetSourceClosure(
	repoRootInput: string = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT,
): Promise<ExecutionPresetSourceClosure> {
	const repoRoot = path.resolve(repoRootInput);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of EXECUTION_PRESET_SOURCE_CLOSURE_FILES) {
		hasher.update(relativePath);
		hasher.update("\0");
		try {
			hasher.update(await fs.readFile(path.join(repoRoot, relativePath)));
		} catch {
			throw new Error(`Execution preset source closure file unavailable: ${relativePath}`);
		}
	}
	return Object.freeze({ files: EXECUTION_PRESET_SOURCE_CLOSURE_FILES, sha256: hasher.digest("hex") });
}

const POLICY: ExecutionPresetInput["policy"] = {
	isolation: "current",
	toolAccess: { allow: [], deny: [] },
	mcpDiscovery: "configured",
	maxDurationMs: 15 * 60 * 1000,
	simpleMode: false,
};

const CJK_CUSTOM: ExecutionPresetInput = {
	id: "custom-cjk",
	label: "研究者プリセット",
	description: "日本語と한국어の実行プリセット",
	policy: POLICY,
};

const REDACTED_CUSTOM: ExecutionPresetInput = {
	id: "custom-redacted",
	label: "Redacted Review",
	description:
		"URL=https://user:pass@example.test/private?token=top-secret path=/Users/private/credential.txt apiKey=sk-test-secret-123",
	policy: POLICY,
};

const DELETE_CUSTOM: ExecutionPresetInput = {
	id: "custom-cjk",
	label: "研究者プリセット",
	description: "保存された日本語プリセット",
	policy: POLICY,
};

type WriterMode = "committed" | "degraded";

type CaptureHarness = Readonly<{
	component: ExecutionPresetSelectorComponent;
	terminal: VirtualTerminal;
	tui: TUI;
	controller: TaskExecutionPolicyController;
	resolveLateApply: () => void;
	callbackCount: () => number;
	statusCount: () => number;
	requestRenderCount: () => number;
	lastMutation: () => ScopedConfigurationMutationReceipt | null;
	lateApplyReceipt: () => ExecutionPresetApplyReceipt | undefined;

	applied: readonly ExecutionPresetApplyReceipt[];
	close: () => Promise<void>;
}>;

function loadContext(root: string): LoadContext {
	return Object.freeze({
		cwd: path.join(root, "repo", "nested"),
		home: path.join(root, "home"),
		repoRoot: path.join(root, "repo"),
	});
}

async function createHarness(
	viewport: ExecutionPresetViewport,
	stateId: ExecutionPresetVisualStateId,
): Promise<CaptureHarness> {
	const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gjc-g005-execution-preset-"));
	const context = loadContext(root);
	const controller = new TaskExecutionPolicyController();
	const initialScope: ExecutionPresetScope = "session";
	const mode: WriterMode = stateId === "apply-user-degraded" ? "degraded" : "committed";
	const serviceByScope = new Map<"project" | "user", ScopedConfigurationMutationService>();
	const mutationByScope = new Map<"project" | "user", ScopedConfigurationMutationReceipt | null>();
	const serviceFor = (scope: "project" | "user"): Pick<ScopedConfigurationMutationService, "read" | "mutate"> => {
		const existing = serviceByScope.get(scope);
		if (existing)
			return {
				read: readScope => existing.read(readScope),
				mutate: async request => {
					const receipt = await existing.mutate(request);
					mutationByScope.set(scope, receipt);
					return receipt;
				},
			};
		const service = new ScopedConfigurationMutationService({
			loadContext: context,
			agentDir: path.join(root, "agent"),
			reloadAndVerify: () => mode !== "degraded",
		});
		serviceByScope.set(scope, service);
		return {
			read: readScope => service.read(readScope),
			mutate: async request => {
				const receipt = await service.mutate(request);
				mutationByScope.set(scope, receipt);
				return receipt;
			},
		};
	};
	const customSession =
		stateId === "custom-cjk" ? [CJK_CUSTOM] : stateId === "custom-redacted" ? [REDACTED_CUSTOM] : [];
	const customProject = stateId === "delete-confirm" ? [DELETE_CUSTOM] : [];
	const sessionStore = new ExecutionPresetStore({ scope: "session", customPresets: customSession });
	const projectStore = new ExecutionPresetStore({
		scope: "project",
		scopedMutationService: serviceFor("project"),
		customPresets: customProject,
	});
	const userStore = new ExecutionPresetStore({ scope: "user", scopedMutationService: serviceFor("user") });
	const stores = new Map<ExecutionPresetScope, ExecutionPresetStore>([
		["session", sessionStore],
		["project", projectStore],
		["user", userStore],
	]);
	let selectedScope: ExecutionPresetScope = initialScope;
	let lateApplyReceipt: ExecutionPresetApplyReceipt | undefined;

	let lateApplyResolver: (() => void) | undefined;
	let appliedCallbackCount = 0;
	let statusCallbackCount = 0;
	let requestRenderCallbackCount = 0;
	const applied: ExecutionPresetApplyReceipt[] = [];
	const source: ExecutionPresetSelectorSource = {
		store: stores.get(initialScope) ?? sessionStore,
		controller,
		scopes: ["session", "project", "user"],
		getScope: () => selectedScope,
		setScope: scope => {
			selectedScope = scope;
		},
		getStoreForScope: scope => {
			const store = stores.get(scope);
			if (!store) throw new Error(`Execution preset scope is unavailable: ${scope}`);
			return store;
		},
		previewPreset: (store, id, currentController, scope) =>
			previewExecutionPreset(store, id, currentController, scope),
		applyPreset: (store, preview, currentController, scope, signal) => {
			const expectedOwner = stateId === "apply-conflict" ? { digest: "not-the-current-digest" } : undefined;
			if (stateId === "no-color-disposed") {
				return new Promise<ExecutionPresetApplyReceipt>((resolve, reject) => {
					lateApplyResolver = () => {
						void applyExecutionPreset(store, preview, currentController, {
							scope,
							preview,
							signal,
							...(expectedOwner ? { expectedOwner } : {}),
						}).then(receipt => {
							lateApplyReceipt = receipt;
							resolve(receipt);
						}, reject);
					};
				});
			}
			return applyExecutionPreset(store, preview, currentController, {
				scope,
				preview,
				signal,
				...(expectedOwner ? { expectedOwner } : {}),
			});
		},
	};
	const component = new ExecutionPresetSelectorComponent(source, {
		onApplied: receipt => {
			appliedCallbackCount += 1;
			applied.push(receipt);
		},
		onStatus: () => {
			statusCallbackCount += 1;
		},
		requestRender: () => {
			requestRenderCallbackCount += 1;
		},
	});
	const terminal = new VirtualTerminal(viewport.columns, viewport.rows, { isProcessTerminal: true });
	const tui = new TUI(terminal, false, { widthSettleMs: 0 });
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await terminal.waitForRender();
	return {
		component,
		terminal,
		tui,
		controller,
		resolveLateApply: () => {
			const resolve = lateApplyResolver;
			if (!resolve) throw new Error("No pending execution preset apply exists.");
			lateApplyResolver = undefined;
			resolve();
		},
		callbackCount: () => appliedCallbackCount,
		statusCount: () => statusCallbackCount,
		requestRenderCount: () => requestRenderCallbackCount,
		lastMutation: () => {
			const project = mutationByScope.get("project");
			const user = mutationByScope.get("user");
			return user ?? project ?? null;
		},
		lateApplyReceipt: () => lateApplyReceipt,

		applied,
		close: async () => {
			component.dispose();
			tui.stop();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

const EXECUTION_PRESET_RECEIPT_WAIT_TIMEOUT_MS = 2_000;

async function waitForAppliedReceipts(harness: CaptureHarness, expectedCount: number): Promise<void> {
	if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
		throw new Error(`Expected applied receipt count must be a positive safe integer; received ${expectedCount}.`);
	}
	const deadline = performance.now() + EXECUTION_PRESET_RECEIPT_WAIT_TIMEOUT_MS;
	while (harness.applied.length < expectedCount) {
		const remainingMs = deadline - performance.now();
		if (remainingMs <= 0) {
			throw new Error(
				`Timed out waiting for ${expectedCount} applied receipt(s); received ${harness.applied.length}.`,
			);
		}
		await Promise.resolve();
		await Bun.sleep(0);
		const renderCompleted = await Promise.race([
			harness.terminal.waitForRender().then(() => true),
			Bun.sleep(remainingMs).then(() => false),
		]);
		if (!renderCompleted && harness.applied.length < expectedCount) {
			throw new Error(
				`Timed out waiting for ${expectedCount} applied receipt(s); received ${harness.applied.length}.`,
			);
		}
	}
}
async function waitForLastMutation(harness: CaptureHarness): Promise<void> {
	const deadline = performance.now() + EXECUTION_PRESET_RECEIPT_WAIT_TIMEOUT_MS;
	while (harness.lastMutation() === null) {
		const remainingMs = deadline - performance.now();
		if (remainingMs <= 0) {
			throw new Error("Timed out waiting for a persisted mutation receipt.");
		}
		await Promise.resolve();
		await Bun.sleep(0);
		const renderCompleted = await Promise.race([
			harness.terminal.waitForRender().then(() => true),
			Bun.sleep(remainingMs).then(() => false),
		]);
		if (!renderCompleted && harness.lastMutation() === null) {
			throw new Error("Timed out waiting for a persisted mutation receipt.");
		}
	}
}

async function settle(harness: CaptureHarness): Promise<void> {
	for (let index = 0; index < 3; index += 1) {
		await Promise.resolve();
		await Bun.sleep(0);
		await harness.terminal.waitForRender();
	}
}

function frameFor(
	component: ExecutionPresetSelectorComponent,
	width: number,
	noColor: boolean,
): Readonly<{ ansi: string[]; plain: string[] }> {
	const rendered = component.render(width);
	const ansi = noColor ? rendered.map(line => Bun.stripANSI(line)) : [...rendered];
	return Object.freeze({ ansi, plain: ansi.map(line => Bun.stripANSI(line)) });
}

function flagsFor(stateId: ExecutionPresetVisualStateId): ExecutionPresetFlags {
	return Object.freeze({
		noColor: stateId === "no-color-disposed",
		cjk: stateId === "custom-cjk",
		redacted: stateId === "custom-redacted",
		disposal: stateId === "no-color-disposed",
	});
}

function semanticStatusFor(stateId: ExecutionPresetVisualStateId): string {
	if (stateId.startsWith("list-") || stateId === "scope-cycle" || stateId === "custom-redacted") return "list";
	if (stateId.startsWith("preview-") || stateId === "custom-cjk") return "preview";
	if (stateId === "apply-session" || stateId === "apply-project-committed") return "applied";
	if (stateId === "apply-user-degraded") return "degraded";
	if (stateId === "apply-conflict") return "conflict";
	if (stateId === "stale-preview") return "stale";
	if (stateId === "delete-confirm") return "deleted";
	return "disposed";
}

function semanticRowsFor(stateId: ExecutionPresetVisualStateId, scope: ExecutionPresetScope): readonly string[] {
	const scopeLabel = scope === "session" ? "Session" : scope === "project" ? "Project" : "User";
	if (stateId.startsWith("list-") || stateId === "scope-cycle") {
		return Object.freeze(["Execution presets", `Scope: ${scopeLabel}`]);
	}
	if (stateId === "preview-secure" || stateId === "no-color-disposed")
		return Object.freeze(["Preview: Secure Review", "Work Mode: unchanged"]);
	if (stateId === "preview-fast") return Object.freeze(["Preview: Fast Build", "Work Mode: unchanged"]);
	if (stateId === "preview-isolated") return Object.freeze(["Preview: Isolated Autonomy", "Work Mode: unchanged"]);
	if (stateId === "custom-cjk") return Object.freeze(["Preview: 研究者プリセット", "日本語と한국어"]);
	if (stateId === "custom-redacted") return Object.freeze(["Redacted Review · custom-redacted", "<redacted>"]);
	if (stateId === "apply-session")
		return Object.freeze(["Status: Applied for Session; timing current_runtime; durability none."]);
	if (stateId === "apply-project-committed")
		return Object.freeze(["Status: Applied for Project; timing current_runtime; durability committed."]);
	if (stateId === "apply-user-degraded")
		return Object.freeze([`Status: Saved for ${scopeLabel}; runtime active, verification degraded.`]);
	if (stateId === "apply-conflict")
		return Object.freeze(["The user preset changed elsewhere; no change was applied."]);
	if (stateId === "stale-preview") return Object.freeze(["The preset could not be applied; no change was applied."]);
	return Object.freeze(["Deleted from Project."]);
}

function receiptEvidence(
	harness: CaptureHarness,
	stateId: ExecutionPresetVisualStateId,
): ExecutionPresetReceiptEvidence {
	const receipt = harness.applied.at(-1) ?? harness.lateApplyReceipt();
	const mutation = harness.lastMutation();
	const snapshot = harness.controller.getSnapshot();
	return Object.freeze({
		status: receipt?.status ?? (stateId === "delete-confirm" ? "deleted" : null),
		reason: receipt?.reason ?? mutation?.reason ?? null,
		timing: receipt?.timing ?? mutation?.timing ?? null,
		durability: receipt?.durability ?? mutation?.durability ?? null,
		mutationStatus: mutation?.status ?? null,
		mutationReason: mutation?.reason ?? null,
		mutationDurability: mutation?.durability ?? null,
		controllerRevision: snapshot.revision,
		controllerFingerprint: snapshot.fingerprint,
	});
}

function actionsFor(stateId: ExecutionPresetVisualStateId): readonly string[] {
	switch (stateId) {
		case "list-session":
			return Object.freeze(["render:ExecutionPresetSelectorComponent"]);
		case "list-project":
			return Object.freeze(["render:ExecutionPresetSelectorComponent", "keyboard:s", "scope:project"]);
		case "list-user":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
			]);
		case "preview-secure":
			return Object.freeze(["render:ExecutionPresetSelectorComponent", "keyboard:Enter"]);
		case "preview-fast":
			return Object.freeze(["render:ExecutionPresetSelectorComponent", "keyboard:ArrowDown", "keyboard:Enter"]);
		case "preview-isolated":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:Enter",
			]);
		case "scope-cycle":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
			]);
		case "apply-session":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:applied",
			]);
		case "apply-project-committed":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:committed",
			]);
		case "apply-user-degraded":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:degraded",
			]);
		case "apply-conflict":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:s",
				"scope:user",
				"keyboard:Enter",
				"keyboard:Enter",
				"receipt:conflict",
			]);
		case "stale-preview":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:Enter",
				"controller:apply-default",
				"keyboard:Enter",
				"receipt:preview_stale",
			]);
		case "custom-cjk":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:Enter",
			]);
		case "custom-redacted":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
			]);
		case "delete-confirm":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:s",
				"scope:project",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:ArrowDown",
				"keyboard:d",
				"keyboard:Enter",
				"delete:custom-cjk",
			]);
		case "no-color-disposed":
			return Object.freeze([
				"render:ExecutionPresetSelectorComponent",
				"keyboard:Enter",
				"keyboard:Enter",
				"apply:pending",
				"disposal:ExecutionPresetSelectorComponent",
				"late-receipt:cancelled",
			]);
	}
}

async function renderState(
	stateId: ExecutionPresetVisualStateId,
	viewport: ExecutionPresetViewport,
): Promise<
	Readonly<{
		plain: string[];
		ansi: string[];
		flags: ExecutionPresetFlags;
		semanticStatus: string;
		semanticRows: readonly string[];
		receipt: ExecutionPresetReceiptEvidence;
		renderTrace: ExecutionPresetRenderTrace;
		renderTraceHash: string;
		semanticDetailHash: string;
		actions: readonly string[];
	}>
> {
	const flags = flagsFor(stateId);
	const harness = await createHarness(viewport, stateId);
	let disposed = false;
	try {
		const actions = [...actionsFor(stateId)];
		const send = async (key: string): Promise<void> => {
			harness.component.handleInput(key);
			await settle(harness);
		};
		const before = frameFor(harness.component, viewport.columns, flags.noColor);
		const beforeHash = hash(before.ansi.join("\n"));
		let beforeDisposalSha256: string | null = null;
		let callbackCountBeforeDisposal: number | null = null;
		let callbackCountAfterDisposal: number | null = null;
		let statusCountBeforeDisposal: number | null = null;
		let statusCountAfterDisposal: number | null = null;
		let requestRenderCountBeforeDisposal: number | null = null;
		let requestRenderCountAfterDisposal: number | null = null;
		let disposition: "none" | "late_apply_cancelled" = "none";

		if (stateId === "list-project") {
			await send("s");
		} else if (stateId === "apply-project-committed") {
			await send("s");
			await send("\n");
			await send("\n");
			await waitForAppliedReceipts(harness, 1);
		} else if (stateId === "list-user") {
			await send("s");
			await send("s");
		} else if (stateId === "apply-user-degraded" || stateId === "apply-conflict") {
			await send("s");
			await send("s");
			await send("\n");
			await send("\n");
			await waitForAppliedReceipts(harness, 1);
		} else if (stateId === "scope-cycle") {
			await send("s");
			await send("s");
		} else if (stateId === "delete-confirm") {
			await send("s");
			await send("\x1b[B");
			await send("\x1b[B");
			await send("\x1b[B");
			await send("d");
			await send("\n");
			await waitForLastMutation(harness);
		} else if (stateId === "preview-fast") {
			await send("\x1b[B");
			await send("\n");
		} else if (stateId === "preview-isolated") {
			await send("\x1b[B");
			await send("\x1b[B");
			await send("\n");
		} else if (stateId === "preview-secure" || stateId === "apply-session" || stateId === "stale-preview") {
			await send("\n");
			if (stateId === "apply-session") {
				await send("\n");
				await waitForAppliedReceipts(harness, 1);
			}
			if (stateId === "stale-preview") {
				harness.controller.apply(DEFAULT_TASK_EXECUTION_POLICY);
				await send("\n");
				await waitForAppliedReceipts(harness, 1);
			}
		} else if (stateId === "custom-cjk") {
			await send("\x1b[B");
			await send("\x1b[B");
			await send("\x1b[B");
			await send("\n");
		} else if (stateId === "custom-redacted") {
			await send("\x1b[B");
			await send("\x1b[B");
			await send("\x1b[B");
		} else if (stateId === "no-color-disposed") {
			await send("\n");
			harness.component.handleInput("\n");
			await settle(harness);
			const beforeDisposal = frameFor(harness.component, viewport.columns, flags.noColor);
			beforeDisposalSha256 = hash(beforeDisposal.ansi.join("\n"));
			callbackCountBeforeDisposal = harness.callbackCount();
			statusCountBeforeDisposal = harness.statusCount();
			requestRenderCountBeforeDisposal = harness.requestRenderCount();
			harness.component.dispose();
			disposed = true;
			harness.resolveLateApply();
			await settle(harness);
			callbackCountAfterDisposal = harness.callbackCount();
			statusCountAfterDisposal = harness.statusCount();
			requestRenderCountAfterDisposal = harness.requestRenderCount();
			disposition = "late_apply_cancelled";
		}
		const after = frameFor(harness.component, viewport.columns, flags.noColor);
		const afterHash = hash(after.ansi.join("\n"));
		let postDisposalSha256: string | null = null;
		let postDisposalChanged = false;
		if (flags.disposal) {
			postDisposalSha256 = afterHash;
			postDisposalChanged = postDisposalSha256 !== beforeDisposalSha256;
		}
		const receipt = receiptEvidence(harness, stateId);
		const renderTrace: ExecutionPresetRenderTrace = Object.freeze({
			component: "ExecutionPresetSelectorComponent",
			theme: EXECUTION_PRESET_CAPTURE_THEME,
			productionRender: true,
			noColorDisposition: flags.noColor ? "ansi_stripped" : "native_color",
			beforeInteractionSha256: beforeHash,
			afterInteractionSha256: afterHash,
			interactionChanged: beforeHash !== afterHash,
			beforeDisposalSha256,
			callbackCountBeforeDisposal,
			callbackCountAfterDisposal,
			statusCountBeforeDisposal,
			statusCountAfterDisposal,
			requestRenderCountBeforeDisposal,
			requestRenderCountAfterDisposal,
			disposition,
			postDisposalSha256,
			postDisposalChanged,
			controllerRevision: receipt.controllerRevision,
			controllerFingerprint: receipt.controllerFingerprint,
			receiptSemanticHash: hash(JSON.stringify(receipt)),
		});
		const semanticRows = semanticRowsFor(stateId, harness.component.getScope());
		const semanticDetailHash = hash(`${stateId}\0${after.plain.join("\n")}\0${JSON.stringify(receipt)}`);
		return Object.freeze({
			plain: after.plain,
			ansi: after.ansi,
			flags,
			semanticStatus: semanticStatusFor(stateId),
			semanticRows,
			receipt,
			renderTrace,
			renderTraceHash: hash(JSON.stringify(renderTrace)),
			semanticDetailHash,
			actions: Object.freeze(actions),
		});
	} finally {
		if (!disposed) harness.component.dispose();
		await harness.close();
	}
}

function htmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function ansiToHtml(value: string): string {
	let body = "";
	let offset = 0;
	let color: string | undefined;
	for (const match of value.matchAll(/\x1b\[([0-9;]*)m/gu)) {
		body += htmlEscape(value.slice(offset, match.index));
		offset = (match.index ?? 0) + match[0].length;
		const token = match[1] ?? "0";
		if (token === "0" || token === "39") {
			if (color) body += "</span>";
			color = undefined;
			continue;
		}
		const rgb = token.match(/^38;2;(\d+);(\d+);(\d+)$/u);
		if (rgb) {
			if (color) body += "</span>";
			color = `color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
			body += `<span style="${color}">`;
		}
	}
	body += htmlEscape(value.slice(offset));
	if (color) body += "</span>";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Execution preset showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{margin:0;padding:1em;white-space:pre;font-family:ui-monospace,monospace}</style></head><body><pre>${body}</pre></body></html>\n`;
}

function entryFor(
	stateId: ExecutionPresetVisualStateId,
	viewport: ExecutionPresetViewport,
	lineStart: number,
	rendered: Awaited<ReturnType<typeof renderState>>,
): ExecutionPresetVisualCaptureEntry {
	return Object.freeze({
		key: `${stateId}/${viewport.id}`,
		stateId,
		semanticStateId: stateId,
		semanticStatus: rendered.semanticStatus,
		semanticRows: rendered.semanticRows,
		semanticDetailHash: rendered.semanticDetailHash,
		viewport,
		flags: rendered.flags,
		lineStart,
		lineCount: rendered.plain.length,
		lineWidths: rendered.plain.map(line => Bun.stringWidth(line)),
		plainSha256: hash(rendered.plain.join("\n")),
		ansiSha256: hash(rendered.ansi.join("\n")),
		productionRender: true,
		component: "ExecutionPresetSelectorComponent",
		theme: EXECUTION_PRESET_CAPTURE_THEME,
		renderTrace: rendered.renderTrace,
		renderTraceHash: rendered.renderTraceHash,
		receipt: rendered.receipt,
		actions: rendered.actions,
	});
}

export async function captureExecutionPresetShowcase(
	outputRootInput: string = EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT,
	options: ExecutionPresetVisualCaptureOptions = {},
): Promise<ExecutionPresetVisualCaptureManifest> {
	const outputRoot = path.resolve(outputRootInput);
	const installedTheme = await getThemeByName(EXECUTION_PRESET_CAPTURE_THEME);
	if (!installedTheme) throw new Error("Execution preset showcase red-claw theme is unavailable.");
	setThemeInstance(installedTheme);
	const sourceClosure = await computeExecutionPresetSourceClosure(options.repoRoot);
	const sourceHash = safeHash(options.sourceHash, sourceClosure.sha256);
	const captureTimestamp = safeTimestamp(options.timestamp);
	const plainLines: string[] = [];
	const ansiLines: string[] = [];
	const entries: ExecutionPresetVisualCaptureEntry[] = [];
	for (const stateId of EXECUTION_PRESET_VISUAL_STATE_IDS) {
		for (const viewport of EXECUTION_PRESET_VIEWPORTS) {
			const rendered = await renderState(stateId, viewport);
			const lineStart = plainLines.length;
			plainLines.push(...rendered.plain);
			ansiLines.push(...rendered.ansi);
			entries.push(entryFor(stateId, viewport, lineStart, rendered));
		}
	}
	const terminalText = `${plainLines.join("\n")}\n`;
	const terminalAnsiText = `${ansiLines.join("\n")}\n`;
	const terminalHtml = ansiToHtml(terminalAnsiText);
	const metadata: ExecutionPresetVisualCaptureMetadata = {
		schema: EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA,
		version: EXECUTION_PRESET_VISUAL_CAPTURE_VERSION,
		sourceHash,
		captureTimestamp,
		locale: EXECUTION_PRESET_CAPTURE_LOCALE,
		timezone: EXECUTION_PRESET_CAPTURE_TIMEZONE,
		seed: EXECUTION_PRESET_CAPTURE_SEED,
		theme: EXECUTION_PRESET_CAPTURE_THEME,
		hostMatrix: { captureHost: "VirtualTerminal", livePty: false, network: false },
		fontRenderingAssumptions:
			"Embedded red-claw theme at deterministic truecolor; HTML uses a monospace terminal fallback stack.",
		wrappingPolicy:
			"ExecutionPresetSelectorComponent owns ANSI-aware terminal-cell truncation at each recorded viewport width.",
		ansiControlSemantics:
			"VirtualTerminal-backed production TUI rendering preserves SGR; no-color evidence strips SGR only.",
		sourceClosure,
		expectedKeyCount: EXECUTION_PRESET_VISUAL_CAPTURE_COUNT,
		keys: EXECUTION_PRESET_VISUAL_KEYS,
		entries,
		hashes: {
			"terminal.txt": hash(terminalText),
			"terminal-ansi.txt": hash(terminalAnsiText),
			"terminal.html": hash(terminalHtml),
		},
	};
	const metadataText = json(metadata);
	const files: ExecutionPresetVisualCaptureManifest["files"] = {
		"terminal.txt": { sha256: hash(terminalText), byteLength: Buffer.byteLength(terminalText) },
		"terminal-ansi.txt": { sha256: hash(terminalAnsiText), byteLength: Buffer.byteLength(terminalAnsiText) },
		"terminal.html": { sha256: hash(terminalHtml), byteLength: Buffer.byteLength(terminalHtml) },
		"metadata.json": { sha256: hash(metadataText), byteLength: Buffer.byteLength(metadataText) },
	};
	const manifest: ExecutionPresetVisualCaptureManifest = Object.freeze({
		schema: EXECUTION_PRESET_VISUAL_CAPTURE_SCHEMA,
		version: EXECUTION_PRESET_VISUAL_CAPTURE_VERSION,
		sourceHash,
		sourceClosure,
		expectedKeyCount: EXECUTION_PRESET_VISUAL_CAPTURE_COUNT,
		keys: EXECUTION_PRESET_VISUAL_KEYS,
		files,
		entries,
	});
	await fs.mkdir(outputRoot, { recursive: true });
	await Promise.all([
		Bun.write(path.join(outputRoot, "terminal.txt"), terminalText),
		Bun.write(path.join(outputRoot, "terminal-ansi.txt"), terminalAnsiText),
		Bun.write(path.join(outputRoot, "terminal.html"), terminalHtml),
		Bun.write(path.join(outputRoot, "metadata.json"), metadataText),
		Bun.write(path.join(outputRoot, "manifest.json"), json(manifest)),
	]);
	return manifest;
}

export const captureExecutionPresetVisualShowcase = captureExecutionPresetShowcase;

function captureArgumentValue(value: string | undefined): string {
	if (value === undefined || value.startsWith("--") || value.trim() === "") {
		throw new Error("Invalid execution preset showcase arguments.");
	}
	return value;
}

function parseCaptureArgs(args: readonly string[]): {
	root: string;
	repoRoot: string;
	sourceHash?: string;
} {
	let root: string = EXECUTION_PRESET_CAPTURE_DEFAULT_OUTPUT;
	let repoRoot: string = EXECUTION_PRESET_CAPTURE_DEFAULT_REPO_ROOT;
	let sourceHash: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--root" || arg === "--output" || arg === "--out") {
			root = captureArgumentValue(value);
			index += 1;
		} else if (arg === "--repo-root") {
			repoRoot = captureArgumentValue(value);
			index += 1;
		} else if (arg === "--source-hash") {
			sourceHash = captureArgumentValue(value);
			index += 1;
		} else {
			throw new Error("Invalid execution preset showcase arguments.");
		}
	}
	return { root, repoRoot, sourceHash };
}

if (import.meta.main) {
	const parsed = parseCaptureArgs(process.argv.slice(2));
	await captureExecutionPresetShowcase(parsed.root, {
		repoRoot: parsed.repoRoot,
		...(parsed.sourceHash === undefined ? {} : { sourceHash: parsed.sourceHash }),
	});
}
