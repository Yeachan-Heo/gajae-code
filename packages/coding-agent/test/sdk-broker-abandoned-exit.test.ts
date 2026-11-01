import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, setAbandonedGraceForTest } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { SdkClient } from "../src/sdk/client/client";

// A short TTL drives the maintenance cadence at `ttl/3`, so an abandonment grace
// expressed in cadences expires in tens of milliseconds.
const HEARTBEAT_TTL_MS = 300;
const CADENCE_MS = HEARTBEAT_TTL_MS / 3;
/** A pid no platform running this suite can have handed out. */
/**
 * A pid this machine is not using, verified rather than assumed: a fixed
 * six-digit pid is not guaranteed absent on Linux, where the fixture would then
 * be registered as live and the test would time out instead of reaping.
 */
function absentPid(): number {
	for (let pid = 999_000; pid < 999_100; pid += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("Could not find an absent pid for the fixture.");
}

const brokers: Broker[] = [];
const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];

/**
 * Starts a broker on a private agent directory. Only the detached autostart entry
 * point enables self-reaping, so the default here mirrors that entry point.
 */
async function startBroker(graceMs: number, reapWhenAbandoned = true): Promise<Broker> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-abandoned-"));
	roots.push(root);
	const broker = new Broker({
		agentDir: path.join(root, "agent"),
		heartbeatTtlMs: HEARTBEAT_TTL_MS,
		reapWhenAbandoned,
	});
	brokers.push(broker);
	setAbandonedGraceForTest(broker, graceMs);
	await broker.start();
	return broker;
}

/**
 * Starts a real process to register as a session host, so the test can take that
 * pid away and still leave a registration carrying a valid recorded incarnation.
 */
async function liveHostProcess(): Promise<{ pid: number; incarnation: string; end: () => Promise<void> }> {
	const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
	children.push(child);
	const incarnation = processIncarnation(child.pid);
	if (incarnation === undefined) throw new Error("Could not read the host process incarnation.");
	return {
		pid: child.pid,
		incarnation,
		end: async () => {
			child.kill();
			// Awaiting the exit is what removes the pid: a zombie still answers a liveness probe.
			await child.exited;
		},
	};
}

/**
 * Registers a host exactly as a session host does, so the index derives liveness
 * from the row itself: a live pid plus the incarnation that pid currently carries.
 */
async function registerHost(broker: Broker, sessionId: string, pid: number, hostIncarnation?: string): Promise<void> {
	const agentDir = broker.settings.agentDir;
	await new SessionIndex(agentDir).append({
		type: "host_registered",
		sessionId,
		locator: { cwd: agentDir, worktreeRoot: null, stateRoot: path.join(agentDir, "state", sessionId) },
		endpointGeneration: 1,
		pid,
		...(hostIncarnation === undefined ? {} : { hostIncarnation }),
	});
	await broker.index.refresh();
}

/** Resolves to true when the broker self-terminated inside the window. */
function completedWithin(broker: Broker, ms: number): Promise<boolean> {
	return Promise.race([
		broker.completion.then(
			() => true,
			() => true,
		),
		Bun.sleep(ms).then(() => false),
	]);
}

