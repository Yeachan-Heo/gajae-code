import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
// "hooks.md" is intentionally absent: the canonical hook-event feature
// (feat(hooks) canonical hook event IR + normalization adapters) re-added the
// doc after this cleanup list was written, so expecting it removed would fail
// on current dev (the follow-up branch rebased onto dev inherits the state).
const removedDocs = [
	"custom-tools.md",
	"extension-loading.md",
	"extensions.md",
	"gemini-manifest-extensions.md",
	"marketplace.md",
	"plugin-manager-installer-plumbing.md",
	// "skills.md" is intentionally absent: the skill zero-code discovery feature
	// (#4349) re-added the doc after this cleanup list was written.
	"slash-command-internals.md",
	"task-agent-discovery.md",
] as const;

describe("GJC docs utility surface cleanup", () => {
	it("removes standalone utility feature docs", async () => {
		for (const fileName of removedDocs) {
			expect(await Bun.file(path.join(repoRoot, "docs", fileName)).exists()).toBe(false);
		}
		expect(await Bun.file(path.join(repoRoot, "docs", "skills", "authoring-extensions.md")).exists()).toBe(false);
	});

	it("removes removed utility docs from the embedded docs index", async () => {
		const generated = await Bun.file(
			path.join(repoRoot, "packages", "coding-agent", "src", "internal-urls", "docs-index.generated.ts"),
		).text();
		for (const fileName of removedDocs) {
			expect(generated).not.toContain(`"${fileName}"`);
		}
		expect(generated).not.toContain("authoring-extensions");
		expect(generated).not.toContain("/marketplace");
		expect(generated).not.toContain("mcp://");
		expect(generated).not.toContain("mcp-only");
	});
});
