import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import {
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";
import {
	captureTaskArtifactOwnerDeletionEvidence,
	newSessionRootStore,
	openOwnerStore,
} from "../src/session/internal/task-artifact-owner-access";
import { SessionManager } from "../src/session/session-manager";
import {
	OWNER_DIRECTORY,
	OWNER_MANIFEST,
	OWNER_SCHEMA_VERSION,
	ownerIdForSession,
	ownerRelativePath,
	type TaskArtifactOwnerLocator,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";

interface OwnerFixture {
	readonly root: string;
	readonly sessionId: string;
	readonly context: TaskArtifactOwnerStorageContext;
	readonly locator: TaskArtifactOwnerLocator;
	readonly ownerPath: string;
	readonly ownerRoot: ManagedDirectoryRoot;
}

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function expectedDirectoryRoot(pathname: string): ManagedDirectoryRoot {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture_directory_invalid");
	return {
		canonicalPath: path.resolve(pathname),
		dev: BigInt.asUintN(64, stat.dev),
		ino: BigInt.asUintN(64, stat.ino),
	};
}

async function makeOwnerFixture(): Promise<OwnerFixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-owner-access-"));
	fixtureRoots.push(root);
	const profileAgentDir = path.resolve(root);
	const sessionsRoot = path.join(profileAgentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { mode: 0o700 });
	const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: prepareManagedDirectoryRoot(profileAgentDir, securityPolicy),
		sessionsRoot,
		securityPolicy,
		profileAgentDir,
	};
	const sessionId = `access-session-${crypto.randomUUID()}`;
	const locator: TaskArtifactOwnerLocator = {
		schemaVersion: OWNER_SCHEMA_VERSION,
		ownerId: ownerIdForSession(sessionId),
		directoryDev: "0",
		directoryIno: "0",
	};
	const rootStore = new ManagedSessionDescendantStore(
		context.rootAuthority,
		sessionsRoot,
		undefined,
		securityPolicy,
		profileAgentDir,
		expectedDirectoryRoot(sessionsRoot),
	);
	let ownerStore: ManagedSessionDescendantStore | undefined;
	try {
		rootStore.verifyRootSecurity();
		rootStore.ensureDirectory(OWNER_DIRECTORY);
		const ownerRoot = rootStore.ensureDirectory(ownerRelativePath(locator.ownerId));
		const boundLocator: TaskArtifactOwnerLocator = {
			...locator,
			directoryDev: ownerRoot.dev.toString(),
			directoryIno: ownerRoot.ino.toString(),
		};
		const ownerPath = path.join(sessionsRoot, ownerRelativePath(locator.ownerId));
		ownerStore = new ManagedSessionDescendantStore(
			context.rootAuthority,
			ownerPath,
			undefined,
			securityPolicy,
			profileAgentDir,
			ownerRoot,
		);
		await ownerStore.publishNoReplace(
			OWNER_MANIFEST,
			Buffer.from(`${JSON.stringify({ ...boundLocator, sessionId })}\n`, "utf8"),
		);
		await ownerStore.publishNoReplace("artifact.bin", Buffer.from("owner-payload", "utf8"));
		return { root, sessionId, context, locator: boundLocator, ownerPath, ownerRoot };
	} finally {
		ownerStore?.close();
		rootStore.close();
	}
}

function openFixtureOwner(fixture: OwnerFixture): ManagedSessionDescendantStore {
	return new ManagedSessionDescendantStore(
		fixture.context.rootAuthority,
		fixture.ownerPath,
		undefined,
		fixture.context.securityPolicy,
		fixture.context.profileAgentDir,
		fixture.ownerRoot,
	);
}

async function replaceManifest(fixture: OwnerFixture, value: Uint8Array): Promise<void> {
	const ownerStore = openFixtureOwner(fixture);
	try {
		await ownerStore.replace(OWNER_MANIFEST, value);
	} finally {
		ownerStore.close();
	}
}

