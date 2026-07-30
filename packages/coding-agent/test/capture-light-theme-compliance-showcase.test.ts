import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCaptureOutputPath } from "../scripts/capture-light-theme-compliance-showcase";

const tempRoots: string[] = [];

async function makeTempRepo(prefix = "capture-output-path-"): Promise<{
	repoRoot: string;
	homeDir: string;
	qaRoot: string;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const repoRoot = path.join(root, "repo");
	const homeDir = path.join(root, "home");
	const qaRoot = path.join(repoRoot, ".gjc", "qa");
	await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
	await fs.mkdir(qaRoot, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	return { repoRoot, homeDir, qaRoot };
}

async function writeMarker(target: string, content = "keep-me"): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, content);
}

async function expectRejectedAndPreserved(
	args: string[],
	repoRoot: string,
	homeDir: string,
	markerPath: string,
	markerContent = "keep-me",
): Promise<void> {
	await expect(resolveCaptureOutputPath(args, repoRoot, homeDir)).rejects.toThrow(
		/Usage:|Refusing capture output path/,
	);
	expect(await Bun.file(markerPath).text()).toBe(markerContent);
}

describe("resolveCaptureOutputPath", () => {
	afterEach(async () => {
		while (tempRoots.length > 0) {
			const root = tempRoots.pop();
			if (!root) continue;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects filesystem root before any deletion", async () => {
		const { repoRoot, homeDir } = await makeTempRepo();
		const markerPath = path.join(repoRoot, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved(["--output", "/"], repoRoot, homeDir, markerPath);
	});

	it("rejects repository root", async () => {
		const { repoRoot, homeDir } = await makeTempRepo();
		const markerPath = path.join(repoRoot, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved(["--output", repoRoot], repoRoot, homeDir, markerPath);
	});

	it("rejects home directory", async () => {
		const { repoRoot, homeDir } = await makeTempRepo();
		const markerPath = path.join(homeDir, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved(["--output", homeDir], repoRoot, homeDir, markerPath);
	});

	it("rejects .git and paths under .git", async () => {
		const { repoRoot, homeDir } = await makeTempRepo();
		const gitDir = path.join(repoRoot, ".git");
		const nestedGit = path.join(gitDir, "objects");
		const markerPath = path.join(gitDir, "HEAD");
		await writeMarker(markerPath, "ref: refs/heads/main");
		await fs.mkdir(nestedGit, { recursive: true });
		await expectRejectedAndPreserved(["--output", gitDir], repoRoot, homeDir, markerPath, "ref: refs/heads/main");
		await expectRejectedAndPreserved(["--output", nestedGit], repoRoot, homeDir, markerPath, "ref: refs/heads/main");
	});

	it("rejects the QA root itself", async () => {
		const { repoRoot, homeDir, qaRoot } = await makeTempRepo();
		const markerPath = path.join(qaRoot, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved(["--output", qaRoot], repoRoot, homeDir, markerPath);
		await expectRejectedAndPreserved(["--output", ".gjc/qa"], repoRoot, homeDir, markerPath);
	});

	it("rejects outside and ancestor paths", async () => {
		const { repoRoot, homeDir, qaRoot } = await makeTempRepo();
		const outside = path.join(path.dirname(repoRoot), "outside-corpus");
		const markerOutside = path.join(outside, "marker.txt");
		const markerInside = path.join(qaRoot, "marker.txt");
		await writeMarker(markerOutside);
		await writeMarker(markerInside);
		await expectRejectedAndPreserved(["--output", outside], repoRoot, homeDir, markerOutside);
		await expectRejectedAndPreserved(["--output", path.join(repoRoot, ".gjc")], repoRoot, homeDir, markerInside);
		await expectRejectedAndPreserved(["--output", path.join(repoRoot, "packages")], repoRoot, homeDir, markerInside);
	});

	it("rejects lexical .. aliases", async () => {
		const { repoRoot, homeDir, qaRoot } = await makeTempRepo();
		const markerPath = path.join(qaRoot, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved(["--output", ".gjc/qa/../qa/escape"], repoRoot, homeDir, markerPath);
		await expectRejectedAndPreserved(
			["--output", `${qaRoot}${path.sep}..${path.sep}qa${path.sep}escape`],
			repoRoot,
			homeDir,
			markerPath,
		);
	});

	it("rejects symlinked .gjc, qa, and nested output escapes", async () => {
		const { repoRoot, homeDir } = await makeTempRepo("capture-output-symlink-");
		const external = path.join(path.dirname(repoRoot), "external-target");
		await fs.mkdir(external, { recursive: true });
		const externalMarker = path.join(external, "marker.txt");
		await writeMarker(externalMarker);

		// Symlinked .gjc component
		const repoA = path.join(path.dirname(repoRoot), "repo-symlink-gjc");
		tempRoots.push(repoA);
		await fs.mkdir(path.join(repoA, ".git"), { recursive: true });
		await fs.symlink(path.join(repoRoot, ".gjc"), path.join(repoA, ".gjc"));
		await expectRejectedAndPreserved(["--output", ".gjc/qa/corpus"], repoA, homeDir, externalMarker);

		// Symlinked qa component
		const repoB = path.join(path.dirname(repoRoot), "repo-symlink-qa");
		tempRoots.push(repoB);
		await fs.mkdir(path.join(repoB, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoB, ".gjc"), { recursive: true });
		await fs.symlink(path.join(repoRoot, ".gjc", "qa"), path.join(repoB, ".gjc", "qa"));
		await expectRejectedAndPreserved(["--output", ".gjc/qa/corpus"], repoB, homeDir, externalMarker);

		// Nested output path that is itself a symlink escape
		const repoC = path.join(path.dirname(repoRoot), "repo-symlink-nested");
		tempRoots.push(repoC);
		const nestedQa = path.join(repoC, ".gjc", "qa");
		await fs.mkdir(path.join(repoC, ".git"), { recursive: true });
		await fs.mkdir(nestedQa, { recursive: true });
		const nestedLink = path.join(nestedQa, "escape-link");
		await fs.symlink(external, nestedLink);
		await expectRejectedAndPreserved(["--output", nestedLink], repoC, homeDir, externalMarker);
		await expectRejectedAndPreserved(["--output", path.join(nestedLink, "child")], repoC, homeDir, externalMarker);
	});

	it("rejects malformed args", async () => {
		const { repoRoot, homeDir, qaRoot } = await makeTempRepo();
		const markerPath = path.join(qaRoot, "marker.txt");
		await writeMarker(markerPath);
		await expectRejectedAndPreserved([], repoRoot, homeDir, markerPath);
		await expectRejectedAndPreserved(["--output"], repoRoot, homeDir, markerPath);
		await expectRejectedAndPreserved(["--out", ".gjc/qa/corpus"], repoRoot, homeDir, markerPath);
		await expectRejectedAndPreserved(["--output", ".gjc/qa/corpus", "extra"], repoRoot, homeDir, markerPath);
	});

	it("accepts a valid nested .gjc/qa/<corpus> path without deleting anything", async () => {
		const { repoRoot, homeDir, qaRoot } = await makeTempRepo();
		const corpus = path.join(qaRoot, "gjc-light-theme-compliance", "current");
		const sibling = path.join(qaRoot, "sibling-corpus", "marker.txt");
		await writeMarker(sibling, "sibling-safe");
		await fs.mkdir(corpus, { recursive: true });
		await Bun.write(path.join(corpus, "stale.txt"), "old-capture");

		const relativeResolved = await resolveCaptureOutputPath(
			["--output", ".gjc/qa/gjc-light-theme-compliance/current"],
			repoRoot,
			homeDir,
		);
		const absoluteResolved = await resolveCaptureOutputPath(["--output", corpus], repoRoot, homeDir);

		expect(relativeResolved).toBe(corpus);
		expect(absoluteResolved).toBe(corpus);
		expect(await Bun.file(path.join(corpus, "stale.txt")).text()).toBe("old-capture");
		expect(await Bun.file(sibling).text()).toBe("sibling-safe");
	});
});
