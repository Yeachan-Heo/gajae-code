/**
 * Post-build script: reads the napi-rs generated `index.d.ts`, rewrites
 * TypeScript-only enum declarations to runtime-backed declarations, and writes
 * `native/index.js` from the checked-in ESM loader template.
 *
 * Why explicit ESM exports matter (issue #892):
 *
 * Consumers import named symbols from `@gajae-code/natives`. The native addon
 * loader returns most values dynamically, while napi-rs `#[napi(string_enum)]`
 * emits `const enum` in the .d.ts — a TypeScript-only construct with no JS
 * runtime value. This script renders the ESM loader template and emits one
 * explicit `export const X = …` per public class/function declared in
 * `index.d.ts`, plus literal runtime objects for each enum.
 *
 * Run after `napi build`: `bun packages/natives/scripts/gen-enums.ts`
 */
import * as path from "node:path";

const nativeDir = path.resolve(import.meta.dir, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");

const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

// Match each `export declare const enum Name { ... }` block. The closing `}`
// is matched only at line start (enum bodies are indented).
const CONST_ENUM_RE = /export declare (?:const )?enum (\w+)\s*\{(.*?)\n\}/gs;

// Match `export declare class Name` (signatures or block headers). napi-rs
// always emits these as top-level declarations; we just need the name.
const CLASS_RE = /^export declare class (\w+)/gm;

// Match `export declare function name(...)`. Same shape rationale.
const FUNCTION_RE = /^export declare function (\w+)/gm;

// These platform-gated classes remain named ESM exports and declarations on
// every platform so cross-platform consumers can import the package without
// conditional export syntax. The native binding is available only where its
// platform implementation is built.
const COMPATIBILITY_CLASSES = ["ComputerController"];

const COMPUTER_CONTROLLER_DECLARATION = `/**
 * macOS computer-use controller.
 *
 * This declaration and the named JS export are available on every platform so
 * consumers can import them portably; the native controller itself is built
 * only on macOS.
 */
export declare class ComputerController {
  constructor()
  screenshot(): ComputerScreenshot
  click(expectedEpoch: number | undefined | null, x: number, y: number, button?: string | undefined | null): void
  doubleClick(expectedEpoch: number | undefined | null, x: number, y: number, button?: string | undefined | null): void
  move(expectedEpoch: number | undefined | null, x: number, y: number): void
  drag(expectedEpoch: number | undefined | null, x: number, y: number, toX: number, toY: number, button?: string | undefined | null): void
  scroll(expectedEpoch: number | undefined | null, x: number, y: number, scrollX: number, scrollY: number): void
  type(expectedEpoch: number | undefined | null, text: string): void
  keypress(expectedEpoch: number | undefined | null, keys: Array<string>): void
  wait(expectedEpoch: number | undefined | null, ms: number): void
}

`;
interface EnumExport {
	name: string;
	entries: string[];
}

function collectEnums(dts: string): EnumExport[] {
	const enums: EnumExport[] = [];
	CONST_ENUM_RE.lastIndex = 0;
	for (;;) {
		const match = CONST_ENUM_RE.exec(dts);
		if (match === null) break;
		const name = match[1]!;
		const body = match[2]!;
		const entries: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
			if (m) {
				const rawValue = m[2]!;
				const value = rawValue.match(/^\d+$/) ? rawValue : JSON.stringify(rawValue);
				entries.push(`\t${m[1]}: ${value},`);
			}
		}
		if (entries.length > 0) {
			enums.push({ name, entries });
		}
	}
	return enums;
}

function collectMatches(dts: string, re: RegExp): string[] {
	const names: string[] = [];
	re.lastIndex = 0;
	for (;;) {
		const match = re.exec(dts);
		if (match === null) break;
		names.push(match[1]!);
	}
	return names;
}

