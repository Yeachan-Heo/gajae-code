import type { Database, SQLQueryBindings } from "bun:sqlite";
import { formatBytes, replaceTabs, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";

const SQLITE_MAGIC = new Uint8Array([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);
const SQLITE_PATH_PATTERN = /\.(?:sqlite3?|db3?)(?=(?::|\?|$))/gi;
const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_SCHEMA_SAMPLE_LIMIT = 5;
const MAX_QUERY_LIMIT = 500;
const MAX_RENDER_WIDTH = 120;
const MAX_COLUMN_WIDTH = 40;
const MIN_COLUMN_WIDTH = 1;
const SQLITE_USER_TABLE_PREDICATE = "name NOT LIKE 'sqlite!_%' ESCAPE '!'";

type SqliteBinding = Exclude<SQLQueryBindings, Record<string, unknown>>;

type SqliteRow = Record<string, unknown>;

interface SqliteMasterRow {
	name: string;
	sql: string | null;
}

interface SqliteCountRow {
	count: number;
}

interface SqliteTableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: unknown;
	pk: number;
}

export interface SqlitePathCandidate {
	sqlitePath: string;
	subPath: string;
	queryString: string;
}

export type SqliteSelector =
	| { kind: "list" }
	| { kind: "schema"; table: string; sampleLimit: number }
	| { kind: "row"; table: string; key: string }
	| { kind: "query"; table: string; limit: number; offset: number; order?: string; where?: string }
	| { kind: "raw"; sql: string };

export type SqliteRowLookup = { kind: "pk"; column: string; type: string } | { kind: "rowid" };

function splitSqliteRemainder(remainder: string): { subPath: string; queryString: string } {
	const queryIndex = remainder.indexOf("?");
	if (queryIndex === -1) {
		return {
			subPath: remainder.replace(/^:+/, ""),
			queryString: "",
		};
	}

	return {
		subPath: remainder.slice(0, queryIndex).replace(/^:+/, ""),
		queryString: remainder.slice(queryIndex + 1),
	};
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function sanitizeCell(value: string): string {
	return replaceTabs(value).replaceAll(/\r?\n/g, "\\n");
}

function stringifySqliteValue(value: unknown): string {
	if (value === null) return "NULL";
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	if (value instanceof Uint8Array) {
		return `<BLOB ${formatBytes(value.byteLength)}>`;
	}

	try {
		const json = JSON.stringify(value);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

function padCell(value: string, width: number): string {
	const truncated = truncateToWidth(sanitizeCell(value), Math.max(width, MIN_COLUMN_WIDTH));
	const visibleWidth = Bun.stringWidth(truncated);
	if (visibleWidth >= width) {
		return truncated;
	}
	return `${truncated}${" ".repeat(width - visibleWidth)}`;
}

function buildAsciiTable(columns: string[], rows: SqliteRow[]): string {
	if (columns.length === 0) {
		return rows.length === 0 ? "(no rows)" : "(rows returned without named columns)";
	}

	const widths = columns.map(column =>
		Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Bun.stringWidth(sanitizeCell(column)))),
	);
	for (const row of rows) {
		for (const [index, column] of columns.entries()) {
			const cellWidth = Bun.stringWidth(sanitizeCell(stringifySqliteValue(row[column])));
			widths[index] = Math.max(widths[index] ?? MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, cellWidth));
		}
	}

	let totalWidth = widths.reduce((sum, width) => sum + width, 0) + columns.length * 3 + 1;
	while (totalWidth > MAX_RENDER_WIDTH) {
		let widestIndex = -1;
		let widestWidth = MIN_COLUMN_WIDTH;
		for (const [index, width] of widths.entries()) {
			if (width > widestWidth) {
				widestIndex = index;
				widestWidth = width;
			}
		}
		if (widestIndex === -1) break;
		widths[widestIndex] = Math.max(MIN_COLUMN_WIDTH, (widths[widestIndex] ?? MIN_COLUMN_WIDTH) - 1);
		totalWidth = widths.reduce((sum, width) => sum + width, 0) + columns.length * 3 + 1;
	}

	const header = `| ${columns.map((column, index) => padCell(column, widths[index] ?? MIN_COLUMN_WIDTH)).join(" | ")} |`;
	const divider = `| ${widths.map(width => "-".repeat(Math.max(width, MIN_COLUMN_WIDTH))).join(" | ")} |`;
	const lines = [header, divider];

	if (rows.length === 0) {
		lines.push("(no rows)");
		return lines.map(line => truncateToWidth(replaceTabs(line), MAX_RENDER_WIDTH)).join("\n");
	}

	for (const row of rows) {
		const cells = columns.map((column, index) =>
			padCell(stringifySqliteValue(row[column]), widths[index] ?? MIN_COLUMN_WIDTH),
		);
		lines.push(`| ${cells.join(" | ")} |`);
	}

	return lines.map(line => truncateToWidth(replaceTabs(line), MAX_RENDER_WIDTH)).join("\n");
}

const DECIMAL_INTEGER_PATTERN = /^[+-]?\d+$/;

function parseLimit(value: string | null, fallback: number): number {
	if (value === null || value.trim().length === 0) {
		return fallback;
	}

	const normalizedValue = value.trim();
	const parsed = Number(normalizedValue);
	if (!DECIMAL_INTEGER_PATTERN.test(normalizedValue) || !Number.isFinite(parsed) || parsed < 1) {
		throw new ToolError(`SQLite limit must be a positive integer; got '${value}'`);
	}
	return Math.min(parsed, MAX_QUERY_LIMIT);
}

function parseOffset(value: string | null): number {
	if (value === null || value.trim().length === 0) {
		return 0;
	}

	const normalizedValue = value.trim();
	const parsed = Number(normalizedValue);
	if (!DECIMAL_INTEGER_PATTERN.test(normalizedValue) || !Number.isFinite(parsed) || parsed < 0) {
		throw new ToolError(`SQLite offset must be a non-negative integer; got '${value}'`);
	}
	return parsed;
}

function getTableMasterRow(db: Database, table: string): SqliteMasterRow {
	const row =
		db
			.prepare<SqliteMasterRow, [string]>(
				`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${SQLITE_USER_TABLE_PREDICATE} AND name = ?`,
			)
			.get(table) ?? null;
	if (!row) {
		throw new ToolError(`SQLite table '${table}' not found`);
	}
	return row;
}

function getTableInfoRows(db: Database, table: string): SqliteTableInfoRow[] {
	getTableMasterRow(db, table);
	return db.prepare<SqliteTableInfoRow, []>(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all();
}

function getTableColumns(db: Database, table: string): string[] {
	return getTableInfoRows(db, table).map(column => column.name);
}

function getPrimaryKeyColumns(db: Database, table: string): SqliteTableInfoRow[] {
	return getTableInfoRows(db, table)
		.filter(column => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
}

function coerceIntegerKey(key: string, label: string): number | bigint {
	const trimmed = key.trim();
	if (!/^-?\d+$/.test(trimmed)) {
		throw new ToolError(`${label} must be an integer; got '${key}'`);
	}

	const asNumber = Number.parseInt(trimmed, 10);
	if (Number.isSafeInteger(asNumber)) {
		return asNumber;
	}
	return BigInt(trimmed);
}

function coerceLookupValue(key: string, type: string): SqliteBinding {
	const normalizedType = type.trim().toUpperCase();
	if (normalizedType.includes("INT")) {
		return coerceIntegerKey(key, `Primary key '${key}'`);
	}
	if (normalizedType.includes("REAL") || normalizedType.includes("FLOA") || normalizedType.includes("DOUB")) {
		const parsed = Number(key);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return key;
}

function resolveOrderClause(order: string | undefined, columns: string[]): string {
	if (!order) return "";
	const trimmed = order.trim();
	if (!trimmed) return "";

	const separatorIndex = trimmed.lastIndexOf(":");
	const column = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
	const direction =
		separatorIndex === -1
			? "asc"
			: trimmed
					.slice(separatorIndex + 1)
					.trim()
					.toLowerCase();
	if (!columns.includes(column)) {
		throw new ToolError(`SQLite order column '${column}' not found in table schema`);
	}
	if (direction !== "asc" && direction !== "desc") {
		throw new ToolError(`SQLite order direction must be 'asc' or 'desc'; got '${direction}'`);
	}
	return ` ORDER BY ${quoteSqliteIdentifier(column)} ${direction.toUpperCase()}`;
}

const FORBIDDEN_WHERE_KEYWORDS = new Set([
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"attach",
	"detach",
	"pragma",
]);

const COMMENT_OR_TERMINATOR_ERROR =
	"SQLite 'where' clause must not contain comments or statement terminators; use '?q=SELECT ...' for raw SQL";
const FORBIDDEN_KEYWORD_ERROR =
	"SQLite 'where' clause must not contain LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL";

/**
 * Scans a `where=` clause character-by-character, tracking single- and double-quoted
 * string literals, and rejects SQL control syntax that would otherwise let the
 * structured helper path escape the bound `LIMIT ? OFFSET ?` pagination:
 *
 * - comments (`--`, `/* ... *\/`) and statement terminators (`;`) outside quotes
 * - pagination / attach / pragma keywords outside quotes
 *
 * Raw SQL remains available through `?q=SELECT ...`.
 */
function findWhereClauseViolation(sql: string): string | null {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let tokenStart = -1;
	let keywordViolation: string | null = null;

	const flushToken = (end: number): void => {
		if (tokenStart < 0 || keywordViolation) {
			tokenStart = -1;
			return;
		}
		const token = sql.slice(tokenStart, end).toLowerCase();
		tokenStart = -1;
		if (FORBIDDEN_WHERE_KEYWORDS.has(token)) {
			keywordViolation = FORBIDDEN_KEYWORD_ERROR;
		}
	};

	for (let index = 0; index <= sql.length; index++) {
		const char = index < sql.length ? sql[index] : undefined;
		const next = index + 1 < sql.length ? sql[index + 1] : undefined;

		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				index += 1;
				continue;
			}
			if (char === "'") {
				inSingleQuote = false;
			}
			continue;
		}
		if (inDoubleQuote) {
			if (char === '"' && next === '"') {
				index += 1;
				continue;
			}
			if (char === '"') {
				inDoubleQuote = false;
			}
			continue;
		}

		const isIdent = char !== undefined && /[A-Za-z0-9_]/.test(char);
		if (isIdent) {
			if (tokenStart < 0) tokenStart = index;
			continue;
		}

		flushToken(index);

		if (char === undefined) break;
		if (char === "'") {
			inSingleQuote = true;
			continue;
		}
		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}
		if (char === ";") return COMMENT_OR_TERMINATOR_ERROR;
		if ((char === "-" && next === "-") || (char === "/" && next === "*") || (char === "*" && next === "/")) {
			return COMMENT_OR_TERMINATOR_ERROR;
		}
	}

	return keywordViolation;
}

function validateWhereClause(where: string | undefined): string | undefined {
	if (!where) return undefined;
	const trimmed = where.trim();
	if (!trimmed) return undefined;
	const violation = findWhereClauseViolation(trimmed);
	if (violation) {
		throw new ToolError(violation);
	}
	return trimmed;
}

function normalizeWriteValue(value: unknown, column: string): SqliteBinding {
	if (value === null) return null;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value;
	}
	throw new ToolError(`SQLite column '${column}' only accepts JSON scalar values or null`);
}

