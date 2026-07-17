import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkNode20Baseline } from "./check-node20-baseline";

const tempRoots: string[] = [];

async function createRepo(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-node20-baseline-"));
	tempRoots.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(root, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return root;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("Node 20 baseline guard", () => {
	test("fails on live docs Node 20 baseline claims", async () => {
		const root = await createRepo({
			"README.md": "# Project\n\nRequires Node.js 20+ for release tooling.\n",
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.path).toBe("README.md");
		expect(violations[0]?.message).toContain("active runtime baseline");
	});

	test("fails on common live docs Node 20 baseline wording", async () => {
		const root = await createRepo({
			"packages/coding-agent/README.md": "# CLI\n\nRequires Node.js 20 for release tooling.\n",
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.path).toBe("packages/coding-agent/README.md");
	});

	test("fails on support-style live docs Node 20 claims", async () => {
		const root = await createRepo({
			"README.md": "# Project\n\nSupports Node.js v20+ for release tooling.\n",
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.path).toBe("README.md");
	});

	test("fails when release workflow setup-node pins Node 20", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: bun run ci:release:publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations.some((violation) => violation.message.includes("node-version: \"24\""))).toBe(true);
	});

	test("fails when release workflow setup-node omits node-version", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - uses: actions/setup-node@v4
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.message).toContain("node-version: \"24\"");
	});

	test("fails when release workflow setup-node omits node-version even with unrelated Node 24 text", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - uses: actions/setup-node@v4
      - run: echo "node-version: 24 is not a setup-node pin"
      # node-version: "24"
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.message).toContain("node-version: \"24\"");
	});

	test("fails each release workflow setup-node step independently", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.line).toBe(8);
	});
	test("passes named release workflow setup-node pinned to Node 24", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toEqual([]);
	});

	test("fails named release workflow setup-node without Node 24", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.message).toContain("node-version: \"24\"");
	});

	test("fails quoted release workflow setup-node without Node 24", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - name: Setup Node
        uses: "actions/setup-node@v4"
        with:
          node-version: "22"
      - run: npm publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.message).toContain("node-version: \"24\"");
	});

	test("passes release workflow setup-node pinned to Node 24", async () => {
		const root = await createRepo({
			".github/workflows/ci.yml": `name: CI
jobs:
  release-npm:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: bun run ci:release:publish
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toEqual([]);
	});

	test("allows released changelog history and historical fixtures", async () => {
		const root = await createRepo({
			"packages/ai/CHANGELOG.md": `# Changelog

## [Unreleased]

- Current work.

## [1.0.0]

- Works in Node.js 20+.
`,
			"packages/coding-agent/test/fixtures/session.jsonl": '{"text":"node20 historical compiler mode"}\n',
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toEqual([]);
	});


	test("fails on Unreleased changelog Node 20 claims", async () => {
		const root = await createRepo({
			"packages/ai/CHANGELOG.md": `# Changelog

## [Unreleased]

- Release tooling supports Node.js 20+.

## [1.0.0]

- Historical entry.
`,
		});

		const violations = await checkNode20Baseline(root);

		expect(violations).toHaveLength(1);
		expect(violations[0]?.path).toBe("packages/ai/CHANGELOG.md");
	});
});
