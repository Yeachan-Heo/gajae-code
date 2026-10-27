import { afterEach, expect, test, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { executeReadUrl, readUrlCacheTestHooks } from "@gajae-code/coding-agent/tools/fetch";
import { GithubTool } from "@gajae-code/coding-agent/tools/gh";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import * as git from "@gajae-code/coding-agent/utils/git";
import * as scrapers from "@gajae-code/coding-agent/web/scrapers/types";

function symlinkCreationAllowed(): boolean {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "artifact-link-probe-"));
	try {
		const target = path.join(dir, "target");
		fsSync.writeFileSync(target, "x");
		fsSync.symlinkSync(target, path.join(dir, "link"));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
}

const canCreateSymlink = symlinkCreationAllowed();

async function modeOf(file: string): Promise<number> {
	return (await fs.lstat(file)).mode & 0o777;
}

let dir = "";

afterEach(async () => {
	vi.restoreAllMocks();
	readUrlCacheTestHooks.reset();
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = "";
});

async function setup(): Promise<{ cwd: string; artifact: string; victim: string }> {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "explicit-artifact-"));
	const artifacts = path.join(dir, "artifacts");
	await fs.mkdir(artifacts, { mode: 0o700 });
	return { cwd: dir, artifact: path.join(artifacts, "out.log"), victim: path.join(dir, "victim.txt") };
}

function githubSession(cwd: string, artifactPath: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => path.dirname(artifactPath),
		allocateOutputArtifact: async () => ({ id: "0", path: artifactPath }),
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "github.enabled": true }),
	};
}

function stubFailedRun(): void {
	vi.spyOn(git.github, "json")
		.mockResolvedValueOnce({
			id: 77,
			name: "CI",
			display_title: "PR checks",
			status: "completed",
			conclusion: "failure",
			head_branch: "feature/bugfix",
			created_at: "2026-04-01T08:00:00Z",
			updated_at: "2026-04-01T08:06:00Z",
			html_url: "https://github.com/owner/repo/actions/runs/77",
		})
		.mockResolvedValueOnce({
			total_count: 1,
			jobs: [
				{
					id: 202,
					name: "test",
					status: "completed",
					conclusion: "failure",
					started_at: "2026-04-01T08:00:00Z",
					completed_at: "2026-04-01T08:06:00Z",
					html_url: "https://github.com/owner/repo/actions/runs/77/job/202",
				},
			],
		});
	vi.spyOn(git.github, "run").mockResolvedValue({
		exitCode: 0,
		stdout: "alpha\nbeta\nMARKER-GH\n",
		stderr: "",
	});
}

async function runGithub(cwd: string, artifactPath: string) {
	stubFailedRun();
	return new GithubTool(githubSession(cwd, artifactPath)).execute("run-watch", {
		op: "run_watch",
		run: "https://github.com/owner/repo/actions/runs/77",
		tail: 3,
	});
}

