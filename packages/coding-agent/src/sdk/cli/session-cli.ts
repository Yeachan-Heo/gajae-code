import * as fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { getAgentDir } from "@gajae-code/utils";
import { ensureBroker } from "../broker/ensure";
import {
	listSdkSessionEndpoints,
	readSdkBrokerDiscovery,
	readSdkSessionEndpoint,
	SdkClient,
	SdkClientError,
	SdkDiscoveryError,
} from "../client";
import { validateAdapterControl } from "../protocol/adapter-validation";
import { adapterDispositionError, findOperation, type OperationKind } from "../protocol/operation-registry";

export type SdkSessionCliAction = "list" | "control" | "query" | "global";

export interface SdkSessionCliArgs {
	action?: string;
	sessionId?: string;
	operation?: string;
	query?: string;
	jsonInput?: string;
	jsonInputFile?: string;
	idempotencyKey?: string;
	jsonInputStdin?: boolean;
	confirm?: boolean;
	cursor?: string;
	showEndpointCredential?: boolean;
	yes?: boolean;
	repo?: string;
	agentDir?: string;
}

type JsonRecord = Record<string, unknown>;
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;

class SdkSessionCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1 | 2,
	) {
		super(message);
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseInput(raw: string | undefined, source: string): JsonRecord {
	if (raw === undefined) return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new SdkSessionCliError("invalid_input", `${source} must be a JSON object.`, 2);
		return value as JsonRecord;
	} catch (error) {
		if (error instanceof SdkSessionCliError) throw error;
		throw new SdkSessionCliError("invalid_json", `${source} must contain valid JSON.`, 2);
	}
}

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, nested]) => SECRET_FIELD.test(key) || containsSecretField(nested));
}

async function inputFromArgs(args: SdkSessionCliArgs): Promise<JsonRecord> {
	const sources = [
		args.jsonInput !== undefined,
		args.jsonInputFile !== undefined,
		args.jsonInputStdin === true,
	].filter(Boolean).length;
	if (sources > 1) throw new SdkSessionCliError("usage", "Use only one JSON input source.", 2);
	if (args.jsonInput !== undefined) {
		const input = parseInput(args.jsonInput, "--json-input");
		if (containsSecretField(input))
			throw new SdkSessionCliError(
				"secret_field_forbidden",
				"Secret values must use --json-input-file or --json-input-stdin.",
				2,
			);
		return input;
	}
	if (args.jsonInputFile !== undefined) {
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(args.jsonInputFile);
		} catch {
			throw new SdkSessionCliError("input_file_unavailable", "Unable to read --json-input-file.", 2);
		}
		if (!stat.isFile() || (stat.mode & 0o077) !== 0)
			throw new SdkSessionCliError(
				"input_file_permissions",
				"--json-input-file must be a regular file with 0600 permissions.",
				2,
			);
		try {
			return parseInput(await fs.readFile(args.jsonInputFile, "utf8"), "--json-input-file");
		} catch (error) {
			if (error instanceof SdkSessionCliError) throw error;
			throw new SdkSessionCliError("input_file_unavailable", "Unable to read --json-input-file.", 2);
		}
	}
	return args.jsonInputStdin ? parseInput(await Bun.stdin.text(), "--json-input-stdin") : {};
}

function requireValue(value: string | undefined, flag: string): string {
	if (!value) throw new SdkSessionCliError("usage", `${flag} is required.`, 2);
	return value;
}

function isEndpointOperation(operation: string): boolean {
	return operation === "session.get_endpoint";
}

function cliOperationError(kind: OperationKind, operation: string): { code: string; message: string } | undefined {
	const row = findOperation(kind, operation);
	const error = adapterDispositionError("daemonCli", kind, operation);
	if (!error) return undefined;
	if (row?.adapterDispositions.daemonCli === "prohibited")
		return {
			code: error.code,
			message: `${operation} is unavailable through the ordinary CLI; provider mode is out of scope this phase.`,
		};
	return error;
}

function isLifecycleOperation(operation: string): boolean {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete"
	);
}

async function confirmEndpointCredentialOutput(): Promise<boolean> {
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await prompt.question("Print the endpoint credential to stdout? [y/N] ")).trim().toLowerCase() === "y";
	} finally {
		prompt.close();
	}
}

async function connectBroker(agentDir: string): Promise<SdkClient> {
	await ensureBroker({ agentDir });
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) throw new SdkSessionCliError("broker_unavailable", "SDK broker discovery is unavailable.", 1);
	return await SdkClient.connect(discovery.url, discovery.token);
}

