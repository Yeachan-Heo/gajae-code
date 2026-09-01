import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processStartTime } from "../../src/config/file-lock";
import {
	SessionStateLockTestHooks,
	SessionStateLockUnavailableError,
	setSessionStateLockNativeBindings,
	withSessionStateFileLock,
} from "../../src/gjc-runtime/session-state-lock";
import { exactIdentityNativeBindings } from "../helpers/exact-identity-natives";

const scenario = process.argv[2];
if (!scenario) throw new Error("scenario is required");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-lock-debris-probe-"));
const stateFile = path.join(root, "runtime-state.json");
const lockFile = `${stateFile}.lock`;
const DEAD_PID = 2 ** 22 - 1;
let attempts = 0;

if (process.env.GJC_SESSION_LOCK_PROBE_NATIVE !== "1")
	setSessionStateLockNativeBindings(() => exactIdentityNativeBindings);
SessionStateLockTestHooks.ownerHostId = () => "probe-local-host";
SessionStateLockTestHooks.legacyOwnerHostId = () => "probe-legacy-host";
SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;
SessionStateLockTestHooks.afterAcquireContention = (_file, attempt) => {
	attempts = Math.max(attempts, attempt);
};

async function age(target: string): Promise<void> {
	const stale = new Date(Date.now() - 60_000);
	await fs.utimes(target, stale, stale);
}

async function writeLiveOwner(token: string): Promise<string> {
	const record = JSON.stringify({
		pid: process.pid,
		start_time: processStartTime(process.pid) ?? "unknown",
		token,
		owner_host_id: "probe-local-host",
	});
	await fs.writeFile(lockFile, record);
	return record;
}

switch (scenario) {
	case "malformed-dead":
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "malformed-dead",
				owner_host_id: "probe-local-host",
				released: false,
			}),
		);
		await age(lockFile);
		break;
	case "unknown-provenance":
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "unknown-provenance",
				owner_host_id: "foreign-host",
				released: false,
			}),
		);
		await age(lockFile);
		break;
	case "old-empty-directory":
		await fs.mkdir(lockFile);
		await age(lockFile);
		break;
	case "plausible-live":
		await writeLiveOwner("plausible-live");
		break;
	case "plausible-live-transition": {
		const transitionDir = `${lockFile}.transition`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "plausible-live-transition",
				owner_host_id: "probe-local-host",
			}),
		);
		break;
	}
	case "stale-dead-transition": {
		const transitionDir = `${lockFile}.transition`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "stale-dead-transition",
				owner_host_id: "probe-local-host",
			}),
		);
		break;
	}
	case "released-transition-tombstone": {
		const transitionDir = `${lockFile}.transition`;
		await fs.mkdir(transitionDir, { mode: 0o700 });
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: 1,
				start_time: "unknown",
				token: "released-transition-tombstone",
				owner_host_id: "probe-local-host",
				released: true,
			}),
			{ mode: 0o600 },
		);
		await age(transitionDir);
		break;
	}

	case "race-replacement": {
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "race-dead",
				owner_host_id: "probe-local-host",
				released: false,
			}),
		);
		await age(lockFile);
		SessionStateLockTestHooks.afterStaleInspection = async () => {
			SessionStateLockTestHooks.afterStaleInspection = undefined;
			await fs.rm(lockFile);
			await writeLiveOwner("race-successor");
		};
		break;
	}
	case "old-empty-directory-replacement": {
		await fs.mkdir(lockFile);
		await age(lockFile);
		SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict = async () => {
			SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict = undefined;
			await fs.rm(lockFile, { recursive: true, force: true });
			await writeLiveOwner("directory-successor");
		};
		break;
	}
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}

const cpuStart = process.cpuUsage();
const wallStart = performance.now();
let entered = false;
let failure: SessionStateLockUnavailableError | undefined;
try {
	await withSessionStateFileLock(stateFile, async () => {
		entered = true;
	});
} catch (error) {
	if (!(error instanceof SessionStateLockUnavailableError)) throw error;
	failure = error;
}
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const remaining = await fs.lstat(lockFile).then(
	async stat => (stat.isFile() ? await fs.readFile(lockFile, "utf8") : "<directory>"),
	() => null,
);

process.stdout.write(
	`${JSON.stringify({
		scenario,
		entered,
		attempts,
		wallMs,
		cpuMs: (cpu.user + cpu.system) / 1_000,
		error: failure
			? {
					name: failure.name,
					message: failure.message,
					lockPath: failure.lockPath,
					reason: failure.reason,
					attempts: failure.attempts,
					elapsedMs: failure.elapsedMs,
					cause: failure.cause instanceof Error ? failure.cause.message : String(failure.cause ?? ""),
				}
			: null,
		remaining,
		lockFile,
	})}\n`,
);

await fs.rm(root, { recursive: true, force: true });