function readSession(cwd: string, artifactPath: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => path.dirname(artifactPath),
		allocateOutputArtifact: async () => ({ id: "1", path: artifactPath }),
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function stubPage(): void {
	const body = Array.from({ length: 400 }, (_, index) => (index === 10 ? "MARKER-URL" : `line-${index}`)).join("\n");
	vi.spyOn(scrapers, "loadPage").mockResolvedValue({
		ok: true,
		status: 200,
		contentType: "text/plain",
		finalUrl: "https://example.com/page",
		content: body,
	});
}

async function runRead(cwd: string, artifactPath: string) {
	readUrlCacheTestHooks.reset();
	stubPage();
	return executeReadUrl(readSession(cwd, artifactPath), { path: "https://example.com/page" });
}

test("still allows saving a new github run-watch artifact", async () => {
	const { cwd, artifact } = await setup();
	const result = await runGithub(cwd, artifact);
	expect(await fs.readFile(artifact, "utf8")).toContain("MARKER-GH");
	expect(result.details?.artifactId).toBe("0");
});

test("still allows rewriting an existing regular github artifact", async () => {
	const { cwd, artifact } = await setup();
	await fs.writeFile(artifact, "OLD-REGULAR\n", { mode: 0o644 });
	await fs.chmod(artifact, 0o644);
	const result = await runGithub(cwd, artifact);
	const text = await fs.readFile(artifact, "utf8");
	expect(text).toContain("MARKER-GH");
	expect(text).not.toContain("OLD-REGULAR");
	expect(result.details?.artifactId).toBe("0");
});

test.skipIf(process.platform === "win32")("publishes a new github artifact as mode 0600", async () => {
	const previous = process.umask(0o022);
	try {
		const { cwd, artifact } = await setup();
		await runGithub(cwd, artifact);
		expect(await modeOf(artifact)).toBe(0o600);
	} finally {
		process.umask(previous);
	}
});

test.skipIf(process.platform === "win32")("replaces a mode 0644 github artifact with mode 0600", async () => {
	const previous = process.umask(0o022);
	try {
		const { cwd, artifact } = await setup();
		await fs.writeFile(artifact, "OLD-REGULAR\n", { mode: 0o644 });
		await fs.chmod(artifact, 0o644);
		await runGithub(cwd, artifact);
		expect(await modeOf(artifact)).toBe(0o600);
		expect(await fs.readFile(artifact, "utf8")).toContain("MARKER-GH");
	} finally {
		process.umask(previous);
	}
});

test.skipIf(!canCreateSymlink)("does not write through a github artifact symlink", async () => {
	const { cwd, artifact, victim } = await setup();
	await fs.writeFile(victim, "SECRET-VICTIM", { mode: 0o600 });
	await fs.symlink(victim, artifact);
	await expect(runGithub(cwd, artifact)).rejects.toThrow(/artifact_destination_symlink/);
	expect(await fs.readFile(victim, "utf8")).toBe("SECRET-VICTIM");
	expect((await fs.lstat(artifact)).isSymbolicLink()).toBe(true);
});

test("still allows saving a truncated page artifact", async () => {
	const { cwd, artifact } = await setup();
	await runRead(cwd, artifact);
	expect(await fs.readFile(artifact, "utf8")).toContain("MARKER-URL");
});

test("still allows rewriting an existing regular page artifact", async () => {
	const { cwd, artifact } = await setup();
	await fs.writeFile(artifact, "OLD-REGULAR\n", { mode: 0o644 });
	await fs.chmod(artifact, 0o644);
	await runRead(cwd, artifact);
	const text = await fs.readFile(artifact, "utf8");
	expect(text).toContain("MARKER-URL");
	expect(text).not.toContain("OLD-REGULAR");
});

test.skipIf(process.platform === "win32")("publishes a new page artifact as mode 0600", async () => {
	const previous = process.umask(0o022);
	try {
		const { cwd, artifact } = await setup();
		await runRead(cwd, artifact);
		expect(await modeOf(artifact)).toBe(0o600);
	} finally {
		process.umask(previous);
	}
});

test.skipIf(process.platform === "win32")("replaces a mode 0644 page artifact with mode 0600", async () => {
	const previous = process.umask(0o022);
	try {
		const { cwd, artifact } = await setup();
		await fs.writeFile(artifact, "OLD-REGULAR\n", { mode: 0o644 });
		await fs.chmod(artifact, 0o644);
		await runRead(cwd, artifact);
		expect(await modeOf(artifact)).toBe(0o600);
		expect(await fs.readFile(artifact, "utf8")).toContain("MARKER-URL");
	} finally {
		process.umask(previous);
	}
});

test("still allows a tail truncation and a head-and-tail truncation to keep untrusted fences", async () => {
	const { cwd, artifact } = await setup();
	const lines = ["HEADMARK"];
	for (let index = 1; index < 400; index++) lines.push(`pad-${index}`);
	lines.push("TAILMARK");
	vi.spyOn(scrapers, "loadPage").mockResolvedValue({
		ok: true,
		status: 200,
		contentType: "text/plain",
		finalUrl: "https://example.com/truncated-page",
		content: lines.join("\n"),
	});
	const session = readSession(cwd, artifact);
	const tool = new ReadTool(session);
	for (const direction of ["last", "both"] as const) {
		readUrlCacheTestHooks.reset();
		const result = await tool.execute(`read-${direction}`, {
			path: "https://example.com/truncated-page",
			truncation: direction,
		});
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block.type === "text" ? block.text : ""))
			.join("\n");
		expect(text.startsWith("<untrusted-content>\n")).toBe(true);
		expect(text.endsWith("\n</untrusted-content>")).toBe(true);
		expect(text).toContain("TAILMARK");
		if (direction === "both") expect(text).toContain("HEADMARK");
	}
});

const LONG_BASENAME = `${"x".repeat(220)}.log`;

test("still allows a 224-byte artifact basename", async () => {
	const { cwd } = await setup();
	const artifacts = path.join(cwd, "artifacts");
	const githubPath = path.join(artifacts, LONG_BASENAME);
	await fs.writeFile(githubPath, "OLD-REGULAR\n", { mode: 0o644 });
	const github = await runGithub(cwd, githubPath);
	const githubText = await fs.readFile(githubPath, "utf8");
	expect(githubText).toContain("MARKER-GH");
	expect(githubText).not.toContain("OLD-REGULAR");
	expect(github.details?.artifactId).toBe("0");

	const pagePath = path.join(artifacts, `${"y".repeat(220)}.log`);
	await runRead(cwd, pagePath);
	expect(await fs.readFile(pagePath, "utf8")).toContain("MARKER-URL");
	const names = await fs.readdir(artifacts);
	expect(names.some(name => name.endsWith(".staging"))).toBe(false);
});

test.skipIf(process.platform === "win32")("publishes a 224-byte artifact basename as mode 0600", async () => {
	const previous = process.umask(0o022);
	try {
		const { cwd } = await setup();
		const artifacts = path.join(cwd, "artifacts");
		const githubPath = path.join(artifacts, LONG_BASENAME);
		const pagePath = path.join(artifacts, `${"y".repeat(220)}.log`);
		await fs.writeFile(githubPath, "OLD-REGULAR\n", { mode: 0o644 });
		await fs.chmod(githubPath, 0o644);
		await runGithub(cwd, githubPath);
		await runRead(cwd, pagePath);
		expect(await modeOf(githubPath)).toBe(0o600);
		expect(await modeOf(pagePath)).toBe(0o600);
		expect((await fs.readdir(artifacts)).some(name => name.endsWith(".staging"))).toBe(false);
	} finally {
		process.umask(previous);
	}
});

test.skipIf(!canCreateSymlink)("does not write through a page artifact symlink", async () => {
	const { cwd, artifact, victim } = await setup();
	await fs.writeFile(victim, "SECRET-VICTIM", { mode: 0o600 });
	await fs.symlink(victim, artifact);
	await expect(runRead(cwd, artifact)).rejects.toThrow(/artifact_destination_symlink/);
	expect(await fs.readFile(victim, "utf8")).toBe("SECRET-VICTIM");
	expect((await fs.lstat(artifact)).isSymbolicLink()).toBe(true);
});
