import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WalkerPoolFixture {
	base: string;
	root: string;
	warmRoot: string;
	readyFile: string;
	startFile: string;
	resultFile: string;
}

export async function createWalkerPoolFixture(): Promise<WalkerPoolFixture> {
	const base = path.join(import.meta.dir, `.walker-pool-unavailable-${crypto.randomUUID()}`);
	const root = path.join(base, "tree");
	const warmRoot = path.join(base, "warm");
	await fs.mkdir(root, { recursive: true });
	await fs.mkdir(warmRoot, { recursive: true });
	await fs.writeFile(path.join(warmRoot, "warm.txt"), "warm\n");

	for (let index = 0; index < 512; index++) {
		const name = `flat-${String(index).padStart(3, "0")}.txt`;
		await fs.writeFile(path.join(root, name), "flat\n");
	}
	for (let index = 0; index < 300; index++) {
		const directory = path.join(root, `dir-${String(index).padStart(3, "0")}`);
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, "nested-a.txt"), "nested\n");
		await fs.writeFile(path.join(directory, "nested-b.txt"), "nested\n");
	}

	return {
		base,
		root,
		warmRoot,
		readyFile: path.join(base, "ready.json"),
		startFile: path.join(base, "start"),
		resultFile: path.join(base, "result.json"),
	};
}

export async function removeWalkerPoolFixture(fixture: WalkerPoolFixture): Promise<void> {
	await fs.rm(fixture.base, { recursive: true, force: true });
}
