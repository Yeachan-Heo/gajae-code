import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Source-level ownership gate for the transient status slot.
 *
 * Every transient loader install/teardown must go through StatusArea
 * (addLoader/removeLoader) so the reserved row budget survives and sibling
 * status components are never dropped. `statusContainer.clear()` is reserved
 * for whole-session resets. This gate pins both rules so a new call site
 * cannot silently bypass the ownership contract: adding a legitimate
 * full-session reset requires updating the allowlist below with its
 * classification.
 */
const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

/** file (relative to src) -> expected number of full-session-reset clears */
const CLEAR_ALLOWLIST = new Map<string, number>([
	// New session (/new, /clear), context clear, and fork all rebuild the
	// entire transcript identity.
	["modes/controllers/command-controller.ts", 3],
	// Extension-driven session switch flows reset the whole session UI.
	["modes/controllers/extension-ui-controller.ts", 2],
	// Interactive-mode dispose/shutdown.
	["modes/controllers/input-controller.ts", 1],
	// Session switching via the sessions selector replaces the transcript.
	["modes/controllers/selector-controller.ts", 1],
]);

/** Only StatusArea itself may install children into the status container. */
const ADD_CHILD_ALLOWLIST = new Set<string>(["modes/status-area.ts"]);

function countMatches(text: string, pattern: RegExp): number {
	let count = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trimStart();
		// Doc comments may reference the pattern when documenting the policy.
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
		count += line.match(pattern)?.length ?? 0;
	}
	return count;
}

async function collectSourceFiles(): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const glob = new Bun.Glob("**/*.ts");
	for await (const relative of glob.scan({ cwd: SRC_ROOT })) {
		files.set(relative, await Bun.file(path.join(SRC_ROOT, relative)).text());
	}
	return files;
}

describe("status area ownership gate", () => {
	it("statusContainer.clear() appears only in classified full-session resets", async () => {
		const files = await collectSourceFiles();
		expect(files.size).toBeGreaterThan(100);
		for (const [relative, text] of files) {
			const clears = countMatches(text, /statusContainer\.clear\(\)/g);
			const allowed = CLEAR_ALLOWLIST.get(relative) ?? 0;
			expect(
				clears,
				`${relative}: statusContainer.clear() must only be used for whole-session resets; ` +
					"transient loader teardown goes through StatusArea.removeLoader (update the allowlist " +
					"with a classification if this is a genuine new session reset)",
			).toBe(allowed);
		}
	});

	it("only StatusArea installs children into the status container", async () => {
		const files = await collectSourceFiles();
		for (const [relative, text] of files) {
			if (ADD_CHILD_ALLOWLIST.has(relative)) continue;
			expect(
				countMatches(text, /statusContainer\.addChild\(/g),
				`${relative}: install transient loaders with StatusArea.addLoader so their rows are reserved`,
			).toBe(0);
		}
	});
});
