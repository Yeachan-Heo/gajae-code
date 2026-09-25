#!/usr/bin/env bun
/**
 * Rust porting inventory verifier.
 *
 * `--deps` compares shared Cargo dependencies with the pinned upstream snapshot.
 * The default mode validates the A–E inventory schema and its filesystem evidence;
 * `--final` additionally requires that no row remains candidate or in-progress.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const INVENTORY_PATH = "docs/rust-porting-inventory.md";
const PIN_PATTERN = /^Upstream pin: `can1357\/oh-my-pi@([0-9a-f]{40})`$/m;
export const INVENTORY_COLUMNS = [
	"id",
	"kind",
	"upstream path@sha",
	"local target",
	"class",
	"napi surface",
	"TS callsite(s)",
	"differential corpus",
	"benchmark suite",
	"rss scenarios",
	"status",
	"PR",
	"rehearsal run",
	"reason",
	"keep-local guards",
	"deleted paths",
	"no-fallback paths",
] as const;

/** Upstream features gjc intentionally does not enable (audio stack rejected as pi-voice). */
export const EXCLUDED_UPSTREAM_FEATURES: Readonly<Record<string, readonly string[]>> = {
	"windows-sys": ["Win32_Media_Audio", "Win32_Media_Multimedia"],
};

type DependencySpec = string | { version?: string; features?: string[] };

export interface DepsMismatch {
	name: string;
	reason: "version" | "features";
	local: string;
	upstream: string;
}

export interface InventoryRow {
	section: string;
	line: number;
	values: Record<(typeof INVENTORY_COLUMNS)[number], string>;
}

export interface InventoryViolation {
	line?: number;
	id?: string;
	message: string;
}

function specVersion(spec: DependencySpec): string {
	return typeof spec === "string" ? spec : (spec.version ?? "");
}

function specFeatures(spec: DependencySpec): string[] {
	return typeof spec === "string" ? [] : (spec.features ?? []);
}

export function workspaceDependencies(toml: string): Record<string, DependencySpec> {
	const parsed = Bun.TOML.parse(toml) as { workspace?: { dependencies?: Record<string, DependencySpec> } };
	const deps = parsed.workspace?.dependencies;
	if (!deps) throw new Error("missing [workspace.dependencies] table");
	return deps;
}

export function parsePin(inventory: string): string {
	const match = inventory.match(PIN_PATTERN);
	if (!match) throw new Error(`${INVENTORY_PATH} is missing the "Upstream pin" header line`);
	return match[1];
}

export function snapshotPathForPin(pin: string): string {
	return `docs/rust-porting/upstream-workspace-deps@${pin.slice(0, 8)}.toml`;
}

export function compareWorkspaceDeps(
	local: Record<string, DependencySpec>,
	upstream: Record<string, DependencySpec>,
): DepsMismatch[] {
	const mismatches: DepsMismatch[] = [];
	for (const name of Object.keys(upstream).sort()) {
		const localSpec = local[name];
		if (localSpec === undefined) continue;
		const upstreamSpec = upstream[name];
		const localVersion = specVersion(localSpec);
		const upstreamVersion = specVersion(upstreamSpec);
		if (localVersion !== upstreamVersion) {
			mismatches.push({ name, reason: "version", local: localVersion, upstream: upstreamVersion });
			continue;
		}
		const excluded = EXCLUDED_UPSTREAM_FEATURES[name] ?? [];
		const localFeatures = new Set(specFeatures(localSpec));
		const missing = specFeatures(upstreamSpec).filter(
			feature => !localFeatures.has(feature) && !excluded.includes(feature),
		);
		if (missing.length > 0) {
			mismatches.push({
				name,
				reason: "features",
				local: [...localFeatures].sort().join(","),
				upstream: `missing ${missing.join(",")}`,
			});
		}
	}
	return mismatches;
}

function splitMarkdownRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
	return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

