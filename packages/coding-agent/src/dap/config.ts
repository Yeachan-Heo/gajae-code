import * as path from "node:path";
import { isRecord } from "@gajae-code/utils";
import { hasRootMarkers, resolveTrustedCommand } from "../lsp/config";
import { isProjectControlledPath } from "../lsp/path-trust";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
	if (!isRecord(config)) return null;
	if (typeof config.command !== "string" || config.command.length === 0) return null;
	const connectMode = config.connectMode === "socket" ? ("socket" as const) : undefined;
	return {
		command: config.command,
		args: normalizeStringArray(config.args),
		languages: normalizeStringArray(config.languages),
		fileTypes: normalizeStringArray(config.fileTypes).map(entry => entry.toLowerCase()),
		rootMarkers: normalizeStringArray(config.rootMarkers),
		launchDefaults: normalizeObject(config.launchDefaults),
		attachDefaults: normalizeObject(config.attachDefaults),
		...(connectMode ? { connectMode } : {}),
	};
}

function getDefaults(): Record<string, DapAdapterConfig> {
	const adapters: Record<string, DapAdapterConfig> = {};
	for (const [name, config] of Object.entries(DEFAULTS)) {
		const normalized = normalizeAdapterConfig(config);
		if (normalized) {
			adapters[name] = normalized;
		}
	}
	return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

export function getAdapterConfigs(): Record<string, DapAdapterConfig> {
	return { ...DEFAULT_ADAPTERS };
}

/**
 * `trustCwds` are extra trust roots, such as the session workspace when the command
 * cwd is a different directory. A command controlled by any of them is refused.
 */
export function resolveAdapter(
	adapterName: string,
	cwd: string,
	trustCwds?: readonly string[],
): DapResolvedAdapter | null {
	const config = DEFAULT_ADAPTERS[adapterName];
	if (!config) return null;
	const resolvedCommand = resolveTrustedCommand(config.command, cwd);
	if (!resolvedCommand) return null;
	if (trustCwds?.some(root => isProjectControlledPath(resolvedCommand, root))) return null;
	return {
		name: adapterName,
		command: config.command,
		args: config.args ?? [],
		resolvedCommand,
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
		rootMarkers: config.rootMarkers ?? [],
		launchDefaults: config.launchDefaults ?? {},
		attachDefaults: config.attachDefaults ?? {},
		connectMode: config.connectMode ?? "stdio",
	};
}

export function getAvailableAdapters(cwd: string, trustCwds?: readonly string[]): DapResolvedAdapter[] {
	return Object.keys(DEFAULT_ADAPTERS)
		.map(name => resolveAdapter(name, cwd, trustCwds))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function getMatchingAdapters(program: string, cwd: string, trustCwds?: readonly string[]): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const available = getAvailableAdapters(cwd, trustCwds);
	if (!extension) {
		// For extensionless binaries, only consider native debuggers (gdb, lldb-dap)
		// or adapters that match by root markers. Don't silently fall back to
		// unrelated adapters like debugpy for a C binary.
		const nativeDebuggers: ReadonlySet<string> = new Set(EXTENSIONLESS_DEBUGGER_ORDER);
		return available.filter(
			adapter =>
				nativeDebuggers.has(adapter.name) ||
				(adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers)),
		);
	}
	const exactMatches = available.filter(adapter => adapter.fileTypes.includes(extension));
	if (exactMatches.length > 0) {
		return exactMatches;
	}
	return available;
}

function sortAdaptersForLaunch(program: string, cwd: string, adapters: DapResolvedAdapter[]): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const rootAware = adapters.map(adapter => ({
		adapter,
		hasExtensionMatch: extension.length > 0 && adapter.fileTypes.includes(extension),
		hasRootMatch: adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers),
	}));
	rootAware.sort((left, right) => {
		if (left.hasExtensionMatch !== right.hasExtensionMatch) {
			return left.hasExtensionMatch ? -1 : 1;
		}
		if (left.hasRootMatch !== right.hasRootMatch) {
			return left.hasRootMatch ? -1 : 1;
		}
		const leftDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const rightDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const normalizedLeftRank = leftDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : leftDebuggerRank;
		const normalizedRightRank = rightDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : rightDebuggerRank;
		if (normalizedLeftRank !== normalizedRightRank) {
			return normalizedLeftRank - normalizedRightRank;
		}
		return left.adapter.name.localeCompare(right.adapter.name);
	});
	return rootAware.map(entry => entry.adapter);
}

export function selectLaunchAdapter(
	program: string,
	cwd: string,
	adapterName?: string,
	trustCwds?: readonly string[],
): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd, trustCwds);
	}
	const matches = getMatchingAdapters(program, cwd, trustCwds);
	const sorted = sortAdaptersForLaunch(program, cwd, matches);
	return sorted[0] ?? null;
}

export function selectAttachAdapter(
	cwd: string,
	adapterName?: string,
	port?: number,
	trustCwds?: readonly string[],
): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd, trustCwds);
	}
	const available = getAvailableAdapters(cwd, trustCwds);
	if (port !== undefined) {
		const debugpy = available.find(adapter => adapter.name === "debugpy");
		if (debugpy) return debugpy;
	}
	for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
		const match = available.find(adapter => adapter.name === preferred);
		if (match) return match;
	}
	return available[0] ?? null;
}
