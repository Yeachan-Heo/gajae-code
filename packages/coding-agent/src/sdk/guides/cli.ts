import { getAgentDir } from "@gajae-code/utils";
import { readGuideCache } from "./cache";
import { BUNDLED_GUIDE_MANIFESTS, GuideCatalog, guideFetchPolicy, isGuideFetchUrlAllowed } from "./catalog";
import { GUIDE_CLIENT_VERSION, GUIDE_PINNED_KEYS } from "./verify";

/**
 * `gjc sdk guides` command family (routing lives in `src/commands/sdk.ts`).
 *
 * Verbs:
 *   refresh --url <https url>  fetch + verify the online manifest and advisory
 *                              text, install the verified cache, report selection.
 *                              Fails operationally (exit 1) whenever the online
 *                              manifest is not selected: fallback cache/bundled
 *                              content is reported as a failure, never as a
 *                              successful refresh
 *   list                       offline selection: verified cache, else bundled
 *   show <guideId>             render the advisory text for one guide (data only)
 *   status                     selection provenance, cache health, fetch policy
 *   trust                      pinned key ids and the no-credential fetch boundary
 *
 * The subsystem is advisory-text only: it never executes guide content, never
 * mutates configuration, and never accepts or emits credentials. The only
 * state it writes is the verified guide cache during `refresh`.
 */
export type SdkGuidesCliAction = "refresh" | "list" | "show" | "status" | "trust";

