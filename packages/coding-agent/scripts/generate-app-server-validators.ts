#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

type Profile = "stable" | "experimental";
type ValidatorMapName =
	| "clientRequestParams"
	| "clientRequestResults"
	| "clientNotificationParams"
	| "serverRequestParams"
	| "serverRequestResults"
	| "serverNotificationParams";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const vendorRoot = path.join(repositoryRoot, "packages/coding-agent/vendor/codex-app-server-schema");
const outputPath = path.join(
	repositoryRoot,
	"packages/coding-agent/src/app-server/protocol-source/schema-validators.generated.ts",
);

async function formatSource(source: string): Promise<string> {
	const process = Bun.spawn(["bunx", "biome", "check", "--write", `--stdin-file-path=${outputPath}`], {
		cwd: repositoryRoot,
		stdin: new TextEncoder().encode(source),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`Biome failed to format generated validators: ${stderr}`);
	return stdout;
}

async function methods(profile: Profile, envelope: string): Promise<string[]> {
	const schema = JSON.parse(await fs.readFile(path.join(vendorRoot, profile, "json", `${envelope}.json`), "utf8")) as {
		oneOf?: { properties?: { method?: { enum?: unknown[] } } }[];
	};
	if (!schema.oneOf) throw new Error(`${profile}/${envelope} has no oneOf`);
	return schema.oneOf.map(branch => {
		const method = branch.properties?.method?.enum?.[0];
		if (typeof method !== "string") throw new Error(`${profile}/${envelope} has a branch without a method enum`);
		return method;
	});
}

function source(): string {
	return `// GENERATED CODE — DO NOT EDIT. Source: vendored Draft-07 protocol envelope and bundle schemas.
// Authoritative generated validators; validators.generated.ts remains the legacy required-key compatibility module.
// Ajv's Draft-07 Ajv class compiles these schemas when this module loads. Standalone output was rejected because twelve self-contained envelope compilations produced a 162 MB module; runtime compilation keeps the generated artifact reviewable and uses the pinned Ajv toolchain.
// Rust integer formats are normalized before compilation: uint/uint64 and int/int64 use JavaScript safe-integer bounds; width-suffixed formats use their exact bounds. Other formats remain unvalidated because validateFormats is disabled, including double and date-time.
// Inputs are limited to JSON data: finite numbers; dense arrays; and objects with Object.prototype or null prototypes whose data properties are enumerable string keys.

import Ajv from "ajv";
import stableClientRequest from "../../../vendor/codex-app-server-schema/stable/json/ClientRequest.json" with { type: "json" };
import stableServerRequest from "../../../vendor/codex-app-server-schema/stable/json/ServerRequest.json" with { type: "json" };
import stableClientNotification from "../../../vendor/codex-app-server-schema/stable/json/ClientNotification.json" with { type: "json" };
import stableServerNotification from "../../../vendor/codex-app-server-schema/stable/json/ServerNotification.json" with { type: "json" };
import stableProtocol from "../../../vendor/codex-app-server-schema/stable/json/codex_app_server_protocol.schemas.json" with { type: "json" };
import stableProtocolV2 from "../../../vendor/codex-app-server-schema/stable/json/codex_app_server_protocol.v2.schemas.json" with { type: "json" };
import experimentalClientRequest from "../../../vendor/codex-app-server-schema/experimental/json/ClientRequest.json" with { type: "json" };
import experimentalServerRequest from "../../../vendor/codex-app-server-schema/experimental/json/ServerRequest.json" with { type: "json" };
import experimentalClientNotification from "../../../vendor/codex-app-server-schema/experimental/json/ClientNotification.json" with { type: "json" };
import experimentalServerNotification from "../../../vendor/codex-app-server-schema/experimental/json/ServerNotification.json" with { type: "json" };
import experimentalProtocol from "../../../vendor/codex-app-server-schema/experimental/json/codex_app_server_protocol.schemas.json" with { type: "json" };
import experimentalProtocolV2 from "../../../vendor/codex-app-server-schema/experimental/json/codex_app_server_protocol.v2.schemas.json" with { type: "json" };
import legacyBundle from "./vendor/app-server.schema.bundle.json" with { type: "json" };

export type SchemaValidator = ((value: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; message?: string }[] | null };
export type ValidatorMap = Record<string, SchemaValidator>;
type Schema = Record<string, unknown>;
type Envelope = Schema & { oneOf: Schema[] };
const safeInteger = Number.MAX_SAFE_INTEGER;
const numericFormats: Record<string, readonly [number, number]> = { uint: [0, safeInteger], uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295], uint64: [0, safeInteger], int: [-safeInteger, safeInteger], int8: [-128, 127], int16: [-32768, 32767], int32: [-2147483648, 2147483647], int64: [-safeInteger, safeInteger] };

function normalize(schema: unknown): unknown { if (Array.isArray(schema)) return schema.map(normalize); if (!schema || typeof schema !== "object") return schema; const copy = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, normalize(value)])) as Schema; const bounds = typeof copy.format === "string" ? numericFormats[copy.format] : undefined; if (bounds) { copy.minimum = Math.max(typeof copy.minimum === "number" ? copy.minimum : bounds[0], bounds[0]); copy.maximum = Math.min(typeof copy.maximum === "number" ? copy.maximum : bounds[1], bounds[1]); delete copy.format; } return copy; }
function branches(envelope: Envelope) { return envelope.oneOf.map(branch => { const properties = branch.properties as Schema; const method = ((properties.method as Schema).enum as unknown[])[0]; if (typeof method !== "string") throw new Error("Vendored envelope branch has no method enum"); return { method, branch, properties }; }); }
function paramsSchema(envelope: Envelope): Schema { const schema = structuredClone(envelope); for (const { branch, properties } of branches(schema)) { delete properties.id; if (Array.isArray(branch.required)) branch.required = branch.required.filter(key => key !== "id"); } return schema; }
function resultSchema(envelope: Envelope, definitions: Schema): Schema { const responses = new Map(Object.values(legacyBundle.directions).flat().flatMap(entry => { const resultType = (entry as { result_type?: string }).result_type; return resultType ? [[entry.method, resultType.replace(/^.*::/, "")] as const] : []; })); return { definitions, oneOf: branches(envelope).map(({ method, properties }) => { const params = properties.params as Schema | undefined; const inferred = typeof params?.$ref === "string" ? params.$ref.replace(/^.*\\//, "").replace(/Params$/, "Response") : undefined; const response = inferred && Object.hasOwn(definitions, inferred) ? inferred : responses.get(method); if (!response || !Object.hasOwn(definitions, response)) throw new Error(\`Missing response definition for \${method}\`); return { properties: { method: { const: method }, value: { $ref: \`#/definitions/\${response}\` } }, required: ["method", "value"], type: "object" }; }) }; }
function validator(schema: Schema): SchemaValidator { return new Ajv({ strict: false, strictNumbers: true, validateFormats: false }).compile(normalize(schema) as Schema) as SchemaValidator; }
export function isJson(value: unknown): boolean { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (Array.isArray(value)) { if (Object.getOwnPropertySymbols(value).length > 0) return false; const descriptors = Object.getOwnPropertyDescriptors(value); for (const [key, descriptor] of Object.entries(descriptors)) { if (key === "length") continue; const index = Number(key); if (!descriptor.enumerable || !("value" in descriptor) || !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key || !isJson(descriptor.value)) return false; } for (let index = 0; index < value.length; index++) { if (!Object.hasOwn(value, index)) return false; } return true; } if (typeof value !== "object") return false; const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false; if (Object.getOwnPropertySymbols(value).length > 0) return false; return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && "value" in descriptor && isJson(descriptor.value)); }
function map(envelope: Envelope, schema: Schema, results = false): ValidatorMap { const compiled = validator(schema); const entries = branches(envelope).map(({ method, branch, properties }): [string, SchemaValidator] => { const hasParams = Object.hasOwn(properties, "params"); const paramsRequired = Array.isArray(branch.required) && branch.required.includes("params"); const validate: (value: unknown) => boolean = results ? (value: unknown) => isJson(value) && Boolean(compiled({ method, value })) : !hasParams ? (value: unknown) => value === undefined : (value: unknown) => (value === undefined && !paramsRequired) || (isJson(value) && Boolean(compiled({ method, params: value }))); return [method, validate as SchemaValidator]; }); return Object.fromEntries(entries); }
function profile(clientRequest: Envelope, serverRequest: Envelope, clientNotification: Envelope, serverNotification: Envelope, protocol: Schema, protocolV2: Schema) { const definitions = { ...(protocol.definitions as Schema), ...(protocolV2.definitions as Schema) }; return { clientRequestParams: map(clientRequest, paramsSchema(clientRequest)), clientRequestResults: map(clientRequest, resultSchema(clientRequest, definitions), true), clientNotificationParams: map(clientNotification, paramsSchema(clientNotification)), serverRequestParams: map(serverRequest, paramsSchema(serverRequest)), serverRequestResults: map(serverRequest, resultSchema(serverRequest, definitions), true), serverNotificationParams: map(serverNotification, paramsSchema(serverNotification)) } as const; }
export const stableValidators = profile(stableClientRequest as Envelope, stableServerRequest as Envelope, stableClientNotification as Envelope, stableServerNotification as Envelope, stableProtocol, stableProtocolV2);
export const experimentalValidators = profile(experimentalClientRequest as Envelope, experimentalServerRequest as Envelope, experimentalClientNotification as Envelope, experimentalServerNotification as Envelope, experimentalProtocol, experimentalProtocolV2);
export const appServerSchemaValidators = { stable: stableValidators, experimental: experimentalValidators } as const;
`;
}

export async function generateAppServerValidators(
	destination = outputPath,
): Promise<Record<Profile, Record<ValidatorMapName, number>>> {
	const result = {} as Record<Profile, Record<ValidatorMapName, number>>;
	for (const profile of ["stable", "experimental"] as const) {
		const [clientRequests, serverRequests, clientNotifications, serverNotifications] = await Promise.all([
			methods(profile, "ClientRequest"),
			methods(profile, "ServerRequest"),
			methods(profile, "ClientNotification"),
			methods(profile, "ServerNotification"),
		]);
		result[profile] = {
			clientRequestParams: clientRequests.length,
			clientRequestResults: clientRequests.length,
			clientNotificationParams: clientNotifications.length,
			serverRequestParams: serverRequests.length,
			serverRequestResults: serverRequests.length,
			serverNotificationParams: serverNotifications.length,
		};
	}
	await fs.writeFile(destination, await formatSource(source()));
	return result;
}

if (import.meta.main) console.log(JSON.stringify(await generateAppServerValidators()));
