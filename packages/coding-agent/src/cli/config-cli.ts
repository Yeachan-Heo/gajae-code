/**
 * Config CLI command handlers.
 *
 * Handles `gjc config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, getAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import chalk from "chalk";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
	Settings,
	type SettingValue,
	settings,
} from "../config/settings";
import { theme } from "../modes/theme/theme";
import { initXdg } from "./commands/init-xdg";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg" | "doctor";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
		showSecrets?: boolean;
	};
}
// =============================================================================
// Setting Filtering
// =============================================================================

type CliSettingDef = {
	path: SettingPath;
	type: string;
	description: string;
	tab: string;
};

const ALL_SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
const REDACTED_SECRET_VALUE = "<redacted>";
const SECRET_SETTING_WORDS = new Set(["token", "secret", "password", "passwd", "pwd", "credential", "credentials"]);
const SECRET_SETTING_COMPOUND_PREFIXES = [
	"api",
	"auth",
	"access",
	"refresh",
	"bearer",
	"session",
	"client",
	"broker",
	"bot",
	"basic",
];
const SECRET_SETTING_COMPOUND_SUFFIXES = ["token", "secret", "password", "credential"];

function isSecretSettingSegment(segment: string): boolean {
	const normalized = segment.toLowerCase();
	if (SECRET_SETTING_WORDS.has(normalized)) return true;
	if (/api[-_]?key/i.test(segment)) return true;
	const words = normalized.split(/[-_]/).filter(Boolean);
	if (words.some(word => SECRET_SETTING_WORDS.has(word))) return true;
	return SECRET_SETTING_COMPOUND_PREFIXES.some(prefix =>
		SECRET_SETTING_COMPOUND_SUFFIXES.some(suffix => normalized === `${prefix}${suffix}`),
	);
}

function isSecretSettingPath(path: string): boolean {
	return path.split(".").some(segment => isSecretSettingSegment(segment));
}

function redactConfigValue(path: string, value: unknown, showSecrets?: boolean): unknown {
	if (showSecrets || value === undefined || value === null || !isSecretSettingPath(path)) {
		return value;
	}
	return REDACTED_SECRET_VALUE;
}

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const key = path as SettingPath;
	const ui = getUi(key);
	return {
		path: key,
		type: getType(key),
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
	};
}

/** Get available values for a setting */
function getSettingValues(def: CliSettingDef): readonly string[] | undefined {
	if (def.type === "enum") {
		return getEnumValues(def.path);
	}
	return undefined;
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "doctor"];

/**
 * Parse config subcommand arguments.
 * Returns undefined if not a config command.
 */
