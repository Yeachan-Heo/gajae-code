import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeNoReplaceResult } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import { getAgentDir, isEnoent, logger } from "@gajae-code/utils";
import { JSONC, YAML } from "bun";
import type { ZodType } from "zod/v4";

/** Minimal subset of the AJV ConfigSchemaError shape this module actually relies on. */
interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

interface FileIdentity {
	dev: number | bigint;
	ino: number | bigint;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function warningDetails(outcomeCode: string, error?: unknown): Record<string, string> {
	const rawName = error instanceof Error ? error.name : "";
	const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawName) ? rawName : "Error";
	return {
		outcomeCode,
		errorName,
		errorMessage: "Legacy config migration was not proven durable.",
	};
}

function warnMigration(outcomeCode: string, error?: unknown): void {
	logger.warn("migrateJsonToYml: migration not completed", warningDetails(outcomeCode, error));
}

function isStructuredPublishOutcome(value: NativeNoReplaceResult): boolean {
	return (
		typeof value.ok === "boolean" &&
		typeof value.mutationState === "string" &&
		typeof value.durabilityState === "string" &&
		typeof value.reason === "string" &&
		typeof value.primitive === "string" &&
		value.primitive.length > 0 &&
		typeof value.phase === "string" &&
		typeof value.diagnostic === "object" &&
		value.diagnostic !== null
	);
}

function isCommittedPublishOutcome(value: NativeNoReplaceResult): boolean {
	return (
		isStructuredPublishOutcome(value) &&
		value.mutationState === "committed" &&
		value.durabilityState === "not_attempted" &&
		value.reason === "none" &&
		value.phase === "complete"
	);
}

const CERTIFIED_NON_COMMIT_REASONS = new Set([
	"destination_exists",
	"atomic_unavailable",
	"invalid_request",
	"cross_device",
	"permission_denied",
	"io_failure",
	"interrupted",
	"identity_violation",
]);

function isCertifiedNonCommit(value: NativeNoReplaceResult): boolean {
	return (
		isStructuredPublishOutcome(value) &&
		value.ok === false &&
		value.mutationState === "not_committed" &&
		value.durabilityState === "not_attempted" &&
		CERTIFIED_NON_COMMIT_REASONS.has(value.reason)
	);
}

function writeFully(fd: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		if (written <= 0) throw new Error("Config migration temp write made no progress");
		offset += written;
	}
}

function syncParentDirectory(ymlPath: string): void {
	const noFollow = fs.constants.O_NOFOLLOW;
	const directory = fs.constants.O_DIRECTORY;
	if (typeof noFollow !== "number" || noFollow === 0 || typeof directory !== "number" || directory === 0) {
		throw new Error("Secure directory sync is unsupported");
	}
	const fd = fs.openSync(path.dirname(ymlPath), fs.constants.O_RDONLY | directory | noFollow);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function removeCertifiedTemp(tempPath: string, identity: FileIdentity | undefined): void {
	if (!identity) return;
	try {
		const current = fs.lstatSync(tempPath);
		if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, identity)) return;
		fs.unlinkSync(tempPath);
	} catch {
		// Cleanup is best effort and never grants authority to touch another path.
	}
}

