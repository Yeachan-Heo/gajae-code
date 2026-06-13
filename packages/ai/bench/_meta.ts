import * as os from "node:os";
import { spawnSync } from "node:child_process";

export type BenchRunMetadata = {
	gitSha: string | null;
	date: string;
	os: string;
	arch: string;
	cpu: string | null;
	bunVersion: string;
	nodeVersion: string | null;
	nativeVersion: string | null;
	nativeVariant: string | null;
};

export async function benchRunMetadata(nativeVariant: string | null = null): Promise<BenchRunMetadata> {
	const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	const nativePackage = (await Bun.file("packages/natives/package.json").json()) as { version?: string };
	return {
		gitSha: git.status === 0 ? git.stdout.trim() : null,
		date: new Date().toISOString(),
		os: os.platform(),
		arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? null,
		bunVersion: Bun.version,
		nodeVersion: process.versions.node ?? null,
		nativeVersion: nativePackage.version ?? null,
		nativeVariant,
	};
}