export function parseConfigArgs(args: string[]): ConfigCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "config") {
		return undefined;
	}

	if (args.length < 2 || args[1] === "--help" || args[1] === "-h") {
		return { action: "list", flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as ConfigAction)) {
		console.error(chalk.red(`Unknown config command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: ConfigCommandArgs = {
		action: action as ConfigAction,
		flags: {},
	};

	const positionalArgs: string[] = [];
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--show-secrets") {
			result.flags.showSecrets = true;
		} else if (!arg.startsWith("-")) {
			positionalArgs.push(arg);
		}
	}

	if (positionalArgs.length > 0) {
		result.key = positionalArgs[0];
	}
	if (positionalArgs.length > 1) {
		result.value = positionalArgs.slice(1).join(" ");
	}

	return result;
}

// =============================================================================
// Value Formatting
// =============================================================================

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = getSettingValues(def);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Schema-Driven Value Parsing
// =============================================================================

function parseAndSetValue(path: SettingPath, rawValue: string): void {
	const schemaType = getType(path);
	let parsedValue: unknown;

	const trimmed = rawValue.trim();
	switch (schemaType) {
		case "boolean": {
			const lower = trimmed.toLowerCase();
			if (["true", "1", "yes", "on"].includes(lower)) parsedValue = true;
			else if (["false", "0", "no", "off"].includes(lower)) parsedValue = false;
			else throw new Error(`Invalid boolean value: ${rawValue}. Use true/false, yes/no, on/off, or 1/0`);
			break;
		}
		case "number": {
			parsedValue = Number(trimmed);
			if (!Number.isFinite(parsedValue)) throw new Error(`Invalid number: ${rawValue}`);
			const validate =
				"validate" in SETTINGS_SCHEMA[path]
					? (SETTINGS_SCHEMA[path].validate as ((value: number) => boolean) | undefined)
					: undefined;
			if (validate?.(parsedValue as number) === false) {
				throw new Error(`Invalid number for ${path}: ${rawValue}`);
			}
			break;
		}
		case "enum": {
			const valid = getEnumValues(path);
			if (valid && !valid.includes(trimmed)) {
				throw new Error(`Invalid value: ${rawValue}. Valid values: ${valid.join(", ")}`);
			}
			parsedValue = trimmed;
			break;
		}
		case "array": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		case "record": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		default:
			parsedValue = trimmed;
	}

	settings.set(path, parsedValue as SettingValue<typeof path>);
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	await Settings.init();

	switch (cmd.action) {
		case "list":
			handleList(cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
		case "doctor":
			await handleDoctor(cmd.flags);
			break;
	}
}

function handleList(flags: { json?: boolean; showSecrets?: boolean }): void {
	const defs = ALL_SETTING_PATHS.map(path => findSettingDef(path)).filter((def): def is CliSettingDef => !!def);

	if (flags.json) {
		const result: Record<string, { value: unknown; type: string; description: string }> = {};
		for (const def of defs) {
			const value = settings.get(def.path);
			result[def.path] = {
				value: redactConfigValue(def.path, value, flags.showSecrets),
				type: def.type,
				description: def.description,
			};
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			const value = settings.get(def.path);
			const displayValue = redactConfigValue(def.path, value, flags.showSecrets);
			const valueStr = formatValue(displayValue);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean; showSecrets?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const value = settings.get(def.path);
	const displayValue = redactConfigValue(def.path, value, flags.showSecrets);

	if (flags.json) {
		console.log(
			JSON.stringify({ key: def.path, value: displayValue, type: def.type, description: def.description }, null, 2),
		);
		return;
	}

	console.log(formatValue(displayValue));
}

async function handleSet(
	key: string | undefined,
	value: string | undefined,
	flags: { json?: boolean; showSecrets?: boolean },
): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	try {
		parseAndSetValue(def.path, value);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	const newValue = settings.get(def.path);
	const displayValue = redactConfigValue(def.path, newValue, flags.showSecrets);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: displayValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.path} = ${formatValue(displayValue)}`));
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const path = def.path as SettingPath;
	const defaultValue = getDefault(path);
	if (defaultValue === undefined) settings.unset(path);
	else settings.set(path, defaultValue as SettingValue<typeof path>);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: defaultValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Reset ${def.path} to ${formatValue(defaultValue)}`));
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}

type ConfigDoctorReport = {
	unknownKeys: string[];
	invalidValues: Array<{ path: string; value: unknown }>;
	legacyShapes: string[];
};

function flattenConfig(value: unknown, prefix = ""): Array<[string, unknown]> {
	if (prefix && ALL_SETTING_PATHS.includes(prefix as SettingPath)) return [[prefix, value]];
	if (value === null || typeof value !== "object" || Array.isArray(value)) return prefix ? [[prefix, value]] : [];
	return Object.entries(value).flatMap(([key, child]) => flattenConfig(child, prefix ? `${prefix}.${key}` : key));
}

function matchesSettingType(path: SettingPath, value: unknown): boolean {
	const definition = SETTINGS_SCHEMA[path];
	switch (definition.type) {
		case "string":
		case "enum":
			return (
				typeof value === "string" && (definition.type !== "enum" || getEnumValues(path)?.includes(value) === true)
			);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "record":
			return value !== null && typeof value === "object" && !Array.isArray(value);
	}
}

function isValidSettingValue(path: SettingPath, value: unknown): boolean {
	if (!matchesSettingType(path, value)) return false;
	const validate = (SETTINGS_SCHEMA[path] as { validate?: (value: unknown) => boolean }).validate;
	return validate?.(value) ?? true;
}

export async function inspectConfigFile(
	configPath = path.join(getAgentDir(), "config.yml"),
): Promise<ConfigDoctorReport> {
	const report: ConfigDoctorReport = { unknownKeys: [], invalidValues: [], legacyShapes: [] };
	try {
		const raw = YAML.parse(await fs.readFile(configPath, "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			report.legacyShapes.push("config root is not a mapping");
			return report;
		}
		for (const [settingPath, value] of flattenConfig(raw)) {
			if (!ALL_SETTING_PATHS.includes(settingPath as SettingPath)) report.unknownKeys.push(settingPath);
			else if (!isValidSettingValue(settingPath as SettingPath, value))
				report.invalidValues.push({ path: settingPath, value: redactConfigValue(settingPath, value) });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			report.legacyShapes.push(`unable to parse config: ${String(error)}`);
	}
	return report;
}

async function handleDoctor(flags: { json?: boolean }): Promise<void> {
	const report = await inspectConfigFile();
	if (flags.json) console.log(JSON.stringify(report, null, 2));
	else {
		console.log(`Unknown keys: ${report.unknownKeys.length ? report.unknownKeys.join(", ") : "none"}`);
		console.log(
			`Invalid values: ${report.invalidValues.length ? report.invalidValues.map(item => item.path).join(", ") : "none"}`,
		);
		console.log(`Legacy shapes: ${report.legacyShapes.length ? report.legacyShapes.join(", ") : "none"}`);
	}
}

// =============================================================================
// Help
// =============================================================================

export function printConfigHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} config`)} - Manage settings

${chalk.bold("Commands:")}
  list               List all settings with current values
  get <key>          Get a specific setting value
  set <key> <value>  Set a setting value
  reset <key>        Reset a setting to its default value
  path               Print the config directory path
  init-xdg           Initialize XDG Base Directory structure
  doctor             Report unknown, invalid, and legacy config entries

${chalk.bold("Options:")}
  --json             Output as JSON
  --show-secrets     Show secret-like setting values without redaction (unsafe)

${chalk.bold("Examples:")}
  ${APP_NAME} config list
  ${APP_NAME} config get theme
  ${APP_NAME} config set theme catppuccin-mocha
  ${APP_NAME} config set compaction.enabled false
  ${APP_NAME} config set defaultThinkingLevel medium
  ${APP_NAME} config reset steeringMode
  ${APP_NAME} config list --json
  ${APP_NAME} config get auth.broker.token --show-secrets
  ${APP_NAME} config init-xdg
  ${APP_NAME} config doctor --json

${chalk.bold("Boolean Values:")}
  true, false, yes, no, on, off, 1, 0
`);
}
