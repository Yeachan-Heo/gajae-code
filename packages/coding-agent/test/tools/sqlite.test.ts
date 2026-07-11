import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "../../src/tools/renderers";
import { Settings } from "../../src/config/settings";
import { ReadTool } from "../../src/tools/read";
import { parseSqlitePathCandidates, parseSqliteSelector, renderTable } from "../../src/tools/sqlite-reader";
import { WriteTool } from "../../src/tools/write";

type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
};

type SessionLike = ConstructorParameters<typeof ReadTool>[0];

function getText(result: ToolTextResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<SessionLike> = {}): SessionLike {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as SessionLike;
}

function createFixtureDatabase(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.run(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				email TEXT NOT NULL,
				status TEXT NOT NULL,
				created INTEGER NOT NULL
			);
			CREATE TABLE slugs (
				slug TEXT PRIMARY KEY,
				title TEXT NOT NULL
			);
			CREATE TABLE notes (
				body TEXT NOT NULL
			);
			CREATE TABLE composite (
				team_id INTEGER NOT NULL,
				user_id INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (team_id, user_id)
			);
			CREATE TABLE wide_rows (
				id INTEGER PRIMARY KEY,
				payload TEXT NOT NULL
			);
		`);

		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Alice",
			"alice@example.com",
			"active",
			1,
		);
		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Bob",
			"bob@example.com",
			"inactive",
			2,
		);
		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Carol",
			"carol@example.com",
			"active",
			3,
		);
		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Dave",
			"dave@example.com",
			"inactive",
			4,
		);
		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Eve",
			"eve@example.com",
			"active",
			5,
		);
		db.prepare("INSERT INTO users (name, email, status, created) VALUES (?, ?, ?, ?)").run(
			"Frank",
			"frank@example.com",
			"active",
			6,
		);

		db.prepare("INSERT INTO slugs (slug, title) VALUES (?, ?)").run("welcome", "Welcome");
		db.prepare("INSERT INTO slugs (slug, title) VALUES (?, ?)").run("about", "About");

		db.prepare("INSERT INTO notes (body) VALUES (?)").run("First note");
		db.prepare("INSERT INTO notes (body) VALUES (?)").run("Second note");
		db.prepare("INSERT INTO notes (body) VALUES (?)").run("Third; note");

		db.prepare("INSERT INTO composite (team_id, user_id, value) VALUES (?, ?, ?)").run(1, 2, "pair");
		db.prepare("INSERT INTO wide_rows (id, payload) VALUES (?, ?)").run(1, "x".repeat(320));
	} finally {
		db.close();
	}
}

function readUserEmail(dbPath: string, id: number): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(id);
		return row?.email ?? null;
	} finally {
		db.close();
	}
}

function readUserCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM users").get()?.count ?? 0;
	} finally {
		db.close();
	}
}

function readUserByEmail(dbPath: string, email: string): { name: string; email: string } | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare<{ name: string; email: string }, [string]>("SELECT name, email FROM users WHERE email = ?")
			.get(email);
	} finally {
		db.close();
	}
}

describe("SQLite tool support", () => {
	let tmpDir: string;
	let sqlitePath: string;
	let sqliteDbPath: string;
	let invalidDbPath: string;
	let readTool: ReadTool;
	let writeTool: WriteTool;
	let originalEditVariant: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-tool-test-"));
		sqlitePath = path.join(tmpDir, "app.sqlite");
		sqliteDbPath = path.join(tmpDir, "app.db");
		invalidDbPath = path.join(tmpDir, "thumbs.db");
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		createFixtureDatabase(sqlitePath);
		await fs.copyFile(sqlitePath, sqliteDbPath);
		await Bun.write(invalidDbPath, "not sqlite\nstill text\n");

		const session = createSession(tmpDir);
		readTool = new ReadTool(session);
		writeTool = new WriteTool(session);
	});

	afterEach(async () => {
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("parses SQLite path candidates at the extension boundary", () => {
		expect(parseSqlitePathCandidates("data/app.db:users?limit=5")).toEqual([
			{
				sqlitePath: "data/app.db",
				subPath: "users",
				queryString: "limit=5",
			},
		]);
		expect(parseSqlitePathCandidates("data/app.sqlite")).toEqual([
			{
				sqlitePath: "data/app.sqlite",
				subPath: "",
				queryString: "",
			},
		]);
	});

	it("parses SQLite selectors for row, query, and raw modes", () => {
		expect(parseSqliteSelector("users:42", "")).toEqual({ kind: "row", table: "users", key: "42" });
		expect(parseSqliteSelector("users", "limit=2&offset=3&order=created:desc")).toEqual({
			kind: "query",
			table: "users",
			limit: 2,
			offset: 3,
			order: "created:desc",
			where: undefined,
		});
		expect(parseSqliteSelector("", "q=SELECT+1")).toEqual({ kind: "raw", sql: "SELECT 1" });
	});
	it("requires complete decimal integers for SQLite pagination", () => {
		for (const value of ["2.5", "2rows", "2e1", "0x10"]) {
			expect(() => parseSqliteSelector("users", `limit=${value}`)).toThrow(
				`SQLite limit must be a positive integer; got '${value}'`,
			);
			expect(() => parseSqliteSelector("users", `offset=${value}`)).toThrow(
				`SQLite offset must be a non-negative integer; got '${value}'`,
			);
		}

		expect(parseSqliteSelector("users", "limit=1&offset=0")).toEqual({
			kind: "query",
			table: "users",
			limit: 1,
			offset: 0,
			order: undefined,
			where: undefined,
		});
		expect(parseSqliteSelector("users", "limit=500&offset=0")).toEqual({
			kind: "query",
			table: "users",
			limit: 500,
			offset: 0,
			order: undefined,
			where: undefined,
		});
	});

	it("lists tables for a .sqlite database and excludes sqlite internal tables", async () => {
		const result = await readTool.execute("sqlite-list", { path: sqlitePath });
		const text = getText(result);

		expect(text).toContain("users (6 rows)");
		expect(text).toContain("slugs (2 rows)");
		expect(text).toContain("notes (3 rows)");
		expect(text).not.toContain("sqlite_sequence");
	});

	it("lists tables for a .db database when the magic bytes match SQLite", async () => {
		const result = await readTool.execute("sqlite-db-list", { path: sqliteDbPath });
		expect(getText(result)).toContain("users (6 rows)");
	});

	it("falls through to plain file reading for non-SQLite .db files", async () => {
		const result = await readTool.execute("sqlite-invalid-db", { path: invalidDbPath });
		expect(getText(result)).toContain("not sqlite");
	});

	it("shows table schema and sample rows", async () => {
		const result = await readTool.execute("sqlite-schema", { path: `${sqlitePath}:users` });
		const text = getText(result);

		expect(text).toContain("CREATE TABLE users");
		expect(text).toContain("Sample rows:");
		expect(text).toContain("Alice");
	});

	it("returns a row by integer primary key", async () => {
		const result = await readTool.execute("sqlite-row-int", { path: `${sqlitePath}:users:2` });
		const text = getText(result);

		expect(text).toContain("id: 2");
		expect(text).toContain("name: Bob");
		expect(text).toContain("email: bob@example.com");
	});

	it("returns a row by text primary key", async () => {
		const result = await readTool.execute("sqlite-row-text", { path: `${sqlitePath}:slugs:welcome` });
		const text = getText(result);

		expect(text).toContain("slug: welcome");
		expect(text).toContain("title: Welcome");
	});

	it("falls back to ROWID lookups for tables without a declared primary key", async () => {
		const result = await readTool.execute("sqlite-row-rowid", { path: `${sqlitePath}:notes:1` });
		expect(getText(result)).toContain("body: First note");
	});

	it("errors on composite primary key row lookups", async () => {
		await expect(readTool.execute("sqlite-row-composite", { path: `${sqlitePath}:composite:1` })).rejects.toThrow(
			/composite primary key/i,
		);
	});

	it("supports pagination and includes a continuation hint", async () => {
		const result = await readTool.execute("sqlite-page", { path: `${sqlitePath}:users?limit=2&offset=1` });
		const text = getText(result);

		expect(text).toContain("Bob");
		expect(text).toContain("Carol");
		expect(text).not.toContain("Alice");
		expect(text).toContain("append :users?limit=2&offset=3 to the database path to continue");
	});

	it("supports where and order via the path selector", async () => {
		const result = await readTool.execute("sqlite-sel-query", {
			path: `${sqlitePath}:users?where=status='active'&order=created:desc&limit=2`,
		});
		const text = getText(result);

		expect(text).toContain("Frank");
		expect(text).toContain("Eve");
		expect(text).not.toContain("Bob");
	});

	it("rejects where= clauses that try to bypass pagination", () => {
		expect(() => parseSqliteSelector("users", "where=1=1 LIMIT 1000000 --&limit=2&offset=0")).toThrow(
			/comments or statement terminators/i,
		);
		expect(() => parseSqliteSelector("users", "where=status='active' LIMIT 1")).toThrow(/LIMIT\/OFFSET\/UNION/i);
		expect(() => parseSqliteSelector("users", "where=1=1; DROP TABLE users")).toThrow(
			/comments or statement terminators/i,
		);
	});

	it("allows semicolons inside quoted SQLite where string literals", async () => {
		const result = await readTool.execute("sqlite-sel-semicolon-literal", {
			path: `${sqlitePath}:notes?where=body LIKE '%;%'&limit=5`,
		});
		const text = getText(result);

		expect(text).toContain("Third; note");
	});

	it("rejects SQLite where clauses that try to override pagination control syntax", async () => {
		await expect(
			readTool.execute("sqlite-where-pagination-bypass", {
				path: `${sqlitePath}:users?where=1=1 LIMIT 1000000 --&limit=2&offset=0`,
			}),
		).rejects.toThrow(/comments or statement terminators/i);
	});

	it("rejects mutating raw queries on the readonly connection", async () => {
		await expect(
			readTool.execute("sqlite-raw-write", {
				path: `${sqlitePath}?q=INSERT+INTO+users+(name,email,status,created)+VALUES+('X','x@example.com','active',7)`,
			}),
		).rejects.toThrow(/readonly/i);
	});

	it("rejects table names that do not exist instead of interpolating them", async () => {
		await expect(
			readTool.execute("sqlite-injection-table", { path: `${sqlitePath}:users;DROP TABLE users;` }),
		).rejects.toThrow(/not found/i);
	});

	it("truncates wide rows to the configured table width", () => {
		const rendered = renderTable(["id", "payload"], [{ id: 1, payload: "x".repeat(320) }], {
			totalCount: 1,
			offset: 0,
			limit: 20,
			table: "wide_rows",
			dbPath: sqlitePath,
		});

		for (const line of rendered.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("inserts rows through the write tool with JSON5 content", async () => {
		await writeTool.execute("sqlite-write-insert", {
			path: `${sqlitePath}:users`,
			content: "{ name: 'Grace', email: 'grace@example.com', status: 'active', created: 7 }",
		});

		expect(readUserByEmail(sqlitePath, "grace@example.com")).toEqual({
			name: "Grace",
			email: "grace@example.com",
		});
	});

	it("updates rows through the write tool by primary key", async () => {
		await writeTool.execute("sqlite-write-update", {
			path: `${sqlitePath}:users:2`,
			content: "{ email: 'bob+new@example.com' }",
		});

		expect(readUserEmail(sqlitePath, 2)).toBe("bob+new@example.com");
	});

	it("deletes rows through the write tool with empty content", async () => {
		await writeTool.execute("sqlite-write-delete", {
			path: `${sqlitePath}:users:2`,
			content: "   ",
		});

		expect(readUserCount(sqlitePath)).toBe(5);
		expect(readUserEmail(sqlitePath, 2)).toBeNull();
	});

	it("enforces plan mode for SQLite writes", async () => {
		const planSession = createSession(tmpDir, {
			getPlanModeState: () => ({
				enabled: true,
				planFilePath: path.join(tmpDir, "plan.md"),
			}),
		});
		const planWriteTool = new WriteTool(planSession);

		await expect(
			planWriteTool.execute("sqlite-plan-mode", {
				path: `${sqlitePath}:users:1`,
				content: "{ email: 'blocked@example.com' }",
			}),
		).rejects.toThrow(/Plan mode/i);
	});

	it("rejects writes to non-existent tables", async () => {
		await expect(
			writeTool.execute("sqlite-write-missing-table", {
				path: `${sqlitePath}:missing`,
				content: "{ value: 1 }",
			}),
		).rejects.toThrow(/not found/i);
	});

	it("rejects writes to non-existent databases", async () => {
		await expect(
			writeTool.execute("sqlite-write-missing-db", {
				path: path.join(tmpDir, "missing.sqlite:users"),
				content: "{ name: 'Nope' }",
			}),
		).rejects.toThrow(/not found/i);
	});

	it("rejects unknown columns in write content", async () => {
		await expect(
			writeTool.execute("sqlite-write-bad-column", {
				path: `${sqlitePath}:users`,
				content: "{ bogus: 1 }",
			}),
		).rejects.toThrow(/no column named 'bogus'/i);
	});
});
