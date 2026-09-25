#!/usr/bin/env bun
import * as path from "node:path";
import { diffLinesDifferential } from "./cases/diff-lines";
import { recordGoldens, verifyDifferential } from "./harness";

export function parseDiffcheckArgs(args: readonly string[]): { module: string; record: boolean; goldenPath?: string } {
	let module = "diff-lines";
	let record = false;
	let goldenPath: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--record") record = true;
		else if (arg === "--golden") {
			const value = args[index + 1];
			if (!value) throw new Error("--golden requires a file path");
			goldenPath = value;
			index += 1;
		} else if (arg?.startsWith("-")) throw new Error(`unknown option ${arg}`);
		else if (arg) {
			if (module !== "diff-lines") throw new Error("only one differential module may be checked at a time");
			module = arg;
		}
	}
	if (module !== "diff-lines") throw new Error(`unknown differential module ${module}`);
	return { module, record, goldenPath };
}

export async function diffcheck(
	args: readonly string[],
	root = path.resolve(import.meta.dir, "../../../.."),
): Promise<number> {
	let parsed: ReturnType<typeof parseDiffcheckArgs>;
	try {
		parsed = parseDiffcheckArgs(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	const goldenPath = path.resolve(
		root,
		parsed.goldenPath ?? path.join(import.meta.dir, "golden", `${parsed.module}.jsonl`),
	);
	try {
		if (parsed.record) {
			const records = await recordGoldens(diffLinesDifferential, goldenPath);
			console.log(JSON.stringify({ module: parsed.module, mode: "record", total: records.length, goldenPath }));
			return 0;
		}
		const report = await verifyDifferential(diffLinesDifferential, goldenPath);
		console.log(JSON.stringify({ module: parsed.module, mode: "verify", ...report }));
		return report.unlisted.length === 0 && report.stale.length === 0 ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) process.exit(await diffcheck(Bun.argv.slice(2)));
