import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";
import { createBenchMockProviderDefinition } from "./mock-provider";

const CHARACTERIZE_DIRECTORY_ENV = "GJC_BENCH_CHARACTERIZE_DIR";

export default function characterizeExtension(api: ExtensionAPI): void {
	const evidenceDir = process.env[CHARACTERIZE_DIRECTORY_ENV];
	if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
		throw new Error(`${CHARACTERIZE_DIRECTORY_ENV} must name an absolute evidence directory.`);
	}
	const requestPath = path.join(evidenceDir, "requests.jsonl");
	// Append, not a FileSink: the host may instantiate this extension more than
	// once (root and task sessions), and a Bun FileSink truncates on open. Each
	// line is persisted before the provider responds.
	const definition = createBenchMockProviderDefinition(0, async requestLine => {
		await fs.appendFile(requestPath, `${requestLine}\n`, "utf8");
	});
	api.registerProvider("bench-mock", definition.config);
}