afterEach(async () => {
	for (const child of children) child.kill();
	children.length = 0;
	for (const broker of brokers) {
		setAbandonedGraceForTest(broker, undefined);
		await broker.stop().catch(() => {});
	}
	brokers.length = 0;
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test("a broker nobody is left to use exits on its own and drops its registration", async () => {
	const broker = await startBroker(CADENCE_MS * 4);
	if (!(await completedWithin(broker, 4_000))) throw new Error("Broker did not reap itself as abandoned.");
	expect(broker.terminalExit).toMatchObject({ mode: "owned-root", reason: "abandoned" });
	// The owned-root stop removes the publication it still owns, so the agent
	// directory is left without a registration pointing at an exited broker.
	expect(await readBrokerDiscovery(broker.settings.agentDir)).toBeNull();
}, 20_000);

test("a live session host keeps the broker running", async () => {
	const broker = await startBroker(CADENCE_MS * 2);
	await registerHost(broker, "held-open", process.pid);
	if (await completedWithin(broker, 1_500)) throw new Error("Broker abandoned a live session host.");
	expect(broker.terminalExit).toBeNull();
}, 20_000);

test("a registration whose host process died lets the broker exit", async () => {
	const broker = await startBroker(CADENCE_MS * 3);
	// A real process registers with the incarnation it actually carries, so the row is
	// provably live -- a recorded incarnation the index can match -- until the pid goes.
	const host = await liveHostProcess();
	await registerHost(broker, "killed-client", host.pid, host.incarnation);
	if (await completedWithin(broker, 1_000)) throw new Error("Broker abandoned a live session host.");
	await host.end();
	if (!(await completedWithin(broker, 4_000))) throw new Error("Broker did not reap itself as abandoned.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 30_000);

test("a registration with a dead pid and no recorded incarnation lets the broker exit", async () => {
	const broker = await startBroker(CADENCE_MS * 3);
	// The registration outlives its process exactly as a killed client leaves it.
	await registerHost(broker, "killed-client", absentPid());
	if (!(await completedWithin(broker, 4_000))) throw new Error("Broker did not reap itself as abandoned.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 20_000);

test("an undecided host reading pauses the clock instead of aging it", async () => {
	const graceMs = CADENCE_MS * 6;
	const broker = await startBroker(graceMs);
	// Confirmed absence arms the clock.
	await registerHost(broker, "gone", absentPid());
	await Bun.sleep(CADENCE_MS * 2);
	// A live pid carrying no recorded incarnation is undecided: the broker cannot tell
	// whether that process is the host that registered, so it must not keep the armed
	// clock running while it cannot see.
	const host = await liveHostProcess();
	await registerHost(broker, "undecided", host.pid);
	await Bun.sleep(graceMs);
	// The process that made the reading undecided is gone, so the reading is decidable
	// again. The clock has to start over here: an instance that let it age through the
	// undecided interval would reap on this very tick.
	await host.end();
	if (await completedWithin(broker, CADENCE_MS * 2))
		throw new Error("The undecided interval let an older clock reap the broker.");
	// It still reaps the broker once its own grace of confirmed absence has passed.
	if (!(await completedWithin(broker, graceMs + CADENCE_MS * 10)))
		throw new Error("Broker never armed a fresh clock after the reading became decided.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 30_000);

test("a supervised service is never reaped, however long it idles", async () => {
	// `gjc sdk broker run` is owned by the operator's process manager, which reads an
	// owned-root completion as a clean exit and would not restart the service.
	const broker = await startBroker(CADENCE_MS * 2, false);
	if (await completedWithin(broker, CADENCE_MS * 12)) throw new Error("A supervised broker reaped itself.");
	expect(broker.terminalExit).toBeNull();
}, 20_000);

test("a connected client keeps the broker running, and losing it lets the broker exit", async () => {
	const broker = await startBroker(CADENCE_MS * 3);
	const discovery = broker.discovery;
	if (!discovery) throw new Error("Broker published no discovery record.");
	const client = await SdkClient.connect(discovery.url, discovery.token);
	try {
		if (await completedWithin(broker, 1_500)) throw new Error("Broker abandoned a connected client.");
		expect(broker.terminalExit).toBeNull();
	} finally {
		await client.close().catch(() => undefined);
	}
	if (!(await completedWithin(broker, 4_000))) throw new Error("Broker did not reap itself as abandoned.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 30_000);

test("a restarted broker gets a full grace instead of the clock its last generation stopped with", async () => {
	const graceMs = CADENCE_MS * 8;
	const broker = await startBroker(graceMs);
	// One maintenance tick arms the clock on an empty broker, and the stop lands
	// well before that armed clock would have expired.
	await Bun.sleep(CADENCE_MS * 2);
	await broker.stop();
	// Wait past the grace the first generation stopped with: an instance that
	// carried its clock across the restart would complete on its first tick here.
	await Bun.sleep(graceMs);
	await broker.start();
	if (await completedWithin(broker, CADENCE_MS * 4))
		throw new Error("Restarted broker inherited the abandonment clock it stopped with.");
	// The new generation still owns a clock of its own: it reaps itself once its
	// own grace runs out, rather than never arming again.
	if (!(await completedWithin(broker, graceMs + CADENCE_MS * 10)))
		throw new Error("Restarted broker never armed its own abandonment clock.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 30_000);

test("a host whose pid was reused lets the broker exit", async () => {
	const broker = await startBroker(CADENCE_MS * 3);
	await registerHost(broker, "held-then-reused", process.pid);
	if (await completedWithin(broker, 1_500)) throw new Error("Broker abandoned a live session host.");
	// The same session re-registers from a pid that now belongs to a different
	// process: the row survives, its incarnation no longer matches, and liveness
	// ends without anyone telling the broker to stop.
	await registerHost(broker, "held-then-reused", 1, "darwin:1:1");
	if (!(await completedWithin(broker, 4_000))) throw new Error("Broker did not reap itself as abandoned.");
	expect(broker.terminalExit).toMatchObject({ reason: "abandoned" });
}, 20_000);
