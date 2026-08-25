import type {
	GjcBundleSummary,
	GjcBundleSurfaceSummary,
	GjcRuntimeSnapshotState,
	GjcUpdatePreview,
} from "../../src/extensibility/gjc-plugins/types";

export interface GjcBundleSettingsFixture {
	bundles: GjcBundleSummary[];
	updatePreview: GjcUpdatePreview | null;
	runtime: GjcRuntimeSnapshotState;
}

interface GjcBundleSettingsState {
	id: string;
	description: string;
	fixture: GjcBundleSettingsFixture;
}

interface GjcBundleSettingsViewport {
	id: string;
	cols: number;
	rows: number;
}

interface GjcBundleSettingsVariant {
	id: string;
	stateId: string;
	viewportId: string;
	renderMode: "ascii-no-color" | "unicode-color";
}

interface GjcBundleSettingsEntry {
	entryId: string;
	stateId: string;
	viewportId: string;
	renderMode: "ascii-no-color" | "unicode-color";
}

const EMPTY_RUNTIME: GjcRuntimeSnapshotState = { status: "unavailable" };

function surface(extensionId: string, name: string, enabled = true, quarantined = false): GjcBundleSurfaceSummary {
	return {
		extensionId,
		kind: "tool",
		name,
		enabled,
		quarantined,
		...(quarantined ? { quarantineCode: "quarantined_surface" } : {}),
	};
}

function bundle(
	name = "catalog-tools",
	scope: "user" | "project" = "user",
	options: {
		description?: string;
		enabled?: boolean;
		quarantined?: boolean;
		surfaces?: GjcBundleSurfaceSummary[];
		updatable?: boolean;
	} = {},
): GjcBundleSummary {
	return {
		identity: { kind: "gjc-bundle", scope, name },
		version: "1.2.0",
		description: options.description ?? "Deterministic catalog bundle",
		enabled: options.enabled ?? true,
		source: {
			kind: options.updatable === false ? "path" : "git",
			display: "bundle-cache/catalog",
			resolvedAt: "2026-07-27T00:00:00.000Z",
			updatable: options.updatable ?? true,
			...(options.updatable === false ? { unsupportedReason: "Local copies cannot refresh." } : {}),
		},
		installedAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:00.000Z",
		manifestHash: "manifest-catalog-120",
		targetFingerprint: `${scope}-${name}-target`,
		surfaces: options.surfaces ?? [surface("tool:catalog", "catalog")],
		quarantined: options.quarantined ?? false,
	};
}

const STANDARD_BUNDLE = bundle();
const UPDATE_PREVIEW: GjcUpdatePreview = {
	identity: STANDARD_BUNDLE.identity,
	current: STANDARD_BUNDLE,
	candidateVersion: "1.3.0",
	candidateManifestHash: "manifest-catalog-130",
	addedSurfaceIds: ["tool:report"],
	removedSurfaceIds: [],
	retainedSurfaceIds: ["tool:catalog"],
	changed: true,
	token: {
		identity: STANDARD_BUNDLE.identity,
		agentDir: "",
		candidateFingerprint: "candidate-catalog-130",
		baselineFingerprint: "baseline-catalog-120",
		decisionContextFingerprint: "decision-catalog-120",
		reviewedAt: "2026-07-27T00:00:00.000Z",
	},
};
const CURRENT_RUNTIME: GjcRuntimeSnapshotState = {
	status: "current",
	snapshot: {
		generation: 7,
		findings: [
			{
				identity: STANDARD_BUNDLE.identity,
				surfaceId: "tool:catalog",
				code: "runtime_mismatch",
				message: "Runtime evidence is advisory.",
			},
		],
	},
};

function fixture(
	bundles: GjcBundleSummary[] = [STANDARD_BUNDLE],
	updatePreview: GjcUpdatePreview | null = null,
	runtime: GjcRuntimeSnapshotState = EMPTY_RUNTIME,
): GjcBundleSettingsFixture {
	return { bundles, updatePreview, runtime };
}

const MANY_SURFACES = Array.from({ length: 14 }, (_, index) =>
	surface(`tool:surface-${index + 1}`, `surface-${index + 1}`),
);

