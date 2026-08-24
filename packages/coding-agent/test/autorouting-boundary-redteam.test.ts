import { afterAll, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@gajae-code/ai";
import * as native from "@gajae-code/natives";
import { getTerminalId } from "@gajae-code/tui";
import { getTerminalSessionsDir } from "@gajae-code/utils";
import { checkAutoroutingTierMap } from "../scripts/check-autorouting-tier-map";
import { AsyncJobManager } from "../src/async";
import { resolveTaskRouting } from "../src/config/autorouting";
import {
	AUTOROUTING_SELECTOR_PATTERN,
	validateAutoroutingEffective,
	validateAutoroutingLocal,
	validateAutoroutingSetup,
} from "../src/config/autorouting-contract";
import { canonicalJsonBytes, generateTierChains } from "../src/config/autorouting-generator";
import { type CuratedTierLabels, validateTierMap } from "../src/config/autorouting-tier-map";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { SmartRoutingPanelComponent } from "../src/modes/components/smart-routing-panel";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import * as sdkModule from "../src/sdk";
import { ArtifactManager } from "../src/session/artifacts";
import { AuthStorage } from "../src/session/auth-storage";
import { ManagedSessionDescendantStore, managedDirectoryRoot } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "../src/session/session-storage";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import {
	buildBoundedRoutingSkips,
	classifyAutoroutingPreflightFailure,
	runSubprocess,
	runSubprocessOnce,
} from "../src/task/executor";
import type { AutoroutingPreflightFailure, SingleResult, TaskRoutingEvidence } from "../src/task/types";
import { assertRoutingEvidenceInvariant } from "../src/task/types";
import { splitInternalUrlSel } from "../src/tools/path-utils";

const rootCommand = "bun test packages/coding-agent/test/autorouting-boundary-redteam.test.ts";

type Verdict = "passed" | "failed";
type CaseRecord = {
	id: string;
	obligation: string;
	invocation: string;
	observed: unknown;
	verdict: Verdict;
	blocker?: string;
};

const cases: CaseRecord[] = [];

function record(
	id: string,
	obligation: string,
	invocation: string,
	observed: unknown,
	pass: boolean,
	blocker?: string,
): void {
	const executedInvocation = invocation.includes(" -t ") ? rootCommand : invocation;
	cases.push({
		id,
		obligation,
		invocation: executedInvocation,
		observed,
		verdict: pass ? "passed" : "failed",
		...(blocker ? { blocker } : {}),
	});
}

function model(provider: string, id: string, reasoning = true, extra: Record<string, unknown> = {}): Model {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		...extra,
	} as Model;
}

function bytes(value: unknown): string {
	return new TextDecoder().decode(canonicalJsonBytes(value));
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

const syntheticLabels = {
	"alpha/fast": [{ tier: "fast", rank: 1 }],
	"alpha/slow": [{ tier: "fast", rank: 2 }],
	"alpha/strong": [{ tier: "strong", effort: "high", rank: 1 }],
	"beta/fast": [{ tier: "fast", rank: 1 }],
	"gamma/fast": [{ tier: "fast", rank: 1 }],
} satisfies CuratedTierLabels;
const syntheticMap = { labels: syntheticLabels, skips: {}, version: 1 };
const syntheticCatalog = [
	model("alpha", "fast"),
	model("alpha", "slow"),
	model("alpha", "strong"),
	model("beta", "fast"),
	model("gamma", "fast"),
];

function testContext(catalog: readonly Model[], settings = Settings.isolated()) {
	const ui = { requestRender: vi.fn(), setFocus: vi.fn() };
	const ctx = {
		settings,
		session: {
			scopedModels: [],
			modelRegistry: {
				getAll: () => catalog,
				getAvailable: () => catalog,
			},
		},
		ui,
		showStatus: vi.fn(),
		showError: vi.fn(),
		notifyConfigChanged: vi.fn(async () => {}),
	};
	return { ctx, settings, ui };
}

const taskAgent = {
	name: "task",
	description: "General task agent",
	systemPrompt: "task",
	source: "bundled" as const,
	model: ["manual/frontmatter"],
	blocking: true,
};

function taskSession(
	settingsOverrides: Record<string, unknown>,
	catalog: readonly Model[],
	getApiKey: (entry: Model) => Promise<string | undefined>,
): any {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(settingsOverrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: {
			getAll: () => catalog,
			getAvailable: () => catalog,
			getApiKey,
		},
	};
}

function successResult(options: Parameters<typeof runSubprocess>[0]): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		modelOverride: options.modelOverride,
	};
}

async function terminalBreadcrumbBytes(): Promise<string | null> {
	const id = getTerminalId();
	if (!id) return null;
	try {
		return (await readFile(path.join(getTerminalSessionsDir(), id))).toString("base64");
	} catch {
		return null;
	}
}

async function tree(root: string): Promise<string[]> {
	const output: string[] = [];
	const walk = async (directory: string, prefix: string): Promise<void> => {
		let entries: Array<import("node:fs").Dirent>;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const relative = path.join(prefix, entry.name);
			if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
			else output.push(relative);
		}
	};
	await walk(root, "");
	return output;
}

async function fileBytes(filePath: string): Promise<string | null> {
	try {
		return (await readFile(filePath)).toString("base64");
	} catch {
		return null;
	}
}

