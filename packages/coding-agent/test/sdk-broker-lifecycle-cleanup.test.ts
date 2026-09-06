import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureBroker } from "../src/sdk/broker/ensure";
import {
	BrokerStartupError,
	brokerStartupFailurePath,
	clearBrokerStartupFailureMarker,
	readBrokerStartupFailureMarker,
	writeBrokerStartupFailureMarker,
} from "../src/sdk/broker/startup-failure";

async function makeAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-lifecycle-"));
}

test("write creates the marker at the expected path and read round-trips it", async () => {
	const agentDir = await makeAgentDir();
	try {
		await writeBrokerStartupFailureMarker(agentDir, {
			reason: "no discovery within deadline",
			exitCode: 3,
			signal: "SIGTERM",
			pid: process.pid,
		});

		const stat = await fs.stat(brokerStartupFailurePath(agentDir));
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBeGreaterThan(0);

		const marker = await readBrokerStartupFailureMarker(agentDir);
		expect(marker).toBeDefined();
		expect(marker?.version).toBe(2);
		expect(marker?.reason).toBe("no discovery within deadline");
		expect(marker?.exitCode).toBe(3);
		expect(marker?.signal).toBe("SIGTERM");
		expect(marker?.pid).toBe(process.pid);
		expect(typeof marker?.incarnation).toBe("string");
		expect(typeof marker?.writtenAt).toBe("number");
		expect(Number.isFinite(marker?.writtenAt)).toBe(true);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("write truncates a reason longer than 512 characters to exactly 512", async () => {
	const agentDir = await makeAgentDir();
	try {
		await writeBrokerStartupFailureMarker(agentDir, {
			reason: "x".repeat(600),
			exitCode: 1,
			signal: null,
			pid: process.pid,
		});

		const marker = await readBrokerStartupFailureMarker(agentDir);
		expect(marker?.reason?.length).toBe(512);
		expect(marker?.reason).toBe("x".repeat(512));
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("read returns undefined when no marker exists", async () => {
	const agentDir = await makeAgentDir();
	try {
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("read returns undefined for a marker file that is not valid JSON", async () => {
	const agentDir = await makeAgentDir();
	try {
		await Bun.write(brokerStartupFailurePath(agentDir), "{not valid json");
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("read returns undefined for a marker with an unsupported version", async () => {
	const agentDir = await makeAgentDir();
	try {
		await Bun.write(
			brokerStartupFailurePath(agentDir),
			JSON.stringify({ version: 2, reason: "old shape", exitCode: 1, signal: null, writtenAt: 123, pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("read returns undefined when a marker field has an invalid type", async () => {
	const agentDir = await makeAgentDir();
	try {
		const markerPath = brokerStartupFailurePath(agentDir);
		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "r", exitCode: "1", signal: null, writtenAt: 123, pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(markerPath, JSON.stringify({ version: 1, exitCode: 1, signal: null, writtenAt: 123, pid: 1 }));
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("clear removes the marker and tolerates an already-absent marker", async () => {
	const agentDir = await makeAgentDir();
	try {
		await writeBrokerStartupFailureMarker(agentDir, { reason: "stale", exitCode: 0, signal: null, pid: process.pid });
		await clearBrokerStartupFailureMarker(agentDir);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await expect(clearBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("BrokerStartupError carries the typed fields and exact message", () => {
	const error = new BrokerStartupError({
		exitCode: 9,
		signal: "SIGKILL",
		reason: "marker reason",
		stderrExcerpt: "bounded stderr",
	});
	expect(error).toBeInstanceOf(Error);
	expect(error.name).toBe("BrokerStartupError");
	expect(error.code).toBe("broker_startup_failed");
	expect(error.exitCode).toBe(9);
	expect(error.signal).toBe("SIGKILL");
	expect(error.reason).toBe("marker reason");
	expect(error.stderrExcerpt).toBe("bounded stderr");
	expect(error.message).toBe(
		"Detached SDK broker exited before discovery (code=9, signal=SIGKILL): marker reason Broker stderr: bounded stderr",
	);

	const withoutExcerpt = new BrokerStartupError({ exitCode: null, signal: null, reason: "bare" });
	expect(withoutExcerpt.stderrExcerpt).toBeUndefined();
	expect(withoutExcerpt.message).toBe("Detached SDK broker exited before discovery (code=null, signal=null): bare");
});

test("write is best-effort when the sdk directory cannot be created", async () => {
	const agentDir = await makeAgentDir();
	try {
		// Turn the agent dir into a regular file so `sdk/` cannot be created beneath it.
		await fs.rm(agentDir, { recursive: true, force: true });
		await Bun.write(agentDir, "not a directory");

		await expect(
			writeBrokerStartupFailureMarker(agentDir, { reason: "boom", exitCode: 1, signal: null, pid: process.pid }),
		).resolves.toBeUndefined();
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("null exitCode and signal round-trip as null, not undefined", async () => {
	const agentDir = await makeAgentDir();
	try {
		await writeBrokerStartupFailureMarker(agentDir, {
			reason: "no exit",
			exitCode: null,
			signal: null,
			pid: process.pid,
		});

		const marker = await readBrokerStartupFailureMarker(agentDir);
		expect(marker?.exitCode).toBeNull();
		expect(marker?.signal).toBeNull();
		expect(marker?.pid).toBe(process.pid);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("read returns undefined for an empty reason, a non-string signal, or a missing writtenAt", async () => {
	const agentDir = await makeAgentDir();
	try {
		const markerPath = brokerStartupFailurePath(agentDir);

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "", exitCode: 1, signal: null, writtenAt: 1, pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "r", exitCode: 1, signal: 7, writtenAt: 1, pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(markerPath, JSON.stringify({ version: 1, reason: "r", exitCode: 1, signal: null, pid: 1 }));
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "r", exitCode: 1, signal: null, writtenAt: "now", pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "r", exitCode: 1, signal: null, writtenAt: 1, pid: "1" }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 1, reason: "r", exitCode: 1, signal: null, writtenAt: 1, pid: 0 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();

		await Bun.write(
			markerPath,
			JSON.stringify({ version: 2, reason: "r", exitCode: 1, signal: null, writtenAt: 1, pid: 1 }),
		);
		await expect(readBrokerStartupFailureMarker(agentDir)).resolves.toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("ensureBroker surfaces the marker reason as a typed BrokerStartupError", async () => {
	const agentDir = await makeAgentDir();
	try {
		// An unsupported session-index snapshot makes the spawned broker's start()
		// reject, so it writes a startup-failure marker and exits before discovery.
		// The caller must see the marker reason through the typed error.
		await fs.mkdir(path.join(agentDir, "sdk", "sessions"), { recursive: true });
		await Bun.write(path.join(agentDir, "sdk", "sessions", "index.snapshot.json"), JSON.stringify({ version: 99 }));

		const failure = await ensureBroker({ agentDir }).then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		expect(failure).toBeInstanceOf(BrokerStartupError);
		const typed = failure as BrokerStartupError;
		expect(typed.code).toBe("broker_startup_failed");
		expect(typed.exitCode).toBe(1);
		expect(typed.signal).toBeNull();
		expect(typed.reason).toContain("index.snapshot.json");
		expect(typed.message).toContain("index.snapshot.json");
		expect(typed.stderrExcerpt).toBeDefined();

		// The per-spawn diagnostic sink must not be retained after the failure.
		const sdkEntries = await fs.readdir(path.join(agentDir, "sdk"));
		expect(sdkEntries.filter(name => name.startsWith("broker-spawn"))).toEqual([]);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);
