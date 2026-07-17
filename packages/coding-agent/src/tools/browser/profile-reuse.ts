/**
 * Profile-reuse orchestration (plan Phase 2 wiring).
 *
 * Single entry point the launch path calls to decide, for a default headless
 * session, whether to warm up from an isolated copy of the user's real Chrome
 * profile. Ties together discovery + posture + isolated warm-up. Filesystem
 * effects (the copy) are performed only when the posture resolves to `real`.
 * The heavy pieces are injectable so this is unit-testable without a browser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DiscoveredProfile, type DiscoveryEnv, discoverDefaultChromeProfile } from "./profile-discovery";
import { decideProfilePosture, type ProfileReusePosture } from "./profile-posture";
import { collectWarmupArtifacts, type WarmupManifest } from "./profile-warmup";

export interface ResolveProfileReuseInputs {
	posture?: ProfileReusePosture;
	/** Caller explicitly requested real-profile reuse (e.g. app.browser === "chrome"). */
	explicitlyRequested?: boolean;
	discoveryEnv: DiscoveryEnv;
	/** Destination for the isolated warm-up copy; defaults to an ephemeral temp dir. */
	destDir?: string;
	/** Injectable copier (defaults to collectWarmupArtifacts). */
	copy?: (sourceProfileDir: string, destDir: string) => WarmupManifest;
	/** Injectable temp-dir factory (defaults to fs.mkdtemp under os.tmpdir()). */
	makeTempDir?: () => string;
}

export interface ProfileReuseResult {
	mode: "real" | "synthetic";
	reason: string;
	warning: string | null;
	discovered: DiscoveredProfile | null;
	/** Isolated copy directory when mode === "real", else null. */
	warmupDir: string | null;
	manifest: WarmupManifest | null;
}

function defaultTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-profile-warmup-"));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve profile reuse for a default session. When the posture resolves to
 * `real`, copies an allowlisted, lock-free subset of the discovered profile
 * into an isolated dir and returns that dir for the launcher to use.
 */
export function resolveProfileReuse(inputs: ResolveProfileReuseInputs): ProfileReuseResult {
	const discovered = discoverDefaultChromeProfile(inputs.discoveryEnv);
	const decision = decideProfilePosture({
		posture: inputs.posture,
		realProfileAvailable: discovered !== null,
		explicitlyRequested: inputs.explicitlyRequested,
	});

	if (decision.mode !== "real" || !discovered) {
		return {
			mode: "synthetic",
			reason: decision.reason,
			warning: null,
			discovered,
			warmupDir: null,
			manifest: null,
		};
	}

	const ownsDestDir = inputs.destDir === undefined;
	let destDir: string | undefined;
	const copy = inputs.copy ?? collectWarmupArtifacts;
	try {
		destDir = inputs.destDir ?? (inputs.makeTempDir ?? defaultTempDir)();
		const manifest = copy(discovered.profileDir, destDir);
		return {
			mode: "real",
			reason: decision.reason,
			warning: decision.warning,
			discovered,
			warmupDir: destDir,
			manifest,
		};
	} catch (error) {
		if (ownsDestDir && destDir) {
			try {
				fs.rmSync(destDir, { recursive: true, force: true });
			} catch {}
		}
		return {
			mode: "synthetic",
			reason: "synthetic-copy-failed",
			warning: `Could not safely copy the discovered Chrome profile; using synthetic browser state instead: ${errorMessage(error)}`,
			discovered,
			warmupDir: null,
			manifest: null,
		};
	}
}
