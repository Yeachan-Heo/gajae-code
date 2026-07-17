import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * AGENTS.md forbids `ReturnType<>`: "write the actual type name." Inferred
 * return types create hidden coupling between call sites and callee signatures
 * and obscure the concrete type a variable holds.
 *
 * This test guards the source files touched by the returntype-allowlist refactor
 * so the `ReturnType<` pattern cannot silently return. `commands/harness.ts` is
 * intentionally excluded (out of scope for that change).
 */

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(PACKAGE_ROOT, "src");

/**
 * Explicit allowlist of source files covered by the refactor. Each file was
 * audited and converted from `ReturnType<typeof ...>` to a named concrete type.
 */
const COVERED_FILES = [
	"cli/setup-cli.ts",
	"commands/launch.ts",
	"gjc-runtime/launch-worktree.ts",
	"sdk/broker/broker.ts",
	"sdk/broker/lifecycle.ts",
	"sdk/broker/transport.ts",
] as const;

const RETURN_TYPE_PATTERN = /\bReturnType\s*</g;

describe("ReturnType allowlist", () => {
	it("touched source files use named concrete types instead of ReturnType<>", async () => {
		const violations: string[] = [];

		for (const relativeFile of COVERED_FILES) {
			const filePath = path.join(SRC_ROOT, relativeFile);
			const source = await Bun.file(filePath).text();

			for (const match of source.matchAll(RETURN_TYPE_PATTERN)) {
				const line = source.slice(0, match.index ?? 0).split("\n").length;
				violations.push(`${relativeFile}:${line}`);
			}
		}

		expect(violations).toEqual([]);
	});

	it("harness.ts remains out of scope and is not accidentally covered", async () => {
		const harnessPath = path.join(SRC_ROOT, "commands", "harness.ts");
		const harnessSource = await Bun.file(harnessPath).text();

		// Sanity: harness.ts still uses ReturnType (untouched by design) and is
		// not in COVERED_FILES, proving the allowlist is bounded to the refactor.
		expect(COVERED_FILES).not.toContain("commands/harness.ts");
		expect(RETURN_TYPE_PATTERN.test(harnessSource)).toBe(true);
	});
});
