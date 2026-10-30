import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@gajae-code/utils";
import type { DetectedRunner, RunnerTask, TaskRunner } from "../runner";

export interface CargoMetadataTarget {
	kind?: string[];
	name?: string;
}

export interface CargoMetadataPackage {
	id?: string;
	name?: string;
	targets?: CargoMetadataTarget[];
}

export interface CargoMetadata {
	packages?: CargoMetadataPackage[];
	workspace_members?: string[];
}

type CargoTargetKind = "bin" | "example" | "test";

async function hasCargoManifest(cwd: string): Promise<boolean> {
	try {
		const stat = await fs.stat(path.join(cwd, "Cargo.toml"));
		return stat.isFile();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function cargoTargetKind(target: CargoMetadataTarget): CargoTargetKind | undefined {
	if (target.kind?.includes("bin")) return "bin";
	if (target.kind?.includes("example")) return "example";
	if (target.kind?.includes("test")) return "test";
	return undefined;
}

function commandPrefixForTarget(packageName: string, kind: CargoTargetKind): string {
	const packageFlag = `--package ${shellQuote(packageName)}`;
	switch (kind) {
		case "bin":
			return `cargo run ${packageFlag} --bin`;
		case "example":
			return `cargo run ${packageFlag} --example`;
		case "test":
			return `cargo test ${packageFlag} --test`;
	}
}

function taskNameForTarget(
	packageName: string,
	kind: CargoTargetKind,
	targetName: string,
	isWorkspace: boolean,
): string {
	const category = kind === "bin" ? "bin" : kind;
	return isWorkspace ? `${packageName}/${category}/${targetName}` : `${category}/${targetName}`;
}

export function tasksFromCargoMetadata(metadata: CargoMetadata): RunnerTask[] {
	const workspaceMembers = new Set(metadata.workspace_members ?? []);
	const workspacePackages = (metadata.packages ?? []).filter(pkg => pkg.id && workspaceMembers.has(pkg.id));
	const packages = workspacePackages.length > 0 ? workspacePackages : (metadata.packages ?? []);
	const isWorkspace = packages.length > 1;
	const tasks: RunnerTask[] = [];
	const seen = new Set<string>();

	for (const pkg of packages) {
		if (!pkg.name) continue;
		for (const target of pkg.targets ?? []) {
			if (!target.name) continue;
			const kind = cargoTargetKind(target);
			if (!kind) continue;
			const name = taskNameForTarget(pkg.name, kind, target.name, isWorkspace);
			if (seen.has(name)) continue;
			seen.add(name);
			tasks.push({
				name,
				doc: `${pkg.name} ${kind} target ${target.name}`,
				parameters: [],
				commandPrefix: commandPrefixForTarget(pkg.name, kind),
				commandName: shellQuote(target.name),
			});
		}
	}

	return tasks;
}

async function readCargoMetadata(cwd: string): Promise<CargoMetadata | null> {
	try {
		const proc = Bun.spawn(["cargo", "metadata", "--no-deps", "--format-version=1"], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exit !== 0) return null;
		return JSON.parse(stdout) as CargoMetadata;
	} catch (err) {
		logger.debug("cargo metadata failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

export const cargoRunner: TaskRunner = {
	id: "cargo",
	label: "Cargo",
	async detect(cwd: string): Promise<DetectedRunner | null> {
		try {
			if (!$which("cargo")) return null;
			if (!(await hasCargoManifest(cwd))) return null;
			const metadata = await readCargoMetadata(cwd);
			if (!metadata) return null;
			const tasks = tasksFromCargoMetadata(metadata);
			if (tasks.length === 0) return null;
			return { id: "cargo", label: "Cargo", commandPrefix: "cargo", tasks };
		} catch (err) {
			logger.debug("cargo runner probe failed", { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	},
};