async function connectSession(repo: string, sessionId: string): Promise<SdkClient> {
	const endpoint = await readSdkSessionEndpoint(repo, sessionId);
	if (!endpoint)
		throw new SdkSessionCliError("session_unavailable", `SDK endpoint for session ${sessionId} is unavailable.`, 1);
	return await SdkClient.connect(endpoint.url, endpoint.token);
}

function brokerAbsent(error: unknown): boolean {
	if (error instanceof SdkSessionCliError) return error.code === "broker_unavailable";
	const details = error instanceof SdkClientError ? error.details : error;
	const code = (details as { code?: unknown } | undefined)?.code;
	return (
		code === "ENOENT" ||
		code === "ECONNREFUSED" ||
		/(?:ENOENT|ECONNREFUSED|connection refused)/i.test(error instanceof Error ? error.message : "")
	);
}

async function runList(repo: string, agentDir: string): Promise<unknown> {
	try {
		const client = await connectBroker(agentDir);
		try {
			return await client.global("session.list", {});
		} finally {
			await client.close();
		}
	} catch (error) {
		if (!brokerAbsent(error)) throw error;
		const { endpoints, warnings } = await listSdkSessionEndpoints(repo);
		return {
			sessions: endpoints.map(({ sessionId, path }) => ({ sessionId, path })),
			warnings: [
				{ code: "broker_unavailable", message: "Listed endpoint files because the broker is unavailable." },
				...warnings,
			],
		};
	}
}

/** Runs the pure-SDK `gjc daemon session` command family. */
export async function runSdkSessionCli(
	args: SdkSessionCliArgs,
	writeOutput: (value: unknown) => void = writeJson,
	setExitCode: (exitCode: 1 | 2) => void = exitCode => {
		process.exitCode = exitCode;
	},
): Promise<void> {
	try {
		const action = args.action;
		if (action !== "list" && action !== "control" && action !== "query" && action !== "global")
			throw new SdkSessionCliError("usage", "Expected one of: list, control, query, global.", 2);
		const repo = args.repo ?? process.cwd();
		const agentDir = args.agentDir ?? getAgentDir();
		if (action === "list") {
			writeOutput(await runList(repo, agentDir));
			return;
		}
		const operation = action === "query" ? requireValue(args.query, "--query") : requireValue(args.operation, "--op");
		const kind: OperationKind = action === "query" ? "query" : action === "global" ? "global" : "control";
		const dispositionError = cliOperationError(kind, operation);
		if (dispositionError) throw new SdkSessionCliError(dispositionError.code, dispositionError.message, 1);
		if (isEndpointOperation(operation)) {
			if (!args.showEndpointCredential)
				throw new SdkSessionCliError(
					"endpoint_credential_forbidden",
					"session.get_endpoint requires --show-endpoint-credential.",
					1,
				);
			if (process.stdout.isTTY && !args.yes && !(await confirmEndpointCredentialOutput()))
				throw new SdkSessionCliError(
					"endpoint_credential_confirmation_required",
					"Endpoint credential output was not confirmed.",
					1,
				);
		}
		const input = await inputFromArgs(args);
		if (kind === "control") {
			const invalid = validateAdapterControl(operation, input);
			if (invalid) throw new SdkSessionCliError(invalid.code, invalid.message, 2);
		}
		if (action === "global") {
			const idempotencyKey = args.idempotencyKey;
			if (isLifecycleOperation(operation) && !idempotencyKey)
				throw new SdkSessionCliError("invalid_input", "--idempotency-key is required for lifecycle operations.", 2);
			const client = await connectBroker(agentDir);
			try {
				writeOutput(await client.global(operation, input, { idempotencyKey }));
			} finally {
				await client.close();
			}
			return;
		}
		const sessionId = requireValue(args.sessionId, "<sessionId>");
		const client = await connectSession(repo, sessionId);
		try {
			if (action === "control")
				writeOutput(await client.control(operation, input, { confirm: args.confirm === true }));
			else writeOutput(await client.query(operation, input, args.cursor));
		} finally {
			await client.close();
		}
	} catch (error) {
		const cliError =
			error instanceof SdkSessionCliError
				? error
				: error instanceof SdkClientError
					? new SdkSessionCliError(error.code, error.message, 1)
					: error instanceof SdkDiscoveryError
						? new SdkSessionCliError(error.code, error.message, 1)
						: new SdkSessionCliError(
								"operation_failed",
								error instanceof Error ? error.message : "SDK operation failed.",
								1,
							);
		writeOutput({ ok: false, error: { code: cliError.code, message: cliError.message } });
		setExitCode(cliError.exitCode);
	}
}
