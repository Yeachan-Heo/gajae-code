import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Args, Command, type CommandEntry, Flags } from "@gajae-code/utils/cli";
import { commands, RootHelpCommand } from "../src/cli";
import {
	buildGjcFigSpec,
	defaultInshellisenseSpecDir,
	type FigName,
	type FigOption,
	type FigSpec,
	installGjcInshellisenseSpec,
	renderFigSpecModule,
} from "../src/cli/completion-cli";

const tempDirs: string[] = [];

class FakeRoot extends Command {
	static hidden = true;
	static description = "Fake root command";
	static args = {
		messages: Args.string({ description: "Prompt text", required: false, multiple: true }),
	};
	static flags = {
		model: Flags.string({ description: "Model id" }),
		print: Flags.boolean({ char: "p", description: "Print mode" }),
		thinking: Flags.string({ description: "Thinking effort", options: ["low", "high"] }),
	};

	async run(): Promise<void> {}
}

class FakeWebSearch extends Command {
	static description = "Search the web";
	static args = {
		query: Args.string({ description: "Search query", required: false, multiple: true }),
	};
	static flags = {
		provider: Flags.string({ description: "Search provider", options: ["auto", "duckduckgo", "insane"] }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {}
}

function fakeEntries(): CommandEntry[] {
	return [
		{ name: "web-search", aliases: ["q"], load: async () => FakeWebSearch },
		{ name: "launch", load: async () => FakeRoot },
	];
}

function names(value: FigName): string[] {
	return Array.isArray(value) ? value : [value];
}

function findOption(options: FigOption[] | undefined, expectedName: string): FigOption | undefined {
	return options?.find(option => names(option.name).includes(expectedName));
}

function findSubcommand(spec: FigSpec, expectedName: string) {
	return spec.subcommands?.find(command => names(command.name).includes(expectedName));
}

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-completion-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("GJC inshellisense completion spec", () => {
	it("maps command aliases, root flags, option args, and variadic args into Fig shape", async () => {
		const spec = await buildGjcFigSpec(fakeEntries());

		expect(spec.name).toBe("gjc");
		expect(spec.description).toBe("Fake root command");
		expect(findOption(spec.options, "--model")?.args).toEqual({ name: "value" });
		expect(findOption(spec.options, "-p")?.description).toBe("Print mode");
		expect(findOption(spec.options, "--thinking")?.args?.suggestions).toEqual(["low", "high"]);
		expect(spec.args).toEqual({ name: "messages", description: "Prompt text", isOptional: true, isVariadic: true });

		const webSearch = findSubcommand(spec, "web-search");
		expect(webSearch).toBeDefined();
		expect(names(webSearch!.name)).toEqual(["web-search", "q"]);
		expect(findOption(webSearch!.options, "--provider")?.args).toEqual({
			name: "provider",
			suggestions: ["auto", "duckduckgo", "insane"],
		});
		expect(webSearch!.args).toEqual({
			name: "query",
			description: "Search query",
			isOptional: true,
			isVariadic: true,
		});
	});

	it("keeps command-name completion available when optional command metadata cannot load", async () => {
		const spec = await buildGjcFigSpec([
			{ name: "native-only", aliases: ["native"], load: async () => Promise.reject(new Error("missing native")) },
			{ name: "launch", load: async () => FakeRoot },
		]);

		const nativeOnly = findSubcommand(spec, "native-only");
		expect(nativeOnly).toBeDefined();
		expect(names(nativeOnly!.name)).toEqual(["native-only", "native"]);
		expect(nativeOnly!.options).toBeUndefined();
	});

	it("exports the real GJC command surface, aliases, and root launch flags", async () => {
		const spec = await buildGjcFigSpec(commands, RootHelpCommand);

		for (const command of ["ralplan", "team", "ultragoal", "deep-interview", "completion"]) {
			expect(findSubcommand(spec, command), command).toBeDefined();
		}
		expect(names(findSubcommand(spec, "web-search")!.name)).toContain("q");
		expect(findOption(spec.options, "--tmux")).toBeDefined();
		expect(findOption(spec.options, "--model")?.args).toEqual({ name: "value" });
		expect(findOption(spec.options, "--resume")?.args).toEqual({ name: "value" });
		expect(findOption(spec.options, "-p")?.description).toContain("Non-interactive");
		expect(renderFigSpecModule(spec)).toContain("export default completionSpec");
	});

	it("uses inshellisense's default local build directory", () => {
		expect(defaultInshellisenseSpecDir("/Users/alice")).toBe(
			path.join("/Users/alice", ".fig", "autocomplete", "build"),
		);
	});

	it("installs a GJC-only index and spec into an empty target directory", async () => {
		const dir = await makeTempDir();
		const spec = await buildGjcFigSpec(fakeEntries());

		const result = await installGjcInshellisenseSpec(spec, { dir });

		expect(result).toMatchObject({ directory: dir, indexStatus: "created" });
		expect(await Bun.file(path.join(dir, "index.js")).text()).toContain("Generated by gjc completion inshellisense");
		expect(await Bun.file(path.join(dir, "gjc.js")).text()).toContain("web-search");
	});

	it("refuses to clobber an unrelated inshellisense index without force", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "index.js"), 'export default ["git"];\n');

		await expect(installGjcInshellisenseSpec(await buildGjcFigSpec(fakeEntries()), { dir })).rejects.toThrow(
			/does not list gjc/,
		);
		expect(await Bun.file(path.join(dir, "index.js")).text()).toBe('export default ["git"];\n');
	});

	it("overwrites an unrelated index only when force is explicit", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "index.js"), 'export default ["git"];\n');

		const result = await installGjcInshellisenseSpec(await buildGjcFigSpec(fakeEntries()), { dir, force: true });

		expect(result.indexStatus).toBe("overwritten");
		expect(await Bun.file(path.join(dir, "index.js")).text()).toContain('export default ["gjc"]');
	});
});
