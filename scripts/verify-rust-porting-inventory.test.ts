import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	compareWorkspaceDeps,
	INVENTORY_COLUMNS,
	INVENTORY_PATH,
	parseInventoryRows,
	parsePin,
	snapshotPathForPin,
	validateInventory,
	workspaceDependencies,
} from "./verify-rust-porting-inventory";

const repoRoot = path.resolve(import.meta.dir, "..");
const PIN = "a85bd5228d9f0f619deade1db78fa49420a721e1";
const baseInventory = `# Rust porting inventory\n\nUpstream pin: \`can1357/oh-my-pi@${PIN}\`\n\n${["A", "B", "C", "D", "E"].map(section => {
	const cells = [`ID-${section}`, "crate", `\`crates/test@${PIN}\``, "crates/test", "infra", "—", "—", "—", "—", "—", "candidate", "", "", "—", "—", "—", "—"];
	return `### ${section}. test\n\n| ${INVENTORY_COLUMNS.join(" | ")} |\n|${INVENTORY_COLUMNS.map(() => "---").join("|")}|\n| ${cells.join(" | ")} |`;
}).join("\n\n")}`;

async function tempRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "gjc-rust-porting-inventory-"));
}

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
		expect(mismatches.map(m => [m.name, m.reason, m.upstream])).toEqual([["syntect", "features", "missing yaml-load"]]);
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
		expect(compareWorkspaceDeps({ dashmap: "6.2", image: { version: "0.25", features: ["png", "jpeg"] } }, { dashmap: "6.2", image: { version: "0.25", features: ["png"] } })).toEqual([]);
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

describe("verify-rust-porting-inventory schema", () => {
	test("default inventory has all A-E tables, exact columns, and unique ids", async () => {
		const inventory = await Bun.file(path.join(repoRoot, INVENTORY_PATH)).text();
		const parsed = parseInventoryRows(inventory);
		expect(parsed.violations).toEqual([]);
		expect(parsed.rows.length).toBeGreaterThan(40);
		expect(new Set(parsed.rows.map(row => row.values.id)).size).toBe(parsed.rows.length);
		expect(await validateInventory(inventory, repoRoot)).toEqual([]);
	});

	test("default schema rejects duplicate ids, wrong columns, missing pin and rejected rows without reasons", async () => {
		const duplicated = baseInventory.replace("ID-E", "ID-D");
		const badHeader = baseInventory.replace("upstream path@sha", "upstream");
		const missingReason = baseInventory.replace("candidate |  |  | — | — | — | — |", "rejected |  |  | — | — | — | — |");
		const root = await tempRoot();
		try {
			expect((await validateInventory(duplicated, root)).some(item => item.message.includes("duplicate inventory id"))).toBe(true);
			expect((await validateInventory(badHeader, root)).some(item => item.message.includes("columns must be exactly"))).toBe(true);
			expect((await validateInventory(baseInventory.replace(/Upstream pin:.*\n/, ""), root)).some(item => item.message.includes("Upstream pin"))).toBe(true);
			expect((await validateInventory(missingReason, root)).some(item => item.message.includes("rejected rows require a reason"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("adopted native rows require PR and rehearsal URLs; removed paths must be absent", async () => {
		const adopted = baseInventory.replace("candidate |  |  | — | — | — | — |", "adopted | — | — | — | — | `crates/test.rs` | — |");
		const root = await tempRoot();
		try {
			await fs.mkdir(path.join(root, "crates"), { recursive: true });
			await fs.writeFile(path.join(root, "crates", "test.rs"), "// native source\n");
			const violations = await validateInventory(adopted, root);
			expect(violations.some(item => item.message.includes("require a PR URL"))).toBe(true);
			expect(violations.some(item => item.message.includes("require a rehearsal run URL"))).toBe(true);
			expect(violations.some(item => item.message.includes("deleted path still exists"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("adopted no-fallback paths reject fallback markers and absent sources", async () => {
		const root = await tempRoot();
		try {
			await fs.mkdir(path.join(root, "test"), { recursive: true });
			await fs.writeFile(path.join(root, "test", "fallback.ts"), "export const findMatchFallback = () => null;\n");
			const adopted = baseInventory.replace(
				"candidate |  |  | — | — | — | — |",
				"adopted | https://example.test/pr/1 | https://example.test/run/1 | — | — | — | `test/fallback.ts` |",
			);
			const violations = await validateInventory(adopted, root);
			expect(violations.some(item => item.message.includes("alternative implementation marker"))).toBe(true);
			const missingSource = adopted.replace("`test/fallback.ts`", "`test/missing.ts`");
			expect((await validateInventory(missingSource, root)).some(item => item.message.includes("no-fallback source path does not exist"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("keep-local entries require existing guard paths; final rejects unfinished statuses", async () => {
		const root = await tempRoot();
		try {
			await fs.mkdir(path.join(root, "test"), { recursive: true });
			await fs.writeFile(path.join(root, "test", "guard.test.ts"), "test(\"guard\", () => {});\n");
			const withKeepLocal = baseInventory.split("\n").map(line =>
				line.startsWith("| ID-D |") ? line.replace("candidate |  |  | — | — | — | — |", "keep-local |  |  | — | `test/guard.test.ts` | — | — |") : line,
			).join("\n");
			expect(await validateInventory(withKeepLocal, root)).toEqual([]);
			const missingGuard = withKeepLocal.replace("`test/guard.test.ts`", "`test/missing.test.ts`");
			expect((await validateInventory(missingGuard, root)).some(item => item.message.includes("guard path does not exist"))).toBe(true);
			expect((await validateInventory(baseInventory, root, { final: true })).some(item => item.message.includes("--final requires"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