function validateWriteColumns(
	db: Database,
	table: string,
	data: Record<string, unknown>,
): Array<[string, SqliteBinding]> {
	const columns = new Set(getTableColumns(db, table));
	return Object.entries(data).map(([column, value]) => {
		if (!columns.has(column)) {
			throw new ToolError(`SQLite table '${table}' has no column named '${column}'`);
		}
		return [column, normalizeWriteValue(value, column)];
	});
}

export function parseSqlitePathCandidates(filePath: string): SqlitePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const seen = new Set<string>();
	const candidates: SqlitePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = SQLITE_PATH_PATTERN.exec(normalized);
		if (match === null) {
			break;
		}

		const end = match.index + match[0].length;
		const sqlitePath = filePath.slice(0, end);
		const remainder = normalized.slice(end);
		const { subPath, queryString } = splitSqliteRemainder(remainder);
		const key = `${sqlitePath}\0${subPath}\0${queryString}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ sqlitePath, subPath, queryString });
	}

	return candidates.sort((left, right) => right.sqlitePath.length - left.sqlitePath.length);
}

export async function isSqliteFile(absolutePath: string): Promise<boolean> {
	try {
		const bytes = await Bun.file(absolutePath).slice(0, SQLITE_MAGIC.byteLength).bytes();
		if (bytes.length !== SQLITE_MAGIC.byteLength) {
			return false;
		}

		for (const [index, byte] of SQLITE_MAGIC.entries()) {
			if (bytes[index] !== byte) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}

export function parseSqliteSelector(subPath: string, queryString: string): SqliteSelector {
	const normalizedSubPath = subPath.replace(/^:+/, "").trim();
	const params = new URLSearchParams(queryString);
	const rawQuery = params.get("q");

	if (rawQuery !== null) {
		const otherKeys = [...params.keys()].filter(key => key !== "q");
		if (normalizedSubPath || otherKeys.length > 0) {
			throw new ToolError("SQLite raw queries cannot be combined with table selectors or pagination");
		}
		if (!rawQuery.trim()) {
			throw new ToolError("SQLite query parameter 'q' cannot be empty");
		}
		return { kind: "raw", sql: rawQuery };
	}

	if (!normalizedSubPath) {
		if (params.size > 0) {
			throw new ToolError("SQLite query parameters require a table selector or q=SELECT...");
		}
		return { kind: "list" };
	}

	const separatorIndex = normalizedSubPath.indexOf(":");
	const table = separatorIndex === -1 ? normalizedSubPath : normalizedSubPath.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalizedSubPath.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite selectors must include a table name");
	}

	if (key !== undefined && key.length > 0) {
		if (params.size > 0) {
			throw new ToolError("SQLite row lookups cannot be combined with query parameters");
		}
		return { kind: "row", table, key };
	}

	const where = validateWhereClause(params.get("where") ?? undefined);
	const order = params.get("order")?.trim() || undefined;
	const hasQueryParams = params.has("limit") || params.has("offset") || order !== undefined || where !== undefined;
	if (hasQueryParams) {
		const knownKeys = new Set(["limit", "offset", "order", "where"]);
		for (const keyName of params.keys()) {
			if (!knownKeys.has(keyName)) {
				throw new ToolError(`Unsupported SQLite query parameter '${keyName}'`);
			}
		}
		return {
			kind: "query",
			table,
			limit: parseLimit(params.get("limit"), DEFAULT_QUERY_LIMIT),
			offset: parseOffset(params.get("offset")),
			order,
			where,
		};
	}

	if (params.size > 0) {
		for (const keyName of params.keys()) {
			throw new ToolError(`Unsupported SQLite query parameter '${keyName}'`);
		}
	}

	return { kind: "schema", table, sampleLimit: DEFAULT_SCHEMA_SAMPLE_LIMIT };
}

export function listTables(db: Database): { name: string; rowCount: number }[] {
	const names = db
		.prepare<Pick<SqliteMasterRow, "name">, []>(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND ${SQLITE_USER_TABLE_PREDICATE} ORDER BY name COLLATE NOCASE`,
		)
		.all();

	return names.map(({ name }) => {
		const countRow =
			db.prepare<SqliteCountRow, []>(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(name)}`).get() ?? null;
		return {
			name,
			rowCount: countRow?.count ?? 0,
		};
	});
}

export function getTableSchema(db: Database, table: string): string {
	const row = getTableMasterRow(db, table);
	if (!row.sql) {
		throw new ToolError(`SQLite schema for table '${table}' is unavailable`);
	}
	return row.sql;
}

export function getTablePrimaryKey(db: Database, table: string): { column: string; type: string } | null {
	const primaryKeyColumns = getPrimaryKeyColumns(db, table);
	if (primaryKeyColumns.length !== 1) {
		return null;
	}

	const column = primaryKeyColumns[0]!;
	return { column: column.name, type: column.type };
}

export function resolveTableRowLookup(db: Database, table: string): SqliteRowLookup {
	const primaryKeyColumns = getPrimaryKeyColumns(db, table);
	if (primaryKeyColumns.length === 1) {
		const column = primaryKeyColumns[0]!;
		return { kind: "pk", column: column.name, type: column.type };
	}
	if (primaryKeyColumns.length > 1) {
		throw new ToolError(`SQLite table '${table}' has a composite primary key; use '?where=' instead`);
	}

	const schema = getTableSchema(db, table);
	if (/\bWITHOUT\s+ROWID\b/i.test(schema)) {
		throw new ToolError(`SQLite table '${table}' does not expose ROWID; use '?where=' instead`);
	}

	return { kind: "rowid" };
}

export function queryRows(
	db: Database,
	table: string,
	opts: { limit: number; offset: number; order?: string; where?: string },
): { columns: string[]; rows: Record<string, unknown>[]; totalCount: number } {
	const columns = getTableColumns(db, table);
	const validatedWhere = validateWhereClause(opts.where);
	const whereClause = validatedWhere ? ` WHERE ${validatedWhere}` : "";
	const orderClause = resolveOrderClause(opts.order, columns);
	const countSql = `SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}${whereClause}`;
	const selectSql = `SELECT * FROM ${quoteSqliteIdentifier(table)}${whereClause}${orderClause} LIMIT ? OFFSET ?`;
	const totalCount = db.prepare<SqliteCountRow, []>(countSql).get()?.count ?? 0;
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(selectSql);
	if (statement.paramsCount !== 2) {
		throw new ToolError(
			"SQLite where clause changed the expected pagination parameters; use q=SELECT ... for raw SQL",
		);
	}
	const rows = statement.all(opts.limit, opts.offset);
	return { columns, rows, totalCount };
}

export function getRowByKey(
	db: Database,
	table: string,
	pk: { column: string; type?: string },
	key: string,
): Record<string, unknown> | null {
	getTableMasterRow(db, table);
	const sql = `SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(pk.column)} = ? LIMIT 1`;
	const binding = coerceLookupValue(key, pk.type ?? "");
	return db.prepare<SqliteRow, SQLQueryBindings[]>(sql).get(binding);
}

export function getRowByRowId(db: Database, table: string, key: string): Record<string, unknown> | null {
	getTableMasterRow(db, table);
	const binding = coerceIntegerKey(key, "SQLite ROWID");
	return db
		.prepare<SqliteRow, SQLQueryBindings[]>(`SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE rowid = ? LIMIT 1`)
		.get(binding);
}

const MAX_RAW_QUERY_ROWS = 1000;

export function executeReadQuery(
	db: Database,
	sql: string,
	maxRows: number = MAX_RAW_QUERY_ROWS,
): { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } {
	const statement = db.prepare<SqliteRow, []>(sql);
	if (statement.paramsCount > 0) {
		throw new ToolError("SQLite raw queries do not support bound parameters");
	}
	// Stream rows and stop at the cap (F20): a raw `q=SELECT ...` over a huge table
	// must not materialize every row into memory via statement.all().
	const rows: Record<string, unknown>[] = [];
	let truncated = false;
	for (const row of statement.iterate()) {
		if (rows.length >= maxRows) {
			truncated = true;
			break;
		}
		rows.push(row as Record<string, unknown>);
	}
	return { columns: [...statement.columnNames], rows, truncated };
}

export function insertRow(db: Database, table: string, data: Record<string, unknown>): void {
	getTableMasterRow(db, table);
	const entries = validateWriteColumns(db, table, data);
	if (entries.length === 0) {
		db.run(`INSERT INTO ${quoteSqliteIdentifier(table)} DEFAULT VALUES`);
		return;
	}

	const columns = entries.map(([column]) => quoteSqliteIdentifier(column)).join(", ");
	const placeholders = entries.map(() => "?").join(", ");
	const bindings = entries.map(([, value]) => value);
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(
		`INSERT INTO ${quoteSqliteIdentifier(table)} (${columns}) VALUES (${placeholders})`,
	);
	statement.run(...bindings);
}

export function updateRowByKey(
	db: Database,
	table: string,
	pk: { column: string; type?: string },
	key: string,
	data: Record<string, unknown>,
): number {
	getTableMasterRow(db, table);
	const entries = validateWriteColumns(db, table, data);
	if (entries.length === 0) {
		throw new ToolError("SQLite updates require at least one column value");
	}

	const assignments = entries.map(([column]) => `${quoteSqliteIdentifier(column)} = ?`).join(", ");
	const bindings = entries.map(([, value]) => value);
	bindings.push(coerceLookupValue(key, pk.type ?? ""));
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(
		`UPDATE ${quoteSqliteIdentifier(table)} SET ${assignments} WHERE ${quoteSqliteIdentifier(pk.column)} = ?`,
	);
	return statement.run(...bindings).changes;
}

export function updateRowByRowId(db: Database, table: string, key: string, data: Record<string, unknown>): number {
	getTableMasterRow(db, table);
	const entries = validateWriteColumns(db, table, data);
	if (entries.length === 0) {
		throw new ToolError("SQLite updates require at least one column value");
	}

	const assignments = entries.map(([column]) => `${quoteSqliteIdentifier(column)} = ?`).join(", ");
	const bindings = entries.map(([, value]) => value);
	bindings.push(coerceIntegerKey(key, "SQLite ROWID"));
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(
		`UPDATE ${quoteSqliteIdentifier(table)} SET ${assignments} WHERE rowid = ?`,
	);
	return statement.run(...bindings).changes;
}

export function deleteRowByKey(
	db: Database,
	table: string,
	pk: { column: string; type?: string },
	key: string,
): number {
	getTableMasterRow(db, table);
	const binding = coerceLookupValue(key, pk.type ?? "");
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(
		`DELETE FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(pk.column)} = ?`,
	);
	return statement.run(binding).changes;
}

export function deleteRowByRowId(db: Database, table: string, key: string): number {
	getTableMasterRow(db, table);
	const binding = coerceIntegerKey(key, "SQLite ROWID");
	const statement = db.prepare<SqliteRow, SQLQueryBindings[]>(
		`DELETE FROM ${quoteSqliteIdentifier(table)} WHERE rowid = ?`,
	);
	return statement.run(binding).changes;
}

export function renderTableList(tables: { name: string; rowCount: number }[]): string {
	if (tables.length === 0) {
		return "(no tables)";
	}

	return tables
		.map(table => truncateToWidth(replaceTabs(`${table.name} (${table.rowCount} rows)`), MAX_RENDER_WIDTH))
		.join("\n");
}

export function renderSchema(
	createSql: string,
	sampleRows: { columns: string[]; rows: Record<string, unknown>[] },
): string {
	const schemaLines = replaceTabs(createSql)
		.split("\n")
		.map(line => truncateToWidth(line, MAX_RENDER_WIDTH));
	const parts = [schemaLines.join("\n"), "", "Sample rows:", buildAsciiTable(sampleRows.columns, sampleRows.rows)];
	return parts.join("\n");
}

export function renderRow(row: Record<string, unknown>): string {
	const entries = Object.entries(row);
	if (entries.length === 0) {
		return "(no columns)";
	}

	return entries
		.map(([column, value]) =>
			truncateToWidth(replaceTabs(`${column}: ${stringifySqliteValue(value)}`), MAX_RENDER_WIDTH),
		)
		.join("\n");
}

export function renderTable(
	columns: string[],
	rows: Record<string, unknown>[],
	meta: { totalCount: number; offset: number; limit: number; table: string; dbPath: string },
): string {
	const parts = [buildAsciiTable(columns, rows)];
	const shown = Math.min(meta.totalCount, meta.offset + rows.length);
	if (shown < meta.totalCount) {
		const remaining = meta.totalCount - shown;
		const nextOffset = meta.offset + rows.length;
		parts.push(
			truncateToWidth(
				replaceTabs(
					`[${remaining} more rows; append :${meta.table}?limit=${meta.limit}&offset=${nextOffset} to the database path to continue]`,
				),
				MAX_RENDER_WIDTH,
			),
		);
	}
	return parts.join("\n");
}
