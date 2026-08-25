/**
 * Official seal for stranded coordinator start-session idempotency projections.
 * Writes completed + ok:false retired:true under the session-state lock.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeCoordinatorAtomic } from "../src/coordinator-mcp/durability";
import { withSessionStateFileLock } from "../src/gjc-runtime/session-state-lock";

function usage(): never {
	console.error(
		"usage: bun scripts/seal-uncertain-create-intent.ts --namespace <dir> --key-digest <64hex> --session-id <uuid>",
	);
	process.exit(2);
}

function arg(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) usage();
	return value;
}

const namespace = arg("--namespace");
const keyDigest = arg("--key-digest");
const sessionId = arg("--session-id");
if (!/^[a-f0-9]{64}$/.test(keyDigest)) {
	console.error("key-digest must be 64 hex chars");
	process.exit(2);
}

const file = path.join(namespace, "idempotency", `${keyDigest}.json`);
const lockFile = path.join(namespace, "idempotency-locks", `${keyDigest}.json`);

await withSessionStateFileLock(lockFile, async () => {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			console.error("missing idempotency projection");
			process.exit(1);
		}
		throw error;
	}
	const existing = JSON.parse(raw) as {
		schema_version?: number;
		tool?: string;
		key_digest?: string;
		request_digest?: string;
		state?: string;
		created_at?: string;
		response?: { error?: { retired?: boolean } };
	};
	if (existing.schema_version !== 1 || existing.key_digest !== keyDigest) {
		console.error("idempotency identity mismatch");
		process.exit(1);
	}
	if (existing.tool !== "gjc_coordinator_start_session") {
		console.error("not a start_session projection");
		process.exit(1);
	}
	if (existing.state === "completed" && existing.response?.error?.retired === true) {
		console.log(JSON.stringify({ ok: true, replayed: true, key_digest: keyDigest, session_id: sessionId }));
		return;
	}
	if (existing.state !== "in_progress") {
		console.error(`refusing to seal state=${existing.state}`);
		process.exit(1);
	}
	const sealed = {
		schema_version: 1,
		tool: existing.tool,
		key_digest: existing.key_digest,
		request_digest: existing.request_digest ?? createHash("sha256").update(keyDigest).digest("hex"),
		state: "completed",
		created_at: existing.created_at ?? new Date().toISOString(),
		completed_at: new Date().toISOString(),
		response: {
			ok: false,
			error: {
				code: "broker_compensation_unobserved",
				retired: true,
				session_id: sessionId,
			},
		},
	};
	await writeCoordinatorAtomic(file, `${JSON.stringify(sealed)}\n`);
	console.log(JSON.stringify({ ok: true, sealed: true, key_digest: keyDigest, session_id: sessionId }));
});
