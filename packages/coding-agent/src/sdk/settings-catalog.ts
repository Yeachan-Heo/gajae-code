import type { Settings, SettingsLayer, SettingsPathResolution } from "../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getUi,
	SETTINGS_SCHEMA,
	type SettingApplication,
	type SettingDef,
	type SettingPath,
	type SubmenuOption,
} from "../config/settings-schema";

import { isSecretConfigKey } from "./protocol/adapter-validation";

export type { SettingsLayer, SettingsPathResolution } from "../config/settings";

export type CatalogValue =
	| { status: "available"; value: boolean | number | string }
	| { status: "absent" }
	| { status: "withheld"; reason: "sensitive-path" | "free-form" | "structured" | "invalid" };

export interface SettingCatalogItem {
	path: SettingPath;
	type: SettingDef["type"];
	defaultValue: CatalogValue;
	effectiveValue: CatalogValue;
	resolution: SettingsPathResolution;
	/** Raw schema UI metadata, not a claim that a terminal-specific row is visible. */
	ui?: AnyUiMetadata;
	choices:
		| { source: "schema"; options: SubmenuOption[] }
		| { source: "runtime"; status: "host-required" }
		| { source: "none" };
	application: SettingApplication | { kind: "unclassified" };
	mutation: {
		/** This query never installs a writer or grants mutation authority. */
		provided: false;
		allowedLayers: SettingsLayer[];
		/** Schema-declared editor ownership must be respected by a host. */
		owner: "notification-atomic" | "unspecified";
	};
}

export interface SettingsCatalog {
	version: 1;
	/** Storage capability, not proof that an individual value has been flushed. */
	durableStorage: boolean;
	items: SettingCatalogItem[];
}

interface CatalogDefinition {
	type: SettingDef["type"];
	application?: SettingApplication;
	values?: readonly string[];
}

/**
 * Fail closed for arbitrary text and compound configuration: even innocent keys
 * can contain endpoint userinfo, headers, shell snippets or nested credentials.
 * Only schema-constrained scalar values cross this display boundary.
 */
function displayValue(path: SettingPath, definition: CatalogDefinition, value: unknown): CatalogValue {
	if (isSecretConfigKey(path)) return { status: "withheld", reason: "sensitive-path" };
	if (definition.type === "string") return { status: "withheld", reason: "free-form" };
	if (definition.type === "boolean") {
		if (value === undefined) return { status: "absent" };
		return typeof value === "boolean" ? { status: "available", value } : { status: "withheld", reason: "invalid" };
	}
	if (definition.type === "number") {
		return typeof value === "number" && Number.isFinite(value)
			? { status: "available", value }
			: { status: "withheld", reason: "invalid" };
	}
	if (definition.type === "enum") {
		return typeof value === "string" && definition.values?.includes(value)
			? { status: "available", value }
			: { status: "withheld", reason: "invalid" };
	}
	return { status: "withheld", reason: "structured" };
}

function choices(definition: CatalogDefinition, ui: AnyUiMetadata | undefined): SettingCatalogItem["choices"] {
	if (ui?.options === "runtime") return { source: "runtime", status: "host-required" };
	if (Array.isArray(ui?.options)) return { source: "schema", options: structuredClone([...ui.options]) };
	if (definition.type === "enum") {
		return { source: "schema", options: (definition.values ?? []).map(value => ({ value, label: value })) };
	}
	return { source: "none" };
}

/**
 * Read-only, detached schema/value snapshot for trusted embedding hosts.
 * No filesystem paths, raw free-form values, credentials or callbacks are
 * included. Runtime choices and unclassified application semantics remain
 * explicit gaps; this is not an exhaustive TUI or managed-operation inventory.
 */
export function getSettingsCatalog(settings: Settings): SettingsCatalog {
	const resolutions = settings.getResolutionSnapshot();
	const items: SettingCatalogItem[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const definition: CatalogDefinition = SETTINGS_SCHEMA[path];
		const ui = getUi(path);
		const resolution = resolutions[path];
		items.push({
			path,
			type: definition.type,
			defaultValue: displayValue(path, definition, getDefault(path)),
			effectiveValue: displayValue(path, definition, settings.get(path)),
			resolution,
			...(ui ? { ui: structuredClone(ui) } : {}),
			choices: choices(definition, ui),
			application: definition.application ? structuredClone(definition.application) : { kind: "unclassified" },
			mutation: {
				provided: false,
				allowedLayers: [...resolution.allowedLayers],
				owner: ui?.editing ?? "unspecified",
			},
		});
	}
	return { version: 1, durableStorage: settings.canPersistDurableConfig(), items };
}
