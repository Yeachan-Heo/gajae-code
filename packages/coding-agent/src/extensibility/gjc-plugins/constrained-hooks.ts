import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { normalizePluginHook } from "../../hooks/normalize";
import { bundleIdentity } from "./lifecycle-reconciliation";
import { verifyImplementationHash } from "./metadata";
import type { ProfileAuthority } from "./paths";
import { resolveWithinRoot } from "./paths";
import { loadEffectiveGjcPluginRegistry } from "./registry";
import { type SessionQuarantine, validateSessionBundles, verifyEntryHashes } from "./session-validation";
import { GjcPluginLoadError, type GjcPluginRegistryEntry, type GjcPluginScope } from "./types";

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

async function resolveConstrainedHookFile(root: string, relativePath: string): Promise<string> {
	const lexical = resolveWithinRoot(root, relativePath);
	const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
	const rel = path.relative(rootReal, fileReal);
	if (rel.startsWith("..") || path.isAbsolute(rel))
		throw new GjcPluginLoadError("runtime_mismatch", `GJC plugin hook escapes its installed root: ${relativePath}`);
	return fileReal;
}

export interface DeclaredHook {
	plugin: string;
	scope: GjcPluginScope;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	implementationHash?: string;
}

async function collectDeclaredHooks(
	entries: readonly GjcPluginRegistryEntry[],
	invalidHookIds = new Set<string>(),
): Promise<DeclaredHook[]> {
	const out: DeclaredHook[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const h of entry.surfaces.hooks) {
			if (disabled.has(h.extensionId) || invalidHookIds.has(`${entry.scope}:${entry.name}:${h.extensionId}`))
				continue;
			const implementationPath = await resolveConstrainedHookFile(entry.pluginRoot, h.relativePath);
			out.push({
				plugin: entry.name,
				scope: entry.scope,
				event: h.event,
				target: h.target,
				phase: h.phase,
				relativePath: implementationPath,
				implementationHash:
					"implementationHash" in h && typeof h.implementationHash === "string" ? h.implementationHash : undefined,
			});
		}
	}
	return out;
}

/** Lazy declaration for one constrained hook. Importing this descriptor is metadata-only. */
export class ConstrainedPluginHookDescriptor {
	readonly plugin: string;
	readonly scope: GjcPluginScope;
	readonly event: string;
	readonly target?: string;
	readonly phase?: "before" | "after";
	readonly relativePath: string;
	readonly implementationHash?: string;

	constructor(input: DeclaredHook) {
		this.plugin = input.plugin;
		this.scope = input.scope;
		this.event = input.event;
		this.target = input.target;
		this.phase = input.phase;
		this.relativePath = input.relativePath;
		this.implementationHash = input.implementationHash;
	}

	async load(): Promise<ConstrainedPluginHook> {
		const normalized = normalizePluginHook({
			declaredEvent: this.event,
			target: this.target,
			phase: this.phase,
			plugin: this.plugin,
			source: this.relativePath,
		});
		if (!normalized.hook) {
			throw new GjcPluginLoadError(
				"invalid_hook",
				normalized.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join("; "),
			);
		}
		if (this.implementationHash) await verifyImplementationHash(this.relativePath, this.implementationHash);
		const registered: { event: string; handler: (...a: any[]) => unknown }[] = [];
		const deny = (method: string) => () => {
			throw new GjcPluginLoadError(
				"security_policy",
				`Plugin hook "${this.plugin}" attempted denied API: ${method}`,
			);
		};
		const constrainedApi: Record<string, unknown> = {
			on: (event: string, handler: (...a: any[]) => unknown) => registered.push({ event, handler }),
			logger,
		};
		for (const method of DENIED_API_METHODS) constrainedApi[method] = deny(method);
		const mod = await import(this.relativePath);
		const factory = mod.default ?? mod;
		if (typeof factory !== "function")
			throw new GjcPluginLoadError("invalid_hook", "Plugin hook must export a default function");
		await (factory as (api: unknown) => unknown)(constrainedApi);
		if (registered.length !== 1 || registered[0]?.event !== this.event) {
			throw new GjcPluginLoadError(
				"runtime_mismatch",
				`Plugin hook registered ${JSON.stringify(registered.map(r => r.event))}, expected exactly ["${this.event}"]`,
			);
		}
		return {
			plugin: this.plugin,
			event: this.event,
			target: this.target,
			phase: this.phase,
			handler: registered[0].handler,
		};
	}
}
async function loadOneHook(
	declared: DeclaredHook,
): Promise<{ hook: ConstrainedPluginHook | null; quarantine: SessionQuarantine | null }> {
	try {
		return { hook: await new ConstrainedPluginHookDescriptor(declared).load(), quarantine: null };
	} catch (error) {
		const code = error instanceof GjcPluginLoadError ? error.code : "invalid_hook";
		return {
			hook: null,
			quarantine: {
				identity: bundleIdentity(declared.scope, declared.plugin),
				plugin: declared.plugin,
				surfaceId: `hook:${declared.event}:${declared.target ?? ""}`,
				code,
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

/**
 * Load all always-on constrained plugin hooks for the effective registry at
 * `cwd`, applying hash-drift + collision quarantine first. Returns empty when
 * no plugins are installed.
 */
export async function loadConstrainedPluginHooks(input: {
	cwd: string;
	agentDir?: string;
	profileAuthority?: ProfileAuthority;
}): Promise<ConstrainedHookLoadResult> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd, {
		agentDir: input.agentDir,
		profileAuthority: input.profileAuthority,
	});
	const preQuarantine: SessionQuarantine[] = [];
	const invalidHookIds = new Set<string>();
	for (const entry of effective) {
		if (!entry.enabled) continue;
		for (const hook of entry.surfaces.hooks) {
			if (entry.disabledSurfaceIds.includes(hook.extensionId)) continue;
			const normalized = normalizePluginHook({
				declaredEvent: hook.event,
				target: hook.target,
				phase: hook.phase,
				plugin: entry.name,
				source: hook.relativePath,
			});
			if (normalized.hook) continue;
			invalidHookIds.add(`${entry.scope}:${entry.name}:${hook.extensionId}`);
			preQuarantine.push({
				identity: bundleIdentity(entry.scope, entry.name),
				plugin: entry.name,
				surfaceId: hook.extensionId,
				code: "invalid_hook",
				message: normalized.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join("; "),
			});
		}
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
		for (const hook of entry.surfaces.hooks) {
			if (entry.disabledSurfaceIds.includes(hook.extensionId)) continue;
			try {
				await resolveConstrainedHookFile(entry.pluginRoot, hook.relativePath);
			} catch (error) {
				invalidHookIds.add(`${entry.scope}:${entry.name}:${hook.extensionId}`);
				preQuarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: hook.extensionId,
					code: "runtime_mismatch",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	const { active, quarantine } = validateSessionBundles(effective, {}, preQuarantine);
	const declared = await collectDeclaredHooks(active, invalidHookIds);
	const hooks: ConstrainedPluginHook[] = [];
	for (const d of declared) {
		const { hook, quarantine: q } = await loadOneHook(d);
		if (hook) hooks.push(hook);
		if (q) quarantine.push(q);
	}
	return { hooks, quarantine };
}
