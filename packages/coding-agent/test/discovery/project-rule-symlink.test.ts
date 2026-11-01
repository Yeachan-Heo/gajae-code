/**
 * Ordinary project discovery must not follow a repository symlink to a file
 * outside the repository. Inside files and inside links still load.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "../../src/capability";
import { clearCache, readFile } from "../../src/capability/fs";
import { type Rule, ruleCapability } from "../../src/capability/rule";
import "../../src/discovery";

const PROPERTY_SEED = 487487;
const PROPERTY_INPUTS = 64;

let tempDir: string;
let project: string;
let outside: string;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function ruleText(body: string): string {
	return `---\nalwaysApply: true\n---\n${body}\n`;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function projectRules(cwd: string): Promise<Rule[]> {
	clearCache();
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd, providers: ["native"] });
	return result.items.filter(rule => rule._source.level === "project");
}

const canSymlink = (() => {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-symlink-probe-"));
	try {
		const target = path.join(probe, "target");
		fs.writeFileSync(target, "x");
		fs.symlinkSync(target, path.join(probe, "link"));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
})();

beforeEach(() => {
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-project-rule-symlink-"));
	project = path.join(tempDir, "project");
	outside = path.join(tempDir, "outside");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
	clearCache();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("a regular project rule still loads", async () => {
	writeFile(path.join(project, ".gjc", "rules", "local.md"), ruleText("LOCAL_RULE"));
	const rules = await projectRules(project);
	expect(rules.some(rule => rule.content.includes("LOCAL_RULE") && rule.alwaysApply === true)).toBe(true);
});

test.skipIf(!canSymlink)("a project rule symlink inside the repository still loads", async () => {
	const target = path.join(project, ".gjc", "rules", "target.md");
	writeFile(target, ruleText("INSIDE_LINK"));
	fs.symlinkSync(target, path.join(project, ".gjc", "rules", "alias.md"));
	const rules = await projectRules(project);
	expect(rules.some(rule => rule.content.includes("INSIDE_LINK"))).toBe(true);
});

test("repo root RULES.md still loads from a nested directory", async () => {
	const nested = path.join(project, "packages", "app");
	fs.mkdirSync(nested, { recursive: true });
	writeFile(path.join(project, ".gjc", "RULES.md"), "NESTED_STICKY\n");
	const rules = await projectRules(nested);
	expect(rules.some(rule => rule.name === "RULES" && rule.content.includes("NESTED_STICKY"))).toBe(true);
});

test.skipIf(!canSymlink)("a project rule symlink outside the repository is not injected", async () => {
	writeFile(path.join(outside, "secret.md"), ruleText("SECRET_RULE"));
	writeFile(path.join(outside, "sticky.md"), "SECRET_STICKY\n");
	fs.mkdirSync(path.join(project, ".gjc", "rules"), { recursive: true });
	fs.symlinkSync(path.join(outside, "secret.md"), path.join(project, ".gjc", "rules", "leak.md"));
	fs.symlinkSync(path.join(outside, "sticky.md"), path.join(project, ".gjc", "RULES.md"));
	const rules = await projectRules(project);
	const blob = rules.map(rule => `${rule.name}\n${rule.content}`).join("\n");
	expect(blob.includes("SECRET_RULE")).toBe(false);
	expect(blob.includes("SECRET_STICKY")).toBe(false);
	expect(rules.some(rule => rule.name === "leak" || rule.name === "RULES")).toBe(false);
});

test.skipIf(!canSymlink)(
	"a rule symlink outside the opened directory is not injected without a repository",
	async () => {
		fs.rmSync(path.join(project, ".git"), { recursive: true, force: true });
		writeFile(path.join(outside, "secret.md"), ruleText("SECRET_NO_REPO"));
		fs.mkdirSync(path.join(project, ".gjc", "rules"), { recursive: true });
		fs.symlinkSync(path.join(outside, "secret.md"), path.join(project, ".gjc", "rules", "leak.md"));
		const rules = await projectRules(project);
		const blob = rules.map(rule => rule.content).join("\n");
		expect(blob.includes("SECRET_NO_REPO")).toBe(false);
	},
);

test.skipIf(!canSymlink)("a contained project read does not reuse an unconstrained cache entry", async () => {
	const target = path.join(outside, "cached.md");
	writeFile(target, "SECRET_CACHE");
	const link = path.join(project, "leak.md");
	fs.symlinkSync(target, link);
	clearCache();
	const open = await readFile(link);
	const bounded = await readFile(link, { containmentRoot: project, scope: "project" });
	expect(open).toContain("SECRET_CACHE");
	expect(bounded).toBeNull();
});

test.skipIf(!canSymlink)("an unconstrained read still loads after a contained read", async () => {
	const target = path.join(outside, "open.md");
	writeFile(target, "SECRET_OPEN");
	const link = path.join(project, "open.md");
	fs.symlinkSync(target, link);
	clearCache();
	await readFile(link, { containmentRoot: project, scope: "project" });
	const open = await readFile(link);
	expect(open).toContain("SECRET_OPEN");
});

test.skipIf(!canSymlink)("narrowing the repository does not reuse a wider discovery cache", async () => {
	const nested = path.join(project, "nested");
	fs.mkdirSync(path.join(nested, ".gjc", "rules"), { recursive: true });
	writeFile(path.join(project, "secret.md"), ruleText("SECRET_NARROW"));
	fs.symlinkSync(path.join(project, "secret.md"), path.join(nested, ".gjc", "rules", "leak.md"));
	clearCache();
	const wide = await loadCapability<Rule>(ruleCapability.id, { cwd: nested, providers: ["native"] });
	expect(wide.items.some(rule => rule._source.level === "project" && rule.content.includes("SECRET_NARROW"))).toBe(
		true,
	);
	fs.mkdirSync(path.join(nested, ".git"));
	const narrow = await loadCapability<Rule>(ruleCapability.id, { cwd: nested, providers: ["native"] });
	const blob = narrow.items
		.filter(rule => rule._source.level === "project")
		.map(rule => rule.content)
		.join("\n");
	expect(blob.includes("SECRET_NARROW")).toBe(false);
});

test.skipIf(!canSymlink)("generated project rule paths stay inside the repository", async () => {
	const random = mulberry32(PROPERTY_SEED);
	const inside: string[] = [];
	const outsideSentinels: string[] = [];
	const rulesDir = path.join(project, ".gjc", "rules");
	fs.mkdirSync(rulesDir, { recursive: true });
	for (let i = 0; i < PROPERTY_INPUTS; i++) {
		const token = `T${i.toString(16).padStart(2, "0")}`;
		if (random() < 0.5) {
			writeFile(path.join(rulesDir, `in-${token}.md`), ruleText(`INSIDE_${token}`));
			inside.push(`INSIDE_${token}`);
		} else {
			const target = path.join(outside, `out-${token}.md`);
			writeFile(target, ruleText(`OUTSIDE_${token}`));
			fs.symlinkSync(target, path.join(rulesDir, `out-${token}.md`));
			outsideSentinels.push(`OUTSIDE_${token}`);
		}
	}
	expect(inside.length + outsideSentinels.length).toBe(PROPERTY_INPUTS);
	expect(inside.length).toBeGreaterThan(0);
	expect(outsideSentinels.length).toBeGreaterThan(0);
	const loadNames = async (): Promise<string[]> => {
		const rules = await projectRules(project);
		const blob = rules.map(rule => rule.content).join("\n");
		for (const sentinel of outsideSentinels) expect(blob.includes(sentinel)).toBe(false);
		for (const sentinel of inside) expect(blob.includes(sentinel)).toBe(true);
		return rules.map(rule => rule.name).sort();
	};
	const first = await loadNames();
	const second = await loadNames();
	expect(second).toEqual(first);
});
