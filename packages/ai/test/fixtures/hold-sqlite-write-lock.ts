import { Database } from "bun:sqlite";

const dbPath = Bun.argv[2];
if (!dbPath) throw new Error("database path is required");
const holdMs = Number(Bun.argv[3] ?? 50);

const db = new Database(dbPath);
db.run("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
await Bun.sleep(holdMs);
db.run("COMMIT");
db.close();