afterAll(async () => {
	await mkdir("artifacts", { recursive: true });
	const grouped = {
		algorithm: cases.filter(item =>
			[
				"generator-perturbations",
				"eligibility-ordering",
				"curation-gate",
				"disabled-path-parity",
				"gen2-b1-forged-provenance-race",
			].includes(item.id),
		),
		api: cases.filter(item =>
			[
				"raw-config-byte-parity",
				"panel-preview-integrity",
				"atomic-batch-integrity",
				"skip-truthfulness",
				"hostile-selector-sanitization",
				"evidence-model-bound",
				"gen2-b2-skip-ordering",
				"gen2-b4-whitespace-placeholder",
				"gen2-b5-bounds-phase-pairs",
				"gen3-direct-skip-projection",
				"gen2-b1-panel-substitution",
				"gen3-b6-callback-and-rapid",
				"gen3-shared-skip-projection",
			].includes(item.id),
		),
		staging: cases.filter(item =>
			[
				"retry-bounds-deny-table",
				"staging-residue-and-rekey",
				"attempt-id-traversal",
				"gen2-b3-attempt-id-variants",
				"gen2-post-fence-remap-rollback",
				"gen3-b7-remap-cycle",
				"gen3-breadcrumb-aggregate-interleaving",
				"gen4-b8-selector-tail-parser",
				"gen4-b9-remap-cycle-nested",
				"gen4-c1-cleanup-fail-closed",
				"gen4-c2-successful-discard-advances",
				"gen4-c3-post-fence-terminal-ledger",
				"gen5-disposition-and-budget",
				"gen5-terminal-diagnostic-bounds",
				"gen5-uri-rekey-grammar",
				"gen5-fence-disposition",
				"gen6-diagnostic-redaction-unicode",
				"gen6-uri-whole-token-shapes",
			].includes(item.id),
		),
	};
	const runnerObserved = {
		casePassCount: cases.filter(item => item.verdict === "passed").length,
		caseFailCount: cases.filter(item => item.verdict === "failed").length,
		expectCount: cases.length,
		exitCode: cases.some(item => item.verdict === "failed") ? 1 : 0,
	};
	await Bun.write(
		"artifacts/autorouting-boundary-algorithm-report.json",
		JSON.stringify(
			{
				kind: "algorithm-boundary-report",
				invocation: rootCommand,
				surface: "generator, curation gate, ordering, selector validation",
				runnerObserved,
				cases: grouped.algorithm,
				verdict: grouped.algorithm.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-api-package-test-report.json",
		JSON.stringify(
			{
				kind: "api-package-test-report",
				invocation: rootCommand,
				surface: "settings, controller, TaskTool routing evidence",
				runnerObserved,
				cases: grouped.api,
				verdict: grouped.api.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-staging-report.json",
		JSON.stringify(
			{
				kind: "property-test-report",
				invocation: rootCommand,
				surface: "preflight evidence, staged sessions, artifact re-keying",
				runnerObserved,
				cases: grouped.staging,
				verdict: grouped.staging.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-generation4-report.json",
		JSON.stringify(
			{
				kind: "property-test-report",
				generation: 4,
				invocation: rootCommand,
				surface: "generation-4 selector-tail remap and preflight cleanup red-team",
				runnerObserved,
				cases,
				verdict: cases.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-generation5-report.json",
		JSON.stringify(
			{
				kind: "property-test-report",
				generation: 5,
				invocation: rootCommand,
				surface:
					"generation-5 terminal disposition, bounded diagnostics, fence semantics, and URI grammar red-team",
				runnerObserved,
				cases,
				verdict: cases.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-generation6-report.json",
		JSON.stringify(
			{
				kind: "property-test-report",
				generation: 6,
				invocation: rootCommand,
				surface: "generation-6 varied diagnostic egress and whole-token URI re-keying red-team",
				runnerObserved,
				cases,
				verdict: cases.some(item => item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
	await Bun.write(
		"artifacts/autorouting-boundary-generation8-report.json",
		JSON.stringify(
			{
				kind: "property-test-report",
				generation: 8,
				invocation: rootCommand,
				surface: "generation-8 artifact ownership and leaked-ID rollback fault injection",
				runnerObserved,
				cases: cases.filter(item => item.id.startsWith("gen8-")),
				verdict: cases.some(item => item.id.startsWith("gen8-") && item.verdict === "failed") ? "failed" : "passed",
			},
			null,
			2,
		),
	);
});

describe("autorouting boundary red-team: deterministic generator and curation", () => {
	it("AC1/AC11: survives key, catalog, credential, disabled-provider, and runtime-overlay perturbations", () => {
		const setup = {
			schema: 1 as const,
			providers: ["alpha", "beta", "gamma"],
			models: ["beta/fast", "alpha/slow", "alpha/fast"],
		};
		const reorderedSetup = { models: [...setup.models], providers: [...setup.providers], schema: 1 as const };
		const first = generateTierChains(setup, syntheticMap, syntheticCatalog);
		const second = generateTierChains(reorderedSetup, syntheticMap, [...syntheticCatalog].reverse());
		const credentialChanged = generateTierChains(
			setup,
			syntheticMap,
			syntheticCatalog.map(entry =>
				model(entry.provider, entry.id, entry.reasoning, {
					baseUrl: "https://credential-state.invalid",
					headers: { Authorization: "Bearer secret" },
					authenticated: false,
				}),
			),
		);
		const disabledFlagChanged = generateTierChains(
			setup,
			syntheticMap,
			syntheticCatalog.map(entry => model(entry.provider, entry.id, entry.reasoning, { disabled: true })),
		);
		const runtimeOverlay = generateTierChains(setup, syntheticMap, [
			...syntheticCatalog,
			model("custom", "runtime-only"),
		]);
		const observed = {
			first,
			second,
			credentialChanged,
			disabledFlagChanged,
			runtimeOverlay,
		};
		const pass =
			bytes(first) === bytes(second) &&
			bytes(first) === bytes(credentialChanged) &&
			bytes(first) === bytes(disabledFlagChanged) &&
			bytes(first.tiers) === bytes(runtimeOverlay.tiers);
		record(
			"generator-perturbations",
			"AC1",
			`${rootCommand} -t generator-perturbations`,
			observed,
			pass,
			"Generator output or fingerprints changed when only credential/disabled runtime state changed.",
		);
		expect(pass).toBe(true);
	});

	it("AC2/AC3/AC4: filters without reordering, never duplicates unlabeled tiers, and ignores non-catalog keys", () => {
		const allowlistA = generateTierChains(
			{ schema: 1, providers: ["alpha", "beta"], models: ["beta/fast", "alpha/slow", "alpha/fast"] },
			syntheticMap,
			syntheticCatalog,
		);
		const allowlistB = generateTierChains(
			{ schema: 1, providers: ["alpha", "beta"], models: ["alpha/fast", "beta/fast", "alpha/slow"] },
			syntheticMap,
			syntheticCatalog,
		);
		const thin = generateTierChains(
			{ schema: 1, providers: ["qianfan"] },
			{ labels: { "qianfan/only": [{ tier: "fast", rank: 1 }] }, skips: {}, version: 1 },
			[model("qianfan", "only", false)],
		);
		const nonCatalog = generateTierChains(
			{ schema: 1, providers: ["alpha"] },
			{ labels: { "alpha/ghost": [{ tier: "strong", rank: 1 }] }, skips: {}, version: 1 },
			[model("alpha", "fast")],
		);
		const thinRouting = resolveTaskRouting({
			effectiveAutorouting: validateAutoroutingEffective({ enabled: true, tiers: thin.tiers }),
			requestedTier: "balanced",
			availableModels: [model("qianfan", "only", false)],
		});
		const observed = {
			allowlistA: allowlistA.tiers,
			allowlistB: allowlistB.tiers,
			thin: thin.tiers,
			thinRouting,
			nonCatalog: nonCatalog.tiers,
		};
		const pass =
			bytes(allowlistA.tiers) === bytes(allowlistB.tiers) &&
			JSON.stringify(allowlistA.tiers.fast) === JSON.stringify(["alpha/fast", "alpha/slow", "beta/fast"]) &&
			JSON.stringify(thin.tiers) === JSON.stringify({ fast: ["qianfan/only"] }) &&
			thinRouting.kind === "manual-fallback" &&
			thinRouting.reason === "tier_missing_in_map" &&
			Object.keys(nonCatalog.tiers).length === 0;
		record(
			"eligibility-ordering",
			"AC2",
			`${rootCommand} -t eligibility-ordering`,
			observed,
			pass,
			"Allowlist reordered candidates, duplicated an unlabeled tier, or admitted a non-catalog key.",
		);
		expect(pass).toBe(true);
	});

	it("AC9/AC10: rejects invalid labels, effort suffixes, rank collisions, and unlabeled current models", () => {
		const catalog = [model("alpha", "one"), model("alpha", "two")];
		const collision = {
			labels: {
				"alpha/one": [{ tier: "fast", rank: 1 }],
				"alpha/two": [{ tier: "fast", rank: 1 }],
			},
			skips: {},
			version: 1,
		};
		const invalidLabel = { labels: { "alpha/missing": [{ tier: "fast", rank: 1 }] }, skips: {}, version: 1 };
		const invalidEffort = {
			labels: { "alpha/one": [{ tier: "fast", effort: "max", rank: 1 }] },
			skips: {},
			version: 1,
		};
		const collisionError = (() => {
			try {
				validateTierMap(collision, catalog);
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		})();
		const invalidLabelError = (() => {
			try {
				validateTierMap(invalidLabel, catalog);
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		})();
		const invalidEffortError = (() => {
			try {
				validateTierMap(invalidEffort, catalog);
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		})();
		const gate = checkAutoroutingTierMap(
			{
				alpha: {
					one: { provider: "alpha", id: "one", reasoning: true },
					three: { provider: "alpha", id: "three", reasoning: false },
				},
			},
			{ "alpha/one": [{ tier: "fast", rank: 1 }] },
			{},
		);
		const selectorIssues = validateAutoroutingSetup({ schema: 1, providers: ["../escape"], models: ["bare-model"] });
		const hostileProviders = ["../escape", "\u0000", "π", "p".repeat(10_000)];
		const hostileProviderIssues = validateAutoroutingSetup({ schema: 1, providers: hostileProviders });
		const hostileProviderOutput = generateTierChains(
			{ schema: 1, providers: hostileProviders },
			syntheticMap,
			syntheticCatalog,
		);
		const observed = {
			collisionError,
			invalidLabelError,
			invalidEffortError,
			gate,
			selectorPattern: AUTOROUTING_SELECTOR_PATTERN,
			selectorIssues,
			hostileProviderIssues,
			hostileProviderOutput,
		};
		const pass =
			collisionError?.includes("collides") === true &&
			invalidLabelError?.includes("absent from") === true &&
			invalidEffortError?.includes("Unknown tier effort") === true &&
			gate.ok === false &&
			gate.report.unlabeledKeys.includes("alpha/three") &&
			selectorIssues.length > 0 &&
			Object.keys(hostileProviderOutput.tiers).length === 0;
		record(
			"curation-gate",
			"AC9",
			`${rootCommand} -t curation-gate`,
			observed,
			pass,
			"Curation accepted a label/effort/rank violation or failed to gate an unlabeled current model.",
		);
		expect(pass).toBe(true);
	});

	it("AC1: disabled mode remains byte-equivalent to the no-routing path", () => {
		const snapshot = [model("alpha", "fast")];
		const disabled = validateAutoroutingEffective({ enabled: false, tiers: { fast: ["alpha/fast"] } });
		const absent = validateAutoroutingEffective(undefined);
		const disabledOutcome = resolveTaskRouting({
			effectiveAutorouting: disabled,
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const absentOutcome = resolveTaskRouting({
			effectiveAutorouting: absent,
			requestedTier: "fast",
			availableModels: snapshot,
		});
		const observed = {
			disabled,
			absent,
			disabledOutcome,
			absentOutcome,
			setupDefault: undefined,
			provenanceDefault: undefined,
		};
		const pass = bytes(disabledOutcome) === bytes(absentOutcome) && disabledOutcome.kind === "disabled";
		record(
			"disabled-path-parity",
			"AC1",
			`${rootCommand} -t disabled-path-parity`,
			observed,
			pass,
			"Disabled autorouting produced a routing outcome different from the no-routing path.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team: config and panel atomicity", () => {
	it("AC1: load/flush preserves hostile-but-valid untouched bytes and omits absent setup/provenance", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-byte-parity-"));
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const config =
			"# preserve\r\nconfigSchemaVersion: 2\r\ntask:\r\n  autorouting:\r\n    enabled: false\r\n    preset: anthropic\r\n\r\n";
		const configPath = path.join(agentDir, "config.yml");
		await writeFile(configPath, config);
		const settings = await Settings.loadForScope({ cwd, agentDir });
		await settings.flush();
		const after = await Bun.file(configPath).text();
		const observed = {
			beforeBytes: Buffer.byteLength(config),
			afterBytes: Buffer.byteLength(after),
			byteEqual: after === config,
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
		};
		const pass = after === config && observed.setup === undefined && observed.provenance === undefined;
		record(
			"raw-config-byte-parity",
			"AC1",
			`${rootCommand} -t raw-config-byte-parity`,
			observed,
			pass,
			"Untouched config bytes changed or absent optional setup/provenance serialized.",
		);
		expect(pass).toBe(true);
	});

	it("AC5/AC6/AC7/AC8: detects a forged preview and verifies atomic/toggle contracts", async () => {
		const catalog = [
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-sonnet-4-6"),
			model("anthropic", "claude-opus-5"),
		];
		const { ctx, settings } = testContext(catalog);
		const controller = new SelectorController(ctx as never);
		const setup = { schema: 1 as const, providers: ["anthropic"] };
		const preview = controller.previewSmartRouting(setup);
		const forgedPreview = { ...preview, tiers: { fast: ["anthropic/claude-opus-5"] } };
		await controller.applySmartRouting(setup, { preview: forgedPreview });
		const applied = settings.get("task.autorouting.tiers");
		const forgedAccepted = bytes(applied) === bytes(forgedPreview.tiers);
		const previewEqualsApply = bytes(applied) === bytes(preview.tiers);
		const beforeToggle = {
			tiers: settings.get("task.autorouting.tiers"),
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
		};
		await controller.setAutoroutingEnabled(true);
		const afterToggle = {
			tiers: settings.get("task.autorouting.tiers"),
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
			enabled: settings.get("task.autorouting.enabled"),
		};
		const observed = {
			expectedPreview: preview,
			forgedPreview,
			applied,
			forgedAccepted,
			previewEqualsApply,
			beforeToggle,
			afterToggle,
		};
		const pass = !forgedAccepted && previewEqualsApply && bytes(beforeToggle.tiers) === bytes(afterToggle.tiers);
		record(
			"panel-preview-integrity",
			"AC6",
			`${rootCommand} -t panel-preview-integrity`,
			observed,
			pass,
			"Controller accepted a forged preview with the same setup, so applied payload differed from the generated preview.",
		);
		expect(pass).toBe(true);
	});

	it("AC5/AC7: rejects partial batches and preserves hand-edit guard inputs", async () => {
		const setup = { schema: 1 as const, providers: ["alpha"] };
		const provenance = {
			schema: 1 as const,
			source: { catalogFingerprint: "a".repeat(64), mapFingerprint: "b".repeat(64), generatorVersion: 1 },
			declarationFingerprint: "c".repeat(64),
			tiersFingerprint: fingerprint({ fast: ["alpha/fast"] }),
		};
		const settings = Settings.isolated({
			"task.autorouting.tiers": { fast: ["before/model"] },
			"task.autorouting.setup": setup,
			"task.autorouting.provenance": provenance,
		});
		const before = {
			tiers: settings.get("task.autorouting.tiers"),
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
		};
		let error = "";
		try {
			await settings.commitAtomicBatch([
				{ path: "task.autorouting.tiers", op: "set", value: { fast: ["after/model"] } },
				{ path: "task.autorouting.setup", op: "set", value: undefined } as never,
			]);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const after = {
			tiers: settings.get("task.autorouting.tiers"),
			setup: settings.get("task.autorouting.setup"),
			provenance: settings.get("task.autorouting.provenance"),
		};
		const observed = { before, after, error };
		const pass =
			Boolean(error) && bytes(before.tiers) === bytes(after.tiers) && bytes(before.setup) === bytes(after.setup);
		record(
			"atomic-batch-integrity",
			"AC5",
			`${rootCommand} -t atomic-batch-integrity`,
			observed,
			pass,
			"Atomic settings batch partially applied after a later invalid patch.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team: routing evidence, retries, and residue", () => {
	it("AC12: distinguishes disabled, missing snapshot, and unavailable credentials and retains overflow accounting", async () => {
		const present = model("enabled", "present");
		const snapshot = [present];
		const settings = {
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": {
				fast: ["disabled/missing", "missing/absent", "enabled/present"],
			},
			disabledProviders: ["disabled"],
		};
		const observedSkips: Array<unknown> = [];
		const stub = async (options: Parameters<typeof runSubprocess>[0]) => {
			observedSkips.push({ skips: options.autoroutingSkips, candidates: options.autoroutingCandidates });
			return successResult(options);
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		const registryApiKey = async (entry: Model): Promise<string | undefined> =>
			entry.provider === "enabled" ? undefined : "key";
		const tool = await TaskTool.create(taskSession(settings, snapshot, registryApiKey), { runSubprocess: stub });
		await tool.execute("skip-case", {
			agent: "task",
			tasks: [{ id: "one", description: "one", assignment: "run", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		const first = observedSkips[0] as
			| { skips?: Array<{ selector: string; code: string }>; candidates?: string[] }
			| undefined;
		const bySelector = Object.fromEntries((first?.skips ?? []).map(entry => [entry.selector, entry.code]));
		const overflowRouting = await runSubprocess({
			cwd: process.cwd(),
			agent: taskAgent,
			task: "overflow",
			assignment: "overflow",
			index: 0,
			id: "overflow",
			runMode: "initial",
			autoroutingPreflight: true,
			autoroutingCandidates: [],
			autoroutingSkips: Array.from({ length: 20 }, (_, index) => ({
				selector: `provider/model-${index}`,
				code: index % 2 === 0 ? "snapshot_missing" : "credential_unavailable",
			})),
			routing: {
				tier: "fast",
				requestedSelector: "enabled/present",
				substitutions: [],
			},
		});
		const observed = { first, bySelector, candidates: first?.candidates, overflowRouting: overflowRouting.routing };
		const pass =
			bySelector["disabled/missing"] === "provider_disabled" &&
			bySelector["missing/absent"] === "snapshot_missing" &&
			bySelector["enabled/present"] === "credential_unavailable" &&
			overflowRouting.routing?.skips?.length === 16 &&
			overflowRouting.routing?.omittedSkipCount === 4 &&
			overflowRouting.routing?.omittedByCode?.snapshot_missing === 2 &&
			overflowRouting.routing?.omittedByCode?.credential_unavailable === 2;
		record(
			"skip-truthfulness",
			"AC12",
			`${rootCommand} -t skip-truthfulness`,
			observed,
			pass,
			"Disabled provider, missing snapshot, and unavailable credentials were conflated or skip overflow was lost.",
		);
		expect(pass).toBe(true);
	});

	it("AC13: bounds attempts, rejects deny-table retries, and preserves phase/code invariants", async () => {
		const failures: Array<{ name: string; failure: AutoroutingPreflightFailure; code: string }> = [
			{
				name: "auth",
				failure: { kind: "transport", class: "auth" },
				code: "terminal",
			},
			{
				name: "quota",
				failure: { kind: "transport", class: "quota" },
				code: "terminal",
			},
			{
				name: "rate_limit",
				failure: { kind: "transport", class: "rate_limit" },
				code: "terminal",
			},
			{
				name: "config",
				failure: { kind: "local", op: "preflight_validation", transient: false },
				code: "terminal",
			},
			{
				name: "credential",
				failure: { kind: "local", op: "auth_resolve", transient: false },
				code: "advance",
			},
			{
				name: "spawn",
				failure: { kind: "local", op: "session_open", transient: true },
				code: "advance",
			},
		];
		const classified = failures.map(item => {
			const error =
				item.failure.kind === "transport"
					? {
							transportFailure: {
								kind: "transport" as const,
								status: item.name === "auth" ? 401 : item.name === "quota" ? 402 : 429,
								...(item.name === "quota" ? { providerCode: "insufficient_quota" } : {}),
							},
						}
					: item.failure;
			return {
				name: item.name,
				failure: classifyAutoroutingPreflightFailure(
					error,
					item.failure.kind === "local" ? item.failure.op : "session_open",
				),
				code: item.code,
			};
		});
		const valid: TaskRoutingEvidence = {
			tier: "fast",
			requestedSelector: "provider/model",
			notExecuted: true,
			substitutions: [],
			attempts: [
				{ selector: "provider/one", phase: "probe", code: "probe_passed" },
				{ selector: "provider/one", phase: "durable", code: "spawn_transient_retry" },
				{ selector: "provider/two", phase: "probe", code: "probe_passed" },
				{ selector: "provider/two", phase: "durable", code: "accepted" },
			],
		};
		assertRoutingEvidenceInvariant(valid);
		let invalidPairing = "";
		try {
			assertRoutingEvidenceInvariant({
				...valid,
				attempts: [{ selector: "provider/model", phase: "probe", code: "accepted" }],
			});
		} catch (error) {
			invalidPairing = error instanceof Error ? error.message : String(error);
		}
		const duplicateAttemptLedger = [
			"provider/one",
			"provider/one",
			"provider/two",
			"provider/three",
			"provider/four",
		].filter((selector, index, all) => all.indexOf(selector) === index);
		const observed = {
			classified,
			valid,
			invalidPairing,
			uniqueCandidateCount: duplicateAttemptLedger.length,
			budgetedCandidates: duplicateAttemptLedger.slice(0, 3),
		};
		const pass =
			classified.filter(item => item.code === "terminal").every(item => item.name !== "credential") &&
			classified.find(item => item.name === "auth")?.failure.kind === "transport" &&
			Boolean(invalidPairing) &&
			duplicateAttemptLedger.length === 4 &&
			observed.budgetedCandidates.length === 3;
		record(
			"retry-bounds-deny-table",
			"AC13",
			`${rootCommand} -t retry-bounds-deny-table`,
			observed,
			pass,
			"A deny-table transport failure advanced, an attempt pairing escaped validation, or duplicate candidates were retried.",
		);
		expect(pass).toBe(true);
	});

	it("AC13: failed staged attempts leave no discovery residue and accepted artifacts are re-keyed", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-staged-boundary-"));
		const cwd = path.join(root, "cwd");
		await mkdir(cwd, { recursive: true });
		const finalPath = path.join(root, "candidate.jsonl");
		const parentArtifacts = new ArtifactManager(finalPath.slice(0, -6));
		const sibling = await parentArtifacts.save("sibling", "tool");
		const beforeBreadcrumb = await terminalBreadcrumbBytes();
		const failed = await SessionManager.openStaged(finalPath, undefined, "attempt-safe");
		const stagedArtifacts = failed.getArtifactManager();
		if (!stagedArtifacts) throw new Error("staged artifact manager unavailable");
		await stagedArtifacts.save("candidate", "tool");
		failed.appendCustomEntry("hostile", {
			artifactRef: "artifact://0",
			agentRef: "agent://0",
			adjacentNumber: "10",
			decimal: "0.5",
		});
		const failedBeforeDiscard = {
			final: await fileBytes(finalPath),
			staging: await tree(path.join(root, ".staging")),
			breadcrumb: await terminalBreadcrumbBytes(),
		};
		await failed.discardStaged();
		await failed.discardStaged();
		const failedAfterDiscard = {
			final: await fileBytes(finalPath),
			staging: await tree(path.join(root, ".staging")),
			breadcrumb: await terminalBreadcrumbBytes(),
		};
		const accepted = await SessionManager.openStaged(finalPath, undefined, "attempt-accepted");
		const acceptedArtifacts = accepted.getArtifactManager();
		if (!acceptedArtifacts) throw new Error("accepted artifact manager unavailable");
		const acceptedOldId = await acceptedArtifacts.save("accepted", "tool");
		accepted.appendCustomEntry("refs", {
			artifactRef: `artifact://${acceptedOldId}`,
			agentRef: `agent://${acceptedOldId}`,
			adjacentNumber: `10${acceptedOldId}`,
			decimal: `${acceptedOldId}.5`,
		});
		await accepted.commitStaged();
		const finalText = await Bun.file(finalPath).text();
		const afterBreadcrumb = await terminalBreadcrumbBytes();
		const observed = {
			sibling,
			failedBeforeDiscard,
			failedAfterDiscard,
			finalText,
			stagingTreeAfterAccept: await tree(path.join(root, ".staging")),
			parentArtifacts: await tree(parentArtifacts.dir),
			beforeBreadcrumb,
			afterBreadcrumb,
			acceptedOldId,
		};
		const pass =
			failedBeforeDiscard.final === null &&
			failedAfterDiscard.final === null &&
			failedAfterDiscard.staging.length === 0 &&
			failedAfterDiscard.breadcrumb === beforeBreadcrumb &&
			finalText.includes("artifact://1") &&
			finalText.includes("agent://1") &&
			!finalText.includes("artifact://0") &&
			!finalText.includes("agent://0") &&
			finalText.includes('"adjacentNumber":"100"') &&
			finalText.includes('"decimal":"0.5"');
		record(
			"staging-residue-and-rekey",
			"AC13",
			`${rootCommand} -t staging-residue-and-rekey`,
			observed,
			pass,
			"Failed staged attempt left durable residue, or accepted artifact references retained stale staged IDs.",
		);
		expect(pass).toBe(true);
	});

	it("injection: rejects traversal attempt IDs before any outside-staging write", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-attempt-id-"));
		const finalPath = path.join(root, "final.jsonl");
		const openedPaths: string[] = [];
		const baseStorage = new FileSessionStorage();
		const storage = new Proxy(baseStorage, {
			get(target, property, receiver) {
				if (property === "openWriter") {
					return (filePath: string, options?: Parameters<SessionStorage["openWriter"]>[1]) => {
						openedPaths.push(filePath);
						return target.openWriter(filePath, options);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as SessionStorage;
		let error = "";
		try {
			await SessionManager.openStaged(finalPath, storage, "../escaped");
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const escapedPath = path.join(root, "escaped.jsonl");
		const escapedExists = await stat(escapedPath)
			.then(() => true)
			.catch(() => false);
		const stagingFiles = await tree(path.join(root, ".staging"));
		const outsideWrites = openedPaths.filter(filePath => filePath.includes("escaped.jsonl"));
		const observed = { error, escapedPath, escapedExists, stagingFiles, openedPaths, outsideWrites };
		const pass =
			error.includes("Unsafe artifact attempt id") &&
			outsideWrites.length === 0 &&
			!escapedExists &&
			stagingFiles.length === 0;
		record(
			"attempt-id-traversal",
			"AC13",
			`${rootCommand} -t attempt-id-traversal`,
			observed,
			pass,
			"Unvalidated attemptId escaped the staging directory before ArtifactManager rejected it.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team: malformed evidence and hostile selectors", () => {
	it("fails closed on control-only selectors and hostile local config values", async () => {
		const hostile = ["../escape/model", "provider/\u0000\u0001", `provider/${"x".repeat(10_000)}`, "аlpha/model"];
		const perSelectorIssues = hostile.map(selector => validateAutoroutingLocal({ tiers: { fast: [selector] } }));
		const localIssues = perSelectorIssues.flat();
		// The selector grammar caps length at the routing-evidence bound and rejects
		// control bytes before they can reach routing; the other hostile shapes remain
		// grammar-valid and flow to the executor's sanitization paths.
		const overLongIssues = perSelectorIssues[2];
		const controlIssues = perSelectorIssues[1];
		const toleratedIssues = [0, 3].flatMap(index => perSelectorIssues[index]);
		let controlOnlyError = "";
		try {
			await runSubprocess({
				cwd: process.cwd(),
				agent: taskAgent,
				task: "hostile",
				assignment: "hostile",
				index: 0,
				id: "hostile",
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: [],
				autoroutingSkips: [{ selector: "\u0000\u0001", code: "snapshot_missing" }],
				routing: {
					tier: "fast",
					requestedSelector: "provider/model",
					substitutions: [],
				},
			});
		} catch (error) {
			controlOnlyError = error instanceof Error ? error.message : String(error);
		}
		const observed = {
			hostile,
			localIssueCount: localIssues.length,
			localIssueDetails: localIssues.map(issue => issue.detail),
			controlOnlyError,
		};
		const pass =
			overLongIssues.length > 0 &&
			controlIssues.length > 0 &&
			toleratedIssues.length === 0 &&
			controlOnlyError.length === 0;
		record(
			"hostile-selector-sanitization",
			"AC12",
			`${rootCommand} -t hostile-selector-sanitization`,
			observed,
			pass,
			"A selector sanitized to an empty string caused executor evidence construction to throw.",
		);
		expect(pass).toBe(true);
	});

	it("does not accept unbounded auth-resolved model evidence", () => {
		const evidence: TaskRoutingEvidence = {
			tier: "fast",
			requestedSelector: "provider/model",
			effectiveModel: "provider/model",
			authResolvedModel: `provider/${"x".repeat(10_000)}`,
			substitutions: [],
		};
		let error = "";
		try {
			assertRoutingEvidenceInvariant(evidence);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const observed = { authResolvedLength: evidence.authResolvedModel?.length, error };
		const pass = error.length > 0;
		record(
			"evidence-model-bound",
			"AC12",
			`${rootCommand} -t evidence-model-bound`,
			observed,
			pass,
			"assertRoutingEvidenceInvariant accepted an unbounded authResolvedModel selector.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team generation 2 delta re-attacks", () => {
	it("B1 varied: forged provenance is discarded and a catalog race cannot persist stale preview bytes", async () => {
		const catalogA = [
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-sonnet-4-6"),
			model("anthropic", "claude-opus-5"),
		];
		const setup = { schema: 1 as const, providers: ["anthropic"] };
		const stableContext = testContext(catalogA);
		const stableController = new SelectorController(stableContext.ctx as never);
		const generated = stableController.previewSmartRouting(setup);
		const forged = {
			...generated,
			provenance: {
				...generated.provenance,
				declarationFingerprint: "e".repeat(64),
				tiersFingerprint: "f".repeat(64),
				source: { ...generated.provenance.source, mapFingerprint: "d".repeat(64) },
			},
		};
		const appliedForged = await stableController.applySmartRouting(setup, { preview: forged });
		const persistedForged = {
			tiers: stableContext.settings.get("task.autorouting.tiers"),
			provenance: stableContext.settings.get("task.autorouting.provenance"),
		};
		const raceContext = testContext(catalogA);
		const catalogB = [model("anthropic", "claude-haiku-4-5")];
		let catalogCalls = 0;
		raceContext.ctx.session.modelRegistry = {
			getAll: () => {
				catalogCalls += 1;
				return catalogCalls === 1 ? catalogA : catalogB;
			},
			getAvailable: () => (catalogCalls === 1 ? catalogA : catalogB),
		};
		const raceController = new SelectorController(raceContext.ctx as never);
		const stalePreview = raceController.previewSmartRouting(setup);
		const racedApplied = await raceController.applySmartRouting(setup, { preview: stalePreview });
		const racedPersisted = raceContext.settings.get("task.autorouting.tiers");
		const changedDeclaration = { schema: 1 as const, providers: ["anthropic", "xai"] };
		let declarationRaceError = "";
		try {
			await stableController.applySmartRouting(changedDeclaration, { preview: generated });
		} catch (error) {
			declarationRaceError = error instanceof Error ? error.message : String(error);
		}
		const observed = {
			forgedProvenance: forged.provenance,
			appliedForged,
			persistedForged,
			stalePreview,
			racedCatalogCalls: catalogCalls,
			racedApplied: racedApplied,
			racedPersisted: racedPersisted,
			declarationRaceError,
		};
		const pass =
			bytes(persistedForged.provenance) === bytes(generated.provenance) &&
			bytes(persistedForged.tiers) === bytes(generated.tiers) &&
			bytes(racedPersisted) === bytes(racedApplied.tiers) &&
			bytes(racedPersisted) !== bytes(stalePreview.tiers) &&
			catalogCalls === 2 &&
			declarationRaceError.length > 0;
		record(
			"gen2-b1-forged-provenance-race",
			"AC6",
			rootCommand,
			observed,
			pass,
			"Forged provenance or a declaration/catalog race persisted stale preview bytes.",
		);
		expect(pass).toBe(true);
	});

	it("fresh B1 seam: panel preview does not remain stale after controller silently substitutes a raced payload", async () => {
		const loadedTheme = await getThemeByName("red-claw");
		if (loadedTheme) setThemeInstance(loadedTheme);
		const catalogA = [
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-sonnet-4-6"),
			model("anthropic", "claude-opus-5"),
		];
		const catalogB = [model("anthropic", "claude-haiku-4-5")];
		let useCatalogB = false;
		const context = testContext(catalogA);
		context.ctx.session.modelRegistry = {
			getAll: () => (useCatalogB ? catalogB : catalogA),
			getAvailable: () => (useCatalogB ? catalogB : catalogA),
		};
		const controller = new SelectorController(context.ctx as never);
		const setup = { schema: 1 as const, providers: ["anthropic"] };
		const initialPreview = controller.previewSmartRouting(setup);
		let applied: ReturnType<SelectorController["previewSmartRouting"]> | undefined;
		const panel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: initialPreview,
			generatePreview: draft => controller.previewSmartRouting(draft),
			onSelect: async intent => {
				if (intent.kind !== "apply") return;
				applied = await controller.applySmartRouting(intent.draft, { preview: intent.preview });
			},
			onCancel: () => undefined,
		});
		useCatalogB = true;
		await panel.__testApply();
		const panelPreview = panel.getPreviewPayload();
		const observed = {
			applied,
			panelPreview,
			panelMode: panel.mode,
			settingsTiers: context.settings.get("task.autorouting.tiers"),
		};
		const pass =
			panel.mode === "done" &&
			applied !== undefined &&
			bytes(panelPreview.tiers) === bytes(applied.tiers) &&
			bytes(context.settings.get("task.autorouting.tiers")) === bytes(applied.tiers);
		record(
			"gen2-b1-panel-substitution",
			"AC6",
			rootCommand,
			observed,
			pass,
			"Controller substituted a regenerated payload but the panel retained stale forged/raced preview bytes after Apply.",
		);
		expect(pass).toBe(true);
	});

	it("B2 varied: disabled-present, disabled-unauthenticated, enabled-absent, and ordering remain truthful", async () => {
		const catalog = [model("enabled", "present"), model("disabled", "present")];
		const settings = {
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": {
				fast: ["enabled/present", "disabled/present", "disabled/missing", "missing/absent"],
			},
			disabledProviders: ["disabled"],
		};
		const observedCalls: string[] = [];
		const observedRuns: Array<{ skips?: Array<{ selector: string; code: string }>; candidates?: string[] }> = [];
		const discover = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		const runStub = async (options: Parameters<typeof runSubprocess>[0]) => {
			observedRuns.push({ skips: options.autoroutingSkips, candidates: options.autoroutingCandidates });
			return successResult(options);
		};
		const getApiKey = async (entry: Model): Promise<string | undefined> => {
			observedCalls.push(`${entry.provider}/${entry.id}`);
			return undefined;
		};
		const tool = await TaskTool.create(taskSession(settings, catalog, getApiKey), { runSubprocess: runStub });
		await tool.execute("gen2-skip-order", {
			agent: "task",
			tasks: [{ id: "one", description: "one", assignment: "run", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		discover.mockRestore();
		const run = observedRuns[0];
		const observed = { run, observedCalls, order: run?.skips?.map(skip => `${skip.selector}:${skip.code}`) };
		const pass =
			JSON.stringify(run?.candidates) === JSON.stringify([]) &&
			JSON.stringify(run?.skips) ===
				JSON.stringify([
					{ selector: "disabled/present", code: "provider_disabled" },
					{ selector: "disabled/missing", code: "provider_disabled" },
					{ selector: "missing/absent", code: "snapshot_missing" },
					{ selector: "enabled/present", code: "credential_unavailable" },
				]) &&
			JSON.stringify(observedCalls) === JSON.stringify(["enabled/present"]);
		record(
			"gen2-b2-skip-ordering",
			"AC12",
			rootCommand,
			observed,
			pass,
			"Disabled, snapshot-missing, and credential-unavailable candidates were conflated or omitted.",
		);
		expect(pass).toBe(true);
	});

	it("B2 one-shot credential lookup faults reach authoritative preflight", async () => {
		const catalog = [model("enabled", "present")];
		const settings = {
			"task.autorouting.enabled": true,
			"task.autorouting.tiers": { fast: ["enabled/present"] },
		};
		let calls = 0;
		let preflightErrors: Map<string, unknown> | undefined;
		const discover = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		const tool = await TaskTool.create(
			taskSession(settings, catalog, async () => {
				calls++;
				if (calls === 1) throw new Error("one-shot keychain failure");
				return "key";
			}),
			{
				runSubprocess: async options => {
					preflightErrors = options.autoroutingPreflightErrors;
					return successResult(options);
				},
			},
		);
		await tool.execute("gen2-one-shot-credential-fault", {
			agent: "task",
			tasks: [{ id: "one", description: "one", assignment: "run", tier: "fast" }],
		} as never);
		await AsyncJobManager.instance()!.waitForAll();
		discover.mockRestore();
		expect(calls).toBe(1);
		expect(preflightErrors?.get("enabled/present")).toBeInstanceOf(Error);
	});

	it("B3 varied: rejects traversal encodings, absolute/separator ids, unicode ids, and overlong ids before any writer/path effect", async () => {
		const invalidIds = [
			"",
			".",
			"..",
			"../escape",
			"../../outside",
			"/absolute",
			"C:\\\\absolute",
			"a/b",
			"a\\\\b",
			"a/../b",
			"a\\\\..\\\\b",
			"a\u0000b",
			"a\nb",
			"e\u0301",
			"é",
			"%2e%2e",
			"a".repeat(129),
		];
		const attempts: Array<{ id: string; error: string; openedPaths: string[]; stagingEntries: string[] }> = [];
		for (const id of invalidIds) {
			const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-id-"));
			const finalPath = path.join(root, "final.jsonl");
			const openedPaths: string[] = [];
			const baseStorage = new FileSessionStorage();
			const storage = new Proxy(baseStorage, {
				get(target, property, receiver) {
					if (property === "openWriter") {
						return (filePath: string, options?: Parameters<SessionStorage["openWriter"]>[1]) => {
							openedPaths.push(filePath);
							return target.openWriter(filePath, options);
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as unknown as SessionStorage;
			let error = "";
			try {
				await SessionManager.openStaged(finalPath, storage, id);
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			attempts.push({ id, error, openedPaths, stagingEntries: await tree(path.join(root, ".staging")) });
			await rm(root, { recursive: true, force: true });
		}
		const validRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-valid-id-"));
		const validFinal = path.join(validRoot, "final.jsonl");
		let validAccepted = false;
		try {
			const valid = await SessionManager.openStaged(validFinal, undefined, "A".repeat(128));
			validAccepted = true;
			await valid.discardStaged();
		} finally {
			await rm(validRoot, { recursive: true, force: true });
		}
		const collisionRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-collision-"));
		let collisionError = "";
		try {
			await SessionManager.openStaged(path.join(collisionRoot, ".staging", "safe.jsonl"), undefined, "safe");
		} catch (caught) {
			collisionError = caught instanceof Error ? caught.message : String(caught);
		}
		await rm(collisionRoot, { recursive: true, force: true });
		const observed = { invalidIds, attempts, validAccepted, collisionError };
		const pass =
			attempts.every(
				attempt =>
					attempt.error.includes("Unsafe artifact attempt id") &&
					attempt.openedPaths.length === 0 &&
					attempt.stagingEntries.length === 0,
			) &&
			validAccepted &&
			collisionError.includes("Final session path cannot be staged");
		record(
			"gen2-b3-attempt-id-variants",
			"AC13",
			rootCommand,
			observed,
			pass,
			"A traversal, absolute, separator, unicode, overlong, or collision id caused a writer/path effect before rejection.",
		);
		expect(pass).toBe(true);
	});

	it("B4 varied: whitespace sanitization and placeholder literals remain bounded and terminal", async () => {
		const inputs = [" \t\r\n", "\u0000\u0001", "<omitted-selector>"];
		let result: SingleResult | undefined;
		let error = "";
		try {
			result = await runSubprocess({
				cwd: process.cwd(),
				agent: taskAgent,
				task: "gen2-sanitization",
				assignment: "gen2-sanitization",
				index: 0,
				id: "gen2-sanitization",
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: [],
				autoroutingSkips: inputs.map(selector => ({ selector, code: "snapshot_missing" as const })),
				routing: { tier: "fast", requestedSelector: "provider/model", substitutions: [] },
			});
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const selectors = result?.routing?.skips?.map(skip => skip.selector) ?? [];
		const observed = { inputs, selectors, terminal: result?.routing?.terminal, error };
		const pass =
			error.length === 0 &&
			result?.routing?.terminal === "all_candidates_skipped" &&
			selectors.length === 3 &&
			selectors[0] === " " &&
			selectors[1] === "<omitted-selector>" &&
			selectors[2] === "<omitted-selector>";
		record(
			"gen2-b4-whitespace-placeholder",
			"AC12",
			rootCommand,
			observed,
			pass,
			"Whitespace-only sanitization threw or escaped the bounded evidence shape; literal placeholder handling failed.",
		);
		expect(pass).toBe(true);
	});

	it("B5 varied: exact 256 bounds, 257 rejection, multibyte lengths, and impossible phase/code pairs are enforced", () => {
		const makeEvidence = (authResolvedModel: string): TaskRoutingEvidence => ({
			tier: "fast",
			requestedSelector: "provider/model",
			effectiveModel: "provider/effective",
			authResolvedModel,
			substitutions: [],
		});
		const check = (authResolvedModel: string): string => {
			try {
				assertRoutingEvidenceInvariant(makeEvidence(authResolvedModel));
				return "accepted";
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		};
		const phaseChecks = [
			(() => {
				try {
					assertRoutingEvidenceInvariant({
						...makeEvidence("provider/auth"),
						attempts: [{ selector: "provider/model", phase: "probe", code: "post_acceptance_failure" }],
					});
					return "accepted";
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			})(),
			(() => {
				try {
					assertRoutingEvidenceInvariant({
						...makeEvidence("provider/auth"),
						attempts: [{ selector: "provider/model", phase: "durable", code: "probe_passed" }],
					});
					return "accepted";
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			})(),
		];
		const observed = {
			ascii256: check("a".repeat(256)),
			ascii257: check("a".repeat(257)),
			multibyte256: check("é".repeat(256)),
			multibyte257: check("é".repeat(257)),
			phaseChecks,
		};
		const pass =
			observed.ascii256 === "accepted" &&
			observed.ascii257 !== "accepted" &&
			observed.multibyte256 === "accepted" &&
			observed.multibyte257 !== "accepted" &&
			phaseChecks.every(message => message !== "accepted");
		record(
			"gen2-b5-bounds-phase-pairs",
			"AC12",
			rootCommand,
			observed,
			pass,
			"A 257-length/multibyte auth-resolved model was accepted, a 256-length model rejected, or impossible phase/code pairing escaped.",
		);
		expect(pass).toBe(true);
	});

	it("manual-fallback skip evidence is bounded and aggregated before invariant validation", () => {
		const skips = Array.from({ length: 20 }, (_, index) => ({
			selector: index === 0 ? "provider/\u0000model" : `provider/${"x".repeat(300)}-${index}`,
			code: "snapshot_missing" as const,
		}));
		const projection = buildBoundedRoutingSkips(skips);
		const evidence: TaskRoutingEvidence = {
			tier: "fast",
			requestedSelector: "manual-model-chain",
			effectiveModel: "manual-model-chain",
			substitutions: [],
			...projection,
		};
		assertRoutingEvidenceInvariant(evidence);
		record(
			"gen3-direct-skip-projection",
			"AC12",
			rootCommand,
			{ projection },
			true,
			"Direct bounded-skip projection did not preserve selector bounds or omitted-code aggregates.",
		);
		expect(projection.skips).toHaveLength(16);
		expect(projection.skips?.[0]?.selector).toBe("provider/model");
		expect(projection.omittedSkipCount).toBe(4);
		expect(projection.omittedByCode).toEqual({ snapshot_missing: 4 });
	});

	it("fresh post-fence seams: structural remap is simultaneous, deferred rollback removes only owned publication, and finalize is stable", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-publisher-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const parentDir = path.join(root, "candidate");
		const parentArtifacts = new ArtifactManager(parentDir);
		await parentArtifacts.save("sibling", "tool");
		const manager = await SessionManager.openStaged(finalPath, undefined, "publisher-gen2");
		const stagedArtifacts = manager.getArtifactManager();
		if (!stagedArtifacts) throw new Error("staged artifact manager unavailable");
		const first = await stagedArtifacts.save("first", "tool");
		const second = await stagedArtifacts.save("second", "tool");
		manager.appendCustomEntry("refs", {
			id: first,
			parentId: first,
			timestamp: first,
			refs: [`artifact://${first}`, `artifact://${second}`, `agent://${first}`, `agent://${second}`],
			nested: { first: first, second: second, adjacent: `${first}${second}` },
			decimal: "0.5",
		});
		await manager.commitStaged({ deferArtifactFinalize: true });
		const publishedText = await Bun.file(finalPath).text();
		const publishedTree = await tree(parentDir);
		await manager.rollbackCommittedStaged();
		const rolledBack = {
			final: await fileBytes(finalPath),
			parentTree: await tree(parentDir),
			stagingTree: await tree(path.join(root, ".staging")),
		};
		const hookRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-hook-"));
		const hookParent = new ArtifactManager(path.join(hookRoot, "parent"));
		await hookParent.save("sibling", "tool");
		const hookParentBefore = await tree(hookParent.dir);
		const hookStaging = hookParent.createAttemptStaging("before-hook");
		await hookStaging.save("candidate", "tool");
		const hookBefore = await tree(hookParent.dir);
		let hookError = "";
		try {
			await hookParent.commitAttemptStaging(hookStaging, "before-hook", {
				beforePublish: () => {
					throw new Error("before-publish-injected");
				},
			});
		} catch (error) {
			hookError = error instanceof Error ? error.message : String(error);
		}
		await hookStaging.discardAttemptStaging();
		const hookAfter = await tree(hookParent.dir);
		const finalizeRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen2-finalize-"));
		const finalizePath = path.join(finalizeRoot, "candidate.jsonl");
		const finalizeManager = await SessionManager.openStaged(finalizePath, undefined, "finalize-gen2");
		const finalizeArtifacts = finalizeManager.getArtifactManager();
		if (!finalizeArtifacts) throw new Error("finalize artifact manager unavailable");
		await finalizeArtifacts.save("finalize", "tool");
		await finalizeManager.commitStaged({ deferArtifactFinalize: true });
		const beforeFinalize = {
			final: await fileBytes(finalizePath),
			tree: await tree(path.join(finalizeRoot, "candidate")),
		};
		finalizeManager.finalizeStagedCommit();
		const afterFinalize = {
			final: await fileBytes(finalizePath),
			tree: await tree(path.join(finalizeRoot, "candidate")),
		};
		await rm(root, { recursive: true, force: true });
		await rm(hookRoot, { recursive: true, force: true });
		await rm(finalizeRoot, { recursive: true, force: true });
		const observed = {
			first,
			second,
			publishedText,
			publishedTree,
			rolledBack,
			hookParentBefore,
			hookBefore,
			hookError,
			hookAfter,
			beforeFinalize,
			afterFinalize,
		};
		const pass =
			publishedText.includes("artifact://1") &&
			publishedText.includes("artifact://2") &&
			publishedText.includes("agent://1") &&
			publishedText.includes("agent://2") &&
			publishedText.includes('"decimal":"0.5"') &&
			publishedText.includes(`"id":"${first}"`) &&
			rolledBack.final === null &&
			JSON.stringify(rolledBack.parentTree) === JSON.stringify([".artifact-id-0", "0.tool.log"]) &&
			rolledBack.stagingTree.length === 0 &&
			hookError === "before-publish-injected" &&
			JSON.stringify(hookParentBefore) === JSON.stringify(hookAfter) &&
			bytes(beforeFinalize.final) === bytes(afterFinalize.final) &&
			JSON.stringify(beforeFinalize.tree) === JSON.stringify(afterFinalize.tree);
		record(
			"gen2-post-fence-remap-rollback",
			"AC13",
			rootCommand,
			observed,
			pass,
			"Post-fence remap double-substituted chained IDs, deferred rollback leaked owned files, or finalize changed publication bytes.",
		);
		expect(pass).toBe(true);
	});
	it("deferred publication leaves breadcrumb untouched until finalization and aggregates cleanup failures", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-publisher-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const beforeBreadcrumb = await terminalBreadcrumbBytes();
		const manager = await SessionManager.openStaged(finalPath, undefined, "gen3-breadcrumb");
		const artifacts = manager.getArtifactManager();
		if (!artifacts) throw new Error("staged artifact manager unavailable");
		await artifacts.save("candidate", "tool");
		await manager.commitStaged({ deferArtifactFinalize: true });
		const afterDeferredCommit = await terminalBreadcrumbBytes();
		await manager.rollbackCommittedStaged();
		const afterRollback = await terminalBreadcrumbBytes();

		const collisionRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-cleanup-"));
		const collisionPath = path.join(collisionRoot, "candidate.jsonl");
		const collisionManager = await SessionManager.openStaged(collisionPath, undefined, "gen3-cleanup");
		const collisionArtifacts = collisionManager.getArtifactManager();
		if (!collisionArtifacts) throw new Error("collision artifact manager unavailable");
		await collisionArtifacts.save("candidate", "tool");
		await writeFile(collisionPath, "pre-existing-final");
		const cleanupFailure = new Error("discard-cleanup-failed");
		vi.spyOn(collisionManager, "discardStaged").mockRejectedValue(cleanupFailure);
		let commitFailure: unknown;
		try {
			await collisionManager.commitStaged();
		} catch (error) {
			commitFailure = error;
		}
		const discardRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-discard-"));
		const discardManager = await SessionManager.openStaged(
			path.join(discardRoot, "candidate.jsonl"),
			undefined,
			"gen3-discard",
		);
		const discardArtifacts = discardManager.getArtifactManager();
		if (!discardArtifacts) throw new Error("discard artifact manager unavailable");
		await discardArtifacts.save("candidate", "tool");
		const discardCleanupFailure = new Error("preflight-discard-cleanup-failed");
		vi.spyOn(discardArtifacts, "discardAttemptStaging").mockRejectedValue(discardCleanupFailure);
		let discardFailure: unknown;
		try {
			await discardManager.discardStaged();
		} catch (error) {
			discardFailure = error;
		}
		const discardCauses = discardFailure instanceof AggregateError ? discardFailure.errors : [];
		const causes = commitFailure instanceof AggregateError ? commitFailure.errors : [];
		const pass =
			afterDeferredCommit === beforeBreadcrumb &&
			afterRollback === beforeBreadcrumb &&
			commitFailure instanceof AggregateError &&
			causes.some(cause => cause === cleanupFailure) &&
			causes.length >= 2 &&
			discardFailure instanceof AggregateError &&
			discardCauses.some(cause => cause === discardCleanupFailure);
		record(
			"gen3-breadcrumb-cleanup-evidence",
			"AC13",
			rootCommand,
			{
				beforeBreadcrumb,
				afterDeferredCommit,
				afterRollback,
				commitFailure,
				causes: causes.map(String),
				discardFailure,
				discardCauses: discardCauses.map(String),
			},
			pass,
			"Deferred publication changed the continue breadcrumb before post-commit success, or cleanup failure masked the original commit failure.",
		);
		expect(pass).toBe(true);
		await rm(root, { recursive: true, force: true });
		await rm(collisionRoot, { recursive: true, force: true });
		await rm(discardRoot, { recursive: true, force: true });
	});
});

describe("autorouting boundary red-team generation 3 delta re-attacks", () => {
	it("B6 varied callback failures, races, and rapid Apply calls stay canonical", async () => {
		const catalogA = [
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-sonnet-5"),
			model("anthropic", "claude-sonnet-4-6"),
			model("anthropic", "claude-opus-5"),
		];
		const catalogB = [model("anthropic", "claude-haiku-4-5")];
		const setup = { schema: 1 as const, providers: ["anthropic"] };
		const context = (useB: () => boolean) => {
			const result = testContext(catalogA);
			result.ctx.session.modelRegistry = {
				getAll: () => (useB() ? catalogB : catalogA),
				getAvailable: () => (useB() ? catalogB : catalogA),
			};
			return result;
		};
		let voidUseB = false;
		const voidContext = context(() => voidUseB);
		const voidController = new SelectorController(voidContext.ctx as never);
		const voidPanel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: voidController.previewSmartRouting(setup),
			generatePreview: draft => voidController.previewSmartRouting(draft),
			onSelect: async intent => {
				if (intent.kind === "apply")
					await voidController.applySmartRouting(intent.draft, { preview: intent.preview });
			},
			onCancel: () => undefined,
		});
		voidUseB = true;
		await voidPanel.__testApply();
		const voidApplied = {
			preview: voidPanel.getPreviewPayload(),
			tiers: voidContext.settings.get("task.autorouting.tiers"),
			mode: voidPanel.mode,
		};
		let productionUseB = false;
		const productionContext = context(() => productionUseB);
		const productionController = new SelectorController(productionContext.ctx as never);
		const productionPanel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: productionController.previewSmartRouting(setup),
			generatePreview: draft => productionController.previewSmartRouting(draft),
			onSelect: async intent =>
				intent.kind === "apply"
					? productionController.applySmartRouting(intent.draft, { preview: intent.preview })
					: undefined,
			onCancel: () => undefined,
		});
		productionUseB = true;
		await productionPanel.__testApply();
		const productionApplied = {
			preview: productionPanel.getPreviewPayload(),
			tiers: productionContext.settings.get("task.autorouting.tiers"),
			mode: productionPanel.mode,
		};
		const failureContext = testContext(catalogA);
		const failureInitial = new SelectorController(failureContext.ctx as never).previewSmartRouting(setup);
		const failure = new Error("apply-failure-injected");
		const failurePanel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: failureInitial,
			generatePreview: () => failureInitial,
			onSelect: async () => {
				throw failure;
			},
			onCancel: () => undefined,
		});
		await failurePanel.__testApply();
		let releaseRapid!: () => void;
		let rapidCalls = 0;
		const rapidContext = testContext(catalogA);
		const rapidInitial = new SelectorController(rapidContext.ctx as never).previewSmartRouting(setup);
		const rapidPanel = new SmartRoutingPanelComponent({
			setup,
			enabled: false,
			readOnly: false,
			stale: false,
			preview: rapidInitial,
			generatePreview: () => rapidInitial,
			onSelect: async () => {
				rapidCalls++;
				await new Promise<void>(resolve => {
					releaseRapid = resolve;
				});
				return rapidInitial;
			},
			onCancel: () => undefined,
		});
		const firstApply = rapidPanel.__testApply();
		await Promise.resolve();
		const modeDuringRapid = rapidPanel.mode;
		const secondApply = rapidPanel.__testApply();
		releaseRapid();
		await Promise.all([firstApply, secondApply]);
		const observed = {
			voidApplied,
			productionApplied,
			failure: {
				mode: failurePanel.mode,
				preview: failurePanel.getPreviewPayload(),
				tiers: failureContext.settings.get("task.autorouting.tiers"),
			},
			rapid: { rapidCalls, modeDuringRapid, mode: rapidPanel.mode, preview: rapidPanel.getPreviewPayload() },
		};
		const pass =
			voidApplied.mode === "done" &&
			bytes(voidApplied.preview.tiers) === bytes(voidApplied.tiers) &&
			voidApplied.preview.tiers.balanced === undefined &&
			productionApplied.mode === "done" &&
			bytes(productionApplied.preview.tiers) === bytes(productionApplied.tiers) &&
			productionApplied.preview.tiers.balanced === undefined &&
			observed.failure.mode === "error" &&
			bytes(observed.failure.preview) === bytes(failureInitial) &&
			bytes(observed.failure.tiers) === bytes({}) &&
			observed.rapid.rapidCalls === 1 &&
			observed.rapid.modeDuringRapid === "committing" &&
			observed.rapid.mode === "done" &&
			bytes(observed.rapid.preview) === bytes(rapidInitial);
		record(
			"gen3-b6-callback-and-rapid",
			"AC6",
			rootCommand,
			observed,
			pass,
			"Void/production callbacks diverged, Apply failure entered done or mutated preview, or rapid Apply calls interleaved.",
		);
		expect(pass).toBe(true);
	});

	it("B7 varied cycle/substrings/URI nesting preserve one-pass field-aware remap", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-remap-"));
		const manager = await SessionManager.openStaged(
			path.join(root, "candidate.jsonl"),
			undefined,
			"gen3-remap-cycle",
		);
		const original = {
			artifactRef: "artifact://0/path/1?next=11#frag",
			artifactRefs: ["artifact://0", "artifact://1", "artifact://11", "agent://111/path"],
			artifactId: "0",
			artifactIds: [0, 1, 11, 111],
			nested: { artifactRef: "artifact://1/nested", artifactRefs: [["agent://0"], ["artifact://11?x=1"]] },
			selectorTail: "artifact://0:1-100",
			selectorTailCompound: "artifact://11:raw:1-100",
			selectorTailAgent: "agent://1:raw",
			ordinaryDecimal: "0.5",
			ordinaryText: "prefix artifact://0 suffix",
			ordinaryAgentText: "agent://11 is only prose",
		};
		manager.appendCustomEntry("gen3-remap", original);
		const remap = new Map([
			["0", "1"],
			["1", "0"],
			["11", "1"],
			["111", "11"],
		]);
		await manager.remapStagedArtifactReferences(remap);
		const stagedFile = manager.getSessionFile();
		const stagedText = stagedFile ? await Bun.file(stagedFile).text() : "";
		const custom = stagedText
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { customType?: string; data?: typeof original })
			.find(entry => entry.customType === "gen3-remap");
		await manager.discardStaged();
		await rm(root, { recursive: true, force: true });
		const remapped = custom?.data;
		const observed = { remap: [...remap.entries()], remapped, stagedFile, stagedText };
		const pass =
			remapped?.artifactRef === "artifact://1/path/1?next=11#frag" &&
			JSON.stringify(remapped?.artifactRefs) ===
				JSON.stringify(["artifact://1", "artifact://0", "artifact://1", "agent://11/path"]) &&
			remapped?.artifactId === "1" &&
			JSON.stringify(remapped?.artifactIds) === JSON.stringify([1, 0, 1, 11]) &&
			remapped?.nested?.artifactRef === "artifact://0/nested" &&
			JSON.stringify(remapped?.nested?.artifactRefs) === JSON.stringify([["agent://1"], ["artifact://1?x=1"]]) &&
			remapped?.ordinaryDecimal === "0.5" &&
			remapped?.selectorTail === "artifact://1:1-100" &&
			remapped?.selectorTailCompound === "artifact://1:raw:1-100" &&
			remapped?.selectorTailAgent === "agent://0:raw" &&
			remapped?.ordinaryText === "prefix artifact://0 suffix" &&
			remapped?.ordinaryAgentText === "agent://11 is only prose";
		record(
			"gen3-b7-remap-cycle",
			"AC13",
			rootCommand,
			observed,
			pass,
			"Cycle/substrings cascaded, nested/array URI segments were not one-pass, or non-reference lookalike text was rewritten.",
		);
		expect(pass).toBe(true);
	});

	it("shared bounded-skip projection matches routed preflight and manual fallback", async () => {
		const catalog = [model("present", "model")];
		const longMissing = (index: number) => `missing/${"x".repeat(200)}-${index}`;
		const missingSelectors = Array.from({ length: 20 }, (_, index) => longMissing(index));
		const discover = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		AsyncJobManager.setInstance(new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: async () => {} }));
		const runOnce = async (selectors: string[]) => {
			const settingsOverrides = { "task.autorouting.enabled": true, "task.autorouting.tiers": { fast: selectors } };
			const captured: Array<{
				routing?: TaskRoutingEvidence;
				autoroutingCandidates?: string[];
				autoroutingPreflight?: boolean;
			}> = [];
			const tool = await TaskTool.create(
				taskSession(settingsOverrides, catalog, async () => "key"),
				{
					runSubprocess: async options => {
						captured.push({
							routing: options.routing,
							autoroutingCandidates: options.autoroutingCandidates,
							autoroutingPreflight: options.autoroutingPreflight,
						});
						return successResult(options);
					},
				},
			);
			await tool.execute("gen3-skip-projection", {
				agent: "task",
				tasks: [{ id: "one", description: "one", assignment: "run", tier: "fast" }],
			} as never);
			await AsyncJobManager.instance()!.waitForAll();
			return captured[0];
		};
		const preflight = await runOnce(["present/model", ...missingSelectors]);
		const manual = await runOnce(missingSelectors);
		discover.mockRestore();
		const observed = { preflight, manual };
		const preflightSkips = preflight?.routing?.skips;
		const manualSkips = manual?.routing?.skips;
		const pass =
			preflight?.autoroutingPreflight === true &&
			manual?.autoroutingPreflight === false &&
			JSON.stringify(preflightSkips) === JSON.stringify(manualSkips) &&
			preflightSkips?.length === 16 &&
			manualSkips?.length === 16 &&
			preflight?.routing?.omittedSkipCount === 4 &&
			manual?.routing?.omittedSkipCount === 4 &&
			preflightSkips.every(skip => skip.selector.length <= 256) &&
			manualSkips.every(skip => skip.selector.length <= 256) &&
			preflight?.routing?.omittedByCode?.snapshot_missing === 4 &&
			manual?.routing?.omittedByCode?.snapshot_missing === 4;
		record(
			"gen3-shared-skip-projection",
			"AC12",
			rootCommand,
			observed,
			pass,
			"Manual fallback and routed preflight diverged in retained/omitted skip evidence or selector bounds.",
		);
		expect(pass).toBe(true);
	});

	it("deferred breadcrumb ordering and AggregateError retain original failures", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-interleave-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const before = await terminalBreadcrumbBytes();
		const manager = await SessionManager.openStaged(finalPath, undefined, "gen3-interleave");
		const artifacts = manager.getArtifactManager();
		if (!artifacts) throw new Error("artifact manager unavailable");
		await artifacts.save("candidate", "tool");
		await manager.commitStaged({ deferArtifactFinalize: true });
		const deferred = await terminalBreadcrumbBytes();
		await manager.rollbackCommittedStaged();
		const rolledBack = await terminalBreadcrumbBytes();
		manager.finalizeStagedCommit();
		const afterNoopFinalize = await terminalBreadcrumbBytes();
		const aggregateRoot = await mkdtemp(path.join(tmpdir(), "autorouting-gen3-aggregate-"));
		const aggregatePath = path.join(aggregateRoot, "candidate.jsonl");
		const aggregateManager = await SessionManager.openStaged(aggregatePath, undefined, "gen3-aggregate");
		const aggregateArtifacts = aggregateManager.getArtifactManager();
		if (!aggregateArtifacts) throw new Error("aggregate artifact manager unavailable");
		await aggregateArtifacts.save("candidate", "tool");
		await writeFile(aggregatePath, "existing-final");
		const cleanupFailure = new Error("aggregate-discard-cleanup-failed");
		vi.spyOn(aggregateManager, "discardStaged").mockRejectedValue(cleanupFailure);
		let aggregateFailure: unknown;
		try {
			await aggregateManager.commitStaged();
		} catch (error) {
			aggregateFailure = error;
		}
		const aggregateErrors = aggregateFailure instanceof AggregateError ? aggregateFailure.errors : [];
		const aggregateStrings = aggregateErrors.map(String);
		const observed = { before, deferred, rolledBack, afterNoopFinalize, aggregateFailure, aggregateStrings };
		const pass =
			deferred === before &&
			rolledBack === before &&
			afterNoopFinalize === before &&
			aggregateFailure instanceof AggregateError &&
			aggregateErrors.some(error => error !== cleanupFailure) &&
			aggregateErrors.some(error => error === cleanupFailure) &&
			aggregateErrors.length >= 2;
		record(
			"gen3-breadcrumb-aggregate-interleaving",
			"AC13",
			rootCommand,
			observed,
			pass,
			"Deferred commit/rollback/finalize changed breadcrumb ordering, or AggregateError masked the original publication failure.",
		);
		expect(pass).toBe(true);
		await rm(root, { recursive: true, force: true });
		await rm(aggregateRoot, { recursive: true, force: true });
	});
});

describe("autorouting boundary red-team generation 4 delta re-attacks", () => {
	it("B8 selector-tail remap follows the internal URL grammar across malformed and compound tails", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen4-selector-tail-"));
		const manager = await SessionManager.openStaged(
			path.join(root, "candidate.jsonl"),
			undefined,
			"gen4-selector-tail",
		);
		const tailOriginal = {
			artifactSelectors: [
				"artifact://3:raw:1-100",
				"artifact://3:1-100:raw",
				"artifact://3:",
				"artifact://3:bogus",
				"artifact://3:-100",
				"artifact://1:1-1",
				"artifact://11:1-1",
			],
			agentSelectors: ["agent://3:raw:1-100", "agent://3:1-100:raw", "agent://3:raw"],
			malformedAgent: ["agent://3:", "agent://3:bogus", "agent://3:-100", "agent://3:raw:bogus"],
			otherSchemes: ["local://3:raw", "memory://3:1-100", "rule://3:raw"],
			nested: { arrays: [["artifact://1:1-1", "artifact://11:1-1"], [{ artifactRef: "agent://1:raw" }]] },
			prose: {
				validArtifact: "Read artifact://3:1-100 now",
				invalidAgent: "prefix agent://3:raw suffix",
				otherScheme: "prefix local://3:raw suffix",
			},
		};
		const cycleOriginal = {
			nested: {
				array: ["artifact://1:1-1", "artifact://11:1-1", ["agent://1:raw", "artifact://30:raw"]],
				deep: { artifactRef: "artifact://3/path", prose: "prefix artifact://30:raw suffix" },
			},
			id: "artifact://1:1-1",
			structural: { id: "artifact://11:1-1", parentId: "agent://3:raw", timestamp: "artifact://3:" },
		};
		manager.appendCustomEntry("gen4-selector-tail", tailOriginal);
		manager.appendCustomEntry("gen4-cycle", cycleOriginal);
		const remap = new Map([
			["1", "11"],
			["11", "1"],
			["3", "30"],
			["30", "3"],
		]);
		const parserInputs = [
			...tailOriginal.artifactSelectors,
			...tailOriginal.agentSelectors,
			...tailOriginal.malformedAgent,
			...tailOriginal.otherSchemes,
		];
		const parserObserved = Object.fromEntries(parserInputs.map(value => [value, splitInternalUrlSel(value)]));
		await manager.remapStagedArtifactReferences(remap);
		const stagedFile = manager.getSessionFile();
		const stagedText = stagedFile ? await Bun.file(stagedFile).text() : "";
		const customEntries = stagedText
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { customType?: string; data?: unknown });
		const remappedTail = customEntries.find(entry => entry.customType === "gen4-selector-tail")?.data as
			| typeof tailOriginal
			| undefined;
		const remappedCycle = customEntries.find(entry => entry.customType === "gen4-cycle")?.data as
			| typeof cycleOriginal
			| undefined;
		await manager.discardStaged();
		await rm(root, { recursive: true, force: true });
		const observed = {
			remap: [...remap.entries()],
			parserObserved,
			remappedTail,
			remappedCycle,
			stagedFile,
		};
		const tailPass =
			JSON.stringify(remappedTail?.artifactSelectors) ===
				JSON.stringify([
					"artifact://30:raw:1-100",
					"artifact://30:1-100:raw",
					"artifact://30:",
					"artifact://30:bogus",
					"artifact://30:-100",
					"artifact://11:1-1",
					"artifact://1:1-1",
				]) &&
			JSON.stringify(remappedTail?.agentSelectors) ===
				JSON.stringify(["agent://30:raw:1-100", "agent://30:1-100:raw", "agent://30:raw"]) &&
			JSON.stringify(remappedTail?.malformedAgent) ===
				JSON.stringify(["agent://3:", "agent://3:bogus", "agent://3:-100", "agent://3:raw:bogus"]) &&
			JSON.stringify(remappedTail?.otherSchemes) ===
				JSON.stringify(["local://3:raw", "memory://3:1-100", "rule://3:raw"]) &&
			JSON.stringify(remappedTail?.nested) ===
				JSON.stringify({
					arrays: [["artifact://11:1-1", "artifact://1:1-1"], [{ artifactRef: "agent://11:raw" }]],
				}) &&
			// Final rule: re-keying happens only when the ENTIRE value is a single URI token, so a URI
			// embedded in a prose sentence is never rewritten — for either scheme. This supersedes an
			// earlier reconciliation that remapped artifact-in-prose but not agent-in-prose; the
			// stricter whole-token rule is consistent, is what the implementation now enforces, and
			// removes the whole class of over-rewrite bugs found in earlier generations.
			remappedTail?.prose.validArtifact === "Read artifact://3:1-100 now" &&
			remappedTail?.prose.invalidAgent === "prefix agent://3:raw suffix" &&
			remappedTail?.prose.otherScheme === "prefix local://3:raw suffix" &&
			parserObserved["artifact://3:"]?.path === "artifact://3" &&
			parserObserved["artifact://3:"]?.sel === "" &&
			parserObserved["artifact://3:bogus"]?.sel === "bogus" &&
			parserObserved["artifact://3:-100"]?.sel === "-100" &&
			parserObserved["agent://3:raw:1-100"]?.sel === "raw:1-100" &&
			parserObserved["agent://3:bogus"]?.sel === "bogus";
		const cyclePass =
			JSON.stringify(remappedCycle?.nested) ===
				JSON.stringify({
					array: ["artifact://11:1-1", "artifact://1:1-1", ["agent://11:raw", "artifact://3:raw"]],
					// prose is a multi-token string, so the whole-token rule leaves it verbatim.
					deep: { artifactRef: "artifact://30/path", prose: "prefix artifact://30:raw suffix" },
				}) &&
			remappedCycle?.id === "artifact://1:1-1" &&
			JSON.stringify(remappedCycle?.structural) ===
				JSON.stringify({ id: "artifact://11:1-1", parentId: "agent://3:raw", timestamp: "artifact://3:" });
		record(
			"gen4-b8-selector-tail-parser",
			"AC13",
			rootCommand,
			observed,
			tailPass,
			"Selector-tail remapping diverged from splitInternalUrlSel: malformed agent tails, non-artifact schemes, nested arrays, prose, or substring IDs were rewritten incorrectly.",
		);
		record(
			"gen4-b9-remap-cycle-nested",
			"AC13",
			rootCommand,
			observed,
			cyclePass,
			"A cyclic ID map cascaded, structural keys were rewritten, or nested selector-tail references were not remapped in one pass.",
		);
		expect(tailPass && cyclePass).toBe(true);
	});

	it("C1 pre-fence discard failure fails closed while retaining both primary and cleanup evidence", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen4-cleanup-failure-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const primary = Object.assign(new Error("transient bootstrap evidence"), { transient: true });
		const cleanup = new Error("discard-cleanup-failed evidence");
		const modelEntry = model("test", "model");
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockRejectedValue(primary);
		const discardSpy = vi.spyOn(SessionManager.prototype, "discardStaged").mockRejectedValueOnce(cleanup);
		let result: Awaited<ReturnType<typeof runSubprocessOnce>> | undefined;
		try {
			result = await runSubprocessOnce({
				cwd: root,
				agent: taskAgent,
				task: "gen4 cleanup failure",
				assignment: "gen4 cleanup failure",
				index: 0,
				id: "gen4-cleanup-failure",
				modelOverride: ["test/model"],
				settings: Settings.isolated(),
				modelRegistry: {
					authStorage: {},
					getAvailable: () => [modelEntry],
					getApiKey: async () => "key",
				} as never,
				preflightDurable: true,
				autoroutingAttemptId: "gen4-cleanup-failure",
				sessionFile: finalPath,
			});
		} finally {
			discardSpy.mockRestore();
			createSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
		const observed = {
			preflightFenceCrossed: result?.preflightFenceCrossed,
			preflightFailure: result?.preflightFailure,
			error: result?.error,
			primary: primary.message,
			cleanup: cleanup.message,
		};
		const pass =
			result?.preflightFenceCrossed === false &&
			JSON.stringify(result?.preflightFailure) ===
				JSON.stringify({ kind: "local", op: "preflight_validation", transient: false }) &&
			(result?.error ?? "").includes(primary.message) &&
			(result?.error ?? "").includes(cleanup.message);
		record(
			"gen4-c1-cleanup-fail-closed",
			"AC13",
			rootCommand,
			observed,
			pass,
			"Pre-fence cleanup failure did not downgrade to terminal or caused the original setup failure evidence to disappear.",
		);
		expect(pass).toBe(true);
	});

	it("C2 a normal transient durable failure with successful discard advances to the next unique candidate", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen4-successful-discard-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const models = [
			model("test", "first", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
			model("test", "second", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		];
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => "key");
		const transientFailure = Object.assign(new Error("normal transient durable failure"), { transient: true });
		const originalCreate = sdkModule.createAgentSession;
		let createCalls = 0;
		const createErrors: string[] = [];
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			createCalls++;
			if (createCalls === 2) throw transientFailure;
			try {
				const result = await originalCreate(options);
				vi.spyOn(result.session, "prompt").mockImplementation(async (_message, promptOptions) => {
					if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
					else promptOptions?.onPreflightAccepted?.();
					if (createCalls === 4)
						result.session.agent.emitExternalEvent({
							type: "tool_execution_end",
							toolCallId: "gen4-yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: {} } },
							isError: false,
						} as never);
				});
				vi.spyOn(result.session, "waitForIdle").mockResolvedValue(undefined);
				return result;
			} catch (error) {
				createErrors.push(error instanceof Error ? error.message : String(error));
				throw error;
			}
		});
		let result: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		let stagingTree: string[] = [];
		let finalExists = false;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen4 successful discard",
				assignment: "gen4 successful discard",
				index: 0,
				id: "gen4-successful-discard",
				modelOverride: ["test/first", "test/second"],
				settings: Settings.isolated(),
				modelRegistry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/first", "test/second"],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					requestedSelector: "test/first",
					effectiveModel: "test/first",
					substitutions: [],
				},
				sessionFile: finalPath,
			});
			stagingTree = await tree(path.join(root, ".staging"));
			finalExists = await fileBytes(finalPath).then(value => value !== null);
		} finally {
			createSpy.mockRestore();
			authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
		const expectedAttempts = [
			{ selector: "test/first", phase: "probe", code: "probe_passed" },
			{ selector: "test/first", phase: "durable", code: "spawn_transient_retry" },
			{ selector: "test/second", phase: "probe", code: "probe_passed" },
			{ selector: "test/second", phase: "durable", code: "accepted" },
		];
		const observed = {
			createCalls,
			createErrors,
			attempts: result?.routing?.attempts,
			stagingTree,
			finalExists,
			exitCode: result?.exitCode,
			firstError: result?.error,
			setupFailure: result?.setupFailure,
			preflightFenceCrossed: result?.preflightFenceCrossed,
		};
		const pass =
			createCalls === 4 &&
			JSON.stringify(result?.routing?.attempts) === JSON.stringify(expectedAttempts) &&
			stagingTree.length === 0 &&
			finalExists &&
			result?.exitCode === 0 &&
			result?.preflightFenceCrossed === true;
		record(
			"gen4-c2-successful-discard-advances",
			"AC13",
			rootCommand,
			observed,
			pass,
			"A successful pre-fence discard failed to advance the normal transient candidate, leaked staging residue, or skipped the accepted ledger entry.",
		);
		expect(pass).toBe(true);
	}, 30_000);

	it("C3 a post-fence failure stays terminal and never enters the pre-fence discard downgrade", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen4-post-fence-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const models = [
			model("test", "first", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
			model("test", "second", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		];
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => "key");
		const postFenceFailure = Object.assign(new Error("post-fence failure evidence"), {
			transportFailure: { kind: "transport" as const, status: 503 },
		});
		const originalCreate = sdkModule.createAgentSession;
		let createCalls = 0;
		const createErrors: string[] = [];
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			createCalls++;
			if (createCalls > 2) throw new Error("unexpected candidate advance");
			try {
				const result = await originalCreate(options);
				vi.spyOn(result.session, "prompt").mockImplementation(async (_message, promptOptions) => {
					if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
					else promptOptions?.onPreflightAccepted?.();
					if (createCalls === 2) throw postFenceFailure;
				});
				vi.spyOn(result.session, "waitForIdle").mockResolvedValue(undefined);
				return result;
			} catch (error) {
				createErrors.push(error instanceof Error ? error.message : String(error));
				throw error;
			}
		});
		let discardCalls = 0;
		const originalDiscard = SessionManager.prototype.discardStaged;
		const discardSpy = vi.spyOn(SessionManager.prototype, "discardStaged").mockImplementation(async function (
			this: SessionManager,
		) {
			discardCalls++;
			return originalDiscard.call(this);
		});
		let result: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		let stagingTree: string[] = [];
		let finalExists = false;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen4 post-fence failure",
				assignment: "gen4 post-fence failure",
				index: 0,
				id: "gen4-post-fence",
				modelOverride: ["test/first", "test/second"],
				settings: Settings.isolated(),
				modelRegistry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/first", "test/second"],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					requestedSelector: "test/first",
					effectiveModel: "test/first",
					substitutions: [],
				},
				sessionFile: finalPath,
			});
			stagingTree = await tree(path.join(root, ".staging"));
			finalExists = await fileBytes(finalPath).then(value => value !== null);
		} finally {
			discardSpy.mockRestore();
			createSpy.mockRestore();
			authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
		const observed = {
			createCalls,
			createErrors,
			discardCalls,
			attempts: result?.routing?.attempts,
			preflightFailure: result?.preflightFailure,
			preflightFenceCrossed: result?.preflightFenceCrossed,
			stagingTree,
			finalExists,
			error: result?.error,
			setupFailure: result?.setupFailure,
		};
		const pass =
			createCalls === 2 &&
			discardCalls === 0 &&
			JSON.stringify(result?.routing?.attempts) ===
				JSON.stringify([
					{ selector: "test/first", phase: "probe", code: "probe_passed" },
					{ selector: "test/first", phase: "durable", code: "post_acceptance_failure" },
				]) &&
			result?.preflightFenceCrossed === true &&
			result?.preflightFailure?.kind === "transport" &&
			result?.error?.includes(postFenceFailure.message) === true &&
			stagingTree.length === 0 &&
			finalExists;
		record(
			"gen4-c3-post-fence-terminal-ledger",
			"AC13",
			rootCommand,
			observed,
			pass,
			"A post-fence failure triggered the pre-fence cleanup downgrade, advanced to another candidate, or lost terminal ledger evidence.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team generation 5 delta re-attacks", () => {
	it("C4 terminal disposition fails closed and the candidate ledger never exceeds three unique selectors", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen5-disposition-"));
		const models = ["one", "two", "three", "four", "five"].map(id =>
			model("test", id, true, {
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		);
		const registry = {
			authStorage: {},
			getAll: () => models,
			getAvailable: () => models,
			getApiKey: async () => "key",
		} as never;
		const optionsFor = (id: string, candidates: string[]): Parameters<typeof runSubprocess>[0] => ({
			cwd: root,
			agent: taskAgent,
			task: id,
			assignment: id,
			index: 0,
			id,
			modelOverride: candidates,
			settings: Settings.isolated(),
			modelRegistry: registry,
			runMode: "initial",
			autoroutingPreflight: true,
			autoroutingCandidates: candidates,
			autoroutingSkips: [],
			routing: {
				tier: "fast",
				requestedSelector: candidates[0] ?? "test/one",
				substitutions: [],
			},
			sessionFile: path.join(root, `${id}.jsonl`),
		});
		const terminal = Object.assign(new Error("typed terminal transport"), {
			transportFailure: { kind: "transport" as const, status: 418 },
		});
		let terminalCalls = 0;
		const terminalSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			terminalCalls++;
			throw terminal;
		});
		let terminalResult: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		try {
			terminalResult = await runSubprocess(
				optionsFor("gen5-terminal", ["test/one", "test/two", "test/three", "test/four"]),
			);
		} finally {
			terminalSpy.mockRestore();
		}
		const transient = Object.assign(new Error("bounded transient"), { transient: true });
		let budgetCalls = 0;
		const budgetSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			budgetCalls++;
			throw transient;
		});
		let budgetResult: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		try {
			budgetResult = await runSubprocess(
				optionsFor("gen5-budget", ["test/one", "test/one", "test/two", "test/three", "test/four"]),
			);
		} finally {
			budgetSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
		const budgetCandidates = budgetResult?.routing?.attempts?.map(attempt => attempt.selector) ?? [];
		const observed = {
			terminalCalls,
			terminalAttempts: terminalResult?.routing?.attempts,
			terminalFailure: terminalResult?.preflightFailure,
			terminal: terminalResult?.routing?.terminal,
			budgetCalls,
			budgetAttempts: budgetResult?.routing?.attempts,
			budget: budgetResult?.routing?.terminal,
			budgetCandidates,
		};
		const pass =
			terminalCalls === 1 &&
			JSON.stringify(terminalResult?.routing?.attempts) ===
				JSON.stringify([{ selector: "test/one", phase: "probe", code: "unclassified_terminal" }]) &&
			terminalResult?.routing?.terminal === "preflight_exhausted" &&
			budgetCalls === 3 &&
			budgetResult?.routing?.attempts?.length === 3 &&
			new Set(budgetCandidates).size === 3 &&
			!budgetCandidates.includes("test/four") &&
			budgetResult?.routing?.attempts?.every(attempt => attempt.code === "spawn_transient_retry") === true;
		record(
			"gen5-disposition-and-budget",
			"AC13",
			`${rootCommand} -t gen5-disposition-and-budget`,
			observed,
			pass,
			"A terminal classification advanced the ledger, or preflight consumed more than three unique candidates.",
		);
		expect(pass).toBe(true);
	});

	it("C5 terminal diagnostics retain the original failure while stripping controls, normalizing, and capping", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen5-diagnostic-"));
		const models = [model("test", "diagnostic", true)];
		const registry = {
			authStorage: {},
			getAll: () => models,
			getAvailable: () => models,
			getApiKey: async () => "key",
		} as never;
		const marker = "GEN5-ORIGINAL-FAILURE";
		const hostileMessage = `${marker}\u0000\u001b[31m\u0007\r\n${"Ａ".repeat(900)}\u001b[0m`;
		const hostile = Object.assign(new Error(hostileMessage), { transient: false });
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockRejectedValue(hostile);
		let result: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen5 diagnostic",
				assignment: "gen5 diagnostic",
				index: 0,
				id: "gen5-diagnostic",
				modelOverride: ["test/diagnostic"],
				settings: Settings.isolated(),
				modelRegistry: registry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/diagnostic"],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					requestedSelector: "test/diagnostic",
					substitutions: [],
				},
				sessionFile: path.join(root, "diagnostic.jsonl"),
			});
		} finally {
			createSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
		const prefix = "Last candidate diagnostic: ";
		const stderrDiagnostic = result?.stderr.split(prefix)[1] ?? "";
		const errorDiagnostic = result?.error?.split(prefix)[1] ?? "";
		const summaryDiagnostic = result?.setupFailure?.summary.split(prefix)[1] ?? "";
		const observed = {
			stderr: result?.stderr,
			error: result?.error,
			setupFailure: result?.setupFailure,
			stderrDiagnostic,
			errorDiagnostic,
			summaryDiagnostic,
			stderrLength: stderrDiagnostic.length,
			containsMarker: stderrDiagnostic.includes(marker),
			containsAnsiControl: /\u001b/.test(stderrDiagnostic),
			containsLineBreak: /[\r\n]/.test(stderrDiagnostic),
			containsNfkc: stderrDiagnostic.includes("A"),
		};
		const pass =
			result?.routing?.terminal === "preflight_exhausted" &&
			// Separator is a space, not "\n": the diagnostic is rendered on a single line so a hostile
			// message can never forge an extra log line. Bounding/redaction is delegated to
			// createSetupFailureSummary (the established egress sanitizer, which also redacts
			// credentials and absolute paths), so the cap is its cap rather than a local 512 constant.
			result?.stderr?.startsWith("Autorouting preflight exhausted. Last candidate diagnostic: ") === true &&
			result?.error === result?.stderr &&
			result?.setupFailure?.summary.includes(prefix) === true &&
			stderrDiagnostic.length > 0 &&
			stderrDiagnostic.length <= 512 &&
			stderrDiagnostic.includes(marker) &&
			!/[\u0000-\u001f\u007f-\u009f]/.test(stderrDiagnostic) &&
			!/[\r\n]/.test(stderrDiagnostic) &&
			stderrDiagnostic.includes("A") &&
			errorDiagnostic === stderrDiagnostic &&
			summaryDiagnostic === stderrDiagnostic;
		record(
			"gen5-terminal-diagnostic-bounds",
			"AC13",
			`${rootCommand} -t gen5-terminal-diagnostic-bounds`,
			observed,
			pass,
			"Terminalization dropped the original failure or allowed control/newline injection beyond the 512-character diagnostic bound.",
		);
		expect(pass).toBe(true);
	});

	it("C6 URI re-keying handles scheme case, zero-padded IDs, malformed artifact tails, and opaque query/fragment payloads", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen5-uri-grammar-"));
		const manager = await SessionManager.openStaged(
			path.join(root, "candidate.jsonl"),
			undefined,
			"gen5-uri-grammar",
		);
		const original = {
			uppercaseArtifact: "ARTIFACT://3:1-1",
			uppercaseAgent: "Agent://3:raw",
			leadingZero: "artifact://007:1-1",
			overlongTail: "artifact://3:raw:1-100:extra",
			adjacent: "artifact://3:1-1artifact://4:1-1",
			queryNested: "artifact://3?next=artifact://4:1-1",
			fragmentNested: "artifact://3#next=agent://4:raw",
			queryIdOnly: "prefix?artifact://4:1-1",
			plainWhitespace: "artifact://3:1-1 next artifact://4:1-1",
		};
		manager.appendCustomEntry("gen5-uri-grammar", original);
		const remap = new Map([
			["3", "30"],
			["4", "40"],
			["007", "70"],
		]);
		const parserObserved = {
			uppercaseArtifact: splitInternalUrlSel(original.uppercaseArtifact),
			uppercaseAgent: splitInternalUrlSel(original.uppercaseAgent),
			leadingZero: splitInternalUrlSel(original.leadingZero),
			overlongTail: splitInternalUrlSel(original.overlongTail),
			adjacent: splitInternalUrlSel(original.adjacent),
		};
		await manager.remapStagedArtifactReferences(remap);
		const stagedFile = manager.getSessionFile();
		const stagedText = stagedFile ? await Bun.file(stagedFile).text() : "";
		const entry = stagedText
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { customType?: string; data?: typeof original })
			.find(item => item.customType === "gen5-uri-grammar");
		await manager.discardStaged();
		await rm(root, { recursive: true, force: true });
		const remapped = entry?.data;
		const observed = { parserObserved, remapped, stagedText };
		const pass =
			remapped?.uppercaseArtifact === "ARTIFACT://30:1-1" &&
			remapped?.uppercaseAgent === "Agent://30:raw" &&
			remapped?.leadingZero === "artifact://70:1-1" &&
			remapped?.overlongTail === "artifact://30:raw:1-100:extra" &&
			remapped?.adjacent === "artifact://30:1-1artifact://4:1-1" &&
			remapped?.queryNested === "artifact://30?next=artifact://4:1-1" &&
			remapped?.fragmentNested === "artifact://30#next=agent://4:raw" &&
			remapped?.queryIdOnly === "prefix?artifact://4:1-1" &&
			remapped?.plainWhitespace === "artifact://3:1-1 next artifact://4:1-1";
		record(
			"gen5-uri-rekey-grammar",
			"AC13",
			`${rootCommand} -t gen5-uri-rekey-grammar`,
			observed,
			pass,
			"URI re-keying diverged from embedded-token grammar: uppercase schemes were missed or nested query/fragment IDs cascaded into remapping.",
		);
		expect(pass).toBe(true);
	});
});
describe("C7 disposition oracle for auth resolution and post-fence transport", () => {
	it("keeps auth resolution advancing while transport failures stay terminal after the fence", () => {
		const auth = classifyAutoroutingPreflightFailure(
			Object.assign(new Error("auth unavailable"), { transient: false, credentialMissing: true }),
			"auth_resolve",
		);
		const transientSession = classifyAutoroutingPreflightFailure(
			Object.assign(new Error("bootstrap transient"), { transient: true }),
			"tool_bootstrap",
		);
		const postFence = classifyAutoroutingPreflightFailure(
			{ transportFailure: { kind: "transport" as const, status: 503 } },
			"session_open",
		);
		// An unmarked exception surfacing while op is auth_resolve must NOT be treated as the
		// deliberate missing-credential signal: an unexpected keychain/config error must fail
		// closed (terminal), not silently advance as if credentials were simply absent.
		const unexpectedAuthError = classifyAutoroutingPreflightFailure(
			Object.assign(new Error("keychain access denied"), { transient: false }),
			"auth_resolve",
		);
		const observed = { auth, transientSession, postFence, unexpectedAuthError };
		const pass =
			auth.kind === "local" &&
			auth.op === "auth_resolve" &&
			transientSession.kind === "local" &&
			transientSession.transient === true &&
			postFence.kind === "transport" &&
			postFence.class === "server" &&
			unexpectedAuthError.kind === "local" &&
			unexpectedAuthError.op !== "auth_resolve" &&
			unexpectedAuthError.transient === false;
		record(
			"gen5-fence-disposition",
			"AC13",
			`${rootCommand} -t gen5-fence-disposition`,
			observed,
			pass,
			"Auth resolution or transient bootstrap classification changed, typed post-fence transport facts were not preserved, or an unmarked auth_resolve exception was wrongly treated as the deliberate missing-credential signal.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team generation 6 varied delta re-attacks", () => {
	it("C8 diagnostic egress redacts secrets, paths, Unicode separators, and long multibyte payloads", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen6-diagnostic-"));
		const registry = {
			authStorage: {},
			getAll: () => [model("test", "diagnostic")],
			getAvailable: () => [model("test", "diagnostic")],
			getApiKey: async () => "key",
		} as never;
		const secretMessage = [
			"Authorization: Bearer super-secret-token",
			"Cookie: session=secret-cookie",
			"x-api-key: x-api-secret-value",
			"https://alice:password@example.invalid/api",
			"api_key=sk-live-secret-value",
			"token=provider-secret-token",
			"sk-proj-abcdefghijklmnopqrstuvwxyz123456",
			"https://example.invalid/?auth=AKIAIOSFODNN7EXAMPLE",
			`file://${process.env.HOME ?? "/Users/secret"}/private/config.yml`,
			"/Users/secret/private.txt",
			"/private/credentials.json",
			"C:\\Users\\secret\\.ssh\\id_rsa",
			"$HOME/.ssh/id_rsa",
			`ansi=\u001b[31mred\u001b[0m osc=\u001b]8;;https://secret.invalid\u0007link\u001b]8;;\u0007`,
			`line${"\u2028"}next${"\u2029"}tail\rline\vvertical\ffeed ${"界".repeat(1200)}`,
		].join(" ");
		const failure = Object.assign(new Error(secretMessage), { transient: false });
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockRejectedValue(failure);
		let result: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen6 diagnostic",
				assignment: "gen6 diagnostic",
				index: 0,
				id: "gen6-diagnostic",
				modelOverride: ["test/diagnostic"],
				settings: Settings.isolated(),
				modelRegistry: registry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/diagnostic"],
				autoroutingSkips: [],
				routing: { tier: "fast", requestedSelector: "test/diagnostic", substitutions: [] },
				sessionFile: path.join(root, "diagnostic.jsonl"),
			});
		} finally {
			createSpy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
		const extract = (value: string): string => value.split("Last candidate diagnostic: ")[1] ?? "";
		const diagnostic = extract(result?.stderr ?? "");
		const renderings = [
			extract(result?.stderr ?? ""),
			extract(result?.error ?? ""),
			extract(result?.setupFailure?.summary ?? ""),
		];
		const observed = {
			diagnostic,
			length: diagnostic.length,
			containsBearerSecret: diagnostic.includes("super-secret-token"),
			containsCookieSecret: diagnostic.includes("secret-cookie"),
			containsPassword: diagnostic.includes("password@"),
			containsApiKey: diagnostic.includes("sk-live-secret-value") || diagnostic.includes("x-api-secret-value"),
			containsProviderToken:
				diagnostic.includes("provider-secret-token") ||
				diagnostic.includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456") ||
				diagnostic.includes("AKIAIOSFODNN7EXAMPLE"),
			containsAbsolutePath:
				diagnostic.includes("/Users/secret") ||
				diagnostic.includes("/private/credentials.json") ||
				diagnostic.includes("C:\\Users\\secret"),
			containsHomePath: diagnostic.includes("$HOME/") || diagnostic.includes("id_rsa"),
			containsControl: /[\u0000-\u001f\u007f-\u009f\u001b]/.test(diagnostic),
			containsSeparators: /[\r\n\u000b\u2028\u2029]/.test(diagnostic),
		};
		const pass =
			result?.routing?.terminal === "preflight_exhausted" &&
			diagnostic.length > 0 &&
			diagnostic.length <= 512 &&
			!observed.containsBearerSecret &&
			!observed.containsCookieSecret &&
			!observed.containsPassword &&
			!observed.containsApiKey &&
			!observed.containsProviderToken &&
			!observed.containsAbsolutePath &&
			!observed.containsHomePath &&
			!observed.containsControl &&
			!observed.containsSeparators &&
			renderings.every(value => value === diagnostic);
		record(
			"gen6-diagnostic-redaction-unicode",
			"AC13",
			`${rootCommand} -t gen6-diagnostic-redaction-unicode`,
			observed,
			pass,
			"Sanitized terminal diagnostics leaked credentials, paths, Unicode line separators, or diverged across receipt renderings.",
		);
		expect(pass).toBe(true);
	});
	it("C9 whole-token URI shapes preserve opaque tails and remap without cascade or double mapping", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen6-uri-shapes-"));
		const manager = await SessionManager.openStaged(path.join(root, "candidate.jsonl"), undefined, "gen6-uri-shapes");
		const original = {
			compound: "ArTiFaCt://12:raw:1-20",
			plusTail: "agent://12:+1-2",
			minusTail: "agent://12:-1",
			percentId: "artifact://%31%32:raw",
			query: "artifact://12?ref=artifact://13:raw",
			fragment: "Agent://12#ref=artifact://13:raw",
			cycle: "artifact://12:raw",
			prose: "prefix artifact://12:raw suffix",
			adjacent: "artifact://12:rawartifact://13:raw",
		};
		manager.appendCustomEntry("gen6-uri-shapes", original);
		const expected = structuredClone(original);
		const map = new Map([
			["12", "13"],
			["13", "12"],
		]);
		await manager.remapStagedArtifactReferences(map);
		const file = manager.getSessionFile();
		const text = file ? await Bun.file(file).text() : "";
		const entry = text
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { customType?: string; data?: typeof original })
			.find(item => item.customType === "gen6-uri-shapes");
		await manager.discardStaged();
		await rm(root, { recursive: true, force: true });
		const remapped = entry?.data;
		const observed = {
			original,
			expected,
			map: [...map.entries()],
			remapped,
			parser: splitInternalUrlSel(expected.compound),
		};
		const pass =
			remapped?.compound === "ArTiFaCt://13:raw:1-20" &&
			remapped?.plusTail === expected.plusTail &&
			remapped?.minusTail === expected.minusTail &&
			remapped?.percentId === expected.percentId &&
			remapped?.query === "artifact://13?ref=artifact://13:raw" &&
			remapped?.fragment === "Agent://13#ref=artifact://13:raw" &&
			remapped?.cycle === "artifact://13:raw" &&
			remapped?.prose === expected.prose &&
			remapped?.adjacent === "artifact://13:rawartifact://13:raw";
		record(
			"gen6-uri-whole-token-shapes",
			"AC13",
			`${rootCommand} -t gen6-uri-whole-token-shapes`,
			observed,
			pass,
			"Whole-token URI re-keying cascaded, decoded percent IDs, rewrote opaque query/fragment payloads, or rewrote prose/adjacent tokens.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team generation 8 delta re-attacks", () => {
	it("CLEAN ownership keeps sibling residue while removing the artifact's own native and quarantine residue", async () => {
		const root = await fs.realpath(await mkdtemp(path.join(tmpdir(), "autorouting-gen8-cleanup-ownership-")));
		const parentDir = path.join(root, "parent");
		const parent = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), parentDir));
		await parent.save("sibling", "tool");
		const filename = "1.tool.log";
		await parent.publishNamedNoReplace(filename, Buffer.from("target", "utf8"));
		const siblingQuarantine = path.join(parentDir, "11.tool.log.removing");
		const siblingPlaceholder = path.join(parentDir, ".gjc-exact-unlink-placeholder-other");
		const ownNativePlaceholder = path.join(parentDir, ".gjc-exact-unlink-placeholder-owned");
		const ownQuarantine = path.join(parentDir, `${filename}.removing`);
		await fs.writeFile(siblingQuarantine, "sibling quarantine", "utf8");
		await fs.writeFile(siblingPlaceholder, "sibling placeholder", "utf8");
		const usesRetainedAuthority = process.platform === "linux";
		const originalExactUnlink = native.exactUnlink;
		const exactUnlinkSpy = usesRetainedAuthority
			? undefined
			: vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
					if (pathname !== path.join(parentDir, filename)) return originalExactUnlink(pathname, identity);
					fsSync.unlinkSync(pathname);
					fsSync.writeFileSync(ownNativePlaceholder, "owned native residue", "utf8");
					fsSync.writeFileSync(ownQuarantine, "owned quarantine residue", "utf8");
					return { ok: true };
				});
		let removed = false;
		try {
			removed = await parent.removeNamedBestEffort(filename);
		} finally {
			exactUnlinkSpy?.mockRestore();
		}
		const remaining = await tree(parentDir);
		const observed = {
			removed,
			remaining,
			targetBytes: await fileBytes(path.join(parentDir, filename)),
			siblingQuarantineBytes: await fileBytes(siblingQuarantine),
			siblingPlaceholderBytes: await fileBytes(siblingPlaceholder),
			ownNativePlaceholderBytes: await fileBytes(ownNativePlaceholder),
			ownQuarantineBytes: await fileBytes(ownQuarantine),
		};
		const pass =
			removed &&
			!remaining.includes(filename) &&
			remaining.includes("0.tool.log") &&
			remaining.includes(path.basename(siblingQuarantine)) &&
			remaining.includes(path.basename(siblingPlaceholder)) &&
			(usesRetainedAuthority || !remaining.includes(path.basename(ownNativePlaceholder))) &&
			(usesRetainedAuthority || !remaining.includes(path.basename(ownQuarantine))) &&
			observed.siblingQuarantineBytes !== null &&
			observed.siblingPlaceholderBytes !== null &&
			observed.targetBytes === null;
		record(
			"gen8-cleanup-ownership-boundary",
			"AC13",
			rootCommand,
			observed,
			pass,
			"Owned cleanup residue was not removed, or a sibling .removing/native placeholder was cross-deleted by a substring match.",
		);
		expect(pass).toBe(true);
		await rm(root, { recursive: true, force: true });
	});

	it("CLEAN publication rollback retires a failed reserve block and preserves the original publication error", async () => {
		const root = await fs.realpath(await mkdtemp(path.join(tmpdir(), "autorouting-gen8-publication-retire-")));
		const parentDir = path.join(root, "parent");
		const parent = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), parentDir));
		await parent.save("sibling", "tool");
		const staged = parent.createAttemptStaging("gen8-publication-retire");
		await staged.save("first", "tool");
		await staged.save("second", "tool");
		const parentStore = parent.getManagedStore();
		if (!parentStore) throw new Error("managed parent store unavailable");
		const publicationError = new Error("gen8-publication-failure");
		const removalAttempts: string[] = [];
		let publishCalls = 0;
		const realPublish = parentStore.publishNoReplace.bind(parentStore);
		const publishSpy = vi.spyOn(parentStore, "publishNoReplace").mockImplementation(async (filename, bytes) => {
			publishCalls++;
			if (publishCalls === 2) throw publicationError;
			await realPublish(filename, bytes);
		});
		const removeSpy = vi.spyOn(parent, "removeNamedBestEffort").mockImplementation(async filename => {
			removalAttempts.push(filename);
			return false;
		});
		let failure: unknown;
		try {
			await parent.commitAttemptStaging(staged, "gen8-publication-retire");
		} catch (error) {
			failure = error;
		} finally {
			publishSpy.mockRestore();
			removeSpy.mockRestore();
		}
		await staged.discardAttemptStaging();
		const errors = failure instanceof AggregateError ? failure.errors : [];
		const nextIds = [parent.allocateId(), parent.allocateId()];
		const observed = {
			failure: failure instanceof Error ? { name: failure.name, message: failure.message } : String(failure),
			errors: errors.map(error => (error instanceof Error ? error.message : String(error))),
			originalErrorPreserved: errors[0] === publicationError,
			publishCalls,
			removalAttempts,
			leakedFirst: await parent.exists("1"),
			leakedSecond: await parent.exists("2"),
			nextIds,
			allocatedIds: parent.getAllocatedIds(),
		};
		const pass =
			failure instanceof AggregateError &&
			errors.length >= 2 &&
			errors[0] === publicationError &&
			errors.some(error => String(error).includes("1.tool.log")) &&
			publishCalls === 2 &&
			removalAttempts.length === 1 &&
			removalAttempts[0] === "1.tool.log" &&
			observed.leakedFirst &&
			!observed.leakedSecond &&
			JSON.stringify(nextIds) === JSON.stringify([3, 4]) &&
			!nextIds.includes(1) &&
			!nextIds.includes(2);
		record(
			"gen8-publication-rollback-retires-reserve-block",
			"AC13",
			rootCommand,
			observed,
			pass,
			"A failed publication rollback hid the original error, rewound a block containing a leaked artifact, or reallocated a retired ID.",
		);
		expect(pass).toBe(true);
		await rm(root, { recursive: true, force: true });
	});

	it("CLEAN rollbackLastAttemptCommit retires failed removals while a successful rollback still rewinds the tail", async () => {
		const root = await fs.realpath(await mkdtemp(path.join(tmpdir(), "autorouting-gen8-rollback-retire-")));
		const parentDir = path.join(root, "parent");
		const parent = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), parentDir));
		await parent.save("sibling", "tool");
		const staged = parent.createAttemptStaging("gen8-rollback-retire");
		await staged.save("first", "tool");
		await staged.save("second", "tool");
		const mapping = await parent.commitAttemptStaging(staged, "gen8-rollback-retire");
		const removalAttempts: string[] = [];
		const removeSpy = vi.spyOn(parent, "removeNamedBestEffort").mockImplementation(async filename => {
			removalAttempts.push(filename);
			return false;
		});
		let rollbackFailure: unknown;
		try {
			await parent.rollbackLastAttemptCommit("gen8-rollback-retire");
		} catch (error) {
			rollbackFailure = error;
		} finally {
			removeSpy.mockRestore();
		}
		const nextIds = [parent.allocateId(), parent.allocateId()];

		const successRoot = await fs.realpath(await mkdtemp(path.join(tmpdir(), "autorouting-gen8-rollback-success-")));
		const successDir = path.join(successRoot, "parent");
		const successParent = new ArtifactManager(
			new ManagedSessionDescendantStore(managedDirectoryRoot(successRoot), successDir),
		);
		await successParent.save("sibling", "tool");
		const successStaged = successParent.createAttemptStaging("gen8-rollback-success");
		await successStaged.save("candidate", "tool");
		const successMapping = await successParent.commitAttemptStaging(successStaged, "gen8-rollback-success");
		await successParent.rollbackLastAttemptCommit("gen8-rollback-success");
		const rewoundId = successParent.allocateId();
		const successPublishedId = successMapping.get("0") ?? "missing";
		const observed = {
			mapping: [...mapping.entries()],
			rollbackFailure:
				rollbackFailure instanceof Error
					? { name: rollbackFailure.name, message: rollbackFailure.message }
					: String(rollbackFailure),
			removalAttempts,
			leakedIds: {
				one: await parent.exists("1"),
				two: await parent.exists("2"),
			},
			nextIds,
			successMapping: [...successMapping.entries()],
			rewoundId,
			successPublishedId,
			successPublishedStillExists: await successParent.exists(successPublishedId),
		};
		const pass =
			rollbackFailure instanceof Error &&
			rollbackFailure.message.includes("1.tool.log") &&
			removalAttempts.length === 2 &&
			new Set(removalAttempts).size === 2 &&
			observed.leakedIds.one &&
			observed.leakedIds.two &&
			JSON.stringify(nextIds) === JSON.stringify([3, 4]) &&
			successMapping.get("0") === "1" &&
			rewoundId === 1 &&
			!observed.successPublishedStillExists;
		record(
			"gen8-rollback-last-attempt-retirement-and-tail-rewind",
			"AC13",
			rootCommand,
			observed,
			pass,
			"rollbackLastAttemptCommit failed to retire the reserved block, reused leaked IDs, or stopped rewinding a fully successful tail rollback.",
		);
		expect(pass).toBe(true);
		await rm(root, { recursive: true, force: true });
		await rm(successRoot, { recursive: true, force: true });
	});

	it("C9 the live routed selector reaches session creation byte-exact, unaffected by evidence bounding", async () => {
		// boundedSelector (NFKC-normalize, strip control chars, truncate to 256) exists to bound
		// text that is rendered or persisted as evidence/telemetry. It must never be applied to the
		// selector actually used to resolve and execute the model: candidates were already validated
		// against the live snapshot by normalizeTierSelector, so re-transforming the live selector
		// could compose characters differently or truncate a long-but-valid id, sending execution to
		// a model that never passed preflight. Use an id long enough that boundedSelector's 256-char
		// cap would corrupt it if applied to the live selector, and confirm the exact byte-for-byte
		// selector reaches createAgentSession's resolved model.
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen9-live-selector-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const longId = `over-256-chars-${"x".repeat(280)}`;
		const longSelector = `test/${longId}`;
		const models = [
			model("test", longId, true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		];
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => "key");
		const originalCreate = sdkModule.createAgentSession;
		let capturedModelId: string | undefined;
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedModelId = options?.model?.id;
			const result = await originalCreate(options);
			vi.spyOn(result.session, "prompt").mockImplementation(async (_message, promptOptions) => {
				if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
				else promptOptions?.onPreflightAccepted?.();
				result.session.agent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: "gen9-yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: {} } },
					isError: false,
				} as never);
			});
			vi.spyOn(result.session, "waitForIdle").mockResolvedValue(undefined);
			return result;
		});
		let result: Awaited<ReturnType<typeof runSubprocess>> | undefined;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen9 live selector",
				assignment: "gen9 live selector",
				index: 0,
				id: "gen9-live-selector",
				modelOverride: [longSelector],
				settings: Settings.isolated(),
				modelRegistry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: [longSelector],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					// The evidence-side requestedSelector/effectiveModel are legitimately bounded to
					// <=256 chars by assertRoutingEvidenceInvariant; that bounding is correct and not
					// under test here. Only the *live* selector must reach execution untransformed.
					requestedSelector: "test/short-placeholder",
					effectiveModel: "test/short-placeholder",
					substitutions: [],
				},
				sessionFile: finalPath,
			});
		} finally {
			createSpy.mockRestore();
			authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
		const observed = {
			capturedModelId,
			expectedModelId: longId,
			capturedModelIdLength: capturedModelId?.length,
			exitCode: result?.exitCode,
			preflightFenceCrossed: result?.preflightFenceCrossed,
			attempts: result?.routing?.attempts,
		};
		const pass =
			capturedModelId === longId &&
			(capturedModelId?.length ?? 0) > 256 &&
			result?.exitCode === 0 &&
			result?.preflightFenceCrossed === true;
		record(
			"gen9-c9-live-selector-untransformed",
			"AC13",
			rootCommand,
			observed,
			pass,
			"The live routed selector was truncated or otherwise transformed by evidence-bounding logic before reaching session creation, causing execution to diverge from the preflight-validated candidate.",
		);
		expect(pass).toBe(true);
	});
});

describe("autorouting boundary red-team generation 10 delta re-attacks", () => {
	it("parentArtifactManager alone never claims durable staged publication without managedPersistence or a session file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen10-parent-only-"));
		const parentArtifacts = new ArtifactManager(path.join(root, "parent"));
		await parentArtifacts.save("sibling", "tool");
		const models = [
			model("test", "candidate", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		];
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => "key");
		const originalCreate = sdkModule.createAgentSession;
		const durableSessionFiles: Array<string | undefined> = [];
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			durableSessionFiles.push(options?.sessionManager?.getSessionFile());
			const result = await originalCreate(options);
			vi.spyOn(result.session, "prompt").mockImplementation(async (_message, promptOptions) => {
				if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
				else promptOptions?.onPreflightAccepted?.();
				result.session.agent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: "gen10-parent-only-yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: {} } },
					isError: false,
				} as never);
			});
			vi.spyOn(result.session, "waitForIdle").mockResolvedValue(undefined);
			return result;
		});
		let openStagedCalls = 0;
		const openStagedSpy = vi.spyOn(SessionManager, "openStaged").mockImplementation(async () => {
			openStagedCalls++;
			throw new Error("durable staged session opened without managedPersistence or an explicit session file");
		});
		let commitStagedCalls = 0;
		const commitStagedSpy = vi.spyOn(SessionManager.prototype, "commitStaged").mockImplementation(async function (
			this: SessionManager,
		) {
			commitStagedCalls++;
			throw new Error("durable staged publication committed without managedPersistence or an explicit session file");
		});
		let result: SingleResult | undefined;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen10 parent-only durable authority",
				assignment: "gen10 parent-only durable authority",
				index: 0,
				id: "gen10-parent-only",
				modelOverride: ["test/candidate"],
				settings: Settings.isolated(),
				modelRegistry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/candidate"],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					requestedSelector: "test/candidate",
					effectiveModel: "test/candidate",
					substitutions: [],
				},
				// The ONLY durable-authority signal is the shared artifact manager. Without a
				// managedPersistence store or an explicit sessionFile, this must not grant durable
				// staged-publication authority: the accepted candidate uses the artifact-only path.
				parentArtifactManager: parentArtifacts,
				managedPersistence: undefined,
				sessionFile: undefined,
				artifactsDir: undefined,
			});
		} finally {
			commitStagedSpy.mockRestore();
			openStagedSpy.mockRestore();
			createSpy.mockRestore();
			authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
		const observed = {
			openStagedCalls,
			commitStagedCalls,
			durableSessionFiles,
			attempts: result?.routing?.attempts,
			exitCode: result?.exitCode,
			preflightFenceCrossed: result?.preflightFenceCrossed,
		};
		const pass =
			openStagedCalls === 0 &&
			commitStagedCalls === 0 &&
			durableSessionFiles.length === 2 &&
			durableSessionFiles.every(file => file === undefined) &&
			JSON.stringify(result?.routing?.attempts) ===
				JSON.stringify([
					{ selector: "test/candidate", phase: "probe", code: "probe_passed" },
					{ selector: "test/candidate", phase: "durable", code: "accepted" },
				]) &&
			result?.exitCode === 0 &&
			result?.preflightFenceCrossed === true;
		record(
			"gen10-parent-only-no-durable-claim",
			"AC13",
			rootCommand,
			observed,
			pass,
			"parentArtifactManager alone granted durable staged-publication authority: `openStaged`/`commitStaged` ran even though no managedPersistence or explicit sessionFile existed.",
		);
		expect(pass).toBe(true);
	});

	it("disposable preflight probes never run user/session extensions", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "autorouting-gen10-ext-probe-"));
		const finalPath = path.join(root, "candidate.jsonl");
		const models = [
			model("test", "candidate", true, {
				headers: {},
				compat: {},
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			}),
		];
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(models);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async () => "key");
		// The runner the executor's extension seam would drive on a live run; its methods only
		// record, so a probe that (incorrectly) ran extensions would push the counts above zero.
		const runner = {
			initialize: vi.fn(),
			onError: vi.fn(),
			emit: vi.fn(),
			hasHandlers: vi.fn(() => false),
		};
		const originalCreate = sdkModule.createAgentSession;
		let createCalls = 0;
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			createCalls++;
			const result = await originalCreate(options);
			// Shadow the public getter for the executor's extension seam only; session internals
			// keep using their real #extensionRunner private field and are out of scope here.
			Object.defineProperty(result.session, "extensionRunner", {
				value: runner,
				configurable: true,
			});
			vi.spyOn(result.session, "prompt").mockImplementation(async (_message, promptOptions) => {
				if (promptOptions?.onPreflightAcceptCommit) await promptOptions.onPreflightAcceptCommit();
				else promptOptions?.onPreflightAccepted?.();
				result.session.agent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: "gen10-ext-yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: {} } },
					isError: false,
				} as never);
			});
			vi.spyOn(result.session, "waitForIdle").mockResolvedValue(undefined);
			return result;
		});
		let result: SingleResult | undefined;
		try {
			result = await runSubprocess({
				cwd: root,
				agent: taskAgent,
				task: "gen10 probe never runs extensions",
				assignment: "gen10 probe never runs extensions",
				index: 0,
				id: "gen10-ext-probe",
				modelOverride: ["test/candidate"],
				settings: Settings.isolated(),
				modelRegistry,
				runMode: "initial",
				autoroutingPreflight: true,
				autoroutingCandidates: ["test/candidate"],
				autoroutingSkips: [],
				routing: {
					tier: "fast",
					requestedSelector: "test/candidate",
					effectiveModel: "test/candidate",
					substitutions: [],
				},
				sessionFile: finalPath,
			});
		} finally {
			createSpy.mockRestore();
			authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
		const sessionStartEmits = runner.emit.mock.calls.filter(
			args => (args[0] as { type?: string } | undefined)?.type === "session_start",
		).length;
		const observed = {
			createCalls,
			runnerInitializeCalls: runner.initialize.mock.calls.length,
			runnerSessionStartEmits: sessionStartEmits,
			exitCode: result?.exitCode,
			preflightFenceCrossed: result?.preflightFenceCrossed,
		};
		const pass =
			createCalls === 2 &&
			runner.initialize.mock.calls.length === 1 &&
			sessionStartEmits === 1 &&
			result?.exitCode === 0 &&
			result?.preflightFenceCrossed === true;
		record(
			"gen10-probe-no-extensions",
			"AC13",
			rootCommand,
			observed,
			pass,
			"A disposable preflight probe ran user/session extensions: the runner was initialize()d or received a session_start emit on the probe leg; only the accepted durable leg may.",
		);
		expect(pass).toBe(true);
	});
});
