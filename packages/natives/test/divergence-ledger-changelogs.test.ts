import { expect, test } from "bun:test";
import * as path from "node:path";
import { Glob } from "bun";

const repoRoot = path.resolve(import.meta.dir, "../../..");

function changelogReferences(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(changelogReferences);
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, entry]) => {
		if (key !== "changelog") return changelogReferences(entry);
		return typeof entry === "string"
			? [entry]
			: Array.isArray(entry)
				? entry.filter(item => typeof item === "string")
				: [];
	});
}

// Release folds and deletes `changelog.d/` fragments, so a divergence ledger that
// cites one breaks on the first release after it lands. Ledgers cite the package
// CHANGELOG.md, which keeps released notes permanently.
test("accepted-divergence ledgers cite durable package changelogs", async () => {
	const ledgers = await Array.fromAsync(
		new Glob("packages/*/test/fixtures/goldens/**/accepted-divergences.json").scan({ cwd: repoRoot }),
	);
	expect(ledgers.length).toBeGreaterThan(0);

	const references: string[] = [];
	for (const ledger of ledgers) {
		for (const reference of changelogReferences(await Bun.file(path.join(repoRoot, ledger)).json())) {
			references.push(reference);
			expect(reference, `${ledger} cites a release-consumed fragment`).toMatch(/^packages\/[^/]+\/CHANGELOG\.md$/);
			expect(await Bun.file(path.join(repoRoot, reference)).exists(), `${ledger} -> ${reference}`).toBe(true);
		}
	}
	expect(references.length).toBeGreaterThan(0);
});
