import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FilesystemTopicRegistryCasAuthority,
	loadInstallationHostId,
	parseMacPlatformUuid,
	parseWindowsMachineGuid,
	type TelegramDaemonFs,
	TopicRegistryDurabilityUnavailableError,
} from "../src/sdk/bus/telegram-daemon";

const temporaryDirectories: string[] = [];
const durableTestFs: TelegramDaemonFs = {
	...fs.promises,
	mkdir: async (directory, options) => {
		await fs.promises.mkdir(directory, options);
	},
	fsyncFile: async () => {},
	fsyncDirectory: async () => {},
};
function authority(): { authority: FilesystemTopicRegistryCasAuthority; file: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-topic-cas-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "telegram-topics.json");
	return {
		authority: new FilesystemTopicRegistryCasAuthority(file, {
			installationHostId: "test-host",
			fs: durableTestFs,
			platform: "linux",
		}),
		file,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
test("machine-local identity parsing is strict and machine IDs are domain-hashed", async () => {
	expect(parseWindowsMachineGuid("MachineGuid    REG_SZ    00112233-4455-6677-8899-aabbccddeeff")).toBe(
		"00112233-4455-6677-8899-aabbccddeeff",
	);
	expect(parseWindowsMachineGuid("MachineGuid REG_SZ not-a-guid")).toBeUndefined();
	expect(parseMacPlatformUuid('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"')).toBeUndefined();

	const hostId = await loadInstallationHostId({
		platform: "linux",
		readFile: async file => {
			if (file === "/etc/machine-id") return "00112233445566778899aabbccddeeff\n";
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
	});
	expect(hostId).toMatch(/^[0-9a-f]{64}$/);
	expect(hostId).not.toContain("00112233445566778899aabbccddeeff");
	await expect(
		loadInstallationHostId({
			platform: "linux",
			readFile: async () => "malformed",
		}),
	).rejects.toThrow("unavailable or malformed");
	await expect(
		loadInstallationHostId({
			platform: "win32",
			runCommand: () => ({ exitCode: 1, stdout: new Uint8Array() }),
		}),
	).rejects.toThrow("unavailable or malformed");
});

test("filesystem topic authority bootstraps, serializes competing hosts, and survives restart", async () => {
	const { authority: first, file } = authority();
	const second = new FilesystemTopicRegistryCasAuthority(file, {
		installationHostId: "test-host",
		fs: durableTestFs,
		platform: "linux",
	});
	expect(await first.read()).toEqual({ version: 2, registryGeneration: 0, topics: {} });
	const next = { version: 2 as const, registryGeneration: 1, topics: {} };
	expect(
		(await Promise.all([first.compareAndSet(0, next), second.compareAndSet(0, next)])).filter(Boolean),
	).toHaveLength(1);
	expect(
		await new FilesystemTopicRegistryCasAuthority(file, {
			installationHostId: "test-host",
			fs: durableTestFs,
			platform: "linux",
		}).read(),
	).toEqual(next);
});
test("filesystem topic authority upgrades exact versionless generation-35 state through CAS and preserves its quarantine", async () => {
	const { authority: registry, file } = authority();
	const legacy = {
		topics: {
			session: {
				topicId: "1",
				topicOrigin: "daemon_created",
				identitySent: true,
				createdAt: 0,
				chatId: "42",
				endpointKey: "ws://endpoint",
				endpointDigest: "digest",
				authorityState: "active",
			},
		},
	};
	fs.writeFileSync(file, JSON.stringify(legacy));
	expect(await registry.read()).toMatchObject({
		version: 2,
		registryGeneration: 0,
		topics: { session: { authorityState: "legacy_quarantined" } },
	});
	const next = { version: 2 as const, registryGeneration: 1, topics: {} };
	expect(await registry.compareAndSet(0, next)).toBe(true);
	expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(next);
	const quarantines = fs
		.readdirSync(path.dirname(file))
		.filter(name => name.startsWith("telegram-topics.json.legacy-quarantine."));
	expect(quarantines).toHaveLength(1);
	expect(JSON.parse(fs.readFileSync(path.join(path.dirname(file), quarantines[0]!), "utf8"))).toEqual(legacy);
});

test("filesystem topic authority fails closed for unavailable or malformed shared state", async () => {
	const { authority: registry, file } = authority();
	fs.writeFileSync(file, "not json");
	await expect(registry.read()).rejects.toThrow("shared topic authority");
	fs.writeFileSync(file, JSON.stringify({ version: 3, registryGeneration: 0, topics: {} }));
	await expect(registry.read()).rejects.toThrow("unsupported");
});
test("filesystem topic authority rejects malformed nested version-two authority records", async () => {
	const { authority: registry, file } = authority();
	for (const malformed of [
		{
			version: 2,
			registryGeneration: 0,
			topics: { session: { topicId: "1", identitySent: true, createdAt: 0, chatId: "1" } },
		},
		{
			version: 2,
			registryGeneration: 0,
			topics: {},
			createClaims: { session: { sessionId: "session", authorityEpoch: -1, createdAt: 0 } },
		},
		{
			version: 2,
			registryGeneration: 0,
			topics: {},
			archiveJobs: {
				session: { sessionId: "session", topicId: "1", attempt: 0, backoffMs: 0, nextAttemptAt: "later" },
			},
		},
		{ version: 2, registryGeneration: 0, topics: {}, fences: { session: -1 } },
		{
			version: 2,
			registryGeneration: 0,
			topics: {},
			closedEndpoints: { session: { chatId: "1", endpointKey: "key" } },
		},
		{
			version: 2,
			registryGeneration: 0,
			topics: {
				session: {
					topicId: 1,
					identitySent: true,
					createdAt: 0,
					authorityState: "active",
					leaseOwner: 42,
					leaseHeartbeatAt: 1,
					leaseExpiresAt: 2,
				},
			},
		},
		{
			version: 2,
			registryGeneration: 0,
			topics: {
				session: {
					topicId: 1,
					identitySent: true,
					createdAt: 0,
					authorityState: "active",
					leaseOwner: "host",
					leaseExpiresAt: 2,
				},
			},
		},
		{
			version: 2,
			registryGeneration: 0,
			topics: {
				session: {
					topicId: 1,
					identitySent: true,
					createdAt: 0,
					authorityState: "active",
					disconnectGraceExpiresAt: 2,
				},
			},
		},
	]) {
		fs.writeFileSync(file, JSON.stringify(malformed));
		await expect(registry.read()).rejects.toThrow("malformed");
	}
});

test("a later CAS generation cannot be overwritten by an earlier publisher after its CAS", async () => {
	const { authority: first, file } = authority();
	const second = new FilesystemTopicRegistryCasAuthority(file, {
		installationHostId: "test-host",
		fs: durableTestFs,
		platform: "linux",
	});
	const a = { version: 2 as const, registryGeneration: 1, topics: {} };
	const b = { version: 2 as const, registryGeneration: 2, topics: {}, fences: { session: 1 } };
	expect(await first.compareAndSet(0, a)).toBe(true);
	expect(await second.compareAndSet(1, b)).toBe(true);
	expect(
		await new FilesystemTopicRegistryCasAuthority(file, {
			installationHostId: "test-host",
			fs: durableTestFs,
			platform: "linux",
		}).read(),
	).toEqual(b);
});
test("Windows topic CAS uses exact identity-bound replacement without directory fsync", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-topic-cas-durability-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "telegram-topics.json");
	fs.writeFileSync(file, JSON.stringify({ version: 2, registryGeneration: 0, topics: {} }));
	const initialIdentity = fs.lstatSync(file, { bigint: true });
	let directorySyncCalls = 0;
	let replaceCalls = 0;
	const fsImpl: TelegramDaemonFs = {
		...fs.promises,
		mkdir: async (directory, options) => {
			await fs.promises.mkdir(directory, options);
		},
		fsyncFile: async () => {},
		fsyncDirectory: async () => {
			directorySyncCalls++;
			throw new Error("Windows directory fsync must not be used");
		},
	};
	const registry = new FilesystemTopicRegistryCasAuthority(file, {
		installationHostId: "test-host",
		fs: fsImpl,
		platform: "win32",
		exactReplace: (source, destination, expectedSource, expectedDestination) => {
			replaceCalls++;
			const stagedIdentity = fs.lstatSync(source, { bigint: true });
			expect(expectedSource).toMatchObject({
				dev: stagedIdentity.dev,
				ino: stagedIdentity.ino,
				nlink: 1n,
				size: stagedIdentity.size,
				mtimeNs: stagedIdentity.mtimeNs,
			});
			expect(expectedDestination).toMatchObject({
				dev: initialIdentity.dev,
				ino: initialIdentity.ino,
				nlink: 1n,
				size: initialIdentity.size,
				mtimeNs: initialIdentity.mtimeNs,
			});
			expect(expectedSource.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(expectedDestination.sha256).toMatch(/^[0-9a-f]{64}$/);
			fs.renameSync(source, destination);
			return { ok: true };
		},
	});

	await expect(registry.compareAndSet(0, { version: 2, registryGeneration: 1, topics: {} })).resolves.toBe(true);
	expect(replaceCalls).toBe(1);
	expect(directorySyncCalls).toBe(0);
	expect(await registry.read()).toEqual({ version: 2, registryGeneration: 1, topics: {} });
});

test("refuses Windows exact replacement failure before advancing authority generation", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-topic-cas-durability-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "telegram-topics.json");
	fs.writeFileSync(file, JSON.stringify({ version: 2, registryGeneration: 0, topics: {} }));
	const fsImpl: TelegramDaemonFs = {
		...fs.promises,
		mkdir: async (directory, options) => {
			await fs.promises.mkdir(directory, options);
		},
		fsyncFile: async () => {},
	};
	const registry = new FilesystemTopicRegistryCasAuthority(file, {
		installationHostId: "test-host",
		fs: fsImpl,
		platform: "win32",
		exactReplace: () => ({
			ok: false,
			code: "identity_mismatch",
		}),
	});

	await expect(registry.compareAndSet(0, { version: 2, registryGeneration: 1, topics: {} })).rejects.toBeInstanceOf(
		TopicRegistryDurabilityUnavailableError,
	);
	expect(fs.existsSync(file)).toBe(true);
	expect(await registry.read()).toEqual({ version: 2, registryGeneration: 0, topics: {} });
});
test("Windows CAS preserves a destination successor substituted after generation validation", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-topic-cas-aba-"));
	temporaryDirectories.push(directory);
	const file = path.join(directory, "telegram-topics.json");
	fs.writeFileSync(file, JSON.stringify({ version: 2, registryGeneration: 0, topics: {} }));
	const successor = `${JSON.stringify({ version: 2, registryGeneration: 9, topics: {} })}\n`;
	const fsImpl: TelegramDaemonFs = {
		...fs.promises,
		mkdir: async (target, options) => {
			await fs.promises.mkdir(target, options);
		},
		fsyncFile: async () => {},
	};
	const registry = new FilesystemTopicRegistryCasAuthority(file, {
		installationHostId: "test-host",
		fs: fsImpl,
		platform: "win32",
		exactReplace: (_source, destination, _expectedSource, _expectedDestination) => {
			fs.unlinkSync(destination);
			fs.writeFileSync(destination, successor);
			expect(fs.readFileSync(destination, "utf8")).toBe(successor);
			return { ok: false, code: "identity_mismatch" };
		},
	});

	await expect(registry.compareAndSet(0, { version: 2, registryGeneration: 1, topics: {} })).rejects.toBeInstanceOf(
		TopicRegistryDurabilityUnavailableError,
	);
	expect(fs.readFileSync(file, "utf8")).toBe(successor);
});
test("foreign-host locks with locally dead PIDs fail closed instead of permitting a CAS write", async () => {
	const { authority: registry, file } = authority();
	const lockDir = `${file}.lock`;
	fs.mkdirSync(lockDir);
	fs.writeFileSync(
		path.join(lockDir, "info"),
		JSON.stringify({
			pid: 999_999_999,
			start_time: "foreign-start",
			owner_host_id: "foreign-host",
			timestamp: 0,
		}),
	);

	await expect(registry.compareAndSet(0, { version: 2, registryGeneration: 1, topics: {} })).rejects.toThrow(
		"Failed to acquire lock",
	);
	expect(fs.existsSync(lockDir)).toBe(true);
	expect(fs.existsSync(file)).toBe(false);
}, 10_000);