export function migrateJsonToYml(jsonPath: string, ymlPath: string): void {
	let tempPath: string | undefined;
	let tempIdentity: FileIdentity | undefined;
	let tempFd: number | undefined;
	let publicationCommitted = false;

	try {
		try {
			fs.lstatSync(ymlPath);
			return;
		} catch (error) {
			if (!isEnoent(error)) {
				warnMigration("destination_identity_failed", error);
				return;
			}
		}

		let source: fs.Stats;
		try {
			source = fs.lstatSync(jsonPath);
		} catch (error) {
			if (!isEnoent(error)) warnMigration("source_identity_failed", error);
			return;
		}
		if (!source.isFile() || source.isSymbolicLink()) {
			warnMigration("source_not_regular");
			return;
		}

		const noFollow = fs.constants.O_NOFOLLOW;
		if (typeof noFollow !== "number" || noFollow === 0) {
			warnMigration("no_follow_unsupported");
			return;
		}

		const sourceFd = fs.openSync(jsonPath, fs.constants.O_RDONLY | noFollow);
		let content: string | undefined;
		try {
			const openedSource = fs.fstatSync(sourceFd);
			if (openedSource.isFile() && sameIdentity(source, openedSource)) {
				content = fs.readFileSync(sourceFd, "utf8");
			}
		} finally {
			fs.closeSync(sourceFd);
		}
		if (content === undefined) {
			warnMigration("source_identity_changed");
			return;
		}

		const parsed = JSON.parse(content);
		if (!parsed) {
			warnMigration("invalid_json_structure");
			return;
		}
		const bytes = Buffer.from(YAML.stringify(parsed, null, 2), "utf8");

		tempPath = path.join(path.dirname(ymlPath), `.${path.basename(ymlPath)}.${randomUUID()}.tmp`);
		tempFd = fs.openSync(
			tempPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
			source.mode & 0o777,
		);
		const openedTemp = fs.fstatSync(tempFd);
		if (!openedTemp.isFile()) throw new Error("Config migration temp is not a regular file");
		tempIdentity = openedTemp;
		writeFully(tempFd, bytes);
		fs.fchmodSync(tempFd, source.mode & 0o777);
		fs.fsyncSync(tempFd);
		fs.closeSync(tempFd);
		tempFd = undefined;

		const publication = native.renameNoReplacePath(tempPath, ymlPath);
		if (isCommittedPublishOutcome(publication)) {
			publicationCommitted = true;
			try {
				syncParentDirectory(ymlPath);
			} catch (error) {
				warnMigration("published_parent_sync_failed", error);
				return;
			}
			if (!publication.ok) warnMigration("published_outcome_not_proven");
			return;
		}
		if (isCertifiedNonCommit(publication)) {
			if (publication.reason !== "destination_exists") {
				warnMigration(`not_committed_${publication.reason}`);
			}
			return;
		}
		warnMigration("publication_outcome_indeterminate");
	} catch (error) {
		warnMigration("migration_failed", error);
	} finally {
		if (tempFd !== undefined) {
			try {
				fs.closeSync(tempFd);
			} catch {
				// The identity check below remains authoritative for cleanup.
			}
		}
		if (!publicationCommitted && tempPath) removeCertifiedTemp(tempPath, tempIdentity);
	}
}

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: ZodType<T>;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ConfigSchemaError[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
	) {
		let messages: string[] | undefined;
		let cause: Error | undefined;
		let klass: string;

		if (schemaErrors) {
			klass = "Schema";
			messages = schemaErrors.map(e => `${e.instancePath || "root"}: ${e.message}`);
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [other.err.message];
				cause = other.err;
			} else {
				messages = [String(other.err)];
			}
		} else {
			klass = "Unknown";
		}

		const title = `Failed to load config file ${id}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
		}

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	get message(): string {
		return this.#message;
	}

	toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;

	constructor(
		readonly id: string,
		readonly schema: ZodType<T>,
		configPath: string = path.join(getAgentDir(), `${id}.yml`),
	) {
		this.#basePath = configPath;
		if (configPath.endsWith(".yml")) {
			const jsonPath = `${configPath.slice(0, -4)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".yaml")) {
			const jsonPath = `${configPath.slice(0, -5)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
			// JSON configs are still supported without migration.
		} else {
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	relocate(configPath?: string): ConfigFile<T> {
		if (!configPath || configPath === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.schema, configPath);
		result.#auxValidate = this.#auxValidate;
		return result;
	}

	getMtimeMs(): number | null {
		try {
			return fs.statSync(this.path()).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` });
			}
		};
		return this;
	}

	createDefault(): T {
		const parsed = this.schema.safeParse({});
		if (parsed.success) return parsed.data;
		const fallback = this.schema.safeParse(undefined);
		if (fallback.success) return fallback.data;
		throw new ConfigError(this.id, undefined, {
			err: new Error("Schema produced no default value"),
			stage: "createDefault",
		});
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	tryLoad(): LoadResult<T> {
		if (this.#cache) return this.#cache;

		try {
			const content = fs.readFileSync(this.path(), "utf-8").trim();

			let parsed: unknown;
			if (this.#basePath.endsWith(".json") || this.#basePath.endsWith(".jsonc")) {
				parsed = JSONC.parse(content);
			} else if (this.#basePath.endsWith(".yml") || this.#basePath.endsWith(".yaml")) {
				parsed = YAML.parse(content);
			} else {
				throw new Error(`Invalid config file path: ${this.#basePath}`);
			}

			const checked = this.schema.safeParse(parsed);
			if (!checked.success) {
				const schemaErrors: ConfigSchemaError[] = [];
				for (const issue of checked.error.issues) {
					const instancePath = issue.path.length === 0 ? "" : `/${issue.path.map(String).join("/")}`;
					schemaErrors.push({ instancePath, message: issue.message });
					if (schemaErrors.length >= 50) break;
				}
				const error = new ConfigError(this.id, schemaErrors);
				logger.warn("Failed to parse config file", { path: this.path(), error });
				return this.#storeCache({ error, status: "error" });
			}
			const value = checked.data;
			try {
				this.#auxValidate?.(value);
			} catch (error) {
				const wrapped =
					error instanceof ConfigError
						? error
						: new ConfigError(this.id, undefined, { err: error, stage: "AuxValidate" });
				return this.#storeCache({ error: wrapped, status: "error" });
			}
			return this.#storeCache({ value, status: "ok" });
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to parse config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }),
				status: "error",
			});
		}
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	path(): string {
		return this.#basePath;
	}

	invalidate() {
		this.#cache = undefined;
	}
}
