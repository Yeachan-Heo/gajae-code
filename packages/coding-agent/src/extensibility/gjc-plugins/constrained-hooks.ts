import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { normalizePluginHook } from "../../hooks/normalize";
import {
	compatibilityFunctionHookGrant,
	type FunctionHookGrant,
	functionHookGrantHash,
	normalizeFunctionHookGrant,
} from "../extensions/function-hooks";
import { compileGjcPluginBundle } from "./compiler";
import { bundleIdentity } from "./lifecycle-reconciliation";
import { verifyImplementationHash } from "./metadata";
import { resolveWithinRoot } from "./paths";
import { loadEffectiveGjcPluginRegistry } from "./registry";
import { type SessionQuarantine, validateSessionBundles, verifyEntryHashes } from "./session-validation";
import {
	GjcPluginLoadError,
	type GjcPluginRegistryEntry,
	type GjcPluginScope,
	type NormalizedHookSurface,
} from "./types";

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
	scope?: GjcPluginScope;
	extensionId?: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	handler: (...args: never[]) => unknown;
	grant?: FunctionHookGrant;
	provenance?: {
		source: "plugin-bundle";
		scope: GjcPluginScope;
		plugin: string;
		path: string;
		extensionId: string;
		activationGeneration?: number;
	};
	functionHook?: boolean;
	activationGeneration?: number;
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
	extensionId?: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	implementationHash?: string;
	capabilities?: string[];
	networkDestinations?: string[];
	filesystemRoots?: string[];
	capabilityHash?: string;
	pluginRoot?: string;
	functionHook?: boolean;
	activationGeneration?: number;
}

interface PersistedHookMetadata {
	grant: FunctionHookGrant;
	functionHook: boolean;
}

