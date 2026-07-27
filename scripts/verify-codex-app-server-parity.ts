#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderGeneratedFiles, type Bundle, type Direction } from "./sync-codex-app-server-schema.ts";
import { supportManifestOverrides } from "../packages/coding-agent/src/app-server/protocol-source/support-manifest.overrides.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const protocolRoot = path.join(repoRoot, "packages/coding-agent/src/app-server/protocol-source");
const vendorRoot = path.join(protocolRoot, "vendor");
const generatedPaths = ["types.generated.ts", "validators.generated.ts", "catalogs.generated.ts", "support-manifest.generated.ts", "behavior/generated-behavior.ts"];
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
type Meta = { upstreamCommit: string; authorityLevel: string; derivation: string; nonAuthoritative: boolean; rustSourceFailure: string | null; checksums: Record<string, string>; sourceFiles: Record<string, string>; directionCounts: Record<Direction, number> };

function assertProvenance(meta: Meta, bundle: Bundle, allowReadmeDerivation: boolean) {
	if (meta.authorityLevel !== "method-and-field-shapes" || bundle.authorityLevel !== meta.authorityLevel) throw new Error("bundle/meta authority mismatch");
	if (meta.derivation !== "rust-source-derived" && meta.derivation !== "readme-derived") throw new Error("invalid provenance derivation");
	if (meta.nonAuthoritative !== (meta.derivation === "readme-derived")) throw new Error("non-authoritative flag conflicts with derivation");
	if (bundle.derivation !== meta.derivation) throw new Error("bundle/meta derivation mismatch");
	if (meta.derivation === "readme-derived" && !allowReadmeDerivation) throw new Error("README-derived method catalog requires --allow-readme-derivation");
	if (meta.rustSourceFailure !== null && (typeof meta.rustSourceFailure !== "string" || !meta.rustSourceFailure.length || meta.rustSourceFailure.length > 1_000)) throw new Error("invalid Rust source failure diagnostic");
	if ((meta.derivation === "readme-derived") !== (typeof meta.rustSourceFailure === "string" && meta.rustSourceFailure.length > 0)) throw new Error("Rust source fallback diagnostic conflicts with derivation");
	if (meta.derivation === "rust-source-derived" && !Object.keys(meta.sourceFiles).length) throw new Error("missing Rust field-shape source provenance");
	for (const direction of ["clientRequests", "clientNotifications", "serverRequests", "serverNotifications"] as const) if (meta.directionCounts[direction] !== bundle.directions[direction].length) throw new Error(`method direction count mismatch: ${direction}`);
	for (const entry of Object.values(bundle.directions).flat()) {
		for (const shape of [entry.params, entry.result].filter((value): value is NonNullable<typeof value> => value !== undefined)) {
			if (!Array.isArray(shape.fields) || !Array.isArray(shape.unresolved) || shape.unresolved.length > 1_000) throw new Error("invalid or unbounded unresolved field references");
			if (new Set(shape.unresolved).size !== shape.unresolved.length) throw new Error("unresolved field references must be enumerated once");
		}
	}
}
function assertGeneratedParity(bundle: Bundle, tracked: Record<string, string>) { const expected = renderGeneratedFiles(bundle); for (const relativePath of generatedPaths) if (expected[relativePath] !== tracked[relativePath]) throw new Error(`generated file is stale: ${relativePath}`); }
function assertManifestCoverage(bundle: Bundle, manifestSource: string, overrides: Record<string, unknown> = supportManifestOverrides) {
	const generated = [...manifestSource.matchAll(/"method":\s*"([^"]+)"/g)].map(match => match[1]); const expected = bundle.directions.clientRequests.map(entry => entry.method);
	if (new Set(generated).size !== generated.length) throw new Error("support manifest contains duplicate methods");
	if (generated.length !== expected.length || !generated.every(method => expected.includes(method)) || !expected.every(method => generated.includes(method))) throw new Error("support manifest method catalog is incomplete");
	for (const column of ["gjcSeam", "gjcBackendPath", "semanticGaps", "translationNotes", "owner", "testIds"]) if (!manifestSource.includes(column)) throw new Error(`support manifest missing required column: ${column}`);
	for (const method of Object.keys(overrides)) if (!expected.includes(method)) throw new Error(`support manifest override is not a client request: ${method}`);
	for (const row of Object.values(overrides) as Array<Record<string, unknown>>) if (row.support === "implemented" && (!row.gjcSeam || !row.gjcBackendPath || !Array.isArray(row.testIds) || !row.testIds.length)) throw new Error("implemented support row lacks evidence");
	if (!manifestSource.includes('support: "planned"')) throw new Error("support manifest lacks planned default classification");
}

