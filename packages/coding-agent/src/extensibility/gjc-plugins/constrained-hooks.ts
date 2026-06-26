import { logger } from "@gajae-code/utils";

import { loadEffectiveGjcPluginRegistry } from "./registry";
import { type SessionQuarantine, validateSessionBundles, verifyEntryHashes } from "./session-validation";
import { GjcPluginLoadError, type GjcPluginRegistryEntry } from "./types";

/**
 * Constrained plugin-hook loader.
 *
 * Third-party plugin hooks are NOT given the broad first-party HookAPI. They
 * receive a restricted API that can only register a handler for their declared
 * event; every session-mutation / command / shell capability throws
 * security_policy. After the factory runs we verify it registered exactly the
 * declared event (and nothing else), or the hook is quarantined.
 */

export interface ConstrainedPluginHook {
	plugin: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	handler: (...args: any[]) => unknown;
}

export interface ConstrainedHookLoadResult {
	hooks: ConstrainedPluginHook[];
	quarantine: SessionQuarantine[];
}

const DENIED_API_METHODS = [
	"sendMessage",
	"appendEntry",
	"registerMessageRenderer",
	"registerCommand",
	"exec",
] as const;

interface DeclaredHook {
	plugin: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
}

function collectDeclaredHooks(entries: readonly GjcPluginRegistryEntry[]): DeclaredHook[] {
	const out: DeclaredHook[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const h of entry.surfaces.hooks) {
			if (disabled.has(h.extensionId)) continue;
			out.push({
				plugin: entry.name,
				event: h.event,
				target: h.target,
				phase: h.phase,
				relativePath: `${entry.pluginRoot}/${h.relativePath}`,
			});
		}
	}
	return out;
}

async function loadOneHook(
	declared: DeclaredHook,
): Promise<{ hook: ConstrainedPluginHook | null; quarantine: SessionQuarantine | null }> {
	const registered: { event: string; handler: (...a: any[]) => unknown }[] = [];
	const deny = (method: string) => () => {
		throw new GjcPluginLoadError(
			"security_policy",
			`Plugin hook "${declared.plugin}" attempted denied API: ${method}`,
		);
	};
	const constrainedApi: Record<string, unknown> = {
		on(event: string, handler: (...a: any[]) => unknown): void {
			registered.push({ event, handler });
		},
		logger,
	};
	for (const method of DENIED_API_METHODS) constrainedApi[method] = deny(method);

	let factory: unknown;
	try {
		const mod = await import(declared.relativePath);
		factory = mod.default ?? mod;
	} catch (error) {
		return {
			hook: null,
			quarantine: {
				plugin: declared.plugin,
				surfaceId: `hook:${declared.event}:${declared.target ?? ""}`,
				code: "invalid_hook",
				message: `Failed to import plugin hook: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
	if (typeof factory !== "function") {
		return {
			hook: null,
			quarantine: {
				plugin: declared.plugin,
				surfaceId: `hook:${declared.event}`,
				code: "invalid_hook",
				message: "Plugin hook must export a default function",
			},
		};
	}
	try {
		await (factory as (api: unknown) => unknown)(constrainedApi);
	} catch (error) {
		const code = error instanceof GjcPluginLoadError ? error.code : "security_policy";
		return {
			hook: null,
			quarantine: {
				plugin: declared.plugin,
				surfaceId: `hook:${declared.event}`,
				code,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	// Exactly one handler, for the declared event only.
	if (registered.length !== 1 || registered[0]?.event !== declared.event) {
		return {
			hook: null,
			quarantine: {
				plugin: declared.plugin,
				surfaceId: `hook:${declared.event}`,
				code: "runtime_mismatch",
				message: `Plugin hook registered ${JSON.stringify(registered.map(r => r.event))}, expected exactly ["${declared.event}"]`,
			},
		};
	}
	return {
		hook: {
			plugin: declared.plugin,
			event: declared.event,
			target: declared.target,
			phase: declared.phase,
			handler: registered[0].handler,
		},
		quarantine: null,
	};
}

/**
 * Load all always-on constrained plugin hooks for the effective registry at
 * `cwd`, applying hash-drift + collision quarantine first. Returns empty when
 * no plugins are installed.
 */
export async function loadConstrainedPluginHooks(input: { cwd: string }): Promise<ConstrainedHookLoadResult> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return { hooks: [], quarantine: [] };
	const preQuarantine: SessionQuarantine[] = [];
	for (const entry of effective) {
		if (!entry.enabled) continue;
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
	}
	const { active, quarantine } = validateSessionBundles(effective, {}, preQuarantine);
	const declared = collectDeclaredHooks(active);
	const hooks: ConstrainedPluginHook[] = [];
	for (const d of declared) {
		const { hook, quarantine: q } = await loadOneHook(d);
		if (hook) hooks.push(hook);
		if (q) quarantine.push(q);
	}
	return { hooks, quarantine };
}
