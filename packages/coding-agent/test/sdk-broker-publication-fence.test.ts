import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker, setAmbiguityGraceForTest, setPublicationObservationForTest } from "../src/sdk/broker/broker";

// A short TTL drives the publication watchdog at `ttl/3`, so the fence advances
// in tens of milliseconds instead of the production five-second cadence.
const HEARTBEAT_TTL_MS = 300;
const WATCHDOG_CADENCE_MS = HEARTBEAT_TTL_MS / 3;

const brokers: Broker[] = [];
const roots: string[] = [];

async function startBroker(): Promise<Broker> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fence-"));
	roots.push(root);
	const broker = new Broker({ agentDir: path.join(root, "agent"), heartbeatTtlMs: HEARTBEAT_TTL_MS });
	brokers.push(broker);
	await broker.start();
	return broker;
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
	for (const broker of brokers) {
		setPublicationObservationForTest(broker, undefined);
		setAmbiguityGraceForTest(broker, undefined);
		await broker.stop().catch(() => {});
	}
	brokers.length = 0;
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test("a permanently ambiguous broker self-terminates instead of lingering forever", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, WATCHDOG_CADENCE_MS);
	// `observe()` returns "ambiguous" forever once the retained publication handle
	// is closed. Before the ambiguity deadline existed this state cleared the loss
	// timer on every tick, so the broker stopped heartbeating but never exited --
	// peers then discovered it as stale and spawned unbounded replacements.
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 20)).toBe(true);
});

test("transient ambiguity within the deadline does not terminate the broker", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, 60_000);
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 6)).toBe(false);
});

test("recovering to owned clears accrued ambiguity", async () => {
	const broker = await startBroker();
	setAmbiguityGraceForTest(broker, WATCHDOG_CADENCE_MS * 8);
	setPublicationObservationForTest(broker, "ambiguous");
	await Bun.sleep(WATCHDOG_CADENCE_MS * 5);

	// Recovery must reset the clock, so the broker survives well past the point
	// where the original uninterrupted ambiguity would have expired.
	setPublicationObservationForTest(broker, "owned");
	await Bun.sleep(WATCHDOG_CADENCE_MS * 2);
	setPublicationObservationForTest(broker, "ambiguous");

	expect(await completedWithin(broker, WATCHDOG_CADENCE_MS * 5)).toBe(false);
});

test("a replaced publication still terminates on the shorter loss grace", async () => {
	const broker = await startBroker();
	// Replacement is proven, not ambiguous, so it must not wait for the ambiguity
	// deadline; the pre-existing 15s loss grace governs it.
	setAmbiguityGraceForTest(broker, 60_000);
	setPublicationObservationForTest(broker, "replaced");

	expect(await completedWithin(broker, 25_000)).toBe(true);
}, 30_000);