const bundleText = await fs.readFile(path.join(vendorRoot, "app-server.schema.bundle.json"), "utf8");
const behaviorText = await fs.readFile(path.join(vendorRoot, "app-server.behavior.json"), "utf8");
const meta = JSON.parse(await fs.readFile(path.join(vendorRoot, "app-server.meta.json"), "utf8")) as Meta;
const bundle = JSON.parse(bundleText) as Bundle;
const provenanceKeys = ["upstreamCommit", "fetchedAt", "authorityLevel", "derivation", "nonAuthoritative", "rustSourceFailure", "checksums", "sourceFiles", "gjcOverrides", "directionCounts"];
if (Object.keys(meta).length !== provenanceKeys.length || provenanceKeys.some(key => !Object.hasOwn(meta, key))) throw new Error("invalid provenance metadata keys");
if (meta.upstreamCommit !== "81da9deb065d7adb283816b19b40f89bcc484276") throw new Error("unexpected upstream pin");
assertProvenance(meta, bundle, process.argv.includes("--allow-readme-derivation"));
for (const name of ["app-server.schema.bundle.json", "app-server.behavior.json"]) if (sha256(await fs.readFile(path.join(vendorRoot, name), "utf8")) !== meta.checksums[name]) throw new Error(`checksum mismatch: ${name}`);
const behavior = JSON.parse(behaviorText) as { errorEnvelopes: Record<string, { id: unknown; error: { data?: unknown } }> ; cli: { AppServerWebsocketAuthArgs: string[] }; wireProtocol: { malformedJson: string } };
for (const [name, envelope] of Object.entries(behavior.errorEnvelopes)) { if (Object.hasOwn(envelope.error, "data")) throw new Error(`golden envelope error has forbidden data key: ${name}`); if (typeof envelope.id !== "string" && (!Number.isInteger(envelope.id))) throw new Error(`golden envelope has invalid id: ${name}`); }
if (behavior.wireProtocol.malformedJson !== "dropped+logged no-response") throw new Error("malformed JSON policy mismatch");
if (!behavior.cli.AppServerWebsocketAuthArgs.includes("--ws-token-file XOR --ws-token-sha256")) throw new Error("missing ws auth XOR definition");
const tracked = Object.fromEntries(await Promise.all(generatedPaths.map(async relative => [relative, await fs.readFile(path.join(protocolRoot, relative), "utf8")]))) as Record<string, string>;
assertGeneratedParity(bundle, tracked); assertManifestCoverage(bundle, tracked["support-manifest.generated.ts"]);
if (process.argv.includes("--self-test")) {
	const entry = bundle.directions.clientRequests.find(candidate => candidate.params.fields.length) ?? bundle.directions.clientRequests[0]; if (!entry) throw new Error("missing client request");
	const mutated = structuredClone(bundle); const shape = mutated.directions.clientRequests.find(candidate => candidate.method === entry.method)?.params; if (!shape) throw new Error("missing mutation shape");
	const field = shape.fields[0] ?? { name: "synthetic", rustType: "String", optional: false, skipSerializingIf: null }; if (!shape.fields.length) shape.fields.push(field);
	for (const mutate of [(candidate: Bundle) => { candidate.directions.clientRequests.find(value => value.method === entry.method)?.params.fields.splice(0, 1); }, (candidate: Bundle) => { const target = candidate.directions.clientRequests.find(value => value.method === entry.method)?.params.fields[0]; if (target) target.optional = !target.optional; }, (candidate: Bundle) => { const target = candidate.directions.clientRequests.find(value => value.method === entry.method)?.params.fields[0]; if (target) target.name = `${target.name}Renamed`; }, (candidate: Bundle) => { candidate.directions.clientRequests.find(value => value.method === entry.method)?.params.unresolved.push("UnlistedReference"); }] as const) { const candidate = structuredClone(mutated); mutate(candidate); let rejected = false; try { assertGeneratedParity(candidate, tracked); } catch { rejected = true; } if (!rejected) throw new Error("negative field-shape mutation was not rejected"); }
	let manifestRejected = false; try { assertManifestCoverage(bundle, tracked["support-manifest.generated.ts"].replaceAll("gjcSeam", "")); } catch { manifestRejected = true; } if (!manifestRejected) throw new Error("negative manifest evidence mutation was not rejected");
}
console.log(`PASS codex app-server field-shape parity: ${bundle.directions.clientRequests.length} client requests, ${bundle.directions.clientNotifications.length} client notifications, ${bundle.directions.serverRequests.length} server requests, ${bundle.directions.serverNotifications.length} server notifications`);
