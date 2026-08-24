import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ActiveSubskillEntry } from "../../skill-state/active-state";
import { resolveWithinRoot } from "./paths";
import { loadEffectiveGjcPluginRegistry } from "./registry";
import type {
	GjcPluginRegistryEntry,
	LoadedSubskillActivation,
	LoadedSubskillToolReference,
	NormalizedSubskillSurface,
} from "./types";
import { GjcPluginLoadError } from "./types";

export type SubskillReference = Partial<LoadedSubskillActivation> & {
	plugin: string;
	subskillName: string;
	parent: string;
	phase: string;
	activationArg: string;
	filePath?: string;
	scope?: "user" | "project";
	extensionId?: string;
	expectedDigest?: string;
	toolRefs?: Array<{ extensionId: string; expectedDigest: string }>;
};

export interface ValidatedActiveSubskill {
	entry: GjcPluginRegistryEntry;
	surface: NormalizedSubskillSurface;
	activation: LoadedSubskillActivation;
	/** Exact bytes read and hash-checked at the validation boundary. */
	body: string;
}

interface VerifiedFile {
	path: string;
	bytes: Buffer;
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function readVerifiedFile(
	root: string,
	relativePath: string,
	expected: string,
	label: string,
): Promise<VerifiedFile> {
	const lexical = resolveWithinRoot(root, relativePath);
	let rootReal: string;
	let fileReal: string;
	try {
		[rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
	} catch (error) {
		throw new GjcPluginLoadError("runtime_mismatch", `Missing or unreadable ${label} at ${relativePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!isWithin(rootReal, fileReal)) {
		throw new GjcPluginLoadError("runtime_mismatch", `${label} escapes the installed plugin root: ${relativePath}`);
	}
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(fileReal);
	} catch (error) {
		throw new GjcPluginLoadError("runtime_mismatch", `Missing or unreadable ${label} at ${relativePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const actual = digest(bytes);
	if (actual.toLowerCase() !== expected.toLowerCase()) {
		throw new GjcPluginLoadError("runtime_mismatch", `${label} hash drift at ${relativePath}`);
	}
	return { path: fileReal, bytes };
}

async function verifyFile(root: string, relativePath: string, expected: string, label: string): Promise<string> {
	return (await readVerifiedFile(root, relativePath, expected, label)).path;
}

async function tryVerifyFile(
	root: string,
	relativePath: string,
	expected: string,
	label: string,
): Promise<string | null> {
	try {
		return await verifyFile(root, relativePath, expected, label);
	} catch (error) {
		if (error instanceof GjcPluginLoadError) return null;
		throw error;
	}
}

async function tryReadVerifiedFile(
	root: string,
	relativePath: string,
	expected: string,
	label: string,
): Promise<VerifiedFile | null> {
	try {
		return await readVerifiedFile(root, relativePath, expected, label);
	} catch (error) {
		if (error instanceof GjcPluginLoadError) return null;
		throw error;
	}
}

function entryForReference(
	entries: readonly GjcPluginRegistryEntry[],
	reference: SubskillReference,
): GjcPluginRegistryEntry | undefined {
	const candidates = entries.filter(
		entry => entry.name === reference.plugin && (!reference.scope || entry.scope === reference.scope),
	);
	return candidates.length === 1 ? candidates[0] : undefined;
}

function surfaceForReference(
	entry: GjcPluginRegistryEntry,
	reference: SubskillReference,
): NormalizedSubskillSurface | undefined {
	const candidates = entry.surfaces.subskills.filter(surface => {
		if (reference.extensionId && surface.extensionId !== reference.extensionId) return false;
		return (
			surface.name === reference.subskillName &&
			surface.parent === reference.parent &&
			surface.phase === reference.phase &&
			surface.activationArg === reference.activationArg
		);
	});
	if (candidates.length !== 1) return undefined;
	return candidates[0];
}

function extractSubskillBody(bytes: Buffer): string {
	return bytes
		.toString("utf8")
		.replace(/^---\n[\s\S]*?\n---\n/, "")
		.trim();
}

/**
 * Single authority for subskill activation, tool loading, and prompt injection.
 * Registry identity is authoritative; persisted executable paths are never used.
 */
export async function resolveValidatedActiveSubskill(input: {
	cwd: string;
	reference: SubskillReference | ActiveSubskillEntry;
	persisted?: boolean;
	agentDir?: string;
}): Promise<ValidatedActiveSubskill | null> {
	const reference = input.reference as SubskillReference;
	if (!reference.scope || !reference.extensionId || !reference.expectedDigest) return null;
	const entries = await loadEffectiveGjcPluginRegistry(input.cwd, { agentDir: input.agentDir });
	const entry = entryForReference(entries, reference);
	if (!entry?.enabled || entry.migration?.status === "failed") return null;
	const surface = surfaceForReference(entry, reference);
	if (!surface?.toolRefs) return null;
	if (entry.disabledSurfaceIds.includes(surface.extensionId)) return null;
	if (entry.quarantine?.some(item => item.surfaceId === surface.extensionId)) return null;
	if (reference.expectedDigest && reference.expectedDigest.toLowerCase() !== surface.sha256.toLowerCase()) return null;
	const subskillFile = await tryReadVerifiedFile(entry.pluginRoot, surface.relativePath, surface.sha256, "subskill");
	if (!subskillFile) return null;
	const subskillPath = subskillFile.path;
	const persistedToolRefs = Array.isArray(reference.toolRefs) ? reference.toolRefs : undefined;
	const toolRefs: LoadedSubskillToolReference[] = [];
	for (const declared of surface.toolRefs) {
		if (entry.quarantine?.some(item => item.surfaceId === declared.extensionId)) return null;
		const persisted = persistedToolRefs?.find(item => item.extensionId === declared.extensionId);
		if (persisted && persisted.expectedDigest.toLowerCase() !== declared.implementationHash.toLowerCase())
			return null;
		const toolPath = await tryVerifyFile(
			entry.pluginRoot,
			declared.relativePath,
			declared.implementationHash,
			"subskill tool",
		);
		if (!toolPath) return null;
		toolRefs.push({
			extensionId: declared.extensionId,
			relativePath: toolPath,
			expectedDigest: declared.implementationHash,
		});
	}
	if (reference.filePath) {
		let requestedReal: string;
		try {
			requestedReal = await fs.realpath(reference.filePath);
		} catch {
			return null;
		}
		if (requestedReal !== subskillPath) return null;
	}
	return {
		entry,
		surface,
		activation: {
			activationArg: surface.activationArg,
			plugin: entry.name,
			subskillName: surface.name,
			parent: surface.parent,
			bindsTo: surface.parent,
			phase: surface.phase,
			scope: entry.scope,
			extensionId: surface.extensionId,
			expectedDigest: surface.sha256,
			filePath: subskillPath,
			toolPaths: toolRefs.map(ref => ref.relativePath),
			toolRefs,
		},
		body: extractSubskillBody(subskillFile.bytes),
	};
}

export async function verifyValidatedActiveSubskill(
	validated: ValidatedActiveSubskill,
): Promise<ValidatedActiveSubskill> {
	await verifyFile(validated.entry.pluginRoot, validated.surface.relativePath, validated.surface.sha256, "subskill");
	for (const ref of validated.surface.toolRefs ?? []) {
		await verifyFile(validated.entry.pluginRoot, ref.relativePath, ref.implementationHash, "subskill tool");
	}
	return validated;
}

export async function verifyValidatedSubskillTool(input: {
	validated: ValidatedActiveSubskill;
	reference: LoadedSubskillToolReference;
}): Promise<string> {
	return verifyFile(
		input.validated.entry.pluginRoot,
		input.reference.relativePath,
		input.reference.expectedDigest,
		"subskill tool",
	);
}
