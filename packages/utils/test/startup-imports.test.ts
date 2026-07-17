import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function runBunEval(source: string, env: Record<string, string> = {}): Promise<string> {
	const proc = Bun.spawn([process.execPath, "-e", source], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`bun -e failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return stdout;
}

function importProbe(modulePath: string, forbidden: string[]): string {
	return `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await import(${JSON.stringify(modulePath)});
const forbidden = ${JSON.stringify(forbidden)};
const loaded = Object.keys(require.cache).filter(key => forbidden.some(name => key.includes(name)));
if (loaded.length) {
	console.error(JSON.stringify(loaded, null, 2));
	process.exit(1);
}
console.log("ok");
`;
}

describe("startup imports", () => {
	it("importing utils does not synchronously load winston or handlebars", async () => {
		await expect(
			runBunEval(importProbe("./packages/utils/src/index.ts", ["node_modules/winston", "node_modules/handlebars"]), {
				GJC_CONFIG_DIR: `.gjc-startup-imports-${Date.now()}`,
			}),
		).resolves.toContain("ok");
	});

	it("importing the fetch tool does not synchronously load linkedom", async () => {
		await expect(
			runBunEval(importProbe("./packages/coding-agent/src/tools/fetch.ts", ["node_modules/linkedom"]), {
				GJC_CONFIG_DIR: `.gjc-startup-imports-${Date.now()}`,
			}),
		).resolves.toContain("ok");
	});

	it("buffers the first synchronous log write until winston transports are ready", async () => {
		const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-logger-startup-"));
		const source = `
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./packages/utils/src/index.ts";

const logDir = process.env.GJC_TEST_LOG_DIR;
logger.setTransports({ file: logDir, console: false });
logger.info("startup-first-line", { marker: "first" });

const deadline = Date.now() + 5000;
let content = "";
while (Date.now() < deadline) {
	const entries = await fs.readdir(logDir).catch(() => []);
	for (const entry of entries) {
		if (!entry.endsWith(".log")) continue;
		content += await fs.readFile(path.join(logDir, entry), "utf8").catch(() => "");
	}
	if (content.includes("startup-first-line") && content.includes('"marker":"first"')) {
		console.log(content);
		process.exit(0);
	}
	await new Promise(resolve => setTimeout(resolve, 50));
}
console.error(content || "no log content");
process.exit(1);
`;
		const output = await runBunEval(source, { GJC_TEST_LOG_DIR: logDir });
		expect(output).toContain("startup-first-line");
		expect(output).toContain('"marker":"first"');
	});
});
