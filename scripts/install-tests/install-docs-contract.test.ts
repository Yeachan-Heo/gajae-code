import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planTargetedTasks, planTasks } from "../ci-dev-affected";

const repoRoot = path.join(import.meta.dir, "..", "..");
const BINARY_FIRST_INSTALLER_REF = "v0.15.3";
const TAGGED_INSTALLER_URL = /https:\/\/raw\.githubusercontent\.com\/Yeachan-Heo\/gajae-code\/(v[^/]+)\/scripts\/install\.(?:sh|ps1)/g;
const STALE_INSTALLER_URL = "/v0.15.0/scripts/install.";

const coreInstallerDocs = [
	"README.md",
	"docs/install.md",
	"docs/terminal-app-integrations.md",
] as const;
const expectedLocalizedInstallerDocs = ["README.ko.md", "README.ja.md", "README.zh-CN.md"] as const;
const installerDocs = [...coreInstallerDocs, ...expectedLocalizedInstallerDocs];

describe("installer documentation contract", () => {
	test("uses the approved immutable installer release in every core and localized guide", async () => {
		for (const documentPath of installerDocs) {
			const content = await Bun.file(path.join(repoRoot, documentPath)).text();
			const taggedUrls = [...content.matchAll(TAGGED_INSTALLER_URL)];

			expect(content).not.toContain(STALE_INSTALLER_URL);
			expect(taggedUrls.length).toBeGreaterThan(0);
			for (const taggedUrl of taggedUrls) {
				expect(taggedUrl[1]).toBe(BINARY_FIRST_INSTALLER_REF);
			}
		}
	});
});

// Exercise the public command and the real shell script, but intercept Bun before
// any builds or installs. This catches commented-out, skipped, or late test calls.
describe.skipIf(process.platform === "win32")("installer CI command contract", () => {
	for (const suiteExitCode of [0, 71]) {
		test(`runs binary upgrade regressions before builds and propagates exit ${suiteExitCode}`, async () => {
			const suite = "scripts/install-tests/install-sh-binary-upgrade.test.ts";
			for (const tasks of [
				planTasks(["scripts/install.sh"], []),
				planTargetedTasks(["scripts/install.sh"], [], [suite]),
			]) {
				expect(tasks.find(task => task.key === "install-methods")?.command).toEqual([
					"bun", "run", "ci:test:install-methods",
				]);
			}

			const manifest = await Bun.file(path.join(repoRoot, "package.json")).json();
			const command = manifest.scripts["ci:test:install-methods"];
			expect(typeof command).toBe("string");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "installer-ci-contract-"));
			try {
				const log = path.join(root, "bun-calls");
				const shim = path.join(root, "bun");
				await fs.writeFile(shim, [
					"#!/bin/sh",
					'printf "%s\\n" "$*" >> "$INSTALLER_CI_CALLS"',
					`if [ "$#" -eq 2 ] && [ "$1" = test ] && [ "$2" = "${suite}" ]; then`,
					'  exit "$INSTALLER_CI_SUITE_EXIT"',
					"fi",
					"exit 72",
					"",
				].join("\n"), { mode: 0o755 });
				const child = Bun.spawn(["bash", "-c", command], {
					cwd: repoRoot,
					env: {
						...process.env,
						PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
						INSTALLER_CI_CALLS: log,
						INSTALLER_CI_SUITE_EXIT: String(suiteExitCode),
					},
					stdout: "ignore",
					stderr: "pipe",
				});
				const stderr = await new Response(child.stderr).text();
				expect(await child.exited).toBe(suiteExitCode || 72);
				expect(stderr).toBe("");
				const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
				expect(calls).toEqual(suiteExitCode === 0
					? [`test ${suite}`, "--cwd=packages/natives run build"]
					: [`test ${suite}`]);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
