import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import Lane from "@gajae-code/coding-agent/commands/lane";

describe("lane command", () => {
	it("advertises the explicit lifecycle actions", () => {
		expect(Lane.args.action.options).toEqual(["configure", "start", "status", "pr", "reconcile", "gc"]);
		expect(Lane.flags.mode.options).toEqual(["pr-only", "local-controlled-merge"]);
		expect(Lane.flags.json.description).toContain("machine-readable");
		expect(Lane.flags.gates.description).toContain("check@app");
	});
	it("is registered for root CLI dispatch", async () => {
		const cliSource = await Bun.file(path.resolve(import.meta.dir, "../../src/cli.ts")).text();
		expect(cliSource).toContain('{ name: "lane", load: () => import("./commands/lane").then(m => m.default) }');
	});
});
