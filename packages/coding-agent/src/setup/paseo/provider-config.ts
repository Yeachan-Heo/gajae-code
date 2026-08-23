import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@gajae-code/utils";
import { type BuildChannel, resolveBuildMetadata } from "../../build-metadata";
import { hashBytes, type ReadTargetResult } from "./json-publisher";
import { PROVIDER_EXTENDS, PROVIDER_KEY } from "./setup-deps";

const PROVIDER_LABEL = "Gajae Code";

export interface PaseoProviderEntry {
	extends: string;
	label: string;
	command: string[];
	env: Record<string, string>;
	enabled: boolean;
}

export type GjcCommandResolution =
	| { readonly ok: true; readonly command: string[]; readonly channel: BuildChannel }
	| { readonly ok: false; readonly channel: BuildChannel; readonly detail: string };

export type ProviderConflict =
	| { readonly conflict: false }
	| { readonly conflict: true; readonly subject: string; readonly detail: string };

/** Resolve an executable from PATH without ever returning its bare command name. */
function resolveViaPath(name: string): string | undefined {
	return $which(name) ?? undefined;
}

export function resolveGjcCommand(): GjcCommandResolution {
	const metadata = resolveBuildMetadata();
	switch (metadata.channel) {
		case "release":
		case "dev":
		case "compiled":
			return { ok: true, command: [process.execPath, "acp"], channel: metadata.channel };
		case "local-source": {
			const launcher = process.argv[1];
			if (!launcher) {
				return {
					ok: false,
					channel: metadata.channel,
					detail: "local-source launcher process.argv[1] is missing; cannot write an absolute command path",
				};
			}
			const resolvedLauncher = path.resolve(launcher);
			if (!isReadableFile(resolvedLauncher)) {
				return {
					ok: false,
					channel: metadata.channel,
					detail: `local-source launcher '${resolvedLauncher}' is not a readable file; cannot write an absolute command path`,
				};
			}
			return { ok: true, command: [process.execPath, resolvedLauncher, "acp"], channel: metadata.channel };
		}
		case "package-install": {
			const executable = resolveViaPath("gjc");
			if (!executable || !path.isAbsolute(executable)) {
				return {
					ok: false,
					channel: metadata.channel,
					detail: "gjc was not found on PATH; cannot write an absolute command path",
				};
			}
			return { ok: true, command: [executable, "acp"], channel: metadata.channel };
		}
		case "unknown":
			return { ok: false, channel: metadata.channel, detail: "build channel is unknown; cannot resolve gjc" };
		default: {
			const _exhaustive: never = metadata.channel;
			throw new Error(`Unhandled build channel '${_exhaustive}'`);
		}
	}
}

export function providerKeyFor(mpreset?: string): string {
	return mpreset === undefined ? PROVIDER_KEY : `${PROVIDER_KEY}-${mpreset}`;
}

export function buildProviderEntry(command: string[], mpreset?: string): PaseoProviderEntry {
	return {
		extends: PROVIDER_EXTENDS,
		label: mpreset === undefined ? PROVIDER_LABEL : `${PROVIDER_LABEL} (${mpreset})`,
		command: mpreset === undefined ? [...command] : [...command, "--mpreset", mpreset],
		env: { GJC_ACP_PERMISSION_MODE: "prompt" },
		enabled: true,
	};
}

/**
 * Produces the narrowly scoped mutation passed to {@link planPublish}. The
 * read result is accepted so callers retain an explicit preflight-to-plan flow.
 */
export function createProviderMutation(
	_current: ReadTargetResult,
	key: string,
	entry: PaseoProviderEntry,
): (draft: Record<string, unknown>) => void {
	return draft => {
		const agents = asRecord(draft.agents);
		if (!agents) draft.agents = {};
		const targetAgents = draft.agents as Record<string, unknown>;
		const providers = asRecord(targetAgents.providers);
		if (!providers) targetAgents.providers = {};
		(targetAgents.providers as Record<string, unknown>)[key] = entry;
	};
}

export function hasProviderConflict(
	config: Record<string, unknown>,
	key: string,
	entry: PaseoProviderEntry,
): ProviderConflict {
	const existing = asRecord(asRecord(config.agents)?.providers)?.[key];
	if (existing === undefined || JSON.stringify(existing) === JSON.stringify(entry)) return { conflict: false };
	return {
		conflict: true,
		subject: `agents.providers.${key}`,
		detail: `Existing provider entry at agents.providers.${key} differs from the GJC-managed entry.`,
	};
}

export function providerEntryHash(entry: PaseoProviderEntry | Record<string, unknown>): string {
	return hashBytes(JSON.stringify(entry));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isReadableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
