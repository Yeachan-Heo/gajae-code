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

export const compiledDefineFlags = ['process.env.PI_COMPILED="true"'];
export const compiledExternalPackages = ["mupdf"];

export const releaseEntrypoints = [
	"./packages/coding-agent/src/cli.ts",
	"./packages/stats/src/sync-worker.ts",
	"./packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
	"./packages/coding-agent/src/eval/js/worker-entry.ts",
	"./packages/natives/native/index.js",
	"./packages/coding-agent/src/notifications/telegram-daemon-cli.ts",
	"./packages/ai/src/models.json",
	"./node_modules/handlebars/lib/index.js",
];

export const devEntrypoints = [
	"./src/cli.ts",
	"../stats/src/sync-worker.ts",
	"./src/tools/browser/tab-worker-entry.ts",
	"./src/eval/js/worker-entry.ts",
	"./src/notifications/telegram-daemon-cli.ts",
	"../ai/src/models.json",
	"../../node_modules/handlebars/lib/index.js",
];

export function buildReleaseCompileArgs(target: string, outfile: string): string[] {
	return buildCompileArgs({
		root: ".",
		entrypoints: releaseEntrypoints,
		outfile,
		target,
		defines: compiledDefineFlags,
		externals: compiledExternalPackages,
	});
}

export function buildDevCompileArgs(outfile = "dist/gjc"): string[] {
	return buildCompileArgs({
		root: "../..",
		entrypoints: devEntrypoints,
		outfile,
		defines: compiledDefineFlags,
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
