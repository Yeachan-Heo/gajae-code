import { afterEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalize, currentTreeHash, verifyObligations } from "../obligations-verifier";

const appServerRoot = path.resolve(import.meta.dir, "..");
const verifierPath = path.resolve(import.meta.dir, "../../../scripts/verify-app-server-obligations.ts");
const temporaryRoots: string[] = [];
const gateIds = ["oracle-stable", "oracle-experimental", "spawned-cli-blackbox", "trace-replay", "real-t3"];
const oracleArgv = [
	"bun",
	"../../scripts/verify-codex-app-server-oracle.ts",
	"--stable",
	"--verify-frozen-subtree-oids",
];
const oracleArtifactPath = "obligations.artifacts/oracle-stable/stdout.txt";
const actualOutput = "actual output\n";

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{ root: string; repositoryRoot: string }> {
	const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-app-server-obligations-"));
	const root = path.join(repositoryRoot, "packages/coding-agent");
	temporaryRoots.push(repositoryRoot);
	const sourceDirectory = path.join(root, "src/app-server");
	await fs.mkdir(sourceDirectory, { recursive: true });
	await Promise.all([
		fs.copyFile(
			path.join(appServerRoot, "obligations.manifest.json"),
			path.join(sourceDirectory, "obligations.manifest.json"),
		),
		fs.copyFile(path.join(appServerRoot, "obligations.digest"), path.join(sourceDirectory, "obligations.digest")),
	]);
	const manifest = await manifestFor(root);
	const gates = manifest.gates as Array<Record<string, unknown>>;
	(gates[0]!.receiptContract as Record<string, unknown>).outputMarker = "actual output";
	await writeManifestDigest(root, manifest);
	await fs.mkdir(path.join(repositoryRoot, "scripts"), { recursive: true });
	await fs.writeFile(
		path.join(repositoryRoot, "scripts/verify-codex-app-server-oracle.ts"),
		`process.stdout.write(${JSON.stringify(actualOutput)});\n`,
	);
	const gitInit = Bun.spawnSync(["git", "init", "--quiet"], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
	if (gitInit.exitCode !== 0)
		throw new Error(`Unable to initialize fixture repository: ${new TextDecoder().decode(gitInit.stderr)}`);
	return { root, repositoryRoot };
}

async function writeOracleArtifact(root: string, contents = actualOutput): Promise<{ path: string; sha256: string }> {
	const artifactPath = path.join(root, oracleArtifactPath);
	await fs.mkdir(path.dirname(artifactPath), { recursive: true });
	await fs.writeFile(artifactPath, contents);
	return { path: oracleArtifactPath, sha256: sha256(contents) };
}

async function writeReceipt(
	root: string,
	overrides: Partial<Record<"argv" | "artifacts" | "cwd" | "exitCode" | "gateId" | "treeHash", unknown>> = {},
	artifactContents = actualOutput,
): Promise<void> {
	const artifact = await writeOracleArtifact(root, artifactContents);
	const treeHash = await currentTreeHash(root, "obligations.receipts");
	const receiptDirectory = path.join(root, "obligations.receipts");
	await fs.mkdir(receiptDirectory, { recursive: true });
	await fs.writeFile(
		path.join(receiptDirectory, "oracle-stable.receipt.json"),
		JSON.stringify(
			{
				receiptVersion: 1,
				gateId: "oracle-stable",
				argv: oracleArgv,
				exitCode: 0,
				cwd: ".",
				treeHash,
				artifacts: [artifact],
				...overrides,
			},
			null,
			2,
		),
	);
}

async function writeManifestDigest(root: string, manifest: unknown): Promise<void> {
	await fs.writeFile(
		path.join(root, "src/app-server/obligations.manifest.json"),
		JSON.stringify(manifest, null, "\t"),
	);
	await fs.writeFile(path.join(root, "src/app-server/obligations.digest"), `${sha256(canonicalize(manifest))}\n`);
}

async function manifestFor(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(path.join(root, "src/app-server/obligations.manifest.json"), "utf8")) as Record<
		string,
		unknown
	>;
}

test("obligations verifier rejects a manifest whose frozen digest was tampered", async () => {
	const { root } = await fixture();
	const manifestPath = path.join(root, "src/app-server/obligations.manifest.json");
	await fs.writeFile(
		manifestPath,
		(await fs.readFile(manifestPath, "utf8")).replace("actual T3 Code", "forged T3 Code"),
	);
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: ["manifest"] });
});

test("obligations verifier accepts canonical key reordering", async () => {
	const { root } = await fixture();
	const manifest = await manifestFor(root);
	await fs.writeFile(
		path.join(root, "src/app-server/obligations.manifest.json"),
		JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse()), null, "\t"),
	);
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: gateIds });
});

