import * as fsSync from "node:fs";
import * as path from "node:path";

/**
 * Issue #4545 dependency probe: the finally/diagnostic masking contract is only
 * implementable once the PR #4459 durability module
 * (packages/coding-agent/src/coordinator-mcp/durability.ts) exists on this
 * branch.
 *
 * While #4459 is unmerged, its production semantics are absent from dev by
 * design — this lane must not duplicate them. The masking suites therefore run
 * their full AggregateError/primary-preservation assertions only when the
 * dependency is present (`skipIf(!available)`) and emit a visible skip notice
 * otherwise. The moment #4459 lands (or is cherry-picked), the same tests
 * activate at full strength and pin the contract, so a later refactor that
 * reintroduces `finally { await close() }` masking fails CI immediately.
 */
export function coordinatorDurabilityAvailable(): boolean {
	// File existence rather than module resolution: extension-less resolution of
	// a not-yet-imported module is unreliable inside the bun test transpiled
	// graph; a plain path probe is deterministic on every runner.
	const durabilityPath = path.join(import.meta.dir, "..", "..", "src", "coordinator-mcp", "durability.ts");
	return fsSync.existsSync(durabilityPath);
}
