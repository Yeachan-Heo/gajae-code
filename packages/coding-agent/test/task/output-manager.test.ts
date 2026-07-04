import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentOutputManager } from "../../src/task/output-manager";

const tempDirs: string[] = [];

async function makeArtifactsDir(existing: string[]): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-output-manager-"));
	tempDirs.push(dir);
	for (const file of existing) await fs.writeFile(path.join(dir, file), "x");
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("AgentOutputManager", () => {
	it("continues past existing outputs so resume does not overwrite", async () => {
		const dir = await makeArtifactsDir(["0-Foo.md", "1-Bar.md", "2-Baz.md"]);
		const mgr = new AgentOutputManager(() => dir);
		expect(await mgr.allocateBatch(["Alpha", "Beta"])).toEqual(["3-Alpha", "4-Beta"]);
	});

	it("does not reuse or duplicate ids when allocations race on a shared instance", async () => {
		// Regression: #ensureInitialized previously set a boolean flag BEFORE the
		// awaited readdir, so a second concurrent allocate short-circuited init and
		// allocated at #nextId === 0 while the first scan was still in flight —
		// colliding with existing 0-/1-/2- outputs and duplicating indices across
		// the two batches. The memoized init promise makes both awaits share one
		// scan, so #nextId is derived before either allocates.
		const dir = await makeArtifactsDir(["0-Foo.md", "1-Bar.md", "2-Baz.md"]);
		const mgr = new AgentOutputManager(() => dir);

		const [first, second] = await Promise.all([mgr.allocateBatch(["Alpha"]), mgr.allocateBatch(["Beta"])]);
		const indices = [...first, ...second].map(id => Number.parseInt(id.split("-")[0] ?? "", 10));

		// Every id continues past the existing 0/1/2 outputs...
		expect(indices.every(index => index >= 3)).toBe(true);
		// ...and no two allocations collide.
		expect(new Set(indices).size).toBe(indices.length);
	});

	it("keeps peekNextIndex consistent with concurrent allocation", async () => {
		const dir = await makeArtifactsDir(["0-Foo.md", "1-Bar.md", "2-Baz.md"]);
		const mgr = new AgentOutputManager(() => dir);

		const [peeked, allocated] = await Promise.all([mgr.peekNextIndex(), mgr.allocate("Alpha")]);
		// peek observes the scanned cursor, not the pre-scan default of 0.
		expect(peeked).toBeGreaterThanOrEqual(3);
		expect(Number.parseInt(allocated.split("-")[0] ?? "", 10)).toBeGreaterThanOrEqual(3);
	});
});
