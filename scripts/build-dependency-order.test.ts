import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Bun's workspace-script scheduler (src/cli/filter_run.zig, `runScriptsWithFilter`)
// orders `bun run --workspaces`/`bun run --filter '*'` scripts by each package's
// regular `dependencies` graph, restricted to packages that declare the invoked
// script (here: `build`). If a dependency cycle exists among those scripted
// packages, Bun's own scheduler detects it and disables ordering for *every*
// scripted package in the run, not just the cyclic ones -- silently turning every
// `bun run build` invocation into an unordered race.
//
// This regression protects that invariant directly: the `@gajae-code/*`
// workspace dependency graph, restricted to packages scheduled for a `build`
// run (any of `prebuild`/`build`/`postbuild` present),
// must stay acyclic. It intentionally does not invoke Bun or assert anything
// about CLI flag spelling (`--workspaces` vs `--filter`), since both route
// through the same scheduler and neither guards this invariant on its own.

const repoRoot = path.join(import.meta.dir, "..");
const packagesDir = path.join(repoRoot, "packages");

interface WorkspacePackageManifest {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
}

interface WorkspaceBuildGraph {
	/** Packages scheduled for a `build` run (any of `prebuild`/`build`/`postbuild` present) -- the only nodes Bun's scheduler creates for that run. */
	scheduledPackageNames: Set<string>;
	/** consumer package name -> producer package names (regular `dependencies` only, restricted to scheduled packages). */
	edges: Map<string, string[]>;
}

async function readWorkspaceBuildGraph(): Promise<WorkspaceBuildGraph> {
	const entries = await fs.readdir(packagesDir, { withFileTypes: true });
	const manifests: WorkspacePackageManifest[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(packagesDir, entry.name, "package.json");
		try {
			manifests.push((await Bun.file(manifestPath).json()) as WorkspacePackageManifest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
	}

	// Bun schedules a package as a node whenever it has a `prebuild`, `build`, or
	// `postbuild` script for the invoked `build` run (matching filter_run.zig's
	// [pre_script_name, script_name, post_script_name] scan) -- not only when
	// `build` itself is present. A future package with only lifecycle hooks
	// (or an intentionally empty `build` script) must still be scheduled here.
	const scheduledPackageNames = new Set(
		manifests
			.filter(
				manifest =>
					manifest.name &&
					(manifest.scripts?.build !== undefined ||
						manifest.scripts?.prebuild !== undefined ||
						manifest.scripts?.postbuild !== undefined),
			)
			.map(manifest => manifest.name as string),
	);

	const edges = new Map<string, string[]>();
	for (const name of scheduledPackageNames) edges.set(name, []);

	for (const manifest of manifests) {
		if (!manifest.name || !scheduledPackageNames.has(manifest.name)) continue;
		const dependencyNames = Object.keys(manifest.dependencies ?? {});
		const producers = dependencyNames.filter(dependencyName => scheduledPackageNames.has(dependencyName));
		edges.set(manifest.name, producers);
	}

	return { scheduledPackageNames, edges };
}

/** Mirrors Bun's own `hasCycle` in `src/cli/filter_run.zig`: DFS with visiting/visited marks. */
function findCycle(edges: Map<string, string[]>): string[] | null {
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(node: string, path: string[]): string[] | null {
		visiting.add(node);
		path.push(node);
		for (const producer of edges.get(node) ?? []) {
			if (visiting.has(producer)) return [...path, producer];
			if (!visited.has(producer)) {
				const cycle = visit(producer, path);
				if (cycle) return cycle;
			}
		}
		path.pop();
		visiting.delete(node);
		visited.add(node);
		return null;
	}

	for (const node of edges.keys()) {
		if (visited.has(node)) continue;
		const cycle = visit(node, []);
		if (cycle) return cycle;
	}
	return null;
}

describe("workspace build dependency graph stays acyclic", () => {
	test("no dependency cycle among build-lifecycle-scheduled @gajae-code/* packages", async () => {
		const { scheduledPackageNames, edges } = await readWorkspaceBuildGraph();

		// Sanity: the graph must actually contain the packages this regression
		// exists to protect (otherwise the test would pass vacuously).
		expect(scheduledPackageNames.has("@gajae-code/natives")).toBe(true);
		expect(scheduledPackageNames.has("@gajae-code/coding-agent")).toBe(true);
		expect(edges.get("@gajae-code/coding-agent")).toContain("@gajae-code/natives");

		const cycle = findCycle(edges);
		if (cycle) {
			throw new Error(
				`Dependency cycle detected among build-lifecycle-scheduled @gajae-code/* packages: ${cycle.join(" -> ")}. ` +
					"Bun's workspace-script scheduler disables build ordering for every scheduled package " +
					"in a run when any cycle exists among them, which silently turns `bun run build` into an " +
					"unordered race (see packages/coding-agent's build shelling into `bun --cwd=../natives run " +
					"embed:native`). Break this cycle instead of relying on `--workspaces`/`--filter` CLI spelling.",
			);
		}
	});
});
