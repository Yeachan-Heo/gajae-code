import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * Regression for https://github.com/can1357/gajae-code/issues/1011
 *
 * In v14.5.13 `spawnTabWorker` (in `src/tools/browser/tab-supervisor.ts`)
 * resolved the worker entry as `new URL("./tab-worker-entry.ts", import.meta.url)`
 * and passed `.href` to `new Worker(...)`. Bun's `--compile` static analyzer
 * cannot discover that pattern, so the entry was never embedded in the
 * single-file binary and the runtime symptom was "Timed out initializing
 * browser tab worker".
 *
 * The original fix used an `import "./worker.ts" with { type: "file" }`
 * trick. That copied the entry as a raw asset but could not resolve its
 * relative imports inside the compiled binary, so the worker still failed
 * to load (issue #1027 was the same root cause, retriggered).
 *
 * The working pattern documented in AGENTS.md is a two-part contract:
 *
 *   1. `spawnTabWorker` branches on `isCompiledBinary()` and uses a literal
 *      string path under `--compile`. Bun's `--compile` analyzer discovers
 *      that literal at the `new Worker("...", ...)` call site. The path is
 *      `--root`-relative (`./packages/coding-agent/src/...`) because the
 *      build script passes `--root ../..`.
 *   2. `scripts/build-binary.ts` lists the worker as an explicit additional
 *      `--compile` entrypoint. Without this, Bun sees the literal at the
 *      spawn site but never emits the worker module into bunfs.
 *
 * Either half alone is insufficient — both must agree on the exact path.
 * Runtime end-to-end coverage lives in `gjc --smoke-test` (via the stats
 * sync worker). This test is the cheap static contract that catches an
 * accidental regression of either half in code review / CI.
 */
describe("issue #1011 — tab worker entry must survive `bun build --compile`", () => {
	const packageDir = path.resolve(import.meta.dir, "..");
	const supervisorPath = path.join(packageDir, "src/tools/browser/tab-supervisor.ts");
	const compileArgsPath = path.join(packageDir, "scripts/compile-args.ts");
	// `--root` is `../..` from packages/coding-agent, so the literal that
	// matches at runtime inside the compiled bunfs is repo-relative.
	const compiledLiteral = "./packages/coding-agent/src/tools/browser/tab-worker-entry.ts";
	// The build script's cwd is packages/coding-agent, so its entrypoint
	// path is package-relative.
	const buildEntrypoint = "./src/tools/browser/tab-worker-entry.ts";

	it("tab-supervisor uses the isCompiledBinary() hybrid spawn pattern with a static literal", async () => {
		const source = await Bun.file(supervisorPath).text();

		// The exact literal at the `new Worker(...)` call must be present
		// and discoverable to Bun's `--compile` static analyzer.
		expect(
			source.includes(`new Worker("${compiledLiteral}"`),
			`tab-supervisor.ts must spawn the worker with the literal "${compiledLiteral}" so Bun's --compile analyzer can embed it`,
		).toBe(true);

		// And the dev-mode branch should keep the portable import.meta.url
		// form so spawns work outside of compiled binaries too.
		expect(
			/new Worker\(\s*new URL\("\.\/tab-worker-entry\.ts",\s*import\.meta\.url\)/.test(source),
			"tab-supervisor.ts must keep a `new URL('./tab-worker-entry.ts', import.meta.url)` branch for dev/source spawns",
		).toBe(true);

		// And the branching must come from `isCompiledBinary()` — not, say,
		// a hard-coded check, an env var, or a renamed helper.
		expect(
			source.includes("isCompiledBinary()"),
			"tab-supervisor.ts must select the spawn pattern via isCompiledBinary()",
		).toBe(true);
	});

	it("compile args list tab-worker-entry as an explicit --compile entrypoint", async () => {
		const source = await Bun.file(compileArgsPath).text();
		expect(
			source.includes(`"${buildEntrypoint}"`),
			`scripts/compile-args.ts must include "${buildEntrypoint}" as an explicit --compile entrypoint so Bun emits the worker into bunfs`,
		).toBe(true);
	});
});
