import { Database } from "bun:sqlite";

const dbPath = Bun.argv[2];
if (!dbPath) throw new Error("database path is required");

const db = new Database(dbPath);
db.run("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
await Bun.sleep(50);
db.run("COMMIT");
db.close();
