import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	compareWorkspaceDeps,
	INVENTORY_PATH,
	parsePin,
	snapshotPathForPin,
	workspaceDependencies,
} from "./verify-rust-porting-inventory";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("verify-rust-porting-inventory --deps", () => {
	test("flags a version drift on a shared dependency", () => {
		const mismatches = compareWorkspaceDeps({ phf: { version: "0.13" } }, { phf: { version: "0.14" } });
		expect(mismatches).toEqual([{ name: "phf", reason: "version", local: "0.13", upstream: "0.14" }]);
	});

	test("flags upstream features missing locally", () => {
		const mismatches = compareWorkspaceDeps(
			{ syntect: { version: "5.3", features: ["regex-fancy"] } },
			{ syntect: { version: "5.3", features: ["regex-fancy", "yaml-load"] } },
		);
		expect(mismatches.map(m => [m.name, m.reason, m.upstream])).toEqual([
			["syntect", "features", "missing yaml-load"],
		]);
	});

	test("ignores excluded audio features and deps absent locally", () => {
		const mismatches = compareWorkspaceDeps(
			{ "windows-sys": { version: "0.61", features: ["Win32_Foundation", "Win32_Globalization"] } },
			{
				"windows-sys": {
					version: "0.61",
					features: ["Win32_Foundation", "Win32_Globalization", "Win32_Media_Audio", "Win32_Media_Multimedia"],
				},
				opus: "0.3",
			},
		);
		expect(mismatches).toEqual([]);
	});

	test("accepts extra local features and string specs", () => {
		expect(
			compareWorkspaceDeps(
				{ dashmap: "6.2", image: { version: "0.25", features: ["png", "jpeg"] } },
				{ dashmap: "6.2", image: { version: "0.25", features: ["png"] } },
			),
		).toEqual([]);
	});

	test("rejects an inventory without a full-SHA pin", () => {
		expect(() => parsePin("Upstream pin: `can1357/oh-my-pi@main`")).toThrow();
	});

	test("the committed workspace matches the committed upstream snapshot", async () => {
		const pin = parsePin(await Bun.file(path.join(repoRoot, INVENTORY_PATH)).text());
		const snapshot = await Bun.file(path.join(repoRoot, snapshotPathForPin(pin))).text();
		const local = await Bun.file(path.join(repoRoot, "Cargo.toml")).text();
		expect(compareWorkspaceDeps(workspaceDependencies(local), workspaceDependencies(snapshot))).toEqual([]);
	});
});
