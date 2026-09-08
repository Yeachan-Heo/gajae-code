import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Reserve an event namespace before publishing any endpoint or replay frame.
 * SQLite serializes competing processes; FULL synchronous commits ensure a
 * crashed host cannot reuse a generation whose events have already escaped.
 */
export async function reserveEventGeneration(stateRoot: string, sessionId: string, minimum: number): Promise<number> {
	if (!sessionId || !Number.isSafeInteger(minimum) || minimum < 1)
		throw new Error("Invalid SDK event generation reservation.");
	await fs.mkdir(stateRoot, { recursive: true });
	const file = path.join(stateRoot, "sdk-event-generations.sqlite");
	const handle = await fs.open(file, "a", 0o600);
	await handle.close();
	const db = new Database(file);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
		db.exec(
			"CREATE TABLE IF NOT EXISTS event_generations (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
		);
		return db
			.transaction(() => {
				const row = db
					.query<{ generation: number }, [string]>("SELECT generation FROM event_generations WHERE session_id = ?")
					.get(sessionId);
				if (row && (!Number.isSafeInteger(row.generation) || row.generation < 1))
					throw new Error("Corrupt SDK event generation.");
				// The clock supplies a fresh namespace on first use, not an expiry.
				// Persisted ordering continues to win if the clock subsequently goes back.
				const generation = Math.max(Date.now(), minimum, (row?.generation ?? 0) + 1);
				if (!Number.isSafeInteger(generation)) throw new Error("SDK event generation exhausted.");
				db.query(
					"INSERT INTO event_generations (session_id, generation) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET generation = excluded.generation",
				).run(sessionId, generation);
				return generation;
			})
			.immediate();
	} finally {
		db.close();
	}
}
