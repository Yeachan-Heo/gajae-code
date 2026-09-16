import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const script = path.join(import.meta.dir, "rebrand-inventory.ts");
const legacyToken = `OM${"p"}`;

async function scan(root: string) {
	const child = Bun.spawn(["bun", script, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, , exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode).toBe(0);
	return JSON.parse(stdout) as {
		inventory: { legacyHits: { allowlisted: number; unexpected: { path: string; token: string }[] } };
		violations: { unexpectedLegacyHitCount: number };
	};
}

async function fixture(files: Record<string, string | Uint8Array>) {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "rebrand-inventory-"));
	await fs.writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "gajae-code", description: "d", homepage: "h", repository: "r", bugs: "b" }),
	);
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, body);
	}
	return root;
}

// A compressed byte run inside a binary asset can decode into text that spells a
// legacy token. Two committed cheatsheet PDFs did exactly that and turned the dev
// gate red while no brand surface actually regressed.
test("a legacy token spelled by binary bytes is not reported as a brand hit", async () => {
	// The token sits on a word boundary exactly as it did in the committed PDFs,
	// so this fixture is a true red control for the unguarded scanner.
	const binary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xd8, ...Buffer.from(` ${legacyToken} `), 0x00, 0xff]);
	const root = await fixture({ "docs/cheatsheet/sheet.pdf": binary, "docs/assets/blob.bin": binary });
	try {
		const report = await scan(root);
		expect(report.violations.unexpectedLegacyHitCount).toBe(0);
		expect(report.inventory.legacyHits.unexpected).toEqual([]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// Review finding A2/1: NUL bytes are not the only binary marker. An asset with an
// unknown extension and no NUL in its sniff window was still token-scanned, so the
// false positive the PR set out to remove stayed reachable.
test("a legacy token spelled by NUL-free binary bytes is not reported as a brand hit", async () => {
	// A real woff2 header followed by invalid UTF-8 continuation bytes: no NUL anywhere,
	// and an extension the walker does not recognize.
	const nulFree = new Uint8Array([
		0x77,
		0x4f,
		0x46,
		0x32,
		0xc3,
		0x28,
		...Buffer.from(` ${legacyToken} `),
		0xa0,
		0xa1,
		0xff,
		0xfe,
	]);
	expect(nulFree.includes(0)).toBe(false);
	const root = await fixture({ "docs/assets/glyphs.woff2": nulFree, "docs/assets/opaque.qqq": nulFree });
	try {
		const report = await scan(root);
		expect(report.violations.unexpectedLegacyHitCount).toBe(0);
		expect(report.inventory.legacyHits.unexpected).toEqual([]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// Guard the other direction: a text file longer than the sniff window must stay a
// brand surface even though its window ends mid-character.
test("a long UTF-8 text doc whose sniff window splits a character is still reported", async () => {
	const filler = "\uAC00".repeat(4000); // 12000 bytes of 3-byte characters
	const root = await fixture({ "docs/long.md": `${filler}\nThe ${legacyToken} runtime is gone.\n` });
	try {
		const report = await scan(root);
		expect(report.violations.unexpectedLegacyHitCount).toBe(1);
		expect(report.inventory.legacyHits.unexpected[0]?.path).toBe("docs/long.md");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// Positive control: skipping binaries must not weaken detection in real text.
test("a legacy token written in a text doc is still reported", async () => {
	const root = await fixture({ "docs/notes.md": `The ${legacyToken} runtime is gone.\n` });
	try {
		const report = await scan(root);
		expect(report.violations.unexpectedLegacyHitCount).toBe(1);
		expect(report.inventory.legacyHits.unexpected[0]?.path).toBe("docs/notes.md");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("an allowlisted text surface keeps its exemption", async () => {
	const root = await fixture({ "docs/environment-variables.md": `Retained ${legacyToken} variable.\n` });
	try {
		const report = await scan(root);
		expect(report.violations.unexpectedLegacyHitCount).toBe(0);
		expect(report.inventory.legacyHits.allowlisted).toBe(1);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