function sameValues(actual: readonly unknown[] | undefined, expected: readonly unknown[]): boolean {
	return (
		actual !== undefined &&
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

function invalidHookMetadata(plugin: string, detail: string): never {
	throw new GjcPluginLoadError(
		"security_policy",
		`GJC plugin hook "${plugin}" has inconsistent function-hook metadata: ${detail}`,
	);
}

/**
 * Registry hook metadata is attacker-editable between install and session
 * startup. Legacy hooks have no grant metadata at all; every hook carrying a
 * grant must instead carry the complete canonical grant, its hash, and the
 * function-hook marker.
 */
function readPersistedHookMetadata(input: {
	plugin: string;
	event: string;
	capabilities?: unknown;
	networkDestinations?: unknown;
	filesystemRoots?: unknown;
	capabilityHash?: unknown;
	functionHook?: unknown;
}): PersistedHookMetadata {
	const hasGrantField =
		input.capabilities !== undefined ||
		input.networkDestinations !== undefined ||
		input.filesystemRoots !== undefined;
	const hasHash = input.capabilityHash !== undefined;

	if (!hasGrantField && !hasHash) {
		if (input.functionHook !== undefined && typeof input.functionHook !== "boolean")
			invalidHookMetadata(input.plugin, "functionHook must be boolean");
		if (input.functionHook === true)
			invalidHookMetadata(
				input.plugin,
				"functionHook requires capabilities, destinations, roots, and capabilityHash",
			);
		return { grant: compatibilityFunctionHookGrant(input.event), functionHook: false };
	}

	if (
		input.functionHook !== true ||
		!Array.isArray(input.capabilities) ||
		!Array.isArray(input.networkDestinations) ||
		!Array.isArray(input.filesystemRoots) ||
		typeof input.capabilityHash !== "string"
	)
		invalidHookMetadata(input.plugin, "functionHook grants must include canonical arrays and capabilityHash");

	let grant: FunctionHookGrant;
	try {
		grant = normalizeFunctionHookGrant({
			capabilities: input.capabilities as FunctionHookGrant["capabilities"],
			networkDestinations: input.networkDestinations as string[],
			filesystemRoots: input.filesystemRoots as string[],
		});
	} catch {
		invalidHookMetadata(input.plugin, "grant values are invalid");
	}
	if (
		!sameValues(input.capabilities as unknown[], grant.capabilities) ||
		!sameValues(input.networkDestinations as unknown[], grant.networkDestinations) ||
		!sameValues(input.filesystemRoots as unknown[], grant.filesystemRoots)
	)
		invalidHookMetadata(input.plugin, "grant values are not normalized");
	const expectedHash = functionHookGrantHash(grant);
	if ((input.capabilityHash as string).toLowerCase() !== expectedHash)
		invalidHookMetadata(input.plugin, "capabilityHash does not match the normalized grant");
	return { grant, functionHook: true };
}

function assertCompiledHookMetadata(
	declared: DeclaredHook,
	expected: NormalizedHookSurface | undefined,
): PersistedHookMetadata {
	const persisted = readPersistedHookMetadata(declared);
	if (!expected) {
		invalidHookMetadata(
			declared.plugin,
			`hook ${declared.extensionId ?? declared.relativePath} is not in the installed manifest`,
		);
	}
	const expectedFunctionHook = expected.functionHook === true;
	if (
		declared.extensionId !== expected.extensionId ||
		declared.event !== expected.event ||
		declared.target !== expected.target ||
		declared.phase !== expected.phase ||
		declared.relativePath !== expected.relativePath ||
		declared.implementationHash !== expected.implementationHash
	)
		invalidHookMetadata(declared.plugin, "identity or implementation metadata does not match the installed manifest");
	if (persisted.functionHook !== expectedFunctionHook)
		invalidHookMetadata(declared.plugin, "functionHook does not match the installed manifest");
	if (!expectedFunctionHook) return persisted;
	if (
		!sameValues(persisted.grant.capabilities, expected.capabilities ?? []) ||
		!sameValues(persisted.grant.networkDestinations, expected.networkDestinations ?? []) ||
		!sameValues(persisted.grant.filesystemRoots, expected.filesystemRoots ?? []) ||
		typeof expected.capabilityHash !== "string" ||
		functionHookGrantHash(persisted.grant).toLowerCase() !== expected.capabilityHash.toLowerCase()
	)
		invalidHookMetadata(declared.plugin, "grant metadata does not match the installed manifest");
	return persisted;
}

async function collectDeclaredHooks(
	entries: readonly GjcPluginRegistryEntry[],
	invalidHookIds = new Set<string>(),
	activationGeneration?: number,
): Promise<DeclaredHook[]> {
	const out: DeclaredHook[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const h of entry.surfaces.hooks) {
			if (disabled.has(h.extensionId) || invalidHookIds.has(`${entry.scope}:${entry.name}:${h.extensionId}`))
				continue;
			out.push({
				plugin: entry.name,
				scope: entry.scope,
				extensionId: h.extensionId,
				event: h.event,
				target: h.target,
				phase: h.phase,
				relativePath: h.relativePath,
				implementationHash:
					"implementationHash" in h && typeof h.implementationHash === "string" ? h.implementationHash : undefined,
				capabilities: h.capabilities,
				networkDestinations: h.networkDestinations,
				filesystemRoots: h.filesystemRoots,
				capabilityHash: h.capabilityHash,
				pluginRoot: entry.pluginRoot,
				functionHook: h.functionHook,
				activationGeneration,
			});
		}
	}
	return out;
}

/** Lazy declaration for one constrained hook. Importing this descriptor is metadata-only. */
export class ConstrainedPluginHookDescriptor {
	readonly plugin: string;
	readonly scope?: GjcPluginScope;
	readonly extensionId?: string;
	readonly event: string;
	readonly target?: string;
	readonly phase?: "before" | "after";
	readonly relativePath: string;
	readonly implementationHash?: string;
	readonly capabilities?: string[];
	readonly networkDestinations?: string[];
	readonly filesystemRoots?: string[];
	readonly capabilityHash?: string;
	readonly pluginRoot?: string;
	readonly grant: FunctionHookGrant;
	readonly functionHook: boolean;
	readonly activationGeneration?: number;
	readonly persistedFunctionHook?: unknown;

	constructor(input: DeclaredHook) {
		this.plugin = input.plugin;
		this.scope = input.scope;
		this.extensionId = input.extensionId;
		this.event = input.event;
		this.target = input.target;
		this.phase = input.phase;
		this.relativePath = input.relativePath;
		this.implementationHash = input.implementationHash;
		this.pluginRoot = input.pluginRoot;
		this.functionHook = input.functionHook === true;
		this.persistedFunctionHook = input.functionHook;
		this.capabilities = input.capabilities;
		this.networkDestinations = input.networkDestinations;
		this.filesystemRoots = input.filesystemRoots;
		this.capabilityHash = input.capabilityHash;
		this.activationGeneration = input.activationGeneration;
		try {
			this.grant =
				input.capabilities === undefined &&
				input.networkDestinations === undefined &&
				input.filesystemRoots === undefined
					? compatibilityFunctionHookGrant(input.event)
					: normalizeFunctionHookGrant({
							capabilities: input.capabilities as FunctionHookGrant["capabilities"] | undefined,
							networkDestinations: input.networkDestinations,
							filesystemRoots: input.filesystemRoots,
						});
		} catch {
			// Keep construction metadata-only; load() performs the fail-closed
			// validation and reports a quarantine-safe error.
			this.grant = compatibilityFunctionHookGrant(input.event);
		}
	}

	async load(): Promise<ConstrainedPluginHook> {
		const metadata = readPersistedHookMetadata({
			plugin: this.plugin,
			event: this.event,
			capabilities: this.capabilities,
			networkDestinations: this.networkDestinations,
			filesystemRoots: this.filesystemRoots,
			capabilityHash: this.capabilityHash,
			functionHook: this.persistedFunctionHook,
		});
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
		if (!this.pluginRoot) {
			throw new GjcPluginLoadError(
				"security_policy",
				`GJC plugin hook "${this.plugin}" has no installed root; refusing to import an unconfined path`,
			);
		}
		if (metadata.functionHook) {
			throw new GjcPluginLoadError(
				"security_policy",
				`Plugin function hook "${this.plugin}" requires an isolated runtime and cannot execute in the host realm`,
			);
		}
		const resolvedPath = await resolveConstrainedHookFile(this.pluginRoot, this.relativePath);
		if (this.implementationHash) await verifyImplementationHash(resolvedPath, this.implementationHash);
		const registered: { event: string; handler: (...a: never[]) => unknown }[] = [];
		const deny = (method: string) => () => {
			throw new GjcPluginLoadError(
				"security_policy",
				`Plugin hook "${this.plugin}" attempted denied API: ${method}`,
			);
		};
		const constrainedApi: Record<string, unknown> = {
			on: (event: string, handler: (...a: never[]) => unknown) => registered.push({ event, handler }),
			logger,
		};
		for (const method of DENIED_API_METHODS) constrainedApi[method] = deny(method);
		const mod = await import(resolvedPath);
		const factory = mod.default ?? mod;
		if (typeof factory !== "function")
			throw new GjcPluginLoadError("invalid_hook", "Plugin hook must export a default function");
		await (factory as (api: unknown) => unknown)(constrainedApi);
		if (this.implementationHash) await verifyImplementationHash(resolvedPath, this.implementationHash);
		if (
			registered.length !== 1 ||
			registered[0]?.event !== this.event ||
			typeof registered[0]?.handler !== "function"
		) {
			throw new GjcPluginLoadError(
				"runtime_mismatch",
				`Plugin hook registered ${JSON.stringify(registered.map(r => r.event))}, expected exactly ["${this.event}"]`,
			);
		}
		return {
			plugin: this.plugin,
			scope: this.scope,
			extensionId: this.extensionId,
			event: this.event,
			target: this.target,
			phase: this.phase,
			handler: registered[0].handler,
			grant: metadata.grant,
			functionHook: metadata.functionHook,
			...(this.scope && this.pluginRoot && this.extensionId
				? {
						provenance: {
							source: "plugin-bundle" as const,
							scope: this.scope,
							plugin: this.plugin,
							path: this.relativePath,
							extensionId: this.extensionId,
							...(this.activationGeneration === undefined
								? {}
								: { activationGeneration: this.activationGeneration }),
						},
					}
				: {}),
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
				surfaceId:
					declared.extensionId ??
					`hook:${declared.event}:${declared.phase ?? ""}:${declared.target ?? "*"}:${path.basename(declared.relativePath)}`,
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
	activationGeneration?: number;
}): Promise<ConstrainedHookLoadResult> {
	const effective = await loadEffectiveGjcPluginRegistry(input.cwd);
	if (effective.length === 0) return { hooks: [], quarantine: [] };
	const preQuarantine: SessionQuarantine[] = [];
	const invalidHookIds = new Set<string>();
	for (const entry of effective) {
		if (!entry.enabled) continue;
		let compiledHooks = new Map<string, NormalizedHookSurface>();
		if (entry.surfaces.hooks.length > 0) {
			try {
				const compiled = await compileGjcPluginBundle(entry.pluginRoot);
				compiledHooks = new Map(compiled.surfaces.hooks.map(hook => [hook.extensionId, hook]));
			} catch (error) {
				preQuarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: `plugin:${entry.name}`,
					code: error instanceof GjcPluginLoadError ? error.code : "invalid_hook",
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
		}
		for (const hook of entry.surfaces.hooks) {
			if (entry.disabledSurfaceIds.includes(hook.extensionId)) continue;
			const normalized = normalizePluginHook({
				declaredEvent: hook.event,
				target: hook.target,
				phase: hook.phase,
				plugin: entry.name,
				source: hook.relativePath,
			});
			if (!normalized.hook) {
				invalidHookIds.add(`${entry.scope}:${entry.name}:${hook.extensionId}`);
				preQuarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: hook.extensionId,
					code: "invalid_hook",
					message: normalized.diagnostics
						.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)
						.join("; "),
				});
				continue;
			}
			try {
				assertCompiledHookMetadata(
					{
						plugin: entry.name,
						scope: entry.scope,
						extensionId: hook.extensionId,
						event: hook.event,
						target: hook.target,
						phase: hook.phase,
						relativePath: hook.relativePath,
						implementationHash: hook.implementationHash,
						capabilities: hook.capabilities,
						networkDestinations: hook.networkDestinations,
						filesystemRoots: hook.filesystemRoots,
						capabilityHash: hook.capabilityHash,
						pluginRoot: entry.pluginRoot,
						functionHook: hook.functionHook,
					},
					compiledHooks.get(hook.extensionId),
				);
			} catch (error) {
				invalidHookIds.add(`${entry.scope}:${entry.name}:${hook.extensionId}`);
				preQuarantine.push({
					identity: bundleIdentity(entry.scope, entry.name),
					plugin: entry.name,
					surfaceId: hook.extensionId,
					code: error instanceof GjcPluginLoadError ? error.code : "invalid_hook",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const drift = await verifyEntryHashes(entry);
		if (drift) preQuarantine.push(drift);
		for (const hook of entry.surfaces.hooks) {
			if (
				entry.disabledSurfaceIds.includes(hook.extensionId) ||
				invalidHookIds.has(`${entry.scope}:${entry.name}:${hook.extensionId}`)
			)
				continue;
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
	const declared = await collectDeclaredHooks(active, invalidHookIds, input.activationGeneration);
	const hooks: ConstrainedPluginHook[] = [];
	for (const d of declared) {
		const { hook, quarantine: q } = await loadOneHook(d);
		if (hook) hooks.push(hook);
		if (q) quarantine.push(q);
	}
	return { hooks, quarantine };
}
