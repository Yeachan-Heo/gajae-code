export interface CompileArgOptions {
	root: string;
	entrypoints: string[];
	outfile: string;
	target?: string;
	defines?: string[];
	externals?: string[];
}

export const compileAutoloadDisableFlags = [
	"--no-compile-autoload-bunfig",
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-tsconfig",
	"--no-compile-autoload-package-json",
];

const compiledDefineFlags = ['process.env.PI_COMPILED="true"'];
const releaseDefineFlags = [...compiledDefineFlags, 'process.env.GJC_BUILD_CHANNEL="release"'];
const devDefineFlags = [...compiledDefineFlags, 'process.env.GJC_BUILD_CHANNEL="dev"'];

export const compiledExternalPackages = ["mupdf"];

export const releaseEntrypoints = [
	"./packages/coding-agent/src/cli.ts",
	"./packages/stats/src/sync-worker.ts",
	"./packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
	"./packages/coding-agent/src/eval/js/worker-entry.ts",
	"./packages/natives/native/index.js",
	"./packages/coding-agent/src/sdk/bus/telegram-daemon-cli.ts",
	"./packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts",
	// NOTE: models.json must NOT be listed here — `bun build --compile` does not
	// emit `.json` extra entrypoints into the bunfs. It is embedded via the
	// `with { type: "file" }` import in packages/ai/src/models.ts instead.
	// NOTE: handlebars must NOT be listed here either — the extra entrypoint
	// silently vanished from minified bundles and crashed v0.9.3–v0.9.6
	// releases at startup (#1939). It is bundled via the statically-traceable
	// `require("handlebars")` in packages/utils/src/prompt.ts instead.
];

export const devEntrypoints = [
	"./src/cli.ts",
	"../stats/src/sync-worker.ts",
	"./src/tools/browser/tab-worker-entry.ts",
	"./src/eval/js/worker-entry.ts",
	"./src/sdk/bus/telegram-daemon-cli.ts",
	"./src/sdk/bus/chat-daemon-cli.ts",
];

export function buildReleaseCompileArgs(target: string, outfile: string): string[] {
	return buildCompileArgs({
		root: ".",
		entrypoints: releaseEntrypoints,
		outfile,
		target,
		defines: releaseDefineFlags,

		externals: compiledExternalPackages,
	});
}

export function buildDevCompileArgs(outfile = "dist/gjc"): string[] {
	return buildCompileArgs({
		root: "../..",
		entrypoints: devEntrypoints,
		outfile,
		defines: devDefineFlags,
		externals: compiledExternalPackages,
	});
}

export function buildCompileArgs(options: CompileArgOptions): string[] {
	const args = [
		"bun",
		"build",
		"--compile",
		// Minify shrinks the bundled JS the compiled binary must parse at
		// startup (302MB → ~114MB --help RSS measured on darwin-arm64).
		// --keep-names below preserves identifiers for error reports.
		// SAFE with handlebars since #1939: the module is bundled via a
		// statically-traceable require in packages/utils/src/prompt.ts, not a
		// bunfs extra entrypoint (which --minify silently dropped, crashing
		// v0.9.3–v0.9.6 releases at startup).
		"--minify",
		...compileAutoloadDisableFlags,
		"--keep-names",
	];

	for (const define of options.defines ?? []) {
		args.push("--define", define);
	}

	args.push("--root", options.root);

	for (const external of options.externals ?? []) {
		args.push("--external", external);
	}

	if (options.target) {
		args.push("--target", options.target);
	}

	args.push(...options.entrypoints, "--outfile", options.outfile);
	return args;
}