export const GJC_BUNDLE_SETTINGS_STATES = Object.freeze([
	{ id: "loading", description: "Bundle list is loading.", fixture: fixture() },
	{ id: "error", description: "A sanitized list error is visible.", fixture: fixture() },
	{ id: "retry", description: "A retry action is focused after an error.", fixture: fixture() },
	{ id: "empty", description: "No bundles are installed.", fixture: fixture([]) },
	{
		id: "unsupported-source",
		description: "The selected bundle cannot refresh its source.",
		fixture: fixture([bundle("local-copy", "project", { updatable: false })]),
	},
	{ id: "list", description: "The installed bundle list is visible.", fixture: fixture() },
	{ id: "detail", description: "A scope-qualified bundle detail is visible.", fixture: fixture() },
	{
		id: "update-review",
		description: "An update preview is visible.",
		fixture: fixture([STANDARD_BUNDLE], UPDATE_PREVIEW),
	},
	{
		id: "update-confirm",
		description: "An update confirmation is focused.",
		fixture: fixture([STANDARD_BUNDLE], UPDATE_PREVIEW),
	},
	{
		id: "update-running",
		description: "A non-cancellable update is running.",
		fixture: fixture([STANDARD_BUNDLE], UPDATE_PREVIEW),
	},
	{
		id: "update-result",
		description: "A completed update result is visible.",
		fixture: fixture([bundle("catalog-tools", "user", { description: "Updated catalog bundle" })]),
	},
	{
		id: "stale-result",
		description: "A stale update result requires review again.",
		fixture: fixture([STANDARD_BUNDLE], UPDATE_PREVIEW),
	},
	{
		id: "toggle-bundle",
		description: "A bundle enablement change is focused.",
		fixture: fixture([bundle("catalog-tools", "user", { enabled: false })]),
	},
	{
		id: "toggle-surface",
		description: "A surface enablement change is focused.",
		fixture: fixture([bundle("catalog-tools", "user", { surfaces: [surface("tool:catalog", "catalog", false)] })]),
	},
	{
		id: "quarantined-blocked",
		description: "Quarantine blocks an enable action.",
		fixture: fixture([
			bundle("catalog-tools", "user", {
				quarantined: true,
				surfaces: [surface("tool:catalog", "catalog", false, true)],
			}),
		]),
	},
	{ id: "runtime-unavailable", description: "Runtime evidence is unavailable.", fixture: fixture() },
	{
		id: "runtime-current",
		description: "Current advisory runtime evidence is visible.",
		fixture: fixture([STANDARD_BUNDLE], null, CURRENT_RUNTIME),
	},
	{
		id: "dual-scope-same-name",
		description: "Same-name user and project bundles remain separate.",
		fixture: fixture([bundle("shared-name", "user"), bundle("shared-name", "project")]),
	},
	{
		id: "long-name-wrapping",
		description: "A long bundle name wraps without hiding its scope.",
		fixture: fixture([bundle("catalog-tools-with-a-deliberately-long-display-name", "project")]),
	},
	{
		id: "cjk",
		description: "Mixed CJK content wraps at semantic boundaries.",
		fixture: fixture([bundle("도구-카탈로그", "user", { description: "도구 목록과 更新の確認" })]),
	},
	{
		id: "many-surfaces-scroll",
		description: "A long surface list scrolls while retaining focus.",
		fixture: fixture([bundle("catalog-tools", "user", { surfaces: MANY_SURFACES })]),
	},
	{
		id: "mutation-in-flight-locked",
		description: "Navigation is locked during a non-cancellable mutation.",
		fixture: fixture([STANDARD_BUNDLE], UPDATE_PREVIEW),
	},
	{
		id: "invalidated-snapshot",
		description: "An invalidated runtime snapshot remains advisory.",
		fixture: fixture([STANDARD_BUNDLE], null, { status: "current", snapshot: { generation: 8, findings: [] } }),
	},
] satisfies GjcBundleSettingsState[]);

export const GJC_BUNDLE_SETTINGS_VIEWPORTS = Object.freeze([
	{ id: "80x24", cols: 80, rows: 24 },
	{ id: "120x36", cols: 120, rows: 36 },
	{ id: "160x48", cols: 160, rows: 48 },
] satisfies GjcBundleSettingsViewport[]);

export const GJC_BUNDLE_SETTINGS_VARIANTS = Object.freeze([
	{ id: "error-ascii", stateId: "error", viewportId: "80x24", renderMode: "ascii-no-color" },
	{ id: "detail-ascii", stateId: "detail", viewportId: "80x24", renderMode: "ascii-no-color" },
	{ id: "quarantined-ascii", stateId: "quarantined-blocked", viewportId: "120x36", renderMode: "ascii-no-color" },
	{ id: "runtime-ascii", stateId: "runtime-unavailable", viewportId: "80x24", renderMode: "ascii-no-color" },
	{ id: "dual-scope-ascii", stateId: "dual-scope-same-name", viewportId: "120x36", renderMode: "ascii-no-color" },
	{ id: "update-confirm-ascii", stateId: "update-confirm", viewportId: "80x24", renderMode: "ascii-no-color" },
	{ id: "cjk-narrow", stateId: "cjk", viewportId: "48x36", renderMode: "unicode-color" },
	{ id: "surfaces-narrow", stateId: "many-surfaces-scroll", viewportId: "48x36", renderMode: "unicode-color" },
] satisfies GjcBundleSettingsVariant[]);

export const GJC_BUNDLE_SETTINGS_ENTRIES = Object.freeze([
	...GJC_BUNDLE_SETTINGS_STATES.flatMap(state =>
		GJC_BUNDLE_SETTINGS_VIEWPORTS.map(viewport => ({
			entryId: `${state.id}/${viewport.id}/unicode-color`,
			stateId: state.id,
			viewportId: viewport.id,
			renderMode: "unicode-color" as const,
		})),
	),
	...GJC_BUNDLE_SETTINGS_VARIANTS.map(variant => ({
		entryId: `${variant.stateId}/${variant.viewportId}/${variant.renderMode}`,
		stateId: variant.stateId,
		viewportId: variant.viewportId,
		renderMode: variant.renderMode,
	})),
] satisfies GjcBundleSettingsEntry[]);
