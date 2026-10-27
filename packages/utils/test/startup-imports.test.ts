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

function fetchImportProbe(): string {
	return `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cacheKeys = () => Object.keys(require.cache).map(key => key.replaceAll(String.fromCharCode(92), "/"));
const registryLoaded = () => cacheKeys().some(key => key.endsWith("/web/scrapers/index.ts"));
const linkedomLoaded = () => cacheKeys().some(key => key.includes("/node_modules/linkedom"));
const fetchModule = await import("./packages/coding-agent/src/tools/fetch.ts");
if (registryLoaded()) throw new Error("scraper registry was eagerly loaded with fetch.ts");
if (linkedomLoaded()) throw new Error("linkedom was synchronously loaded with fetch.ts");

let requests = 0;
globalThis.fetch = async () => {
	requests++;
	return new Response(JSON.stringify({
		title: "Startup import regression",
		number: 5841,
		state: "open",
		user: { login: "test" },
		created_at: "2026-09-23T00:00:00Z",
		updated_at: "2026-09-23T00:00:00Z",
		body: "Served by the local startup-import probe.",
		labels: [],
		comments: 0,
		html_url: "https://github.com/gjc/startup-imports/issues/5841"
	}), { status: 200, headers: { "content-type": "application/json" } });
};
const result = await fetchModule.fetchSpecialHandlerTestHooks.dispatch(
	"https://github.com/gjc/startup-imports/issues/5841", 1, undefined, null
);
if (result?.method !== "github-issue" || !result.content.includes("# Startup import regression")) {
	throw new Error("GitHub special handler did not execute after lazy registry load");
}
if (requests !== 1) throw new Error("GitHub handler made an unexpected number of requests");
if (!registryLoaded()) throw new Error("special-handler dispatch did not load the scraper registry");
if (linkedomLoaded()) throw new Error("special-handler dispatch synchronously loaded linkedom");
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

	// A cold Bun child import can exceed the default timeout under shard contention.
	it("fetch defers scraper handlers until dispatch while keeping linkedom lazy", async () => {
		await expect(
			runBunEval(fetchImportProbe(), {
				GJC_CONFIG_DIR: `.gjc-startup-imports-${Date.now()}`,
			}),
		).resolves.toContain("ok");
	}, 30_000);

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
