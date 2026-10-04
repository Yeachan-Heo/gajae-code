/**
 * Environment pins and provenance bindings for raw outputs, the preflight
 * record, and the run guard.
 */
import * as os from "node:os";
import { $ } from "bun";
import { bootstrapDigest } from "./bootstrap";
import { workloadDigest } from "./workload";

export interface Provenance {
	sourceSha: string;
	dirty: boolean;
	workloadDigest: string;
	bootstrapDigest: string;
	bunVersion: string;
	osVersion: string;
	platform: string;
	arch: string;
	cpu: string;
	totalMemoryBytes: number;
}

export async function currentProvenance(cwd = import.meta.dir): Promise<Provenance> {
	const sourceSha = (await $`git rev-parse HEAD`.cwd(cwd).quiet().text()).trim();
	const status = (await $`git status --porcelain`.cwd(cwd).quiet().text()).trim();
	const productVersion = (await $`sw_vers -productVersion`.nothrow().quiet().text()).trim();
	const buildVersion = (await $`sw_vers -buildVersion`.nothrow().quiet().text()).trim();
	return {
		sourceSha,
		dirty: status.length > 0,
		workloadDigest: workloadDigest(),
		bootstrapDigest: bootstrapDigest(),
		bunVersion: Bun.version,
		osVersion: productVersion ? `macOS ${productVersion} (${buildVersion})` : `${os.type()} ${os.release()}`,
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? "unknown",
		totalMemoryBytes: os.totalmem(),
	};
}
