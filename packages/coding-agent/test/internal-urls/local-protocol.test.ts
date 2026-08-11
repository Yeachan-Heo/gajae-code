import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	initializeLocalRoot,
	LocalProtocolHandler,
	resolveLocalRoot,
	resolveLocalUrlToPath,
} from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function withLocalRoot<T>(sessionId: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = resolveLocalRoot({ getSessionId: () => sessionId });
	await fs.rm(root, { recursive: true, force: true });
	await fs.mkdir(root, { recursive: true });

	try {
		return await fn(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function localOptions(sessionId: string, artifactsDir: string) {
	return { getArtifactsDir: () => artifactsDir, isManagedDestination: () => true, getSessionId: () => sessionId };
}

it("keeps explicit local roots under artifacts while managed roots stay external", async () => {
	await withTempDir(async artifactsDir => {
		const sessionId = `routing-${path.basename(artifactsDir)}`;
		expect(resolveLocalRoot({ getArtifactsDir: () => artifactsDir, getSessionId: () => sessionId })).toBe(
			path.join(artifactsDir, "local"),
		);
		expect(
			resolveLocalRoot({
				getArtifactsDir: () => artifactsDir,
				isManagedDestination: () => true,
				getSessionId: () => sessionId,
			}),
		).toBe(path.join(os.tmpdir(), "gjc-local", sessionId));
	});
});
it("migrates opaque managed legacy topology, retires exactly once, and verifies the marker", async () => {
	const sessionId = `managed-${crypto.randomUUID()}`;
	const snapshot = { rootDev: "1", rootIno: "2", entries: [] } as never;
	let captures = 0;
	let retired = 0;
	await withLocalRoot(sessionId, async localRoot => {
		LocalProtocolHandler.setOverride({
			getSessionId: () => sessionId,
			getManagedLegacyLocalMigrationSource: () => ({
				capture: async () => {
					captures++;
					return {
						snapshot,
						entries: [
							{ relativePath: "", kind: "directory" },
							{ relativePath: "nested", kind: "directory" },
							{ relativePath: "empty", kind: "directory" },
							{
								relativePath: "nested/legacy.json",
								kind: "file",
								bytes: Buffer.from('{"legacy":true}'),
								sha256: "600bfa81b1561fa6281505a8630327ec94da208976f36c142c781b0b46a95725",
							},
						],
					};
				},
				retire: expected => {
					expect(expected).toBe(snapshot);
					retired++;
				},
			}),
		});
		await initializeLocalRoot(LocalProtocolHandler.resolveOptions()!);
		expect(await fs.readFile(path.join(localRoot, "nested", "legacy.json"), "utf8")).toBe('{"legacy":true}');
		expect((await fs.lstat(path.join(localRoot, "empty"))).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe("verified\n");
		await initializeLocalRoot(LocalProtocolHandler.resolveOptions()!);
		expect({ captures, retired }).toEqual({ captures: 1, retired: 1 });
	});
});

it("coalesces concurrent managed migration for the same local root", async () => {
	const sessionId = `managed-concurrent-${crypto.randomUUID()}`;
	let captures = 0;
	let retired = 0;
	await withLocalRoot(sessionId, async localRoot => {
		const captureStarted = Promise.withResolvers<void>();
		const releaseCapture = Promise.withResolvers<void>();
		const options = {
			getSessionId: () => sessionId,
			getManagedLegacyLocalMigrationSource: () => ({
				capture: async () => {
					captures++;
					captureStarted.resolve();
					await releaseCapture.promise;
					return null;
				},
				retire: () => retired++,
			}),
		};
		const first = initializeLocalRoot(options);
		await captureStarted.promise;
		const second = initializeLocalRoot(options);
		expect(captures).toBe(1);
		releaseCapture.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual([localRoot, localRoot]);
		expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe("absent\n");
		expect({ captures, retired }).toEqual({ captures: 1, retired: 0 });
	});
});

it("rolls back a sorted managed partial install and retries the same identity", async () => {
	const sessionId = `managed-collision-${crypto.randomUUID()}`;
	const snapshot = { rootDev: "1", rootIno: "2", entries: [] } as never;
	let retired = 0;
	await withLocalRoot(sessionId, async localRoot => {
		await fs.writeFile(path.join(localRoot, "02-second"), "existing");
		const options = {
			getSessionId: () => sessionId,
			getManagedLegacyLocalMigrationSource: () => ({
				capture: async () => ({
					snapshot,
					entries: [
						{ relativePath: "", kind: "directory" as const },
						{
							relativePath: "01-first",
							kind: "file" as const,
							bytes: Buffer.from("first"),
							sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
						},
						{
							relativePath: "02-second",
							kind: "file" as const,
							bytes: Buffer.from("second"),
							sha256: "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4",
						},
					],
				}),
				retire: () => retired++,
			}),
		};
		await expect(initializeLocalRoot(options)).rejects.toThrow("destination is ambiguous");
		await expect(fs.lstat(path.join(localRoot, "01-first"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(path.join(localRoot, "02-second"), "utf8")).toBe("existing");
		expect(retired).toBe(0);
		await expect(fs.lstat(path.join(localRoot, ".gjc-local-legacy-migrated-v1"))).rejects.toMatchObject({
			code: "ENOENT",
		});

		await fs.rm(path.join(localRoot, "02-second"));
		await initializeLocalRoot(options);
		expect(await fs.readFile(path.join(localRoot, "01-first"), "utf8")).toBe("first");
		expect(await fs.readFile(path.join(localRoot, "02-second"), "utf8")).toBe("second");
		expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe("verified\n");
		expect(retired).toBe(1);
	});
});

it("fails closed for real managed payloads above the 64 MiB safe size without writing a marker or retiring the source", async () => {
	const sessionId = `managed-oversize-${crypto.randomUUID()}`;
	const snapshot = { rootDev: "1", rootIno: "2", entries: [] } as never;
	let retired = 0;
	// Production sums entry.bytes.byteLength before install; use a real byteLength without
	// allocating a full 64 MiB+ buffer into the process heap.
	const oversizeBytes = { byteLength: 64 * 1024 * 1024 + 1 } as Buffer;
	await withLocalRoot(sessionId, async localRoot => {
		const options = {
			getSessionId: () => sessionId,
			getManagedLegacyLocalMigrationSource: () => ({
				capture: async () => ({
					snapshot,
					entries: [
						{ relativePath: "", kind: "directory" as const },
						{
							relativePath: "huge.bin",
							kind: "file" as const,
							bytes: oversizeBytes,
							sha256: "deadbeef",
						},
					],
				}),
				retire: () => retired++,
			}),
		};
		await expect(initializeLocalRoot(options)).rejects.toThrow("exceeds the safe size limit");
		await expect(fs.lstat(path.join(localRoot, "huge.bin"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.lstat(path.join(localRoot, ".gjc-local-legacy-migrated-v1"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(retired).toBe(0);
	});
});

describe("LocalProtocolHandler", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("prefers explicit owned mappings over a live main registry session", () => {
		AgentRegistry.global().register({
			id: "main",
			displayName: "main",
			kind: "main",
			status: "running",
			session: {
				sessionManager: {
					getArtifactsDir: () => "/registry-artifacts",
					getSessionId: () => "registry-session",
				},
			} as unknown as AgentSession,
		});
		const owned = { getArtifactsDir: () => "/owned-artifacts", getSessionId: () => "owned-session" };
		const dispose = LocalProtocolHandler.installOverride(owned);

		expect(LocalProtocolHandler.resolveOptions()).toBe(owned);

		dispose();
		const fallback = LocalProtocolHandler.resolveOptions();
		expect(fallback?.getArtifactsDir?.()).toBe("/registry-artifacts");
		expect(fallback?.getSessionId?.()).toBe("registry-session");
	});

	it("uses only live main registry sessions as the fallback", () => {
		const session = {
			sessionManager: {
				getArtifactsDir: () => "/registry-artifacts",
				getSessionId: () => "registry-session",
			},
		} as unknown as AgentSession;
		const resolveForStatus = (status: "idle" | "completed" | "aborted") => {
			AgentRegistry.resetGlobalForTests();
			AgentRegistry.global().register({
				id: "main",
				displayName: "main",
				kind: "main",
				status,
				session,
			});
			return LocalProtocolHandler.resolveOptions();
		};

		const idle = resolveForStatus("idle");
		expect(idle?.getArtifactsDir?.()).toBe("/registry-artifacts");
		expect(idle?.getSessionId?.()).toBe("registry-session");
		expect(resolveForStatus("completed")).toBeUndefined();
		expect(resolveForStatus("aborted")).toBeUndefined();
	});

	it("keeps the newest owned mapping live until its exact disposer runs", () => {
		const first = { getArtifactsDir: () => "/first", getSessionId: () => "first" };
		const second = { getArtifactsDir: () => "/second", getSessionId: () => "second" };
		const third = { getArtifactsDir: () => "/third", getSessionId: () => "third" };
		const disposeFirst = LocalProtocolHandler.installOverride(first);
		const disposeSecond = LocalProtocolHandler.installOverride(second);
		const disposeThird = LocalProtocolHandler.installOverride(third);

		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeSecond();
		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeSecond();
		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeThird();
		expect(LocalProtocolHandler.resolveOptions()).toBe(first);
		disposeFirst();
		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
		disposeFirst();
		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
	});

	it("reset clears direct and owned overrides", () => {
		const owned = { getArtifactsDir: () => "/owned", getSessionId: () => "owned" };
		LocalProtocolHandler.installOverride(owned);
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => "/direct", getSessionId: () => "direct" });

		LocalProtocolHandler.resetOverrideForTests();

		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
	});

	it("migrates verified legacy artifacts/local content into external scratch exactly once", async () => {
		await withTempDir(async artifactsDir => {
			const sessionId = `external-${path.basename(artifactsDir)}`;
			await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });

			await Bun.write(path.join(artifactsDir, "local", "legacy.json"), '{"legacy":true}');

			await withLocalRoot(sessionId, async localRoot => {
				await Bun.write(path.join(localRoot, "handoff.json"), '{"ok":true}');
				LocalProtocolHandler.setOverride(localOptions(sessionId, artifactsDir));
				const resource = await InternalUrlRouter.instance().resolve("local://");

				expect(localRoot).toBe(path.join(os.tmpdir(), "gjc-local", sessionId));
				expect(resource.sourcePath).toBe(await fs.realpath(localRoot));
				expect(resource.content).toContain("handoff.json");
				expect(resource.content).toContain("legacy.json");
				expect(resource.sourcePath?.startsWith(`${path.resolve(artifactsDir)}${path.sep}`)).toBe(false);
				await expect(fs.lstat(path.join(artifactsDir, "local"))).rejects.toMatchObject({ code: "ENOENT" });
				expect((await InternalUrlRouter.instance().resolve("local://legacy.json")).content).toBe('{"legacy":true}');
				expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe(
					"cleanup_pending\n",
				);
			});
		});
	});

	it("migrates through a benign ancestor symlink while retaining a canonical migration authority", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async tempDir => {
			const canonicalParent = path.join(tempDir, "canonical");
			const artifactsDir = path.join(canonicalParent, "artifacts");
			const aliasedArtifactsDir = path.join(tempDir, "alias", "artifacts");
			const sessionId = `legacy-ancestor-symlink-${path.basename(tempDir)}`;
			await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await fs.symlink(canonicalParent, path.join(tempDir, "alias"));
			await Bun.write(path.join(artifactsDir, "local", "legacy.json"), '{"legacy":true}');
			await withLocalRoot(sessionId, async localRoot => {
				LocalProtocolHandler.setOverride(localOptions(sessionId, aliasedArtifactsDir));
				await initializeLocalRoot(LocalProtocolHandler.resolveOptions()!);
				expect(await fs.readFile(path.join(localRoot, "legacy.json"), "utf8")).toBe('{"legacy":true}');
				await expect(fs.lstat(path.join(artifactsDir, "local"))).rejects.toMatchObject({ code: "ENOENT" });
				expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe(
					"cleanup_pending\n",
				);
			});
		});
	});

	it("aborts legacy migration when the canonical root changes at manifest capture", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async tempDir => {
			const canonicalParent = path.join(tempDir, "canonical");
			const canonicalArtifactsDir = path.join(canonicalParent, "artifacts");
			const artifactsDir = path.join(tempDir, "alias", "artifacts");
			const sessionId = `legacy-capture-swap-${path.basename(tempDir)}`;
			const legacy = path.join(artifactsDir, "local");
			const displacedLegacy = path.join(artifactsDir, "displaced-local");
			await fs.mkdir(canonicalArtifactsDir, { recursive: true });
			await fs.symlink(canonicalParent, path.join(tempDir, "alias"));
			await fs.mkdir(legacy, { recursive: true });
			await Bun.write(path.join(legacy, "legacy.json"), '{"legacy":true}');
			const legacyRootPaths = new Set([path.resolve(legacy), await fs.realpath(legacy)]);
			await withLocalRoot(sessionId, async localRoot => {
				const lstat = fs.lstat.bind(fs);
				let rootSnapshots = 0;
				const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (
					target: nodeFs.PathLike,
					options?: nodeFs.StatOptions,
				) => {
					if (legacyRootPaths.has(path.resolve(String(target))) && ++rootSnapshots === 3) {
						await fs.rename(legacy, displacedLegacy);
						await fs.mkdir(legacy);
						await Bun.write(path.join(legacy, "replacement.json"), '{"replacement":true}');
					}
					return lstat(target, options);
				}) as unknown as typeof fs.lstat);
				try {
					LocalProtocolHandler.setOverride(localOptions(sessionId, artifactsDir));
					await expect(initializeLocalRoot(LocalProtocolHandler.resolveOptions()!)).rejects.toThrow(
						"Legacy local:// migration source changed during capture",
					);
				} finally {
					lstatSpy.mockRestore();
				}

				expect(await fs.readFile(path.join(legacy, "replacement.json"), "utf8")).toBe('{"replacement":true}');
				expect(await fs.readFile(path.join(displacedLegacy, "legacy.json"), "utf8")).toBe('{"legacy":true}');
				await expect(fs.lstat(path.join(localRoot, ".gjc-local-legacy-migrated-v1"))).rejects.toMatchObject({
					code: "ENOENT",
				});
				await expect(fs.lstat(path.join(localRoot, "legacy.json"))).rejects.toMatchObject({ code: "ENOENT" });
			});
		});
	});

	it("fails closed when artifacts/local itself is a symlink during legacy migration", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async artifactsDir => {
			const sessionId = `legacy-root-symlink-${path.basename(artifactsDir)}`;
			const legacySource = path.join(artifactsDir, "legacy-source");
			const legacy = path.join(artifactsDir, "local");
			await fs.mkdir(legacySource, { recursive: true });
			await Bun.write(path.join(legacySource, "legacy.json"), '{"legacy":true}');
			await fs.symlink(legacySource, legacy);
			await withLocalRoot(sessionId, async localRoot => {
				LocalProtocolHandler.setOverride(localOptions(sessionId, artifactsDir));
				await expect(InternalUrlRouter.instance().resolve("local://")).rejects.toThrow(
					"Unsafe legacy local:// migration source",
				);
				expect((await fs.lstat(legacy)).isSymbolicLink()).toBe(true);
				await expect(fs.lstat(path.join(localRoot, ".gjc-local-legacy-migrated-v1"))).rejects.toMatchObject({
					code: "ENOENT",
				});
			});
		});
	});

	it("fails closed when legacy local migration contains a symlink", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async artifactsDir => {
			const sessionId = `legacy-symlink-${path.basename(artifactsDir)}`;
			const legacy = path.join(artifactsDir, "local");
			await fs.mkdir(legacy, { recursive: true });
			await fs.symlink(path.join(artifactsDir, "outside"), path.join(legacy, "linked"));
			LocalProtocolHandler.setOverride(localOptions(sessionId, artifactsDir));
			await expect(InternalUrlRouter.instance().resolve("local://")).rejects.toThrow(
				"Unsafe legacy local:// migration source",
			);
		});
	});

	it("isolates local roots by session identity", async () => {
		await withTempDir(async tempDir => {
			const sessionA = `session-a-${path.basename(tempDir)}`;
			const sessionB = `session-b-${path.basename(tempDir)}`;
			await withLocalRoot(sessionA, async rootA => {
				await withLocalRoot(sessionB, async rootB => {
					await Bun.write(path.join(rootA, "trace.txt"), "trace");
					expect(rootA).not.toBe(rootB);

					LocalProtocolHandler.setOverride(localOptions(sessionA, path.join(tempDir, "artifacts-a")));
					expect((await InternalUrlRouter.instance().resolve("local://trace.txt")).content).toBe("trace");

					LocalProtocolHandler.setOverride(localOptions(sessionB, path.join(tempDir, "artifacts-b")));
					const listing = await InternalUrlRouter.instance().resolve("local://");
					expect(listing.content).toContain("(empty)");
				});
			});
		});
	});

	it("component-encodes listing hrefs and follows delimiter and literal-percent siblings", async () => {
		await withTempDir(async tempDir => {
			const sessionId = `encoded-listing-${path.basename(tempDir)}`;
			await withLocalRoot(sessionId, async localRoot => {
				await Bun.write(path.join(localRoot, "report%3Araw.txt"), "literal-percent");
				await Bun.write(path.join(localRoot, "report:raw.txt"), "colon-sibling");
				await Bun.write(path.join(localRoot, "report).txt"), "root-delimiter");
				await fs.mkdir(path.join(localRoot, "batch(1)"));
				await Bun.write(path.join(localRoot, "batch(1)", "report).txt"), "nested-delimiter");
				await Bun.write(path.join(localRoot, "report](other.txt"), "root-label-delimiter");
				await fs.mkdir(path.join(localRoot, "batch[1]"));
				await Bun.write(path.join(localRoot, "batch[1]", "report](other.txt"), "nested-label-delimiter");
				LocalProtocolHandler.setOverride(localOptions(sessionId, path.join(tempDir, "artifacts")));
				const router = InternalUrlRouter.instance();
				const listing = await router.resolve("local://");
				expect(listing.content).toContain("[report%3Araw.txt](local://report%253Araw.txt)");
				expect(listing.content).toContain("[report:raw.txt](local://report%3Araw.txt)");
				expect(listing.content).toContain("[report).txt](local://report%29.txt)");
				expect(listing.content).toContain("[batch(1)/report).txt](local://batch%281%29/report%29.txt)");
				expect(listing.content).toContain("[report\\](other.txt](local://report%5D%28other.txt)");
				expect(listing.content).toContain(
					"[batch\\[1\\]/report\\](other.txt](local://batch%5B1%5D/report%5D%28other.txt)",
				);
				expect((await router.resolve("local://report%253Araw.txt")).content).toBe("literal-percent");
				expect((await router.resolve("local://report%3Araw.txt")).content).toBe("colon-sibling");
				expect((await router.resolve("local://report%29.txt")).content).toBe("root-delimiter");
				expect((await router.resolve("local://batch%281%29/report%29.txt")).content).toBe("nested-delimiter");
				expect((await router.resolve("local://report%5D%28other.txt")).content).toBe("root-label-delimiter");
				expect((await router.resolve("local://batch%5B1%5D/report%5D%28other.txt")).content).toBe(
					"nested-label-delimiter",
				);
				expect((await router.resolve("LOCAL://report%5D%28other.txt")).content).toBe("root-label-delimiter");
				await expect(router.resolve("local://report%2Graw.txt")).rejects.toThrow(
					"Invalid URL encoding in local:// path",
				);
			});
		});
	});

	it.skipIf(process.platform === "win32")(
		"keeps CR and LF filenames on one listing bullet and follows exact hrefs",
		async () => {
			await withTempDir(async tempDir => {
				const sessionId = `multiline-listing-${path.basename(tempDir)}`;
				await withLocalRoot(sessionId, async localRoot => {
					await Bun.write(path.join(localRoot, "line\nbreak.txt"), "line-feed");
					await fs.mkdir(path.join(localRoot, "batch\rname"));
					await Bun.write(path.join(localRoot, "batch\rname", "report\nraw.txt"), "nested-controls");
					LocalProtocolHandler.setOverride(localOptions(sessionId, path.join(tempDir, "artifacts")));
					const router = InternalUrlRouter.instance();
					const listing = await router.resolve("local://");
					const bullets = listing.content.split("\n").filter(line => line.startsWith("- ["));
					expect(bullets).toHaveLength(2);
					expect(bullets).toContain("- [line\\nbreak.txt](local://line%0Abreak.txt)");
					expect(bullets).toContain("- [batch\\rname/report\\nraw.txt](local://batch%0Dname/report%0Araw.txt)");
					expect((await router.resolve("local://line%0Abreak.txt")).content).toBe("line-feed");
					expect((await router.resolve("local://batch%0Dname/report%0Araw.txt")).content).toBe("nested-controls");
				});
			});
		},
	);

	it("blocks path traversal attempts", async () => {
		await withTempDir(async tempDir => {
			const sessionId = `session-c-${path.basename(tempDir)}`;
			await withLocalRoot(sessionId, async () => {
				LocalProtocolHandler.setOverride(localOptions(sessionId, path.join(tempDir, "artifacts")));
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("local://../secret.txt")).rejects.toThrow(
					"Path traversal (..) is not allowed in local:// URLs",
				);
				await expect(router.resolve("local://%2E%2E/secret.txt")).rejects.toThrow(
					"Path traversal (..) is not allowed in local:// URLs",
				);
			});
		});
	});

	it("preserves literal percent escapes in the authority while decoding only the pathname", async () => {
		await withTempDir(async tempDir => {
			const sessionId = `percent-authority-${path.basename(tempDir)}`;
			await withLocalRoot(sessionId, async localRoot => {
				const literalPercent = path.join(localRoot, "report%3Araw.txt");
				const decodedSibling = path.join(localRoot, "report:raw.txt");
				await fs.writeFile(literalPercent, "literal");
				await fs.writeFile(decodedSibling, "decoded");
				const options = localOptions(sessionId, path.join(tempDir, "artifacts"));

				expect(resolveLocalUrlToPath("local://report%253Araw.txt", options)).toBe(literalPercent);
				expect(resolveLocalUrlToPath("local://report:raw.txt", options)).toBe(decodedSibling);
			});
		});
	});

	it("rejects malformed pathname escapes without decoding the authority again", async () => {
		await withTempDir(async tempDir => {
			const sessionId = `percent-malformed-${path.basename(tempDir)}`;
			await withLocalRoot(sessionId, async () => {
				const options = localOptions(sessionId, path.join(tempDir, "artifacts"));
				expect(() => resolveLocalUrlToPath("local://report%253Araw.txt/%ZZ", options)).toThrow(
					"Invalid URL encoding in local:// path",
				);
			});
		});
	});

	it("resolves a stable external path before initialization", async () => {
		const options = {
			getSessionId: () => "session/fallback",
			getArtifactsDir: () => null,
		};
		const root = resolveLocalRoot(options);
		expect(root).toBe(path.join(os.tmpdir(), "gjc-local", "session_fallback"));
		expect(resolveLocalUrlToPath("local://memo.txt", options)).toBe(path.join(root, "memo.txt"));
		await initializeLocalRoot(options);
		expect(resolveLocalUrlToPath("local://memo.txt", options)).toBe(path.join(root, "memo.txt"));
	});

	it("resolves against a cleanup_pending root the async gate already settled", async () => {
		// The async gate treats `cleanup_pending` as settled: entries are installed and
		// content-verified, only legacy-source retirement is outstanding. The sync
		// resolver used to reject that same marker as unsafe, so a session whose
		// migration ended in `cleanup_pending` failed closed on every local:// read.
		await withTempDir(async artifactsDir => {
			const sessionId = `cleanup-pending-sync-${path.basename(artifactsDir)}`;
			await withLocalRoot(sessionId, async localRoot => {
				await Bun.write(path.join(localRoot, "carried.json"), '{"carried":true}');
				await fs.writeFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "cleanup_pending\n", {
					mode: 0o600,
				});

				const options = localOptions(sessionId, artifactsDir);
				expect(resolveLocalUrlToPath("local://carried.json", options)).toBe(path.join(localRoot, "carried.json"));
				// Idempotent: a second resolution must not rewrite or reject the marker.
				expect(resolveLocalUrlToPath("local://", options)).toBe(localRoot);
				expect(await fs.readFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "utf8")).toBe(
					"cleanup_pending\n",
				);
			});
		});
	});

	it("still rejects an unrecognized migration marker value", async () => {
		await withTempDir(async artifactsDir => {
			const sessionId = `unsafe-marker-sync-${path.basename(artifactsDir)}`;
			await withLocalRoot(sessionId, async localRoot => {
				await fs.writeFile(path.join(localRoot, ".gjc-local-legacy-migrated-v1"), "definitely-not-a-state\n", {
					mode: 0o600,
				});
				expect(() => resolveLocalUrlToPath("local://memo.txt", localOptions(sessionId, artifactsDir))).toThrow(
					"Unsafe local:// migration marker",
				);
			});
		});
	});

	it("blocks symlink escapes outside local root", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const sessionId = `session-d-${path.basename(tempDir)}`;
			await withLocalRoot(sessionId, async localRoot => {
				const outsideDir = path.join(tempDir, "outside");
				await fs.mkdir(localRoot, { recursive: true });
				await fs.mkdir(outsideDir, { recursive: true });
				await Bun.write(path.join(outsideDir, "secret.txt"), "secret");
				await fs.symlink(outsideDir, path.join(localRoot, "linked"));

				LocalProtocolHandler.setOverride(localOptions(sessionId, path.join(tempDir, "artifacts")));
				await expect(InternalUrlRouter.instance().resolve("local://linked/secret.txt")).rejects.toThrow(
					"local:// URL escapes local root",
				);
			});
		});
	});

	it("rejects symlinked and colliding session roots", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const symlinkSession = `symlink-${path.basename(tempDir)}`;
			const collisionSession = `collision-${path.basename(tempDir)}`;
			const outsideDir = path.join(tempDir, "outside");
			await fs.mkdir(outsideDir, { recursive: true });

			await withLocalRoot(symlinkSession, async symlinkRoot => {
				await fs.rm(symlinkRoot, { recursive: true, force: true });

				await fs.symlink(outsideDir, symlinkRoot);
				LocalProtocolHandler.setOverride(localOptions(symlinkSession, path.join(tempDir, "artifacts")));
				await expect(InternalUrlRouter.instance().resolve("local://")).rejects.toThrow("Unsafe local:// root");
			});

			await withLocalRoot(collisionSession, async collisionRoot => {
				await fs.rm(collisionRoot, { recursive: true, force: true });
				await fs.writeFile(collisionRoot, "not a directory");
				LocalProtocolHandler.setOverride(localOptions(collisionSession, path.join(tempDir, "artifacts")));
				await expect(InternalUrlRouter.instance().resolve("local://")).rejects.toThrow("Unsafe local:// root");
			});
		});
	});
});
