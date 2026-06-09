import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	dispatchRpcCommand,
	isRpcCommandType,
	RPC_COMMAND_TYPES,
} from "../../src/modes/shared/agent-wire/command-contract";

const SRC_ROOT = join(process.cwd(), "src");
const HARNESS_CONTROL_PLANE_DIR = join(SRC_ROOT, "harness-control-plane");
const REMOVED_FRAME_MAPPER = join(HARNESS_CONTROL_PLANE_DIR, "frame-mapper.ts");

const ADAPTER_ROOTS = [
	"modes/rpc",
	"modes/bridge",
	"modes/acp",
	"harness-control-plane",
	"modes/shared/agent-wire",
] as const;

const ALLOWED_EVENT_TYPE_SWITCH_FILES = new Set([
	"src/modes/shared/agent-wire/event-envelope.ts",
	"src/modes/shared/agent-wire/event-observation.ts",
	"src/modes/acp/acp-event-mapper.ts",
]);

function repoRelative(path: string): string {
	return relative(process.cwd(), path).split(sep).join("/");
}

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const entries = readdirSync(root).sort();
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...walkFiles(path));
		} else if (stat.isFile()) {
			files.push(path);
		}
	}
	return files;
}

function sourceFiles(root: string): string[] {
	return walkFiles(root).filter(path => /\.(?:ts|tsx|mts|cts)$/.test(path));
}

describe("agent-wire command contract red-team", () => {
	it("exports the shared RPC command registry and dispatcher boundary", () => {
		expect(Array.isArray(RPC_COMMAND_TYPES)).toBe(true);
		expect(RPC_COMMAND_TYPES.length).toBeGreaterThan(0);
		expect(RPC_COMMAND_TYPES).toContain("prompt");
		expect(RPC_COMMAND_TYPES).toContain("bash");
		expect(isRpcCommandType("prompt")).toBe(true);
		expect(isRpcCommandType("nope")).toBe(false);
		expect(typeof dispatchRpcCommand).toBe("function");
	});

	it("keeps the deleted harness frame mapper absent with no private imports", () => {
		expect(existsSync(REMOVED_FRAME_MAPPER)).toBe(false);
		expect(existsSync(HARNESS_CONTROL_PLANE_DIR)).toBe(true);

		const harnessFiles = sourceFiles(HARNESS_CONTROL_PLANE_DIR);
		expect(harnessFiles).toContain(join(HARNESS_CONTROL_PLANE_DIR, "owner.ts"));

		const importPattern =
			/from\s+["'](?:\.\/frame-mapper|.*harness-control-plane\/frame-mapper)["']|import\s*\(["'](?:\.\/frame-mapper|.*harness-control-plane\/frame-mapper)["']\)/;
		const offenders = sourceFiles(SRC_ROOT)
			.filter(path => importPattern.test(readFileSync(path, "utf8")))
			.map(repoRelative);

		expect(offenders).toEqual([]);
	});

	it("keeps semantic event.type switches only at the canonical/shared and ACP presentation boundaries", () => {
		const adapterFiles = ADAPTER_ROOTS.flatMap(root => sourceFiles(join(SRC_ROOT, root)));
		const offenders: string[] = [];
		const missingAllowed: string[] = [];

		for (const file of adapterFiles) {
			const rel = repoRelative(file);
			const text = readFileSync(file, "utf8");
			const hasEventTypeSwitch = /switch\s*\(\s*event\.type\s*\)/.test(text);
			if (hasEventTypeSwitch && !ALLOWED_EVENT_TYPE_SWITCH_FILES.has(rel)) {
				offenders.push(rel);
			}
		}

		for (const allowed of ALLOWED_EVENT_TYPE_SWITCH_FILES) {
			const path = join(process.cwd(), allowed);
			if (!/switch\s*\(\s*event\.type\s*\)/.test(readFileSync(path, "utf8"))) {
				missingAllowed.push(allowed);
			}
		}

		expect(offenders).toEqual([]);
		expect(missingAllowed).toEqual([]);
	});
});