test("obligations verifier rejects malformed manifest JSON", async () => {
	const { root } = await fixture();
	await fs.writeFile(path.join(root, "src/app-server/obligations.manifest.json"), "{");
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: ["manifest"] });
});

test("obligations verifier rejects a manifest with missing required keys", async () => {
	const { root } = await fixture();
	const manifest = await manifestFor(root);
	delete manifest.limitations;
	await writeManifestDigest(root, manifest);
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: ["manifest"] });
});

test("obligations verifier blocks a receipt bound to a different tree", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { treeHash: "0".repeat(64) });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier reports missing receipts as blocked", async () => {
	const { root } = await fixture();
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: gateIds });
});

test("obligations verifier rejects a tree mutated after receipt recording before re-execution", async () => {
	const { root, repositoryRoot } = await fixture();
	await writeReceipt(root);
	await fs.writeFile(
		path.join(repositoryRoot, "scripts/verify-codex-app-server-oracle.ts"),
		"process.stdout.write('changed output\\n');\n",
	);
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier accepts a genuinely re-executed matching receipt", async () => {
	const { root } = await fixture();
	await writeReceipt(root);
	expect(await verifyObligations(root)).toEqual({ verified: ["oracle-stable"], blocked: gateIds.slice(1) });
});

test("leader fabrication attack is rejected when the claimed command was never run", async () => {
	const { root } = await fixture();
	await writeReceipt(root, {}, "I never ran anything. This is fabricated.\n");
	const result = await verifyObligations(root);
	expect(result.verified).not.toContain("oracle-stable");
	expect(result.blocked).toContain("oracle-stable");
});

