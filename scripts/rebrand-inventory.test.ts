import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./rebrand-inventory.ts", import.meta.url));
const legacyToken = "om" + "p";

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rebrand-inventory-"));
	const write = (name: string, content: string): void => {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	write("package.json", JSON.stringify({ name: "gajae-code" }));
	write(
		"packages/coding-agent/package.json",
		JSON.stringify({ name: "@gajae-code/coding-agent", bin: { gjc: "cli.js", "gjc-stats": "stats.js" } }),
	);
	for (const name of ["autoresearch", "deep-interview", "ralplan", "ultragoal"])
		write(`packages/coding-agent/src/defaults/gjc/skills/${name}/SKILL.md`, name);
	for (const name of ["architect", "critic", "executor", "planner"])
		write(`packages/coding-agent/src/prompts/agents/${name}.md`, name);
	fs.mkdirSync(path.join(root, "docs", "cheatsheet", "src"), { recursive: true });
	return root;
}

function inventory(root: string) {
	const result = Bun.spawnSync([process.execPath, script, "--strict", "--json"], { cwd: root });
	expect(result.stderr.toString()).toBe("");
	return { exitCode: result.exitCode, report: JSON.parse(result.stdout.toString()) };
}

test("PDF binary payloads are not scanned as source text", () => {
	const root = fixture();
	try {
		for (const extension of ["pdf", "PDF"])
			fs.writeFileSync(
				path.join(root, "docs", "cheatsheet", `binary.${extension}`),
				Buffer.from(`%PDF-1.4\nstream\n\0${legacyToken}\0\nendstream\n%%EOF`),
			);
		const { exitCode, report } = inventory(root);
		expect(exitCode).toBe(0);
		expect(report.violations.unexpectedLegacyHitCount).toBe(0);
		expect(report.inventory.legacyHits.unexpected).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Review finding A2/1: the extension list above cannot close this hole, because
// walk() still admits arbitrary unknown extensions. A NUL-free binary asset was
// therefore decoded and token-scanned, leaving the false positive reachable.
test.each(["woff2", "qqq"])("NUL-free binary payloads are not scanned as source text (.%s)", extension => {
	const root = fixture();
	try {
		// Real woff2 signature, then invalid UTF-8 continuation bytes. No NUL anywhere.
		const payload = Buffer.concat([
			Buffer.from([0x77, 0x4f, 0x46, 0x32, 0xc3, 0x28]),
			Buffer.from(` ${legacyToken} `),
			Buffer.from([0xa0, 0xa1, 0xff, 0xfe]),
		]);
		expect(payload.includes(0)).toBe(false);
		fs.writeFileSync(path.join(root, "docs", "cheatsheet", `asset.${extension}`), payload);
		const { exitCode, report } = inventory(root);
		expect(exitCode).toBe(0);
		expect(report.violations.unexpectedLegacyHitCount).toBe(0);
		expect(report.inventory.legacyHits.unexpected).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Guard the other direction: the binary sniff window must not misread a long text
// file whose window boundary splits a multibyte character.
test("long UTF-8 text whose sniff window splits a character still fails strict inventory", () => {
	const root = fixture();
	try {
		const filler = "\uAC00".repeat(4000); // 12000 bytes of 3-byte characters
		fs.writeFileSync(path.join(root, "README.md"), `${filler}\nLegacy CLI: ${legacyToken}\n`);
		const { exitCode, report } = inventory(root);
		expect(exitCode).toBe(1);
		expect(report.violations.unexpectedLegacyHitCount).toBe(1);
		expect(report.inventory.legacyHits.unexpected).toEqual([{ line: 2, path: "README.md", token: legacyToken }]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test.each(["README.md", "docs/cheatsheet/src/content.py"])("legacy text in %s still fails strict inventory", file => {
	const root = fixture();
	try {
		fs.writeFileSync(path.join(root, file), `Legacy CLI: ${legacyToken}\n`);
		const { exitCode, report } = inventory(root);
		expect(exitCode).toBe(1);
		expect(report.violations.unexpectedLegacyHitCount).toBe(1);
		expect(report.inventory.legacyHits.unexpected).toEqual([{ line: 1, path: file, token: legacyToken }]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