export function parseInventoryRows(inventory: string): { rows: InventoryRow[]; violations: InventoryViolation[] } {
	const lines = inventory.split(/\r?\n/);
	const rows: InventoryRow[] = [];
	const violations: InventoryViolation[] = [];
	const sections = new Map<string, number>();
	for (let index = 0; index < lines.length; index += 1) {
		const section = lines[index]?.match(/^### ([A-E])\./)?.[1];
		if (!section) continue;
		if (sections.has(section)) violations.push({ line: index + 1, message: `duplicate table section ${section}` });
		sections.set(section, index);
		let headerIndex = index + 1;
		while (headerIndex < lines.length && !lines[headerIndex]?.startsWith("|")) headerIndex += 1;
		if (headerIndex >= lines.length) {
			violations.push({ line: index + 1, message: `section ${section} has no schema table` });
			continue;
		}
		const headers = splitMarkdownRow(lines[headerIndex] ?? "");
		if (headers.length !== INVENTORY_COLUMNS.length || headers.some((header, cellIndex) => header !== INVENTORY_COLUMNS[cellIndex])) {
			violations.push({
				line: headerIndex + 1,
				message: `section ${section} columns must be exactly: ${INVENTORY_COLUMNS.join(" | ")}`,
			});
			continue;
		}
		const separator = splitMarkdownRow(lines[headerIndex + 1] ?? "");
		if (!isSeparatorRow(separator) || separator.length !== INVENTORY_COLUMNS.length) {
			violations.push({ line: headerIndex + 2, message: `section ${section} is missing a valid Markdown table separator` });
			continue;
		}
		for (let rowIndex = headerIndex + 2; rowIndex < lines.length && lines[rowIndex]?.startsWith("|"); rowIndex += 1) {
			const cells = splitMarkdownRow(lines[rowIndex] ?? "");
			if (cells.length !== INVENTORY_COLUMNS.length) {
				violations.push({ line: rowIndex + 1, message: `section ${section} row has ${cells.length} cells; expected ${INVENTORY_COLUMNS.length}` });
				continue;
			}
			const values = Object.fromEntries(INVENTORY_COLUMNS.map((column, cellIndex) => [column, cells[cellIndex] ?? ""])) as InventoryRow["values"];
			rows.push({ section, line: rowIndex + 1, values });
		}
	}
	for (const required of ["A", "B", "C", "D", "E"]) {
		if (!sections.has(required)) violations.push({ message: `missing inventory table section ${required}` });
	}
	return { rows, violations };
}

function listedPaths(value: string): string[] {
	if (!value.trim() || value.trim() === "—" || value.trim() === "-") return [];
	const paths = [...value.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? "");
	if (paths.length > 0) return paths;
	return value.split(/[;,\s]+/).filter(item => item.includes("/") && !item.includes("…"));
}

async function fileExists(repoRoot: string, relativePath: string): Promise<boolean> {
	try {
		await fs.access(path.resolve(repoRoot, relativePath));
		return true;
	} catch {
		return false;
	}
}

const FALLBACK_MARKERS = [
	/try\s*\{[\s\S]{0,600}?require\(["']@gajae-code\/natives["']\)/,
	/\b\w*Fallback\b/,
	/Unavailable\s*=\s*true/,
	/catch\s*\([^)]*\)[\s\S]{0,400}?(?:fallback|TypeScript|TS path)/i,
];

export async function validateInventory(
	inventory: string,
	repoRoot: string,
	options: { final?: boolean } = {},
): Promise<InventoryViolation[]> {
	const violations: InventoryViolation[] = [];
	let pin: string;
	try {
		pin = parsePin(inventory);
	} catch (error) {
		return [{ message: error instanceof Error ? error.message : String(error) }];
	}
	const parsed = parseInventoryRows(inventory);
	violations.push(...parsed.violations);
	const ids = new Set<string>();
	for (const row of parsed.rows) {
		const { values, line, section } = row;
		const id = values.id.trim();
		const add = (message: string) => violations.push({ line, id, message });
		if (!id) add("row id is required");
		else if (ids.has(id)) add(`duplicate inventory id ${id}`);
		else ids.add(id);
		if (!values.kind.trim()) add("kind is required");
		if (!values.status.trim()) add("status is required");
		if (!["candidate", "in-progress", "adopted", "rejected", "keep-local"].includes(values.status)) add(`unknown status ${values.status}`);
		if (values.status === "rejected" && (!values.reason.trim() || values.reason === "—")) add("rejected rows require a reason");
		if (values.status === "keep-local") {
			const guards = listedPaths(values["keep-local guards"]);
			if (guards.length === 0) add("keep-local rows require at least one guard test path");
			let hasExistingGuard = false;
			for (const guard of guards) {
				if (await fileExists(repoRoot, guard)) hasExistingGuard = true;
				else add(`keep-local guard path does not exist: ${guard}`);
			}
			if (guards.length > 0 && !hasExistingGuard) add("keep-local rows require at least one existing guard test path");
		}
		const upstream = values["upstream path@sha"];
		if (upstream.trim() && upstream !== "—" && upstream !== "-") {
			const shas = [...upstream.matchAll(/@([0-9a-f]{40})\b/g)].map(match => match[1]);
			if (shas.length === 0) add("upstream source must include a full 40-character SHA");
			else if (shas.some(sha => sha !== pin)) add(`upstream SHA must match the inventory pin ${pin}`);
		}
		if (values.status === "adopted") {
			const touchesNative = /native|crate|overlap/i.test(values.kind) || values["local target"].includes("crates/");
			if (touchesNative && !/^https:\/\//.test(values.PR.trim())) add("adopted native rows require a PR URL");
			if (touchesNative && !/^https:\/\//.test(values["rehearsal run"].trim())) add("adopted native rows require a rehearsal run URL");
		}
		for (const relativePath of listedPaths(values["deleted paths"])) {
			if (await fileExists(repoRoot, relativePath)) add(`deleted path still exists: ${relativePath}`);
		}
		if (values.status === "adopted") {
			for (const relativePath of listedPaths(values["no-fallback paths"])) {
				const absolutePath = path.resolve(repoRoot, relativePath);
				let source: string;
				try {
					source = await fs.readFile(absolutePath, "utf8");
				} catch {
					add(`no-fallback source path does not exist: ${relativePath}`);
					continue;
				}
				if (FALLBACK_MARKERS.some(marker => marker.test(source))) add(`no-fallback path contains an alternative implementation marker: ${relativePath}`);
			}
		}
		if (options.final && ["candidate", "in-progress"].includes(values.status)) {
			add(`--final requires no candidate or in-progress rows (section ${section})`);
		}
	}
	return violations;
}

export async function runDeps(repoRoot: string): Promise<number> {
	const pin = parsePin(await Bun.file(path.join(repoRoot, INVENTORY_PATH)).text());
	const snapshotPath = snapshotPathForPin(pin);
	const snapshot = Bun.file(path.join(repoRoot, snapshotPath));
	if (!(await snapshot.exists())) {
		process.stderr.write(`missing upstream snapshot ${snapshotPath} for pin ${pin}\n`);
		return 1;
	}
	const mismatches = compareWorkspaceDeps(
		workspaceDependencies(await Bun.file(path.join(repoRoot, "Cargo.toml")).text()),
		workspaceDependencies(await snapshot.text()),
	);
	if (mismatches.length === 0) {
		process.stdout.write(`workspace deps match upstream pin ${pin}\n`);
		return 0;
	}
	for (const mismatch of mismatches) {
		process.stderr.write(`${mismatch.name}: ${mismatch.reason} local=${mismatch.local} upstream=${mismatch.upstream}\n`);
	}
	return 1;
}

export async function runInventory(repoRoot: string, final = false): Promise<number> {
	const inventory = await Bun.file(path.join(repoRoot, INVENTORY_PATH)).text();
	const violations = await validateInventory(inventory, repoRoot, { final });
	if (violations.length === 0) {
		process.stdout.write(`${INVENTORY_PATH}: schema valid (${parseInventoryRows(inventory).rows.length} rows)${final ? ", final status complete" : ""}\n`);
		return 0;
	}
	for (const violation of violations) {
		const location = [violation.id, violation.line ? `line ${violation.line}` : undefined].filter(Boolean).join(" ");
		process.stderr.write(`${location ? `${location}: ` : ""}${violation.message}\n`);
	}
	return 1;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repoRoot = path.resolve(import.meta.dir, "..");
	if (args.length === 0) process.exit(await runInventory(repoRoot));
	if (args.length === 1 && args[0] === "--deps") process.exit(await runDeps(repoRoot));
	if (args.length === 1 && args[0] === "--final") process.exit(await runInventory(repoRoot, true));
	process.stderr.write("usage: bun scripts/verify-rust-porting-inventory.ts [--deps|--final]\n");
	process.exit(2);
}