test("obligations verifier reports a live exit-code mismatch", async () => {
	const { root, repositoryRoot } = await fixture();
	await fs.writeFile(
		path.join(repositoryRoot, "scripts/verify-codex-app-server-oracle.ts"),
		"process.exitCode = 1;\n",
	);
	await writeReceipt(root, {}, "");
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier reports a live output mismatch", async () => {
	const { root } = await fixture();
	await writeReceipt(root, {}, "forged output\n");
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks a command that cannot be executed", async () => {
	const { root } = await fixture();
	const manifest = await manifestFor(root);
	const gates = manifest.gates as Array<Record<string, unknown>>;
	(gates[0]!.receiptContract as Record<string, unknown>).argv = ["bun", "../../scripts/does-not-exist.ts"];
	await writeManifestDigest(root, manifest);
	await writeReceipt(root, { argv: ["bun", "../../scripts/does-not-exist.ts"] });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier enforces each gate's argv contract", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { argv: ["bun", "test", "unrelated.test.ts"] });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier rejects a receipt with trailing argv arguments", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { argv: [...oracleArgv, "--forged-mode"] });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier rejects any argv difference from the manifest command", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { argv: ["bun", "../../scripts/verify-codex-app-server-oracle.ts", "--experimental"] });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier uses the running Bun executable instead of a shadowed PATH entry", async () => {
	const { root, repositoryRoot } = await fixture();
	const shadowDirectory = path.join(repositoryRoot, "shadow-bin");
	await fs.mkdir(shadowDirectory);
	await fs.writeFile(path.join(shadowDirectory, "bun"), "#!/bin/sh\nprintf 'shadowed executable\\n'\n");
	await fs.chmod(path.join(shadowDirectory, "bun"), 0o755);
	await writeReceipt(root);
	const originalPath = process.env.PATH;
	process.env.PATH = `${shadowDirectory}:${originalPath ?? ""}`;
	try {
		expect(await verifyObligations(root)).toEqual({ verified: ["oracle-stable"], blocked: gateIds.slice(1) });
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("currentTreeHash ignores a shadowed git earlier on PATH", async () => {
	const { root, repositoryRoot } = await fixture();
	const shadowDirectory = path.join(repositoryRoot, "shadow-git-bin");
	await fs.mkdir(shadowDirectory);
	await fs.writeFile(path.join(shadowDirectory, "git"), "#!/bin/sh\nprintf 'forged snapshot\\n'\n");
	await fs.chmod(path.join(shadowDirectory, "git"), 0o755);
	const expected = await currentTreeHash(root, "obligations.receipts");
	const originalPath = process.env.PATH;
	process.env.PATH = `${shadowDirectory}:${originalPath ?? ""}`;
	try {
		expect(await currentTreeHash(root, "obligations.receipts")).toBe(expected);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("currentTreeHash ignores hostile GIT_DIR and GIT_WORK_TREE", async () => {
	const { root } = await fixture();
	const hostileRepository = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hostile-git-"));
	temporaryRoots.push(hostileRepository);
	const expected = await currentTreeHash(root, "obligations.receipts");
	const gitInit = Bun.spawnSync(["/usr/bin/git", "init", "--quiet"], {
		cwd: hostileRepository,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(gitInit.exitCode).toBe(0);
	const originalGitDir = process.env.GIT_DIR;
	const originalGitWorkTree = process.env.GIT_WORK_TREE;
	process.env.GIT_DIR = path.join(hostileRepository, ".git");
	process.env.GIT_WORK_TREE = hostileRepository;
	try {
		expect(await currentTreeHash(root, "obligations.receipts")).toBe(expected);
	} finally {
		if (originalGitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = originalGitDir;
		if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
		else process.env.GIT_WORK_TREE = originalGitWorkTree;
	}
});

test("obligations verifier rejects an empty or degenerate output artifact", async () => {
	const { root } = await fixture();
	await writeReceipt(root, {}, "");
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier rejects empty live output even with a substantive recorded artifact", async () => {
	const { root, repositoryRoot } = await fixture();
	await fs.writeFile(
		path.join(repositoryRoot, "scripts/verify-codex-app-server-oracle.ts"),
		"process.stdout.write('');\n",
	);
	await writeReceipt(root);
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier rejects a command that changes the repository during re-execution", async () => {
	const { root, repositoryRoot } = await fixture();
	await fs.writeFile(path.join(root, "mutated.txt"), "before\n");
	await fs.writeFile(
		path.join(repositoryRoot, "scripts/verify-codex-app-server-oracle.ts"),
		`await Bun.write("mutated.txt", "after\\n"); process.stdout.write(${JSON.stringify(actualOutput)});\n`,
	);
	await writeReceipt(root);
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks a nonzero receipt exit code", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { exitCode: 1 });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks a gate ID that differs from its receipt filename", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { gateId: "real-t3" });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks a receipt with a missing artifact", async () => {
	const { root } = await fixture();
	await writeReceipt(root, {
		artifacts: [{ path: "obligations.artifacts/oracle-stable/missing.txt", sha256: "0".repeat(64) }],
	});
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks a receipt with an artifact SHA-256 mismatch", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { artifacts: [{ path: oracleArtifactPath, sha256: "0".repeat(64) }] });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier requires canonical cwd", async () => {
	const { root } = await fixture();
	await writeReceipt(root, { cwd: "" });
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
});

test("obligations verifier blocks an artifact path that escapes through a symlink", async () => {
	const { root } = await fixture();
	await fs.writeFile(path.join(root, ".gitignore"), "artifact-link.txt\n");
	await writeReceipt(root);
	const outside = path.join(root, "..", `gjc-outside-${crypto.randomUUID()}.txt`);
	await fs.writeFile(outside, "outside\n");
	await fs.symlink(outside, path.join(root, "artifact-link.txt"));
	const receiptPath = path.join(root, "obligations.receipts/oracle-stable.receipt.json");
	const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
	receipt.artifacts = [{ path: "artifact-link.txt", sha256: sha256("outside\n") }];
	await fs.writeFile(receiptPath, JSON.stringify(receipt));
	expect((await verifyObligations(root)).blocked).toContain("oracle-stable");
	await fs.rm(outside, { force: true });
});

test("obligations verifier rejects unknown CLI arguments with usage exit status 2", async () => {
	const process = Bun.spawn(["bun", verifierPath, "--rot", "/tmp/x"], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	expect(exitCode).toBe(2);
	expect(stdout).toBe("");
	expect(stderr).toBe("Usage: verify-app-server-obligations.ts [--root <package-root>]\n");
});

test("obligations verifier fails closed explicitly in a compiled artifact", async () => {
	const previous = process.env.PI_COMPILED;
	process.env.PI_COMPILED = "1";
	try {
		expect(await verifyObligations()).toEqual({ verified: [], blocked: ["compiled-artifact"] });
	} finally {
		if (previous === undefined) delete process.env.PI_COMPILED;
		else process.env.PI_COMPILED = previous;
	}
});

test("a coordinated manifest and digest edit remains an explicit residual limitation", async () => {
	const { root } = await fixture();
	const manifest = await manifestFor(root);
	manifest.limitations = "Coordinated manifest and digest edits are not externally anchored.";
	await writeManifestDigest(root, manifest);
	expect(await verifyObligations(root)).toEqual({ verified: [], blocked: gateIds });
});
