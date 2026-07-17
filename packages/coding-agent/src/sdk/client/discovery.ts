import * as fs from "node:fs/promises";
import path from "node:path";
import { type BrokerDiscovery, readBrokerDiscovery as readBrokerFile } from "../broker/discovery";

export interface SdkSessionEndpoint {
	sessionId: string;
	url: string;
	token: string;
	path: string;
}

export interface SdkDiscoveryWarning {
	code: "discovery_error";
	path: string;
	message: string;
}

export interface SdkSessionEndpointList {
	endpoints: SdkSessionEndpoint[];
	warnings: SdkDiscoveryWarning[];
}

export class SdkDiscoveryError extends Error {
	readonly code = "discovery_error";
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "SdkDiscoveryError";
	}
}

function endpointDirectory(repo: string): string {
	return path.join(repo, ".gjc", "state", "sdk");
}

function parseEndpoint(sessionId: string, file: string, value: unknown): SdkSessionEndpoint {
	if (!value || typeof value !== "object")
		throw new SdkDiscoveryError(file, "SDK endpoint discovery record must be an object.");
	const endpoint = value as { version?: unknown; url?: unknown; token?: unknown };
	if (typeof endpoint.version === "number" && endpoint.version > 1)
		throw new SdkDiscoveryError(file, "Unsupported SDK endpoint discovery state version.");
	if (typeof endpoint.url !== "string" || typeof endpoint.token !== "string" || !endpoint.url || !endpoint.token)
		throw new SdkDiscoveryError(file, "SDK endpoint discovery record is invalid.");
	return { sessionId, url: endpoint.url, token: endpoint.token, path: file };
}

function discoveryError(file: string, error: unknown): SdkDiscoveryError {
	if (error instanceof SdkDiscoveryError) return error;
	return new SdkDiscoveryError(file, "Unable to read SDK discovery record.");
}

/** Lists endpoint files and returns individual malformed or unreadable records as warnings. */
export async function listSdkSessionEndpoints(repo: string): Promise<SdkSessionEndpointList> {
	const directory = endpointDirectory(repo);
	let entries: Array<{ name: string; isFile(): boolean }>;
	try {
		entries = (await fs.readdir(directory, { withFileTypes: true })) as Array<{ name: string; isFile(): boolean }>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { endpoints: [], warnings: [] };
		throw discoveryError(directory, error);
	}
	const results = await Promise.all(
		entries
			.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
			.map(async entry => {
				const sessionId = entry.name.slice(0, -".json".length);
				const file = path.join(directory, entry.name);
				try {
					return { endpoint: parseEndpoint(sessionId, file, JSON.parse(await fs.readFile(file, "utf8"))) };
				} catch (error) {
					return { warning: discoveryError(file, error) };
				}
			}),
	);
	return {
		endpoints: results.flatMap(result => (result.endpoint ? [result.endpoint] : [])),
		warnings: results.flatMap(result =>
			result.warning
				? [{ code: result.warning.code, path: result.warning.path, message: result.warning.message }]
				: [],
		),
	};
}

/** Resolves one per-session SDK endpoint discovery file. */
export async function readSdkSessionEndpoint(repo: string, sessionId: string): Promise<SdkSessionEndpoint | null> {
	if (!sessionId || sessionId.includes(path.sep) || sessionId.includes("/")) return null;
	const file = path.join(endpointDirectory(repo), `${sessionId}.json`);
	try {
		return parseEndpoint(sessionId, file, JSON.parse(await fs.readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw discoveryError(file, error);
	}
}

/** Reads the agent-global broker discovery record. */
export async function readSdkBrokerDiscovery(agentDir: string): Promise<BrokerDiscovery | null> {
	try {
		return await readBrokerFile(agentDir);
	} catch (error) {
		const file = path.join(agentDir, "sdk", "broker.json");
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw discoveryError(file, error);
	}
}