export interface SdkGuidesCliArgs {
	action?: string;
	/** Guide id for `show`. */
	guideId?: string;
	/** Online manifest URL for `refresh`; must satisfy the HTTPS allowlist. */
	url?: string;
	agentDir?: string;
	/** Bounded fetch timeout for `refresh`. */
	timeoutMs?: number;
	/** Fetch implementation override for `refresh` (test seam); defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

const GUIDE_CLI_ACTIONS: readonly string[] = ["refresh", "list", "show", "status", "trust"];

class SdkGuidesCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1 | 2,
	) {
		super(message);
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usageFailure(message: string): SdkGuidesCliError {
	return new SdkGuidesCliError("usage", message, 2);
}

function operationalFailure(code: string, message: string): SdkGuidesCliError {
	return new SdkGuidesCliError(code, message, 1);
}

/**
 * Usage-shaped errors (bad verb, missing argument, URL outside the allowlist)
 * exit 2; every verification/operational failure exits 1. Fail-closed codes
 * from the verification pipeline map to exit 1 so scripts observe a hard
 * failure on tamper, unknown key, rollback, expiry, or corrupt cache.
 */
function toCliError(error: unknown): SdkGuidesCliError {
	if (error instanceof SdkGuidesCliError) return error;
	const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
	const message = error instanceof Error ? error.message : String(error);
	switch (code) {
		case "usage":
		case "invalid_input":
		case "fetch_forbidden":
			return new SdkGuidesCliError(code ?? "operation_failed", message, 2);
		default:
			return operationalFailure(code ?? "operation_failed", message);
	}
}

function requireValue(value: string | undefined, flag: string): string {
	if (value === undefined || value.length === 0) throw usageFailure(`${flag} is required.`);
	return value;
}

function manifestSummary(manifest: {
	manifestId: string;
	keyId: string;
	sequence: number;
	issuedAt: number;
	expiresAt: number;
	minimumSdkVersion: number;
}) {
	return {
		manifestId: manifest.manifestId,
		keyId: manifest.keyId,
		sequence: manifest.sequence,
		issuedAt: manifest.issuedAt,
		expiresAt: manifest.expiresAt,
		minimumSdkVersion: manifest.minimumSdkVersion,
	};
}

async function runRefresh(agentDir: string, args: SdkGuidesCliArgs): Promise<unknown> {
	const url = requireValue(args.url, "--url");
	if (!isGuideFetchUrlAllowed(url)) throw usageFailure(`--url ${url} is outside the HTTPS allowlist.`);
	const catalog = new GuideCatalog({
		agentDir,
		onlineUrl: url,
		timeoutMs: args.timeoutMs,
		fetchImpl: args.fetchImpl,
	});
	const result = await catalog.refresh();
	if (!result.ok) throw operationalFailure(result.error.code, result.error.message);
	const selection = result.value;
	if (selection.source !== "online") {
		const reasons = selection.warnings.length > 0 ? ` ${selection.warnings.join("; ")}` : "";
		throw operationalFailure(
			"online_refresh_failed",
			`Online refresh did not select an online source (selected ${selection.source} instead)${reasons}.`,
		);
	}
	return {
		source: selection.source,
		manifest: manifestSummary(selection.manifest),
		guides: selection.guides.map(guide => ({ id: guide.id, title: guide.title, sha256: guide.sha256 })),
		warnings: selection.warnings,
	};
}

async function runList(agentDir: string): Promise<unknown> {
	const catalog = new GuideCatalog({ agentDir });
	const result = await catalog.load();
	if (!result.ok) throw operationalFailure(result.error.code, result.error.message);
	const selection = result.value;
	return {
		source: selection.source,
		manifest: manifestSummary(selection.manifest),
		guides: selection.guides.map(guide => ({ id: guide.id, title: guide.title, sha256: guide.sha256 })),
		warnings: selection.warnings,
	};
}

async function runShow(agentDir: string, args: SdkGuidesCliArgs): Promise<unknown> {
	const guideId = requireValue(args.guideId, "<guideId>");
	const catalog = new GuideCatalog({ agentDir });
	const result = await catalog.advisory(guideId);
	if (!result.ok) throw operationalFailure(result.error.code, result.error.message);
	return {
		source: result.value.source,
		guideId: result.value.guideId,
		title: result.value.title,
		text: result.value.text,
	};
}

async function runStatus(agentDir: string): Promise<unknown> {
	const now = Date.now();
	const cache = await readGuideCache({ agentDir, now });
	const cacheView =
		!cache.ok && cache.error.code === "missing_cache"
			? { present: false }
			: {
					present: true,
					verified: cache.ok,
					code: cache.ok ? undefined : cache.error.code,
					manifestId: cache.ok ? cache.value.manifest.manifestId : undefined,
					sequence: cache.ok ? cache.value.manifest.sequence : undefined,
					expiresAt: cache.ok ? cache.value.manifest.expiresAt : undefined,
				};
	const catalog = new GuideCatalog({ agentDir });
	const selection = await catalog.load();
	return {
		clientVersion: GUIDE_CLIENT_VERSION,
		source: selection.ok ? selection.value.source : undefined,
		manifest: selection.ok ? manifestSummary(selection.value.manifest) : undefined,
		cache: cacheView,
		bundled: BUNDLED_GUIDE_MANIFESTS.length,
		fetch: guideFetchPolicy(),
		warnings: selection.ok ? selection.value.warnings : [],
	};
}

function runTrust(): unknown {
	return {
		clientVersion: GUIDE_CLIENT_VERSION,
		pinnedKeys: GUIDE_PINNED_KEYS.map(key => ({ keyId: key.keyId, source: key.source })),
		fetch: guideFetchPolicy(),
	};
}

/**
 * Runs the `gjc sdk guides` command family. Exported for command routing from
 * `src/commands/sdk.ts` and for direct service use; the injected `write` /
 * `setExitCode` hooks keep the surface testable without touching stdout or
 * the process exit code.
 */
export async function runSdkGuidesCli(
	args: SdkGuidesCliArgs,
	writeOutput: (value: unknown) => void = writeJson,
	setExitCode: (exitCode: 1 | 2) => void = exitCode => {
		process.exitCode = exitCode;
	},
): Promise<void> {
	try {
		const action = args.action;
		if (action === undefined || !GUIDE_CLI_ACTIONS.includes(action))
			throw usageFailure(`Expected one of: ${GUIDE_CLI_ACTIONS.join(", ")}.`);
		const agentDir = args.agentDir ?? getAgentDir();
		switch (action) {
			case "refresh":
				writeOutput({ ok: true, result: await runRefresh(agentDir, args) });
				return;
			case "list":
				writeOutput({ ok: true, result: await runList(agentDir) });
				return;
			case "show":
				writeOutput({ ok: true, result: await runShow(agentDir, args) });
				return;
			case "status":
				writeOutput({ ok: true, result: await runStatus(agentDir) });
				return;
			case "trust":
				writeOutput({ ok: true, result: runTrust() });
				return;
		}
	} catch (error) {
		const cliError = toCliError(error);
		writeOutput({ ok: false, error: { code: cliError.code, message: cliError.message } });
		setExitCode(cliError.exitCode);
	}
}
