import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createWalkerPoolFixture,
	removeWalkerPoolFixture,
	type WalkerPoolFixture,
} from "./walker-pool-unavailable-fixture";

const LIVE_TIMEOUT_MS = 60_000;
setDefaultTimeout(LIVE_TIMEOUT_MS);

let fixture: WalkerPoolFixture;

type PoolProbeResult = {
	initialStatus: string;
	statusAfterWarmup: string;
	finalStatus: string;
	beforeThreads: number;
	afterThreads: number;
	walkerThreadNames: string[];
	totalMatches: number;
	actual: string[];
	expected: string[];
};

async function waitForReadyFile(filePath: string, child: ReturnType<typeof Bun.spawn>): Promise<{ rss: number }> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await fs.readFile(filePath, "utf8")) as { rss: number };
		} catch {
			if (child.exitCode !== null) throw new Error(`walker probe exited before readiness: ${child.exitCode}`);
			await Bun.sleep(10);
		}
	}
	throw new Error("walker probe did not reach its pre-traversal readiness point");
}

async function runProbe(): Promise<PoolProbeResult> {
	await fs.rm(fixture.readyFile, { force: true });
	await fs.rm(fixture.startFile, { force: true });
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "walker-pool-unavailable-child.ts")], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
		env: {
			...process.env,
			PI_WALK_WORKERS: "4",
			PI_WALKER_TEST_FORCE_POOL_UNAVAILABLE: "1",
			WALKER_TEST_ROOT: fixture.root,
			WALKER_TEST_WARM_ROOT: fixture.warmRoot,
			WALKER_TEST_READY_FILE: fixture.readyFile,
			WALKER_TEST_RESULT_FILE: fixture.resultFile,
			WALKER_TEST_START_FILE: fixture.startFile,
		},
	});
	try {
		await waitForReadyFile(fixture.readyFile, child);
		await fs.writeFile(fixture.startFile, "start\n");
		const exitCode = await child.exited;
		if (exitCode !== 0) throw new Error(`walker probe exited ${exitCode}`);
		return JSON.parse(await fs.readFile(fixture.resultFile, "utf8")) as PoolProbeResult;
	} catch (error) {
		child.kill();
		const exitCode = await child.exited;
		throw new Error(`${String(error)}\nwalker probe exit ${exitCode}`);
	}
}

beforeAll(async () => {
	fixture = await createWalkerPoolFixture();
});

afterAll(async () => {
	if (fixture) await removeWalkerPoolFixture(fixture);
});

describe("walker Rayon pool failure falls back to serial traversal", () => {
	it("proves the pool-build failure precondition and returns every file without adding threads", async () => {
		const result = await runProbe();
		expect(result.initialStatus).toBe("uninitialized");
		expect(result.statusAfterWarmup).toBe("uninitialized");
		expect(result.finalStatus).toBe("unavailable");
		expect(result.totalMatches).toBeGreaterThanOrEqual(512);
		expect(result.actual).toEqual(result.expected);
		expect(result.afterThreads).toBeLessThanOrEqual(result.beforeThreads);
	});
});