describe("generic artifact continuation without owner publication", () => {
	it.each([
		["allocate", "replace"],
		["allocate", "close"],
		["save", "replace"],
		["save", "close"],
		["allocate", "switch"],
		["save", "switch"],
	] as const)("fences %s after %s during the final allocation await", async (operation, transition) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-artifact-final-await-"));
		fixtureRoots.push(root);
		const session = SessionManager.create(root, SessionManager.managedDestination(root, root));
		session.appendMessage({ role: "user", content: "real managed transcript", timestamp: 1 });
		await session.ensureOnDisk();
		const manager = session.getArtifactManager();
		if (!manager) throw new Error("Expected live artifact manager");
		let targetFile: string | undefined;
		if (transition === "switch") {
			const target = SessionManager.create(root, SessionManager.managedDestination(root, root));
			try {
				target.appendMessage({ role: "user", content: "switched transcript", timestamp: 2 });
				await target.ensureOnDisk();
				targetFile = target.getSessionFile();
			} finally {
				await target.close();
			}
			session.adoptArtifactManager(manager);
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const allocate = manager.allocatePath.bind(manager);
		let reservedId: string | undefined;
		const allocation = vi.spyOn(manager, "allocatePath").mockImplementation(async toolType => {
			const reserved = await allocate(toolType);
			reservedId = reserved.id;
			entered.resolve();
			await release.promise;
			return reserved;
		});
		const pending =
			operation === "allocate"
				? session.allocateArtifactPath("continuation")
				: session.saveArtifact("must not be published", "continuation");
		try {
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Artifact operation completed before the allocation gate.");
				}),
			]);
			if (transition === "replace")
				session.adoptArtifactManager(new ArtifactManager(path.join(root, "replacement")));
			else if (transition === "switch") {
				if (!targetFile) throw new Error("Expected genuine switch target");
				await session.setSessionFile(targetFile);
				expect(session.getArtifactManager()).toBe(manager);
				expect(session.getSessionFile()).toBe(targetFile);
			} else await session.close();
			release.resolve();
			await expect(pending).rejects.toThrow(transition === "close" ? "closing" : "no longer authorized");
			expect(reservedId).toBeDefined();
			expect(await Bun.file(path.join(manager.dir, `${reservedId}.continuation.log`)).exists()).toBe(false);
			expect(fs.existsSync(path.join(root, "replacement", `${reservedId}.continuation.log`))).toBe(false);
			if (transition === "replace") {
				allocation.mockRestore();
				const freshId = await session.saveArtifact("current manager works", "continuation");
				const freshPath = await session.getArtifactPath(freshId!);
				if (!freshPath) throw new Error("Expected current-manager artifact");
				expect(await Bun.file(freshPath).text()).toBe("current manager works");
			}
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
			allocation.mockRestore();
			await session.close();
		}
	});

	it("invalidates an awaited save even when rollback restores the same session and adopted manager", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-artifact-rollback-aba-"));
		fixtureRoots.push(root);
		const session = SessionManager.create(root, SessionManager.managedDestination(root, root));
		const borrowed = new ArtifactManager(path.join(root, "shared"));
		session.adoptArtifactManager(borrowed);
		const snapshot = session.captureState();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const allocate = borrowed.allocatePath.bind(borrowed);
		const allocation = vi.spyOn(borrowed, "allocatePath").mockImplementation(async toolType => {
			const reserved = await allocate(toolType);
			entered.resolve();
			await release.promise;
			return reserved;
		});
		const pending = session.saveArtifact("stale ABA payload", "aba");
		try {
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Artifact operation completed before the allocation gate.");
				}),
			]);
			session.restoreState(snapshot);
			expect(session.getSessionId()).toBe(snapshot.sessionId);
			expect(session.getArtifactManager()).toBe(borrowed);
			release.resolve();
			await expect(pending).rejects.toThrow("no longer authorized");
			expect(await borrowed.exists("0")).toBe(false);
			allocation.mockRestore();
			const freshId = await session.saveArtifact("fresh rollback payload", "aba");
			expect(await borrowed.readRange(freshId!)).toBe("fresh rollback payload");
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
			allocation.mockRestore();
			await session.close();
		}
	});
});

