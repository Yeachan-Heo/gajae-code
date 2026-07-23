import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runner = join(import.meta.dir, "../scripts/qa-iterm-pet.ts");
const versions = ["3.5.0", "3.6.11"],
	modes = ["direct", "tmux"],
	size = 20;
type Ref = { path: string; sha256: string; format: "rgba8" };
type Raster = { artifactSha256: string; width: number; height: number };
type Scenario = {
	expected: Raster;
	actual: Raster;
	owned: { x: number; y: number; width: number; height: number };
	erase: { before: Raster; after: Raster };
	telemetryMs: number;
	artifactSha256: string;
};
type Json = Record<string, unknown>;
type Fixture = {
	schemaVersion: number;
	provenance: string;
	capturedAt: string;
	producer?: string;
	environment: Json;
	captures: Json[];
	_dir: string;
	_refs: Ref[];
};
function fixture(origin = false): Fixture {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-qa-"));
	const expected = Buffer.alloc(size * size * 4),
		actual = Buffer.from(expected);
	const i = ((origin ? 0 : 2) * size + (origin ? 0 : 2)) * 4;
	actual[i] = 220;
	actual[i + 1] = 40;
	actual[i + 3] = 255;
	actual[i + 4] = 40;
	actual[i + 1 + 4] = 220;
	actual[i + 3 + 4] = 255;
	const refs: Ref[] = [];
	const put = (name: string, b: Buffer): Raster => {
		const path = `artifacts/${name}.rgba`;
		mkdirSync(join(dir, "artifacts"), { recursive: true });
		writeFileSync(join(dir, path), b);
		const sha256 = createHash("sha256").update(b).digest("hex");
		refs.push({ path, sha256, format: "rgba8" });
		return { artifactSha256: sha256, width: size, height: size };
	};
	const e = put("expected", expected);
	const z = put("after", expected);
	const state = (offset: number): Scenario => {
		const variant = Buffer.from(actual);
		const byte = ((origin ? 0 : 2) * size + (origin ? 0 : 2)) * 4;
		variant[byte] = (variant[byte] + offset) % 255;
		const actualRef = put(`actual-${offset}`, variant);
		const beforeRef = actualRef;
		return {
			expected: e,
			actual: actualRef,
			owned: { x: origin ? 0 : 2, y: origin ? 0 : 2, width: 2, height: 1 },
			erase: { before: beforeRef, after: z },
			telemetryMs: 10,
			artifactSha256: actualRef.artifactSha256,
		};
	};
	const scenarios = Object.fromEntries(
		["red", "blue"].map((c, skinIndex) => [
			c,
			Object.fromEntries(
				["idle", "working", "burst", "preview"].map((s, stateIndex) => [s, state(skinIndex * 4 + stateIndex + 1)]),
			),
		]),
	);
	const captures = versions.flatMap(version =>
		modes.map(mode => ({
			version,
			mode,
			artifacts: refs,
			states: scenarios,
			failureEvidence: { directFailure: "failed", managedFailure: "failed" },
		})),
	);
	return {
		environment: {
			fontFamily: "Menlo",
			fontSize: 12,
			zoom: 1,
			columns: 80,
			rows: 24,
			cellWidthPx: 8,
			cellHeightPx: 16,
		},
		schemaVersion: 1,
		provenance: "operator-capture",
		capturedAt: "2026-01-01T00:00:00Z",
		captures,
		_dir: dir,
		_refs: refs,
	};
}
function run(data: Fixture, extra: string[] = []) {
	const dir = data._dir;
	const input = join(dir, "capture.json"),
		output = `${dir}-out`;
	writeFileSync(input, JSON.stringify(data));
	const v = extra.includes("--versions") ? extra[extra.indexOf("--versions") + 1] : "3.5.0,3.6.11",
		m = extra.includes("--modes") ? extra[extra.indexOf("--modes") + 1] : "direct,tmux";
	const r = Bun.spawnSync([
		"bun",
		runner,
		"--versions",
		v,
		"--modes",
		m,
		"--input",
		input,
		"--output",
		output,
		"--test-only-synthetic",
	]);
	rmSync(dir, { recursive: true, force: true });
	rmSync(output, { recursive: true, force: true });
	return r;
}
function publishThenRerun(mutate: (output: string) => void, extra: string[] = ["--test-only-synthetic"]) {
	const f = fixture(),
		input = join(f._dir, "capture.json"),
		output = `${f._dir}-out`,
		command = ["bun", runner, "--versions", "3.5.0,3.6.11", "--modes", "direct,tmux", "--output", output];
	try {
		writeFileSync(input, JSON.stringify(f));
		expect(Bun.spawnSync([...command, "--input", input, "--test-only-synthetic"]).exitCode).toBe(0);
		rmSync(input);
		mutate(output);
		return Bun.spawnSync([...command, ...extra]);
	} finally {
		rmSync(f._dir, { recursive: true, force: true });
		rmSync(output, { recursive: true, force: true });
	}
}
describe("iTerm pet QA runner", () => {
	it("accepts hash-bound rgba sidecars", () => {
		const f = fixture();
		expect(run(f).exitCode).toBe(0);
	});
	it("rejects tampered sidecar", () => {
		const f = fixture(),
			dir = f._dir,
			ref = f._refs[1];
		const p = join(dir, ref.path);
		const b = readFileSync(p);
		b[0] ^= 1;
		writeFileSync(p, b);
		expect(run(f).exitCode).not.toBe(0);
	});
	it("rejects unbound raster hash", () => {
		const f = fixture();
		const first = f.captures[0];
		const states = first.states as Json;
		const red = states.red as Json;
		const idle = red.idle as Json;
		const actual = idle.actual as Json;
		actual.artifactSha256 = "0".repeat(64);
		expect(run(f).exitCode).not.toBe(0);
	});
	it("preserves rgba format", () => {
		const f = fixture(),
			dir = f._dir;
		f.producer = "gjc-iterm-live-capture-v1";
		for (const c of f.captures) {
			c.producer = "gjc-iterm-live-capture-v1";
			c.artifacts = f._refs;
		}
		const input = join(dir, "capture.json");
		writeFileSync(input, JSON.stringify(f));
		const out = `${dir}-out`;
		const r = Bun.spawnSync([
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--input",
			input,
			"--output",
			out,
		]);
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(join(out, "3.6.11", "tmux", "manifest.json"), "utf8")).artifacts[0].format).toBe(
			"rgba8",
		);
		rmSync(dir, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	});
	it("publishes exactly four self-contained mode directories", () => {
		const f = fixture();
		const input = join(f._dir, "capture.json");
		const out = `${f._dir}-out`;
		writeFileSync(input, JSON.stringify(f));
		const r = Bun.spawnSync([
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--input",
			input,
			"--output",
			out,
			"--test-only-synthetic",
		]);
		expect(r.exitCode).toBe(0);
		expect(readdirSync(out).sort()).toEqual(versions);
		for (const version of versions)
			for (const mode of modes) {
				const dir = join(out, version, mode);
				expect(readdirSync(dir).sort()).toEqual(["artifacts", "evidence.json", "manifest.json"]);
				const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Json;
				expect(manifest.schemaVersion).toBe(1);
				expect(manifest.cases as Json[]).toHaveLength(mode === "tmux" ? 13 : 12);
				const actual = (manifest.cases as Json[])[0].actualCapture as string;
				expect(actual).toMatch(/^artifacts\/[a-f0-9]{64}\.rgba$/);
				expect(readFileSync(join(dir, actual)).length).toBe(size * size * 4);
			}
		rmSync(f._dir, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	});
	it("is idempotent when rerun without the legacy root manifest", () => {
		const f = fixture();
		const input = join(f._dir, "capture.json");
		const out = `${f._dir}-out`;
		writeFileSync(input, JSON.stringify(f));
		const command = [
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--output",
			out,
			"--test-only-synthetic",
		];
		expect(Bun.spawnSync([...command, "--input", input]).exitCode).toBe(0);
		rmSync(input);
		const rerun = Bun.spawnSync(command);
		expect(rerun.exitCode).toBe(0);
		expect(readdirSync(out).sort()).toEqual(versions);
		for (const version of versions)
			for (const mode of modes)
				expect(readdirSync(join(out, version, mode)).sort()).toEqual([
					"artifacts",
					"evidence.json",
					"manifest.json",
				]);
		rmSync(f._dir, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	});
});
it("accepts an owned rectangle at the terminal origin", () => {
	const f = fixture(true);
	expect(run(f).exitCode).toBe(0);
});
it("rejects synthetic published output without the test-only flag", () => {
	const result = publishThenRerun(() => {}, []);
	expect(result.exitCode).not.toBe(0);
});
it("rejects a disconnected published raster pointer", () => {
	const result = publishThenRerun(output => {
		const path = join(output, "3.5.0", "direct", "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8")) as Json;
		(manifest.cases as Json[])[0].actualCapture = `artifacts/${"f".repeat(64)}.rgba`;
		writeFileSync(path, JSON.stringify(manifest));
	});
	expect(result.exitCode).not.toBe(0);
});
it("rejects eight actual captures aliased to one declared hash", () => {
	const result = publishThenRerun(output => {
		const path = join(output, "3.5.0", "direct", "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8")) as Json;
		const cases = manifest.cases as Json[];
		const declared = cases[0].actualCapture as string;
		for (const entry of cases.filter(c => c.outcome === "success")) entry.actualCapture = declared;
		writeFileSync(path, JSON.stringify(manifest));
	});
	expect(result.exitCode).not.toBe(0);
});
it("rejects mismatched published failure provenance", () => {
	const result = publishThenRerun(output => {
		const path = join(output, "3.5.0", "direct", "evidence.json");
		const evidence = JSON.parse(readFileSync(path, "utf8")) as Json;
		(evidence["missing-f"] as Json).provenance = "another-provenance";
		writeFileSync(path, JSON.stringify(evidence));
		const manifestPath = join(output, "3.5.0", "direct", "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Json;
		manifest.provenance = "";
		writeFileSync(manifestPath, JSON.stringify(manifest));
	});
	expect(result.exitCode).not.toBe(0);
});
it("rejects a journal targeting an unrelated directory without deleting its sentinel", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-journal-"));
	const output = join(root, "published");
	const unrelated = join(root, "unrelated");
	try {
		mkdirSync(unrelated);
		const sentinel = join(unrelated, "sentinel");
		writeFileSync(sentinel, "keep");
		writeFileSync(
			`${output}.transaction-journal`,
			JSON.stringify({
				output,
				stage: join(unrelated, "published.staging-tampered"),
				backup: join(root, "published.backup-valid"),
			}),
		);
		const result = Bun.spawnSync([
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--output",
			output,
		]);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("rejects a journal targeting a symlink sibling without deleting its sentinel", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-journal-"));
	const output = join(root, "published");
	const target = join(root, "target");
	try {
		mkdirSync(target);
		const sentinel = join(target, "sentinel");
		writeFileSync(sentinel, "keep");
		symlinkSync(target, `${output}.staging-tampered`);
		writeFileSync(
			`${output}.transaction-journal`,
			JSON.stringify({
				output,
				stage: `${output}.staging-tampered`,
				backup: `${output}.backup-valid`,
			}),
		);
		const result = Bun.spawnSync([
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--output",
			output,
		]);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("preserves a forged same-parent staging sibling during journal recovery", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-journal-"));
	const output = join(root, "published");
	const stage = `${output}.staging-tampered`;
	const backup = `${output}.backup-valid`;
	const f = fixture();
	try {
		const input = join(f._dir, "capture.json");
		writeFileSync(input, JSON.stringify(f));
		const command = ["bun", runner, "--versions", "3.5.0,3.6.11", "--modes", "direct,tmux", "--output", output];
		expect(Bun.spawnSync([...command, "--input", input, "--test-only-synthetic"]).exitCode).toBe(0);
		mkdirSync(stage);
		const sentinel = join(stage, "sentinel");
		writeFileSync(sentinel, "keep");
		writeFileSync(`${output}.transaction-journal`, JSON.stringify({ output, stage, backup }));
		const result = Bun.spawnSync([...command, "--test-only-synthetic"]);
		expect(result.exitCode).toBeTypeOf("number");
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
		expect(readdirSync(stage)).toEqual(["sentinel"]);
	} finally {
		rmSync(f._dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves a forged same-parent backup sibling during journal recovery", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-journal-"));
	const output = join(root, "published");
	const backup = `${output}.backup-tampered`;
	const stage = `${output}.staging-valid`;
	const f = fixture();
	try {
		const input = join(f._dir, "capture.json");
		writeFileSync(input, JSON.stringify(f));
		const command = ["bun", runner, "--versions", "3.5.0,3.6.11", "--modes", "direct,tmux", "--output", output];
		expect(Bun.spawnSync([...command, "--input", input, "--test-only-synthetic"]).exitCode).toBe(0);
		mkdirSync(backup);
		const sentinel = join(backup, "sentinel");
		writeFileSync(sentinel, "keep");
		writeFileSync(`${output}.transaction-journal`, JSON.stringify({ output, stage, backup }));
		const result = Bun.spawnSync([...command, "--test-only-synthetic"]);
		expect(result.exitCode).toBeTypeOf("number");
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
		expect(readdirSync(backup)).toEqual(["sentinel"]);
	} finally {
		rmSync(f._dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

it("rejects an invalid matching backup when published output is missing", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-journal-"));
	const output = join(root, "published");
	const backup = `${output}.backup-tampered`;
	const stage = `${output}.staging-valid`;
	try {
		mkdirSync(backup);
		const sentinel = join(backup, "sentinel");
		writeFileSync(sentinel, "keep");
		writeFileSync(`${output}.transaction-journal`, JSON.stringify({ output, stage, backup }));
		const result = Bun.spawnSync([
			"bun",
			runner,
			"--versions",
			"3.5.0,3.6.11",
			"--modes",
			"direct,tmux",
			"--output",
			output,
		]);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
		expect(readdirSync(backup)).toEqual(["sentinel"]);
		expect(() => readdirSync(output)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
