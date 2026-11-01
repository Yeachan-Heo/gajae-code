import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { EvalTool, type EvalToolResult } from "../../src/tools/eval";

const CELLS = { cells: [{ language: "js" as const, code: "1 + 1" }] };
const ALLOWED_RESULT: EvalToolResult = { content: [{ type: "text", text: "still-allowed" }], details: undefined };

function session(options: {
	bashAllowedPrefixes?: string[];
	bashRestrictionProfile?: ToolSession["bashRestrictionProfile"];
}): ToolSession {
	return {
		cwd: "workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		...options,
	};
}

describe("eval bash restriction", () => {
	test("restricted session refuses eval before any cell runs", async () => {
		let ran = false;
		const tool = new EvalTool(session({ bashAllowedPrefixes: ["git status", "git diff"] }), {
			proxyExecutor: async () => {
				ran = true;
				return ALLOWED_RESULT;
			},
		});
		await expect(tool.execute("attack", CELLS)).rejects.toThrow(/bash allowlist or read-only profile is active/);
		expect(ran).toBe(false);
	});

	test("read-only profile refuses eval even without prefixes", async () => {
		let ran = false;
		const tool = new EvalTool(session({ bashRestrictionProfile: "read-only" }), {
			proxyExecutor: async () => {
				ran = true;
				return ALLOWED_RESULT;
			},
		});
		await expect(tool.execute("attack-ro", CELLS)).rejects.toThrow(/bash allowlist or read-only profile is active/);
		expect(ran).toBe(false);
	});

	test("unrestricted session still runs eval", async () => {
		let ran = false;
		const tool = new EvalTool(session({}), {
			proxyExecutor: async () => {
				ran = true;
				return ALLOWED_RESULT;
			},
		});
		await expect(tool.execute("allowed", CELLS)).resolves.toEqual(ALLOWED_RESULT);
		expect(ran).toBe(true);
	});

	test("blank prefixes and a workflow profile still run eval", async () => {
		let ran = false;
		const tool = new EvalTool(session({ bashAllowedPrefixes: ["  ", "\t"], bashRestrictionProfile: "workflow" }), {
			proxyExecutor: async () => {
				ran = true;
				return ALLOWED_RESULT;
			},
		});
		await expect(tool.execute("blank", CELLS)).resolves.toEqual(ALLOWED_RESULT);
		expect(ran).toBe(true);
	});

	test("property: eval block matches bash restriction flags", async () => {
		const profile = fc.constantFrom(undefined, "workflow" as const, "read-only" as const);
		const prefixes = fc.array(fc.string({ maxLength: 24 }), { maxLength: 4 });
		await fc.assert(
			fc.asyncProperty(profile, prefixes, async (bashRestrictionProfile, bashAllowedPrefixes) => {
				let ran = false;
				const tool = new EvalTool(session({ bashAllowedPrefixes, bashRestrictionProfile }), {
					proxyExecutor: async () => {
						ran = true;
						return ALLOWED_RESULT;
					},
				});
				const prefixActive = bashAllowedPrefixes.some(prefix => prefix.trim().length > 0);
				const blocked = bashRestrictionProfile === "read-only" || prefixActive;
				if (blocked) {
					await expect(tool.execute("prop", CELLS)).rejects.toThrow(
						/bash allowlist or read-only profile is active/,
					);
					expect(ran).toBe(false);
				} else {
					await expect(tool.execute("prop", CELLS)).resolves.toEqual(ALLOWED_RESULT);
					expect(ran).toBe(true);
				}
			}),
			{ seed: 4202020, numRuns: 64 },
		);
	});
});