describe("task artifact owner read-only access", () => {
	it("captures immutable evidence from a complete managed owner and tolerates only a missing locator", async () => {
		const fixture = await makeOwnerFixture();
		const evidence = captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator);
		if (!evidence) throw new Error("valid owner locator unexpectedly absent");
		const rootStore = newSessionRootStore(fixture.context);
		try {
			expect(evidence.locator).toEqual(fixture.locator);
			expect(evidence.sessionId).toBe(fixture.sessionId);
			expect(evidence.treeSnapshot.rootDev).toBe(fixture.locator.directoryDev);
			expect(evidence.treeSnapshot.rootIno).toBe(fixture.locator.directoryIno);
			expect(evidence.parentIdentity).toEqual(rootStore.captureDirectoryIdentity(OWNER_DIRECTORY));
			expect(Object.isFrozen(evidence)).toBe(true);
			expect(Object.isFrozen(evidence.treeSnapshot.entries)).toBe(true);
		} finally {
			rootStore.close();
		}
		expect(captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, undefined)).toBeUndefined();
		expect(() =>
			captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, {
				...fixture.locator,
				ownerId: "bad",
			}),
		).toThrow("task_artifact_owner_locator_invalid");
	});

	it("rejects a noncanonical profile and session or manifest identity substitutions", async () => {
		const fixture = await makeOwnerFixture();
		const badProfile = { ...fixture.context, profileAgentDir: "relative-profile" };
		expect(() => captureTaskArtifactOwnerDeletionEvidence(badProfile, fixture.sessionId, fixture.locator)).toThrow(
			"task_artifact_owner_profile_invalid",
		);
		const fileProfilePath = path.join(fixture.root, "not-a-profile-directory");
		fs.writeFileSync(fileProfilePath, "untouched profile occupant", { mode: 0o600 });
		expect(() =>
			captureTaskArtifactOwnerDeletionEvidence(
				{ ...fixture.context, profileAgentDir: fileProfilePath },
				fixture.sessionId,
				fixture.locator,
			),
		).toThrow("task_artifact_owner_profile_invalid");
		expect(fs.readFileSync(fileProfilePath, "utf8")).toBe("untouched profile occupant");
		expect(() =>
			captureTaskArtifactOwnerDeletionEvidence(fixture.context, `${fixture.sessionId}-other`, fixture.locator),
		).toThrow("task_artifact_owner_session_mismatch");
		const changedLocator = {
			...fixture.locator,
			directoryDev: (BigInt(fixture.locator.directoryDev) + 1n).toString(),
		};
		expect(() =>
			captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, changedLocator),
		).toThrow("task_artifact_owner_manifest_mismatch");
	});

	it("rejects malformed and session-mismatched owner manifests", async () => {
		const fixture = await makeOwnerFixture();
		await replaceManifest(fixture, Buffer.from("{", "utf8"));
		expect(() =>
			captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator),
		).toThrow("task_artifact_owner_manifest_invalid");

		const second = await makeOwnerFixture();
		await replaceManifest(
			second,
			Buffer.from(`${JSON.stringify({ ...second.locator, sessionId: "another-owner-session" })}\n`, "utf8"),
		);
		expect(() => captureTaskArtifactOwnerDeletionEvidence(second.context, second.sessionId, second.locator)).toThrow(
			"task_artifact_owner_session_mismatch",
		);

		const third = await makeOwnerFixture();
		await replaceManifest(
			third,
			Buffer.from(`${JSON.stringify({ ...third.locator, sessionId: third.sessionId, extra: true })}\n`, "utf8"),
		);
		expect(() => captureTaskArtifactOwnerDeletionEvidence(third.context, third.sessionId, third.locator)).toThrow(
			"task_artifact_owner_manifest_invalid",
		);
	});

	it("rejects a replaced parent directory without following or repairing it", async () => {
		const fixture = await makeOwnerFixture();
		const parent = path.join(fixture.context.sessionsRoot, OWNER_DIRECTORY);
		const retainedParent = `${parent}.retained-${crypto.randomUUID()}`;
		fs.renameSync(parent, retainedParent);
		fs.writeFileSync(parent, "foreign parent", { mode: 0o600 });
		try {
			expect(() =>
				captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator),
			).toThrow("managed_directory_identity_unavailable");
			expect(await Bun.file(parent).text()).toBe("foreign parent");
		} finally {
			fs.unlinkSync(parent);
			fs.renameSync(retainedParent, parent);
		}
	});

	it("fails closed when a valid locator names a missing owner directory", async () => {
		const fixture = await makeOwnerFixture();
		const displacedOwner = `${fixture.ownerPath}.displaced-${crypto.randomUUID()}`;
		fs.renameSync(fixture.ownerPath, displacedOwner);
		try {
			expect(() =>
				captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator),
			).toThrow("task_artifact_owner_missing");
			expect(fs.existsSync(fixture.ownerPath)).toBe(false);
		} finally {
			fs.renameSync(displacedOwner, fixture.ownerPath);
		}
	});

	it("rejects an owner directory replaced beneath an otherwise valid manifest", async () => {
		const fixture = await makeOwnerFixture();
		const displacedOwner = `${fixture.ownerPath}.displaced-${crypto.randomUUID()}`;
		const replacementOwner = `${fixture.ownerPath}.replacement-${crypto.randomUUID()}`;
		fs.mkdirSync(replacementOwner, { mode: 0o700 });
		fs.writeFileSync(
			path.join(replacementOwner, OWNER_MANIFEST),
			`${JSON.stringify({ ...fixture.locator, sessionId: fixture.sessionId })}\n`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(replacementOwner, "artifact.bin"), "foreign-payload", { mode: 0o600 });
		fs.renameSync(fixture.ownerPath, displacedOwner);
		fs.renameSync(replacementOwner, fixture.ownerPath);
		try {
			expect(() =>
				captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator),
			).toThrow("task_artifact_owner_identity_mismatch");
			expect(await Bun.file(path.join(fixture.ownerPath, "artifact.bin")).text()).toBe("foreign-payload");
		} finally {
			fs.renameSync(fixture.ownerPath, replacementOwner);
			fs.renameSync(displacedOwner, fixture.ownerPath);
		}
	});

	it("rejects both real cross-process managed publication windows and acknowledges release", async () => {
		for (const phase of ["staging", "replacement"] as const) {
			const fixture = await makeOwnerFixture();
			const readyPath = path.join(fixture.root, `writer-${phase}.ready`);
			const releasePath = path.join(fixture.root, `writer-${phase}.release`);
			const fixturePath = path.join(import.meta.dir, "fixtures", "task-owner-access-writer.ts");
			const child = Bun.spawn([process.execPath, fixturePath], {
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					GJC_TASK_OWNER_ACCESS_WRITER_INPUT: JSON.stringify({
						profileRoot: fixture.context.profileAgentDir,
						ownerRoot: fixture.ownerPath,
						filename: phase === "replacement" ? "artifact.bin" : `child-${phase}.bin`,
						ready: readyPath,
						release: releasePath,
						phase,
					}),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdoutPromise = new Response(child.stdout).text();
			const stderrPromise = new Response(child.stderr).text();
			try {
				const deadline = Date.now() + 10_000;
				while (!(await Bun.file(readyPath).exists())) {
					if (Date.now() >= deadline) throw new Error(`writer ${phase} readiness timed out`);
					const exited = await Promise.race([
						child.exited.then(code => ({ done: true as const, code })),
						Bun.sleep(10).then(() => ({ done: false as const })),
					]);
					if (exited.done)
						throw new Error(`writer ${phase} exited before readiness (${exited.code}): ${await stderrPromise}`);
				}

				const readyValue: unknown = JSON.parse(await Bun.file(readyPath).text());
				if (typeof readyValue !== "object" || readyValue === null || Array.isArray(readyValue))
					throw new Error(`writer ${phase} readiness record invalid`);
				const record = readyValue as Record<string, unknown>;
				expect(record.pid).toEqual(expect.any(Number));
				expect(record.pid).not.toBe(process.pid);
				expect(record.phase).toBe(phase);
				expect(typeof record.marker).toBe("string");
				expect(typeof record.dev).toBe("string");
				expect(typeof record.ino).toBe("string");
				if (typeof record.marker !== "string" || typeof record.dev !== "string" || typeof record.ino !== "string")
					throw new Error(`writer ${phase} descriptor identity missing`);
				expect(record.marker).toMatch(
					new RegExp(`^\\..+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${phase}$`, "u"),
				);
				const markerPath = path.join(fixture.ownerPath, record.marker);
				const markerStat = fs.lstatSync(markerPath, { bigint: true });
				expect(markerStat.isFile()).toBe(true);
				expect(markerStat.dev.toString()).toBe(record.dev);
				expect(markerStat.ino.toString()).toBe(record.ino);

				const destinationBefore = await Bun.file(path.join(fixture.ownerPath, "artifact.bin")).text();
				expect(() =>
					captureTaskArtifactOwnerDeletionEvidence(fixture.context, fixture.sessionId, fixture.locator),
				).toThrow("task_artifact_owner_writer_not_quiescent");
				expect(await Bun.file(path.join(fixture.ownerPath, "artifact.bin")).text()).toBe(destinationBefore);
				expect(fs.lstatSync(markerPath, { bigint: true }).ino.toString()).toBe(record.ino);
			} finally {
				await Bun.write(releasePath, "release");
				const exitCode = await child.exited;
				const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
				expect(exitCode, `${phase} writer failed: ${stderr}`).toBe(0);
				expect(stdout).toContain(`"phase":"${phase}"`);
				expect(stdout).toContain('"status":"acknowledged"');
			}
			if (phase === "replacement")
				expect(await Bun.file(path.join(fixture.ownerPath, "artifact.bin")).text()).toBe(
					"independent-managed-replacement",
				);
			else
				expect(await Bun.file(path.join(fixture.ownerPath, `child-${phase}.bin`)).text()).toBe(
					"independent-managed-staging",
				);
		}
	});

	it("returns the real native exact-removal result only for the captured parent identity", async () => {
		const fixture = await makeOwnerFixture();
		const rootStore = newSessionRootStore(fixture.context);
		const directRemove = native.exactRemoveDirectoryTree;
		let nativeResult: native.NativeExactUnlinkResult | undefined;
		const removalSpy = vi
			.spyOn(native, "exactRemoveDirectoryTree")
			.mockImplementation((pathname, snapshot, parent) => {
				nativeResult = directRemove(pathname, snapshot, parent);
				return nativeResult;
			});
		try {
			const snapshot = rootStore.captureTree(ownerRelativePath(fixture.locator.ownerId));
			const parent = rootStore.captureDirectoryIdentity(OWNER_DIRECTORY);
			expect(() =>
				rootStore.removeTreeExpectedWithParentIdentity(ownerRelativePath(fixture.locator.ownerId), snapshot, {
					dev: BigInt(parent.dev),
					ino: BigInt(parent.ino) + 1n,
				}),
			).toThrow("managed_remove_parent_identity_mismatch");
			const result = rootStore.removeTreeExpectedWithParentIdentity(
				ownerRelativePath(fixture.locator.ownerId),
				snapshot,
				{
					dev: BigInt(parent.dev),
					ino: BigInt(parent.ino),
				},
			);
			expect(removalSpy).toHaveBeenCalledTimes(1);
			if (!nativeResult) throw new Error("Expected the real native removal call");
			expect(result).toBe(nativeResult);
			// Durable native scrub may retain a namespace; do not demand POSIX physical reclamation.
			if (!result.ok) expect(result.code).toBeDefined();
		} finally {
			removalSpy.mockRestore();
			rootStore.close();
		}
	});

	it("rejects a substituted directory in the read-only expected-identity security window", async () => {
		const fixture = await makeOwnerFixture();
		const candidate = path.join(fixture.root, "substitute-session-root");
		const displaced = path.join(fixture.root, "original-session-root");
		fs.mkdirSync(candidate, { mode: 0o700 });
		fs.writeFileSync(path.join(candidate, "sentinel"), "unmodified foreign bytes", { mode: 0o600 });
		const expected = expectedDirectoryRoot(fixture.context.sessionsRoot);
		const nativeBindings = native;
		let swapped = false;
		let verifiedWithoutMutation = false;
		let restoreVerifier: (() => void) | undefined;
		const swapAndFingerprint = (): { dev: bigint; ino: bigint; mode: bigint; ctimeNs: bigint; bytes: string } => {
			if (!swapped) {
				fs.renameSync(fixture.context.sessionsRoot, displaced);
				fs.renameSync(candidate, fixture.context.sessionsRoot);
				swapped = true;
			}
			const stat = fs.lstatSync(fixture.context.sessionsRoot, { bigint: true });
			return {
				dev: stat.dev,
				ino: stat.ino,
				mode: stat.mode & 0o777n,
				ctimeNs: stat.ctimeNs,
				bytes: fs.readFileSync(path.join(fixture.context.sessionsRoot, "sentinel"), "utf8"),
			};
		};

		try {
			if (process.platform === "win32") {
				const original = nativeBindings.verifyOwnerOnlyPathSecurityExpected.bind(nativeBindings);
				const spy = vi
					.spyOn(nativeBindings, "verifyOwnerOnlyPathSecurityExpected")
					.mockImplementation((pathname, kind, dev, ino) => {
						if (pathname !== fixture.context.sessionsRoot) return original(pathname, kind, dev, ino);
						const before = swapAndFingerprint();
						expect(before.ino).not.toBe(expected.ino);
						const result = original(pathname, kind, dev, ino);
						expect(swapAndFingerprint()).toEqual(before);
						verifiedWithoutMutation = true;
						return result;
					});
				restoreVerifier = () => spy.mockRestore();
			} else {
				const original = nativeBindings.verifyOwnerOnlyPathSecurity.bind(nativeBindings);
				const spy = vi.spyOn(nativeBindings, "verifyOwnerOnlyPathSecurity").mockImplementation((pathname, kind) => {
					if (pathname !== fixture.context.sessionsRoot) return original(pathname, kind);
					const before = swapAndFingerprint();
					expect(before.ino).not.toBe(expected.ino);
					const result = original(pathname, kind);
					expect(swapAndFingerprint()).toEqual(before);
					verifiedWithoutMutation = true;
					return result;
				});
				restoreVerifier = () => spy.mockRestore();
			}
			expect(
				() =>
					new ManagedSessionDescendantStore(
						fixture.context.rootAuthority,
						fixture.context.sessionsRoot,
						undefined,
						fixture.context.securityPolicy,
						fixture.context.profileAgentDir,
						expected,
					),
			).toThrow();
			expect(verifiedWithoutMutation).toBe(true);
			expect(fs.readFileSync(path.join(fixture.context.sessionsRoot, "sentinel"), "utf8")).toBe(
				"unmodified foreign bytes",
			);
		} finally {
			restoreVerifier?.();
			if (swapped) {
				fs.renameSync(fixture.context.sessionsRoot, candidate);
				fs.renameSync(displaced, fixture.context.sessionsRoot);
			}
		}
	});

	it("opens a complete owner only after validating its locator and manifest", async () => {
		const fixture = await makeOwnerFixture();
		const rootStore = newSessionRootStore(fixture.context);
		let ownerStore: ManagedSessionDescendantStore | undefined;
		try {
			ownerStore = openOwnerStore(fixture.context, rootStore, fixture.locator, fixture.sessionId);
			expect(ownerStore.subtreeRootAuthority).toEqual(fixture.ownerRoot);
			expect(ownerStore.readExpected(OWNER_MANIFEST)?.bytes.byteLength).toBeGreaterThan(0);
			expect(() =>
				openOwnerStore(fixture.context, rootStore, fixture.locator, `${fixture.sessionId}-wrong`),
			).toThrow("task_artifact_owner_session_mismatch");
		} finally {
			ownerStore?.close();
			rootStore.close();
		}
	});
});
