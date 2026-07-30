import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEvidenceArchive,
	extractEvidenceArchive,
	lightThemeEvidenceReleaseUrl,
	resolveEvidenceOutputRoot,
	validateEvidenceArchivePaths,
	validateEvidenceArchiveSizes,
} from "../scripts/ci-light-theme-evidence";

const ENTRY_FILENAMES = [
	"metadata.json",
	"terminal-ansi.txt",
	"terminal.html",
	"terminal.png",
	"terminal.txt",
] as const;
const ROOT_FILENAMES = [
	"capture-environment.json",
	"independent-review.json",
	"manifest.json",
	"review-input.json",
	"run-receipt.json",
] as const;
const temporaryRoots: string[] = [];

function canonicalArchivePaths(): string[] {
	const paths: string[] = [...ROOT_FILENAMES];
	for (let index = 0; index < 180; index += 1) {
		const theme = index < 90 ? "blue-crab-light" : "red-claw-light";
		const entry = `${theme}/scene-${index.toString().padStart(3, "0")}/80x24/unicode-color`;
		for (const filename of ENTRY_FILENAMES) paths.push(`${entry}/${filename}`);
	}
	return paths;
}

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "light-theme-evidence-ci-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	while (temporaryRoots.length > 0) {
		const root = temporaryRoots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("light-theme evidence CI transport", () => {
	it("binds downloads to a canonical repository and exact 40-hex revision", () => {
		const revision = "a".repeat(40);
		expect(lightThemeEvidenceReleaseUrl("owner/repository", revision)).toBe(
			`https://github.com/owner/repository/releases/download/light-theme-evidence-${revision}/gjc-light-theme-compliance.tar.gz`,
		);
		expect(() => lightThemeEvidenceReleaseUrl("owner/repository/extra", revision)).toThrow(
			"Invalid evidence repository",
		);
		expect(() => lightThemeEvidenceReleaseUrl("owner/repository", "main")).toThrow("Invalid evidence revision");
	});

	it("requires the exact 180-entry, 900-leaf archive shape", () => {
		const paths = canonicalArchivePaths();
		expect(() => validateEvidenceArchivePaths(paths)).not.toThrow();

		const traversal = [...paths];
		traversal[5] = `../${traversal[5]}`;
		expect(() => validateEvidenceArchivePaths(traversal)).toThrow("Unsafe evidence archive path");

		const missingControl = paths.filter(candidate => candidate !== "independent-review.json");
		expect(() => validateEvidenceArchivePaths(missingControl)).toThrow("exactly 905 unique files");

		const incompleteEntry = [...paths];
		incompleteEntry[5] = "blue-crab-light/scene-000/80x24/unicode-color/unexpected.txt";
		expect(() => validateEvidenceArchivePaths(incompleteEntry)).toThrow("Invalid evidence entry path");
	});

	it("bounds extracted bytes independently of compressed archive size", () => {
		expect(() => validateEvidenceArchiveSizes([1, 2, 3])).not.toThrow();
		expect(() => validateEvidenceArchiveSizes([300 * 1024 * 1024, 300 * 1024 * 1024])).toThrow(
			"extracted size exceeds the limit",
		);
		expect(() => validateEvidenceArchiveSizes([Number.MAX_SAFE_INTEGER])).toThrow("invalid or oversized file");
	});

	it("rejects output aliases, existing paths, and symlink components", async () => {
		const runnerTemp = await makeTempRoot();
		const valid = path.join(runnerTemp, "evidence", "exact-head");
		expect(await resolveEvidenceOutputRoot(valid, runnerTemp)).toBe(valid);
		await fs.mkdir(valid, { recursive: true });
		await expect(resolveEvidenceOutputRoot(valid, runnerTemp)).rejects.toThrow("already exists");
		await expect(resolveEvidenceOutputRoot(path.join(runnerTemp, "..", "escape"), runnerTemp)).rejects.toThrow(
			"strict descendant",
		);
		await expect(resolveEvidenceOutputRoot(path.join(runnerTemp, "line\nbreak"), runnerTemp)).rejects.toThrow(
			"strict descendant",
		);

		const external = await makeTempRoot();
		const link = path.join(runnerTemp, "linked");
		await fs.symlink(external, link);
		await expect(resolveEvidenceOutputRoot(path.join(link, "corpus"), runnerTemp)).rejects.toThrow(
			"symlink component",
		);
	});

	it("archives and extracts only validated regular files", async () => {
		const root = await makeTempRoot();
		const source = path.join(root, "source");
		for (const relativePath of canonicalArchivePaths()) {
			const target = path.join(source, ...relativePath.split("/"));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await Bun.write(target, relativePath);
		}
		const archivePath = path.join(root, "evidence.tar.gz");
		await createEvidenceArchive(source, archivePath);
		const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
		const runnerTemp = path.join(root, "runner");
		await fs.mkdir(runnerTemp);
		const destination = await extractEvidenceArchive(bytes, path.join(runnerTemp, "evidence"), runnerTemp);
		expect(await Bun.file(path.join(destination, "manifest.json")).text()).toBe("manifest.json");
		expect(
			await Bun.file(
				path.join(destination, "red-claw-light", "scene-179", "80x24", "unicode-color", "terminal.png"),
			).text(),
		).toContain("red-claw-light/scene-179");
	});
});
