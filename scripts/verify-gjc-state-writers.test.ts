import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const script = path.join(import.meta.dir, "verify-gjc-state-writers.ts");

async function run(root: string) {
	const child = Bun.spawn(["bun", script, "--fail", "--root", root], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

test("--root scans the supplied PR-head tree rather than the verifier source tree", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-root-"));
	try {
		const file = path.join(root, "packages", "coding-agent", "src", "bad.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, 'const target = ".gjc/state.json";\nawait Bun.write(target, "bad");\n');
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("scanned packages/coding-agent/src");
		expect(`${result.stdout}\n${result.stderr}`).toContain("packages/coding-agent/src/bad.ts");
		expect(`${result.stdout}\n${result.stderr}`).toContain("G1 FAIL");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects aliased node filesystem writes into .gjc", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-alias-"));
	try {
		const file = path.join(root, "packages", "coding-agent", "src", "evil.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(
			file,
			'import { writeFile as write } from "node:fs/promises";\nconst target = ".gjc/redteam.json";\nawait write(target, "pwn");\n',
		);
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("packages/coding-agent/src/evil.ts");
		expect(`${result.stdout}\n${result.stderr}`).toContain("G1 FAIL");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects namespace and fs.promises writes into .gjc", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-namespace-"));
	try {
		const directory = path.join(root, "packages", "coding-agent", "src");
		await fs.mkdir(directory, { recursive: true });
		await Bun.write(path.join(directory, "namespace.ts"), 'import * as io from "node:fs/promises";\nawait io.writeFile(".gjc/a", "x");\n');
		await Bun.write(path.join(directory, "promises.ts"), 'import * as fs from "node:fs";\nawait fs.promises.writeFile(".gjc/b", "x");\n');
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("namespace.ts");
		expect(`${result.stdout}\n${result.stderr}`).toContain("promises.ts");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects dynamic fs bindings and indirect Bun.write aliases into .gjc", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-dynamic-"));
	try {
		const directory = path.join(root, "packages", "coding-agent", "src");
		await fs.mkdir(directory, { recursive: true });
		await Bun.write(path.join(directory, "dynamic.ts"), 'const io = await import("node:fs/promises");\nawait io.writeFile(".gjc/a", "x");\n');
		await Bun.write(path.join(directory, "destructured.ts"), 'const { writeFile: write } = await import("node:fs/promises");\nawait write(".gjc/b", "x");\n');
		await Bun.write(path.join(directory, "bun-alias.ts"), 'const write = Bun.write;\nawait write(".gjc/c", "x");\n');
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		for (const file of ["dynamic.ts", "destructured.ts", "bun-alias.ts"]) {
			expect(`${result.stdout}\n${result.stderr}`).toContain(file);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects computed and indirect namespace calls, distant targets, and non-ts sources", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-expanded-"));
	try {
		const directory = path.join(root, "packages", "coding-agent", "src");
		await fs.mkdir(directory, { recursive: true });
		await Bun.write(path.join(directory, "indirect.mts"), 'import * as io from "node:fs/promises";\nconst writer = io.writeFile;\nawait writer(".gjc/a", "x");\n');
		await Bun.write(path.join(directory, "computed.js"), 'import * as io from "node:fs/promises";\nawait io["writeFile"](".gjc/b", "x");\n');
		await Bun.write(path.join(directory, "distant.tsx"), `import { writeFile } from "node:fs/promises";\nconst target = ".gjc/c";\n${"// gap\n".repeat(12)}await writeFile(target, "x");\n`);
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		for (const file of ["indirect.mts", "computed.js", "distant.tsx"]) {
			expect(`${result.stdout}\n${result.stderr}`).toContain(file);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects aliases assigned from computed namespace members", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-computed-alias-"));
	try {
		const file = path.join(root, "packages", "coding-agent", "src", "computed-alias.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, 'import * as io$ from "node:fs/promises";\nconst writer$ = io$ ["writeFile"];\nawait writer$(".gjc/x", "x");\n');
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("computed-alias.ts");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("detects constructed constant .gjc paths", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-writer-constructed-"));
	try {
		const file = path.join(root, "packages", "coding-agent", "src", "constructed.ts");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, 'const target = "." + "gjc/pwned.json";\nawait Bun.write(target, "pwn");\n');
		const result = await run(root);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("constructed.ts");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
