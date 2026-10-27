import { afterEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	ApplyPatchError,
	applyCodexPatch,
	DEFAULT_FUZZY_THRESHOLD,
	executePatchSingle,
} from "@gajae-code/coding-agent/edit";
import { writethroughNoop } from "@gajae-code/coding-agent/lsp";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function track(directory: string): string {
	temporaryDirectories.push(directory);
	return directory;
}

function makeSession(
	cwd: string,
	options: { artifactsDir?: string | null; sessionId?: string | null; managed?: boolean } = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => options.artifactsDir ?? null,
		getSessionId: () => options.sessionId ?? null,
		isManagedSessionDestination: () => options.managed ?? false,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

function createThrough(session: ToolSession, targetPath: string, signal?: AbortSignal) {
	return executePatchSingle({
		session,
		path: targetPath,
		params: { op: "create", diff: "ok\n" },
		signal,
		allowFuzzy: true,
		fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
		writethrough: writethroughNoop,
		beginDeferredDiagnosticsForPath: noopBeginDeferred,
	});
}

function moveThrough(session: ToolSession, sourcePath: string, destPath: string, signal?: AbortSignal) {
	return executePatchSingle({
		session,
		path: sourcePath,
		params: { op: "update", rename: destPath, diff: "@@\n-line\n+moved" },
		signal,
		allowFuzzy: true,
		fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
		writethrough: writethroughNoop,
		beginDeferredDiagnosticsForPath: noopBeginDeferred,
	});
}

describe("patch mkdir symlink", () => {
	test("still allows creating an ordinary file inside cwd", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-inside-")));
		const file = path.join(cwd, "note.txt");

		const result = await createThrough(makeSession(cwd), "note.txt");

		expect(result.details?.op).toBe("create");
		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test("still allows creating a new nested directory inside cwd", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-nested-")));
		const file = path.join(cwd, "nested", "deep", "note.txt");

		await createThrough(makeSession(cwd), "nested/deep/note.txt");

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform === "win32")(
		"still allows creating a file when cwd is a symlink to the real directory",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-cwd-link-")));
			const real = path.join(root, "real");
			const link = path.join(root, "link");
			await fs.mkdir(real);
			await fs.symlink(real, link, "dir");

			await createThrough(makeSession(link), "note.txt");

			expect(await fs.readFile(path.join(real, "note.txt"), "utf8")).toBe("ok\n");
		},
	);

	test.skipIf(process.platform === "win32")(
		"still allows creating a file through a directory symlink that stays inside cwd",
		async () => {
			const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-in-link-")));
			const real = path.join(cwd, "real");
			await fs.mkdir(real);
			await fs.symlink(real, path.join(cwd, "link"), "dir");

			await createThrough(makeSession(cwd), "link/note.txt");

			expect(await fs.readFile(path.join(real, "note.txt"), "utf8")).toBe("ok\n");
		},
	);

	test("still allows creating a file at an absolute path outside cwd", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-abs-")));
		const cwd = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		await fs.mkdir(cwd);
		await fs.mkdir(outside);
		const file = path.join(outside, "note.txt");

		await createThrough(makeSession(cwd), file);

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test("still allows creating a nested file when cwd is the filesystem root", async () => {
		const dir = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-fsroot-")));
		const file = path.join(dir, "nested", "note.txt");

		await createThrough(makeSession("/"), file);

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform !== "win32")("still allows creating a file when cwd is a drive root", async () => {
		const drive = path.parse(process.cwd()).root;
		const dir = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-drive-")));
		const file = path.join(dir, "note.txt");

		await createThrough(makeSession(drive), file);

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform !== "darwin" || !fsSync.lstatSync("/var").isSymbolicLink())(
		"still allows creating a nested directory through the /var alias",
		async () => {
			const cwd = track(await fs.mkdtemp(path.join("/var/tmp", "patch-mkdir-var-")));
			const file = path.join(cwd, "nested", "note.txt");

			await createThrough(makeSession(cwd), "nested/note.txt");

			expect(await fs.readFile(file, "utf8")).toBe("ok\n");
		},
	);

	test.skipIf(process.platform === "win32")(
		"refuses to create through a directory symlink that leaves cwd",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-cwd-esc-")));
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(cwd, "link"), "dir");

			await expect(createThrough(makeSession(cwd), "link/newsub/note.txt")).rejects.toThrow(ApplyPatchError);
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);

	test.skipIf(process.platform === "win32")("still allows creating a file inside the session local root", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-managed-ok-")));
		const sessionId = `patch-mkdir-${process.pid}-${Date.now()}`;
		const localRoot = track(path.join(os.tmpdir(), "gjc-local", sessionId));
		await fs.mkdir(localRoot, { recursive: true });

		await createThrough(makeSession(cwd, { sessionId, managed: true }), "local://nested/note.txt");

		expect(await fs.readFile(path.join(localRoot, "nested", "note.txt"), "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform === "win32")(
		"refuses to create through a directory symlink that leaves the session local root",
		async () => {
			const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-managed-esc-")));
			const sessionId = `patch-mkdir-${process.pid}-${Date.now()}-esc`;
			const localRoot = track(path.join(os.tmpdir(), "gjc-local", sessionId));
			const outside = path.join(cwd, "outside");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(localRoot, "planted"), "dir");

			await expect(
				createThrough(makeSession(cwd, { sessionId, managed: true }), "local://planted/newsub/note.txt"),
			).rejects.toThrow(ApplyPatchError);
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);

	test.skipIf(process.platform === "win32")("still allows creating a file inside an explicit local root", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-explicit-ok-")));
		const cwd = path.join(root, "workspace");
		const artifacts = path.join(root, "artifacts");
		const localRoot = path.join(artifacts, "local");
		await fs.mkdir(cwd);
		await fs.mkdir(localRoot, { recursive: true });

		await createThrough(
			makeSession(cwd, { artifactsDir: artifacts, sessionId: "explicit", managed: false }),
			"local://nested/note.txt",
		);

		expect(await fs.readFile(path.join(localRoot, "nested", "note.txt"), "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform === "win32")(
		"refuses to create through a directory symlink that leaves an explicit local root",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-explicit-esc-")));
			const artifacts = path.join(root, "artifacts");
			const localRoot = path.join(artifacts, "local");
			const outside = path.join(root, "outside");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(localRoot, "planted"), "dir");

			await expect(
				createThrough(
					makeSession(root, { artifactsDir: artifacts, sessionId: "explicit", managed: false }),
					"local://planted/newsub/note.txt",
				),
			).rejects.toThrow(ApplyPatchError);
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);

	test("still allows moving a file into a new directory inside cwd", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-move-ok-")));
		const source = path.join(cwd, "src.txt");
		await fs.writeFile(source, "line\n");

		await moveThrough(makeSession(cwd), "src.txt", "nested/dst.txt");

		expect(await fs.readFile(path.join(cwd, "nested", "dst.txt"), "utf8")).toBe("moved\n");
		await expect(fs.stat(source)).rejects.toThrow();
	});

	test("still allows moving a file to an absolute path outside cwd", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-move-abs-")));
		const cwd = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		await fs.mkdir(cwd);
		await fs.mkdir(outside);
		const source = path.join(cwd, "src.txt");
		const dest = path.join(outside, "nested", "dst.txt");
		await fs.writeFile(source, "line\n");

		await moveThrough(makeSession(cwd), "src.txt", dest);

		expect(await fs.readFile(dest, "utf8")).toBe("moved\n");
	});

	test.skipIf(process.platform === "win32")("refuses to move a file whose parent symlink leaves cwd", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-move-src-esc-")));
		const cwd = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		await fs.mkdir(cwd);
		await fs.mkdir(outside);
		const secret = path.join(outside, "secret.txt");
		await fs.writeFile(secret, "line\n");
		await fs.symlink(outside, path.join(cwd, "link"), "dir");

		await expect(moveThrough(makeSession(cwd), "link/secret.txt", "nested/dst.txt")).rejects.toThrow(ApplyPatchError);
		expect(await fs.readFile(secret, "utf8")).toBe("line\n");
		await expect(fs.stat(path.join(cwd, "nested", "dst.txt"))).rejects.toThrow();
	});

	test.skipIf(process.platform === "win32")(
		"refuses to move through a directory symlink that leaves cwd",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-move-esc-")));
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			const source = path.join(cwd, "src.txt");
			await fs.writeFile(source, "line\n");
			await fs.symlink(outside, path.join(cwd, "link"), "dir");

			await expect(moveThrough(makeSession(cwd), "src.txt", "link/newsub/dst.txt")).rejects.toThrow(ApplyPatchError);
			expect(await fs.readFile(source, "utf8")).toBe("line\n");
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);

	test("still allows creating a file when the call signal is not aborted", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-signal-ok-")));
		const file = path.join(cwd, "note.txt");

		await createThrough(makeSession(cwd), "note.txt", new AbortController().signal);

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test("refuses to create when the call signal is already aborted", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-signal-abort-")));
		const file = path.join(cwd, "note.txt");

		await expect(createThrough(makeSession(cwd), "note.txt", AbortSignal.abort())).rejects.toThrow();
		await expect(fs.stat(file)).rejects.toThrow();
	});

	test("still allows creating a file under an explicit local root that does not exist yet", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-missing-root-")));
		const cwd = path.join(root, "workspace");
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(cwd);
		await fs.mkdir(artifacts);
		const file = path.join(artifacts, "local", "new", "note.txt");

		await createThrough(makeSession(cwd, { artifactsDir: artifacts, sessionId: "explicit", managed: false }), file);

		expect(await fs.readFile(file, "utf8")).toBe("ok\n");
	});

	test("still allows moving a file into an explicit local root that does not exist yet", async () => {
		const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-missing-move-")));
		const cwd = path.join(root, "workspace");
		const artifacts = path.join(root, "artifacts");
		await fs.mkdir(cwd);
		await fs.mkdir(artifacts);
		const source = path.join(cwd, "src.txt");
		const dest = path.join(artifacts, "local", "new", "dst.txt");
		await fs.writeFile(source, "line\n");

		await moveThrough(
			makeSession(cwd, { artifactsDir: artifacts, sessionId: "explicit", managed: false }),
			"src.txt",
			dest,
		);

		expect(await fs.readFile(dest, "utf8")).toBe("moved\n");
	});

	test("still allows creating a file when rename stays inside cwd", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-create-rename-ok-")));
		const result = await executePatchSingle({
			session: makeSession(cwd),
			path: "note.txt",
			params: { op: "create", diff: "ok\n", rename: "nested/other.txt" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		expect(result.details?.op).toBe("create");
		expect(await fs.readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform === "win32")(
		"refuses to create when rename follows a directory symlink out of cwd",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-create-rename-esc-")));
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(cwd, "link"), "dir");

			await expect(
				executePatchSingle({
					session: makeSession(cwd),
					path: "note.txt",
					params: { op: "create", diff: "ok\n", rename: "link/newsub/dst.txt" },
					allowFuzzy: true,
					fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
					writethrough: writethroughNoop,
					beginDeferredDiagnosticsForPath: noopBeginDeferred,
				}),
			).rejects.toThrow(ApplyPatchError);
			await expect(fs.stat(path.join(cwd, "note.txt"))).rejects.toThrow();
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);

	test("still allows applying two in-workspace creates", async () => {
		const cwd = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-batch-ok-")));
		const patch = "*** Begin Patch\n*** Add File: good.txt\n+ok\n*** Add File: nested/also.txt\n+ok\n*** End Patch";

		await applyCodexPatch(patch, { cwd });

		expect(await fs.readFile(path.join(cwd, "good.txt"), "utf8")).toBe("ok\n");
		expect(await fs.readFile(path.join(cwd, "nested", "also.txt"), "utf8")).toBe("ok\n");
	});

	test.skipIf(process.platform === "win32")(
		"refuses a later create through a directory symlink before writing earlier files",
		async () => {
			const root = track(await fs.mkdtemp(path.join(os.tmpdir(), "patch-mkdir-batch-esc-")));
			const cwd = path.join(root, "workspace");
			const outside = path.join(root, "outside");
			await fs.mkdir(cwd);
			await fs.mkdir(outside);
			await fs.symlink(outside, path.join(cwd, "link"), "dir");
			const patch =
				"*** Begin Patch\n*** Add File: good.txt\n+ok\n*** Add File: link/newsub/bad.txt\n+ok\n*** End Patch";

			await expect(applyCodexPatch(patch, { cwd })).rejects.toThrow(ApplyPatchError);
			await expect(fs.stat(path.join(cwd, "good.txt"))).rejects.toThrow();
			await expect(fs.stat(path.join(outside, "newsub"))).rejects.toThrow();
		},
	);
});
