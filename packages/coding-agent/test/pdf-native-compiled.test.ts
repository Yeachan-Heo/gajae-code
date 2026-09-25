import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pdfGoldenCorpus } from "../../natives/test/pdf-fixtures";
import { buildDevCompileArgs } from "../scripts/compile-args";

const packageRoot = path.resolve(import.meta.dir, "..");

async function run(command: string[], cwd: string) {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("compiled native PDF conversion", () => {
	it("converts a PDF through the embedded native addon in a compiled binary", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pdf-compiled-"));
		const executable = path.join(directory, "pdf-convert");
		const inputPath = path.join(directory, "input.pdf");
		await Bun.write(inputPath, pdfGoldenCorpus[0]!.bytes);
		try {
			const embedded = await run(["bun", "--cwd=../natives", "run", "embed:native"], packageRoot);
			expect(embedded.exitCode).toBe(0);

			const compileArgs = buildDevCompileArgs(executable);
			const entryIndex = compileArgs.indexOf("./src/cli.ts");
			const outputIndex = compileArgs.indexOf("--outfile");
			if (entryIndex < 0 || outputIndex <= entryIndex)
				throw new Error("could not locate the compiled entrypoint list");
			compileArgs.splice(
				entryIndex,
				outputIndex - entryIndex,
				"./test/fixtures/pdf-native-compiled-convert-entry.ts",
			);
			const compiled = await run([process.execPath, ...compileArgs.slice(1)], packageRoot);
			expect({ exitCode: compiled.exitCode, stderr: compiled.stderr.slice(0, 2000) }).toEqual({
				exitCode: 0,
				stderr: "",
			});

			const converted = await run([executable, inputPath], directory);
			expect({ exitCode: converted.exitCode, stderr: converted.stderr }).toEqual({ exitCode: 0, stderr: "" });
			const result = JSON.parse(converted.stdout) as { content: string };
			expect(result.content).toContain("<!-- Page 1 -->");
			expect(result.content).toContain("Golden paragraph one");
		} finally {
			const reset = await run(["bun", "--cwd=../natives", "run", "embed:native", "--reset"], packageRoot);
			await fs.rm(directory, { recursive: true, force: true });
			expect(reset.exitCode).toBe(0);
		}
	}, 240_000);
});
