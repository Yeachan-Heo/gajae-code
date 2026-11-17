import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigFile } from "../src/config/model-registry";

const tempDirs: string[] = [];
const docsPath = path.join(import.meta.dir, "../../../docs/custom-providers-and-multi-account.md");

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

for (const heading of ["Local OpenAI-compatible endpoint (no auth)", "Hosted proxy with an env-based key"]) {
	test.each([
		"LF",
		"CRLF",
	])(`custom provider recipe loads through runtime validation: ${heading} (%s)`, async newline => {
		const source = await Bun.file(docsPath).text();
		const document = (newline === "CRLF" ? source.replace(/\r?\n/g, "\r\n") : source).replace(/\r\n/g, "\n");
		const section = document.split(`### ${heading}\n`)[1]?.split("\n### ")[0];
		const yaml = section?.match(/```yaml\n([\s\S]*?)```/)?.[1];
		expect(yaml, `missing complete YAML recipe: ${heading}`).toBeDefined();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-provider-docs-"));
		tempDirs.push(dir);
		const configPath = path.join(dir, "models.yml");
		await Bun.write(configPath, newline === "CRLF" ? yaml!.replace(/\r?\n/g, "\r\n") : yaml!);
		const result = ModelsConfigFile.relocate(configPath).tryLoad();
		expect(result.status, String(result.error ?? "")).toBe("ok");
		expect(Object.keys(result.value?.providers ?? {})).toHaveLength(1);
	});
}