function applyPathIdentityTypes(dts: string): string {
	const identity = `export type NativeCanonicalDirectoryIdentity =
	| { ok: true; platform: "posix" | "win32"; canonicalPath: string; code?: never }
	| {
			ok: false;
			platform?: never;
			canonicalPath?: never;
			code: "not_found" | "not_directory" | "not_utf8" | "network_unsupported" | "identity_unavailable" | "io_error";
	  }`;
	const security = `export type NativeOwnerOnlySecurityResult =
	| {
			ok: true;
			platform: "linux";
			kind: "file";
			protocol: "apply" | "verify";
			aclEvidence: {
				access: {
					clear: "cleared" | "already_absent" | "unsupported" | "not_run";
					query: "absent" | "unsupported";
				};
				default?: never;
			};
			code?: never;
			operation?: never;
			attribute?: never;
	  }
	| {
			ok: true;
			platform: "linux";
			kind: "directory";
			protocol: "apply" | "verify";
			aclEvidence: {
				access: {
					clear: "cleared" | "already_absent" | "unsupported" | "not_run";
					query: "absent" | "unsupported";
				};
				default: {
					clear: "cleared" | "already_absent" | "unsupported" | "not_run";
					query: "absent" | "unsupported";
				};
			};
			code?: never;
			operation?: never;
			attribute?: never;
	  }
	| {
			ok: true;
			platform?: never;
			kind?: never;
			protocol?: never;
			aclEvidence?: never;
			code?: never;
			operation?: never;
			attribute?: never;
	  }
	| {
			ok: false;
			code: "acl_denied" | "acl_io_error" | "acl_present" | "acl_malformed" | "acl_unknown";
			operation: "clear" | "query";
			attribute: "access" | "default";
			platform?: never;
			kind?: never;
			protocol?: never;
			aclEvidence?: never;
	  }
	| {
			ok: false;
			code: "acl_unavailable" | "acl_apply_failed" | "acl_verify_failed";
			operation?: never;
			attribute?: never;
			platform?: never;
			kind?: never;
			protocol?: never;
			aclEvidence?: never;
	  }
	| {
			ok: false;
			code:
				| "not_found"
				| "not_directory"
				| "network_unsupported"
				| "reparse_point"
				| "identity_unavailable"
				| "identity_mismatch"
				| "owner_mismatch"
				| "mode_mismatch"
				| "io_error";
			operation?: never;
			attribute?: never;
			platform?: never;
			kind?: never;
			protocol?: never;
			aclEvidence?: never;
	  }`;
	return dts
		.replace(
			/^export declare function canonicalExistingDirectoryIdentity\([^\n]*$/m,
			"export declare function canonicalExistingDirectoryIdentity(path: string | Uint8Array): NativeCanonicalDirectoryIdentity",
		)
		.replace(
			/^export declare function applyOwnerOnlyPathSecurity\([^\n]*$/m,
			'export declare function applyOwnerOnlyPathSecurity(path: string, kind: "directory" | "file"): NativeOwnerOnlySecurityResult',
		)
		.replace(
			/^export declare function applyOwnerOnlyFdSecurity\([^\n]*$/m,
			'export declare function applyOwnerOnlyFdSecurity(path: string, kind: "directory" | "file", callerFd: number): NativeOwnerOnlySecurityResult',
		)
		.replace(
			/^export declare function verifyOwnerOnlyPathSecurityExpected\([^\n]*$/m,
			'export declare function verifyOwnerOnlyPathSecurityExpected(path: string, kind: "directory" | "file", expectedDev: bigint, expectedIno: bigint): NativeOwnerOnlySecurityResult',
		)
		.replace(
			/^export declare function verifyOwnerOnlyPathSecurity\([^\n]*$/m,
			'export declare function verifyOwnerOnlyPathSecurity(path: string, kind: "directory" | "file"): NativeOwnerOnlySecurityResult',
		)
		.replace(
			/^export declare function verifyOwnerOnlyFdSecurity\([^\n]*$/m,
			'export declare function verifyOwnerOnlyFdSecurity(path: string, kind: "directory" | "file", callerFd: number): NativeOwnerOnlySecurityResult',
		)
		.replace(
			/^export declare function repairOwnerOnlyPathSecurityExpected\([^\n]*$/m,
			'export declare function repairOwnerOnlyPathSecurityExpected(path: string, kind: "directory" | "file", expectedDev: bigint, expectedIno: bigint): NativeOwnerOnlySecurityResult',
		)
		.replace(/export interface NativeCanonicalDirectoryIdentity \{[\s\S]*?\n\}/, identity)
		.replace(
			/export (?:interface|type) NativeOwnerOnlySecurityResult[\s\S]*?(?=\n\n\/\*\* Bound endpoint info)/,
			security,
		);
}

function buildGeneratedBlock(dts: string): string {
	const classes = [...new Set([...COMPATIBILITY_CLASSES, ...collectMatches(dts, CLASS_RE)])];
	const functions = collectMatches(dts, FUNCTION_RE);
	const enums = collectEnums(dts);

	if (classes.length === 0 && functions.length === 0 && enums.length === 0) {
		throw new Error("No public symbols found in index.d.ts — check napi build output");
	}

	const lines: string[] = [];
	if (classes.length > 0) {
		lines.push("// classes");
		for (const name of classes) {
			lines.push(`export const ${name} = nativeBindings.${name};`);
		}
	}
	if (functions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// functions");
		for (const name of functions) {
			lines.push(`export const ${name} = nativeBindings.${name};`);
		}
	}
	if (enums.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// string/numeric enums (napi-rs string_enum produces TS-only const enum)");
		for (const e of enums) {
			lines.push(`export const ${e.name} = {\n${e.entries.join("\n")}\n};`);
		}
	}

	return `${MARKER_START}\n${lines.join("\n")}\n${MARKER_END}`;
}

function patchCompatibilityDeclarations(dts: string): string {
	let patched = dts;
	if (!/^export declare class ComputerController\b/m.test(patched)) {
		patched = patched.replace("/* eslint-disable */\n", `/* eslint-disable */\n${COMPUTER_CONTROLLER_DECLARATION}`);
	}
	return patched
		.replace(
			"/** The action id being answered (the real broker `gate_id` for asks). */",
			"/** The transient action/presentation id being answered, not a durable gate id. */",
		)
		.replace(
			"/** Public status of exact direct retirement. Claims and receipts remain native. */\nexport interface RetireIfUnclaimedResult {\n  status: string\n}",
			'/** Public status of exact direct retirement. Claims and receipts remain native. */\nexport interface RetireIfUnclaimedResult {\n  status: "retired" | "already_terminal" | "claimed" | "stale"\n}',
		)
		.replace(
			"/**\n * Private in-process presentation identity used for exact direct retirement.\n * It is never emitted to SDK clients or persisted.\n */",
			"/**\n * Opaque in-process capability returned by `registerArbitratedAsk`.\n * Pass it unchanged to `retireIfUnclaimed`; do not construct, persist,\n * inspect, or treat it as workflow-gate authority.\n */",
		)
		.replace(
			"Register an ask and return an in-memory-only exact presentation lease for\n   * a subsequent direct retirement attempt. A supplied `workflowGateId` is\n   * preserved.",
			"Register an ask and return an opaque in-process capability. Pass it\n   * unchanged to `retireIfUnclaimed`; do not construct, persist, inspect, or\n   * treat it as workflow-gate authority. A supplied `workflowGateId` is preserved.",
		)
		.replace(
			"Atomically terminalize this exact presentation lease. The typed status\n   * proves whether the lease retired, was already terminal, was claimed, or\n   * became stale without exposing claims, receipts, or registration state.",
			"Atomically terminalize the exact presentation named by an opaque lease.\n   * The typed status proves whether it retired, was already terminal, was\n   * claimed, or became stale without exposing claims, receipts, registration\n   * state, or workflow-gate authority.",
		)
		.replace(
			"Legacy id-only local termination is unsafe for arbitrated presentations.\n   * Use [`Self::retire_if_unclaimed`] with the exact lease instead.",
			"Resolve a legacy/non-arbitrated action locally (the CLI/TUI answered).\n   * Arbitrated presentations require `retireIfUnclaimed` with the opaque exact\n   * lease, so id-only local resolution fails closed for those presentations.",
		);
}

export async function generateEnumExports(): Promise<void> {
	const generatedDts = await Bun.file(dtsPath).text();
	const existing = await Bun.file(jsPath).text();
	const generatedBlock = buildGeneratedBlock(generatedDts);

	// Patch the generated block in place. `native/index.js` is the hand-edited
	// loader; only the block between MARKER_START and MARKER_END is owned by
	// this script. The markers are committed to disk so the patch is purely
	// content replacement — no scaffold, no template file.
	const blockStart = existing.indexOf(MARKER_START);
	const blockEnd = existing.indexOf(MARKER_END);
	if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
		throw new Error(
			`gen-enums: ${jsPath} is missing the generated marker block. ` +
				`Add\n\n${MARKER_START}\n${MARKER_END}\n\nplaceholders before running.`,
		);
	}
	const js = existing.slice(0, blockStart) + generatedBlock + existing.slice(blockEnd + MARKER_END.length);

	await Bun.write(jsPath, js);

	// Also fix the .d.ts: replace `const enum` with `enum` so TS allows
	// assigning string literals to enum types without casts.
	const constEnumCount = (generatedDts.match(/export (?:declare )?const enum/g) ?? []).length;
	const dtsContent = patchCompatibilityDeclarations(
		applyPathIdentityTypes(
			generatedDts
				.replaceAll("export const enum", "export declare enum")
				.replaceAll("export declare const enum", "export declare enum"),
		),
	);
	await Bun.write(dtsPath, dtsContent);

	const symbolCount = (generatedBlock.match(/^export const /gm) ?? []).length;
	console.log(
		`Generated ${symbolCount} explicit ESM exports in index.js, fixed ${constEnumCount} const enums in index.d.ts`,
	);
}

if (import.meta.main) {
	await generateEnumExports();
}
