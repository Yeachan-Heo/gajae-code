/**
 * Read-only diagnostic addon loader (private subpath).
 *
 * Deliberately NOT the ordinary loader: importing the package entry runs
 * `loadNative()` plus crash-diagnostics initialization, and the ordinary loader
 * may consider embedded payloads, cache directories and self-healing steps. A
 * read-only broker observation must not do any of that, so this module:
 *
 *   - admits exactly one runtime tuple (darwin/arm64 on Bun 1.4.0) and reports a
 *     fixed `unsupported` outcome for everything else, before touching the
 *     filesystem;
 *   - selects exactly ONE package-owned layout — the versioned cache slot when
 *     running from a compiled binary, otherwise the addon beside this file (build
 *     checkout) or, when that is absent, the `os`/`cpu`-matched optional platform
 *     package that ships it in a published install. There is no candidate walk: a
 *     selected layout that fails verification is `unsupported`, never a reason to
 *     try another location. No cwd, environment, agent directory or search path is
 *     ever consulted;
 *   - proves the trusted namespace before reading: every component is owned by the
 *     current user or by root, is not a symlink, and grants no group/other write,
 *     so an account that owns none of the path cannot swap the artifact out;
 *   - proves the bytes on a retained descriptor: SHA-256 equal to the digest this
 *     package records in `diagnostic-artifact.json`, which is part of the module
 *     graph so a compiled binary carries it too. An addon's own
 *     `nativeBuildInfo()` is self-reported by code that has already executed, so
 *     it is only a consistency check afterwards, never the trust anchor;
 *   - activates the verified bytes through that same retained descriptor
 *     (`process.dlopen` on `/dev/fd/<fd>`), so a pathname replaced between
 *     verification and activation cannot change what is loaded. On this runtime the
 *     descriptor path reopens the descriptor's own vnode; that was verified
 *     experimentally, and the loader refuses to activate at all if that route is
 *     unavailable;
 *   - creates nothing and changes nothing on disk: no embedded-payload unpacking,
 *     no staging, no directory creation, no permission change, no lock, and no
 *     crash-diagnostics initialization.
 *
 * Boundaries stated exactly, because the loader must not claim what it cannot prove:
 *
 *   - ACL authority IS inspected, through the platform's own read-only ACL API
 *     (`acl_get_fd_np`/`acl_get_entry`/`acl_free`), bound from the ABSOLUTE system
 *     library path with Bun's existing FFI. The absolute path matters: a basename
 *     bootstrap loads and runs the initializer of a same-named library found through
 *     the dynamic loader's search, which was reproduced on this runtime. Apple's own
 *     `acl_get_fd` is a wrapper for `acl_get_fd_np(fd, ACL_TYPE_EXTENDED)`; the `_np`
 *     form is used here only to state the ACL type explicitly.
 *   - A dyld override environment (`DYLD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`,
 *     `DYLD_FRAMEWORK_PATH`, the `DYLD_FALLBACK_*` variants) cannot be proven safe
 *     from inside the process, so the loader refuses BEFORE it calls `dlopen`,
 *     without deleting or rewriting anyone's environment.
 *   - The addon under verification is never imported for this, no helper process is
 *     spawned and nothing is installed. The artifact file and its own directory -- the
 *     artifact namespace anchor, which is NOT `agentDir` -- must have NO extended ACL
 *     entry. A trusted ancestor STRICTLY ABOVE that anchor may instead carry exactly one
 *     fully validated, non-inheriting `everyone DENY DELETE` entry (the user-approved
 *     exception); anything else, including ALLOW, mixed, inherited, extra rights, a
 *     different principal or more than one entry, fails closed. An ACL the platform
 *     cannot answer for counts as
 *     unproven and is refused: `st_mode` alone cannot show an ACE that grants another
 *     account write access. An `acl_get_entry` result of -1 is end-of-iteration OR a
 *     failure (an invalid ACL reports EINVAL the same way), so it is never read as
 *     "this file has no ACL"; only a null handle with the platform's "no such ACL"
 *     errno proves absence. Where the API is unavailable the loader reports
 *     `unsupported` instead of guessing.
 *   - A rewrite of the same inode by the owner or root stays an explicit non-goal.
 *     What the loader does enforce is that any write which lands after verification
 *     — by anyone, including a byte-identical rewrite — invalidates the handle,
 *     because activation re-proves the descriptor's metadata before `dlopen`.
 *
 * The lease returned by `openDiagnosticSnapshot` exposes no descriptor, path or
 * publication authority: only bounded bytes, revalidation and close.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as nodePath from "node:path";
import trustedArtifacts from "./diagnostic-artifact.json" with { type: "json" };
import packageManifest from "../package.json" with { type: "json" };

/** SPEC AC-B3: the first supported runtime is exactly Darwin arm64 on Bun 1.4.0. */
const SUPPORTED_BUN_VERSION = "1.4.0";
const ARTIFACT_BASENAME = "pi_natives.darwin-arm64.node";
const PLATFORM_PACKAGE = "@gajae-code/natives-darwin-arm64";
const DIAGNOSTIC_EXPORT = "diagnosticSnapshotOpen";
const READ_CHUNK_BYTES = 1 << 20;

const unsupported = { ok: false, reason: "unsupported" };

/**
 * The one admitted runtime tuple. Node, another Bun build or another OS/arch is
 * unsupported: the observation contract was only established for this tuple.
 *
 * @param {{ platform?: string; arch?: string; bunVersion?: string }} runtime
 * @returns {boolean}
 */
export function supportedRuntime(runtime) {
	if (runtime.platform !== "darwin") return false;
	if (runtime.arch !== "arm64") return false;
	return runtime.bunVersion === SUPPORTED_BUN_VERSION;
}

/**
 * A compiled binary has no package directory to read from, so the artifact can
 * only come from the existing versioned cache location.
 *
 * @returns {boolean}
 */
function runningFromCompiledBinary() {
	if (process.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * The existing fixed trusted cache location for this package version.
 *
 * @returns {string}
 */
function cachedArtifactPath() {
	const dataHome = process.env.XDG_DATA_HOME;
	const base =
		dataHome && fs.existsSync(nodePath.join(dataHome, "gjc"))
			? nodePath.join(dataHome, "gjc", "natives")
			: nodePath.join(os.homedir(), ".gjc", "natives");
	return nodePath.join(base, packageManifest.version, ARTIFACT_BASENAME);
}

/**
 * The package-owned expected digest for this artifact, or null when this package
 * ships no trusted record for it.
 *
 * @returns {string | null}
 */
function trustedDigest() {
	if (trustedArtifacts?.version !== packageManifest.version) return null;
	const digest = trustedArtifacts?.artifacts?.[ARTIFACT_BASENAME];
	return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * Select the single applicable layout. Exactly one distribution shape applies per
 * install, and a failure of the selected layout is never a reason to try another.
 *
 * @param {NodeRequire} require
 * @returns {string | null}
 */
export function selectArtifactLayout(require) {
	if (runningFromCompiledBinary()) return cachedArtifactPath();
	const besideLoader = nodePath.join(
		nodePath.dirname(require.resolve("./diagnostic-loader.js")),
		ARTIFACT_BASENAME,
	);
	if (fs.existsSync(besideLoader)) return besideLoader;
	try {
		// Published installs ship the addon in the os/cpu-matched optional package,
		// resolved through package metadata only.
		const platformManifest = require.resolve(`${PLATFORM_PACKAGE}/package.json`);
		return nodePath.join(nodePath.dirname(platformManifest), "native", ARTIFACT_BASENAME);
	} catch {
		return null;
	}
}

/** Lazily bound read-only ACL symbols from the platform's own system library. */
let aclBinding;

/** The absolute system library that owns the platform ACL API. */
const SYSTEM_LIBRARY_PATH = "/usr/lib/libSystem.B.dylib";

/**
 * Dynamic-loader overrides that can introduce another image into this process. They
 * are applied before any of this code runs, so their presence cannot be undone here;
 * the loader refuses instead, and never edits the environment.
 */
const DYLD_OVERRIDE_VARIABLES = [
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"DYLD_FALLBACK_FRAMEWORK_PATH",
	"DYLD_VERSIONED_LIBRARY_PATH",
	"DYLD_VERSIONED_FRAMEWORK_PATH",
];

/**
 * Whether this process runs with a dynamic-loader override in effect.
 *
 * @returns {boolean}
 */
function dyldOverridePresent() {
	return DYLD_OVERRIDE_VARIABLES.some(name => {
		const value = process.env[name];
		return typeof value === "string" && value !== "";
	});
}

/**
 * Bind the read-only macOS ACL API.
 *
 * Only `acl_get_fd`, `acl_get_entry` and `acl_free` are bound, all of them
 * read-only: nothing here can set or change an ACL. The library is the system's own
 * `libSystem.B.dylib`, resolved by the dynamic loader, which is the same trust
 * anchor the ordinary native loader already relies on for platform calls.
 *
 * @returns {{ aclGetFd: (fd: number) => number | bigint, aclGetEntry: (acl: number | bigint, id: number, out: unknown) => number, aclFree: (acl: number | bigint) => number } | null}
 */
function aclSymbols() {
	if (aclBinding !== undefined) return aclBinding;
	aclBinding = null;
	if (process.platform !== "darwin" || typeof Bun === "undefined") return aclBinding;
	// Refuse before any dlopen: an override could have introduced another image, and
	// inspecting the library after loading it cannot undo an initializer.
	if (dyldOverridePresent()) return aclBinding;
	try {
		const require = createRequire(import.meta.url);
		const { dlopen, FFIType, ptr, read, toArrayBuffer } = require("bun:ffi");
		const library = dlopen(SYSTEM_LIBRARY_PATH, {
			// `acl_get_fd` is Apple's wrapper for this call; the `_np` form is used so the
			// ACL type is explicit at the call site.
			acl_get_fd_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.ptr },
			acl_get_entry: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
			// Read-only entry introspection for the approved single-ACE exception.
			acl_valid: { args: [FFIType.ptr], returns: FFIType.i32 },
			// Full permission mask and the bounded external representation: these are what
			// make "nothing but DELETE" and "exactly one entry" complete statements rather
			// than a walk over the bits we happened to enumerate.
			acl_get_permset_mask_np: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			acl_size: { args: [FFIType.ptr], returns: FFIType.i64 },
			acl_copy_ext_native: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.i64 },
			__error: { args: [], returns: FFIType.ptr },
		});
		aclBinding = {
			aclGetFd: fd => library.symbols.acl_get_fd_np(fd, ACL_TYPE_EXTENDED),
			aclGetEntry: (acl, id, out) => library.symbols.acl_get_entry(acl, id, ptr(out)),
			aclFree: acl => library.symbols.acl_free(acl),
			aclValid: acl => library.symbols.acl_valid(acl),
			readPointer: view => Number(view[0]),
			aclGetPermsetMask: (entry, out) => library.symbols.acl_get_permset_mask_np(entry, ptr(out)),
			aclSize: acl => Number(library.symbols.acl_size(acl)),
			aclCopyExtNative: (buffer, acl, size) =>
				Number(library.symbols.acl_copy_ext_native(ptr(buffer), acl, size)),
			errno: () => {
				const pointer = library.symbols.__error();
				return pointer ? read.i32(pointer, 0) : null;
			},
			resetErrno: () => {
				const pointer = library.symbols.__error();
				if (!pointer) return false;
				// Clearing errno at the call boundary keeps a stale value from a previous,
				// unrelated call out of the classification below.
				new DataView(toArrayBuffer(pointer, 0, 4)).setInt32(0, 0, true);
				return true;
			},
		};
	} catch {
		aclBinding = null;
	}
	return aclBinding;
}

/** First-entry selector of the platform ACL iteration API. */
const ACL_FIRST_ENTRY = 0;

/** macOS ACL type selector for the extended (NFSv4-style) ACL. */
const ACL_TYPE_EXTENDED = 0x00000100;

/** `errno` value the platform reports when a file simply has no extended ACL. */
const ACL_ERRNO_NO_ACL = 2;

/** Selector for the entry after the first one. */
const ACL_NEXT_ENTRY = -1;

/** Selector for the last entry. */
const ACL_LAST_ENTRY = -2;

/** `errno` the platform reports when iteration has reached the end. */
const ACL_ERRNO_END_OF_ITERATION = 22;

/**
 * Bounded external ACL representation (`kauth_filesec`, magic `0x012cc16d`).
 *
 * Layout from the platform SDK (`sys/kauth.h`): `u32 magic`, `guid_t owner`,
 * `guid_t group`, then `struct kauth_acl { u32 entrycount; u32 flags; kauth_ace ace[] }`
 * with `struct kauth_ace { guid_t applicable; u32 flags; u32 rights }`. A one-entry ACL
 * is therefore exactly 68 bytes, which was confirmed against a real ACL on this runtime
 * before this parser was relied on.
 */
const KAUTH_FILESEC_MAGIC = 0x012cc16d;
const KAUTH_FILESEC_HEADER_BYTES = 44;
const KAUTH_ACE_BYTES = 24;
const KAUTH_ACL_MAX_ENTRIES = 128;
const KAUTH_ACE_DENY_ONLY = 2;
const KAUTH_VNODE_DELETE_ONLY = 1 << 4;

/**
 * Parse the bounded external representation. Every structural fact is validated: total
 * length, magic, entry count against the byte length and the platform maximum. Nothing
 * is reinterpreted beyond that documented layout.
 *
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, count: number, headerFlags: number, entries: { guid: Uint8Array, flags: number, rights: number }[] } | { ok: false }}
 */
export function parseAclRepresentation(bytes) {
	if (!(bytes instanceof Uint8Array)) return { ok: false };
	if (bytes.byteLength < KAUTH_FILESEC_HEADER_BYTES) return { ok: false };
	const payload = bytes.byteLength - KAUTH_FILESEC_HEADER_BYTES;
	if (payload % KAUTH_ACE_BYTES !== 0) return { ok: false };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== KAUTH_FILESEC_MAGIC) return { ok: false };
	const count = view.getUint32(36, true);
	if (count !== payload / KAUTH_ACE_BYTES) return { ok: false };
	if (count > KAUTH_ACL_MAX_ENTRIES) return { ok: false };
	const entries = [];
	for (let index = 0; index < count; index += 1) {
		const base = KAUTH_FILESEC_HEADER_BYTES + index * KAUTH_ACE_BYTES;
		entries.push({
			guid: bytes.slice(base, base + 16),
			flags: view.getUint32(base + 16, true),
			rights: view.getUint32(base + 20, true),
		});
	}
	return { ok: true, count, headerFlags: view.getUint32(40, true), entries };
}

/**
 * Decide a parsed representation against the approved exception. Full-field equality,
 * never a walk over known bits: the ACL header flags must be entirely zero, the entry's
 * flags must be exactly the deny tag, and its rights must be exactly DELETE.
 *
 * @param {unknown} parsed
 * @returns {"approved-single-deny-delete" | "not-allowlisted" | "unproven"}
 */
export function classifyAclRepresentation(parsed) {
	if (typeof parsed !== "object" || parsed === null) return "unproven";
	const record = /** @type {{ ok?: unknown; count?: unknown; headerFlags?: unknown; entries?: unknown }} */ (parsed);
	if (record.ok !== true) return "unproven";
	if (typeof record.count !== "number" || !Array.isArray(record.entries)) return "unproven";
	if (record.count !== record.entries.length) return "unproven";
	if (record.count !== 1) return "not-allowlisted";
	if (record.headerFlags !== 0) return "not-allowlisted";
	const entry = record.entries[0];
	if (entry.flags !== KAUTH_ACE_DENY_ONLY) return "not-allowlisted";
	if (entry.rights !== KAUTH_VNODE_DELETE_ONLY) return "not-allowlisted";
	if (entry.guid.length !== EVERYONE_GUID.length) return "unproven";
	return entry.guid.every((byte, index) => byte === EVERYONE_GUID[index])
		? "approved-single-deny-delete"
		: "not-allowlisted";
}

/** Raw well-known everyone GUID (`ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C`). */
const EVERYONE_GUID = Uint8Array.from([
	0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x0c,
]);

/**
 * Classify one ACL probe. Pure, so it behaves identically on every platform and can
 * be tested without the platform API.
 *
 * Absence must be proven positively: a null handle counts only with the platform's
 * "no such ACL" errno. A first entry means an ACE exists. `acl_get_entry` returning
 * -1 is end-of-iteration OR a failure -- an invalid ACL reports EINVAL the same way
 * -- so it is `unproven`, never "empty".
 *
 * @param {{ handle: number; errno: number | null; firstEntry: number | null }} probe
 * @returns {"absent" | "present" | "unproven"}
 */
export function classifyAclProbe(probe) {
	if (!probe.handle) return probe.errno === ACL_ERRNO_NO_ACL ? "absent" : "unproven";
	if (probe.firstEntry === 0) return "present";
	return "unproven";
}

/**
 * Classify the extended ACL of one open descriptor.
 *
 * `absent` requires a positive observation that the ACL holds no entry; a first
 * entry means an ACE exists and the artifact is refused; anything the API cannot
 * answer is `unproven`, never silently treated as clean.
 *
 * @param {number} fd
 * @returns {"absent" | "present" | "unproven"}
 */
export function inspectAclOnDescriptor(fd) {
	const symbols = aclSymbols();
	if (symbols === null) return "unproven";
	let acl;
	try {
		// Reset at the call boundary, then capture immediately after the call, so the
		// value classified below belongs to this call and not to an earlier one.
		if (!symbols.resetErrno()) return "unproven";
		acl = symbols.aclGetFd(fd);
	} catch {
		return "unproven";
	}
	const handle = typeof acl === "bigint" ? Number(acl) : acl;
	if (!handle) {
		return classifyAclProbe({ handle: 0, errno: symbols.errno(), firstEntry: null });
	}
	try {
		const entry = new BigUint64Array(1);
		if (!symbols.resetErrno()) return "unproven";
		const result = symbols.aclGetEntry(acl, ACL_FIRST_ENTRY, entry);
		return classifyAclProbe({ handle, errno: symbols.errno(), firstEntry: result });
	} catch {
		return "unproven";
	} finally {
		try {
			symbols.aclFree(acl);
		} catch {
			// Nothing to recover; the allocation is owned by the platform call above.
		}
	}
}

/**
 * Classify a trusted ancestor's ACL: absent, the single approved deny-delete ACE, or
 * fail closed.
 *
 * @param {number} fd
 * @returns {"absent" | "approved-single-deny-delete" | "not-allowlisted" | "unproven"}
 */
export function inspectAncestorAclOnDescriptor(fd) {
	const classification = inspectAclOnDescriptor(fd);
	if (classification === "absent") return "absent";
	if (classification === "unproven") return "unproven";
	const symbols = aclSymbols();
	if (symbols === null) return "unproven";
	let acl;
	try {
		if (!symbols.resetErrno()) return "unproven";
		acl = symbols.aclGetFd(fd);
	} catch {
		return "unproven";
	}
	const handle = typeof acl === "bigint" ? Number(acl) : acl;
	if (!handle) return "unproven";
	try {
		if (symbols.aclValid(acl) !== 0) return "unproven";

		// 1. Authoritative completeness: the bounded external representation carries the
		//    exact entry count, the whole ACL header flag field and each entry's whole
		//    flag and rights fields.
		if (!symbols.resetErrno()) return "unproven";
		const size = symbols.aclSize(acl);
		if (!Number.isInteger(size) || size <= 0 || size > 1 << 20) return "unproven";
		const buffer = new Uint8Array(size);
		if (!symbols.resetErrno()) return "unproven";
		const copied = symbols.aclCopyExtNative(buffer, acl, size);
		if (copied !== size) return "unproven";
		const decision = classifyAclRepresentation(parseAclRepresentation(buffer));
		if (decision !== "approved-single-deny-delete") return decision;

		// 2. Independent cardinality cross-check on the live ACL. Each failable call
		//    resets errno immediately before and captures it immediately after, before
		//    any other FFI call or free, so a stale value can never stand in for a real
		//    one. `-1` alone proves nothing: the terminator must also report the expected
		//    errno, and FIRST and LAST must be the very same entry.
		const firstOut = new BigUint64Array(1);
		if (!symbols.resetErrno()) return "unproven";
		const first = symbols.aclGetEntry(acl, ACL_FIRST_ENTRY, firstOut);
		const firstErrno = symbols.errno();
		if (first !== 0 || firstErrno === null) return "unproven";
		const firstEntry = symbols.readPointer(firstOut);
		if (!firstEntry) return "unproven";

		const lastOut = new BigUint64Array(1);
		if (!symbols.resetErrno()) return "unproven";
		const last = symbols.aclGetEntry(acl, ACL_LAST_ENTRY, lastOut);
		const lastErrno = symbols.errno();
		if (last !== 0 || lastErrno === null) return "unproven";
		const lastEntry = symbols.readPointer(lastOut);
		if (!lastEntry || lastEntry !== firstEntry) return "unproven";

		const nextOut = new BigUint64Array(1);
		if (!symbols.resetErrno()) return "unproven";
		const next = symbols.aclGetEntry(acl, ACL_NEXT_ENTRY, nextOut);
		const nextErrno = symbols.errno();
		if (next === 0) return "not-allowlisted";
		if (next !== -1 || nextErrno !== ACL_ERRNO_END_OF_ITERATION) return "unproven";

		// 3. Full permission mask from the platform's own mask getter, as a second,
		//    independent statement that nothing but DELETE is granted or denied.
		const maskOut = new BigUint64Array(1);
		if (!symbols.resetErrno()) return "unproven";
		const maskResult = symbols.aclGetPermsetMask(firstEntry, maskOut);
		const maskErrno = symbols.errno();
		if (maskResult !== 0 || maskErrno === null) return "unproven";
		if (maskOut[0] !== BigInt(KAUTH_VNODE_DELETE_ONLY)) return "not-allowlisted";

		return "approved-single-deny-delete";
	} catch {
		return "unproven";
	} finally {
		try {
			symbols.aclFree(acl);
		} catch {
			// The allocation belongs to the call above; nothing else to release.
		}
	}
}

/**
 * Classify the extended ACL of a path component without following symlinks.
 *
 * @param {string} target
 * @param {boolean} isDirectory
 * @returns {"absent" | "present" | "unproven"}
 */
function inspectAclOnPath(target, isDirectory) {
	let fd = -1;
	try {
		const flags =
			fs.constants.O_RDONLY |
			(fs.constants.O_NOFOLLOW ?? 0) |
			(isDirectory ? (fs.constants.O_DIRECTORY ?? 0) : 0);
		fd = fs.openSync(target, flags);
		return inspectAclOnDescriptor(fd);
	} catch {
		return "unproven";
	} finally {
		if (fd >= 0) closeDescriptor(fd);
	}
}

/**
 * Admission for one component of the artifact path.
 *
 * Ownership matters as much as the permission bits: a directory owned by another
 * account can be rewritten by that account whatever its mode says, so only the
 * current user or root may own any component. Group/other write is refused, and a
 * symlink anywhere on the path is refused because it can be repointed.
 *
 * @param {{ uid: number; gid: number; mode: number; isSymbolicLink: boolean; isDirectory: boolean }} component
 * @param {number} euid
 * @returns {boolean}
 */
export function namespaceComponentAdmitted(component, euid) {
	if (component.isSymbolicLink) return false;
	if (component.uid !== euid && component.uid !== 0) return false;
	if ((component.mode & 0o022) !== 0) return false;
	return component.isDirectory;
}

/**
 * Prove the namespace that leads to the artifact: a regular-file leaf, and every
 * ancestor owned by the current user or root with no ambient write and no symlink.
 *
 * @param {string} file
 * @returns {boolean}
 */
function trustedNamespace(file) {
	// Read-only inspection through the OS stat and ACL interfaces only.
	//
	// The artifact file and its own directory -- the artifact namespace ANCHOR, which is
	// a different path from `agentDir` -- stay strict. Only trusted ancestors strictly
	// above the anchor may carry the approved single everyone DENY DELETE entry.
	const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
	if (euid < 0) return false;
	const anchor = nodePath.dirname(file);
	let current = file;
	for (;;) {
		const stat = fs.lstatSync(current);
		const component = {
			uid: stat.uid,
			gid: stat.gid,
			mode: stat.mode,
			isSymbolicLink: stat.isSymbolicLink(),
			isDirectory: current === file ? true : stat.isDirectory(),
		};
		if (current === file && !stat.isFile()) return false;
		if (!namespaceComponentAdmitted(component, euid)) return false;
		// An ACE can grant another account write access that `st_mode` never shows.
		const strict = current === file || current === anchor;
		if (strict) {
			if (inspectAclOnPath(current, current !== file) !== "absent") return false;
		} else if (!ancestorAclAdmitted(current)) {
			return false;
		}
		const parent = nodePath.dirname(current);
		if (parent === current) return true;
		current = parent;
	}
}

/**
 * Whether a trusted ancestor above the anchor is admissible: no ACL, or exactly one
 * validated non-inheriting everyone DENY DELETE entry.
 *
 * @param {string} directory
 * @returns {boolean}
 */
function ancestorAclAdmitted(directory) {
	let fd = -1;
	try {
		fd = fs.openSync(
			directory,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0),
		);
		const decision = inspectAncestorAclOnDescriptor(fd);
		return decision === "absent" || decision === "approved-single-deny-delete";
	} catch {
		return false;
	} finally {
		if (fd >= 0) closeDescriptor(fd);
	}
}

/**
 * @param {number} fd
 * @returns {string}
 */
function digestOfDescriptor(fd) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	let position = 0;
	for (;;) {
		const read = fs.readSync(fd, buffer, 0, buffer.length, position);
		if (read <= 0) break;
		hash.update(buffer.subarray(0, read));
		position += read;
	}
	return hash.digest("hex");
}

/**
 * Live verification authority, keyed by an unguessable token. The descriptor never
 * leaves this module, and consuming an entry removes the authority: a handle is
 * single use, so a stale token can neither activate a recycled descriptor number
 * nor close a descriptor that now belongs to something else.
 *
 * @type {Map<string, { fd: number; file: string; identity: string }>}
 */
const verifiedArtifacts = new Map();

/**
 * @param {import("node:fs").Stats} stat
 * @returns {string}
 */
function identityOfStat(stat) {
	// Content- and authority-affecting fields only. `nlink` and `ctime` are
	// deliberately excluded: unlinking or renaming the PATH away leaves the verified
	// bytes untouched, and refusing that would break the pinned-descriptor guarantee
	// this loader exists to provide. A write to the bytes bumps `mtime`, and a
	// permission or ownership change shows up in `mode`/`uid`/`gid`.
	return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.uid, stat.gid, stat.mode]);
}

/**
 * Take the authority for a token, if any. The entry is removed, so every handle is
 * consumed exactly once.
 *
 * @param {unknown} handle
 * @returns {{ fd: number; file: string; identity: string } | null}
 */
function consumeHandle(handle) {
	if (typeof handle !== "object" || handle === null) return null;
	const token = /** @type {{ token?: unknown }} */ (handle).token;
	if (typeof token !== "string") return null;
	const entry = verifiedArtifacts.get(token);
	if (entry === undefined) return null;
	verifiedArtifacts.delete(token);
	return entry;
}

/**
 * Verify one artifact and retain the descriptor the verified bytes came from.
 *
 * The returned handle is opaque and single use: it carries no descriptor, and
 * either `activateVerifiedArtifact` or `closeVerifiedArtifact` consumes it.
 *
 * @param {string} file
 * @returns {{ ok: true, token: string } | { ok: false, reason: "unsupported" }}
 */
export function verifyDiagnosticArtifact(file) {
	const expectedDigest = trustedDigest();
	if (expectedDigest === null) return unsupported;
	let fd = -1;
	try {
		if (!trustedNamespace(file)) return unsupported;
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size === 0) return unsupported;
		if ((stat.mode & 0o022) !== 0) return unsupported;
		if (stat.uid !== process.geteuid?.() && stat.uid !== 0) return unsupported;
		if (inspectAclOnDescriptor(fd) !== "absent") return unsupported;
		if (digestOfDescriptor(fd) !== expectedDigest) return unsupported;
		const token = createHash("sha256")
			.update(`${file}:${randomUUID()}:${stat.ino}`)
			.digest("hex");
		verifiedArtifacts.set(token, { fd, file, identity: identityOfStat(fs.fstatSync(fd)) });
		fd = -1;
		return { ok: true, token };
	} catch {
		return unsupported;
	} finally {
		if (fd >= 0) closeDescriptor(fd);
	}
}

/**
 * @param {number} fd
 * @returns {void}
 */
function closeDescriptor(fd) {
	try {
		fs.closeSync(fd);
	} catch {
		// Nothing to recover: the descriptor is already gone.
	}
}

/**
 * Release a verified handle without activating it. Unknown, fabricated or already
 * consumed handles are ignored: they hold no authority and must not be able to
 * close a descriptor number that now belongs to something else.
 *
 * @param {unknown} handle
 * @returns {void}
 */
export function closeVerifiedArtifact(handle) {
	const entry = consumeHandle(handle);
	if (entry === null) return;
	closeDescriptor(entry.fd);
}

/**
 * Activate the verified bytes through their retained descriptor.
 *
 * The handle's authority is consumed first, so it cannot be replayed. Before the
 * descriptor is handed to the runtime loader its metadata is re-proved against the
 * snapshot taken during verification: any write that landed in between — including
 * a byte-identical rewrite, which leaves the digest intact — invalidates it.
 *
 * `process.dlopen` is given `/dev/fd/<fd>`, which on this runtime reopens the
 * descriptor's own vnode, so replacing the original pathname cannot redirect the
 * load. The descriptor is always closed before returning.
 *
 * @param {unknown} handle
 * @returns {{ ok: true, value: { openDiagnosticSnapshot: (agentDir: string, budgetMs: number) => unknown } } | { ok: false, reason: "unsupported" }}
 */
export function activateVerifiedArtifact(handle) {
	const entry = consumeHandle(handle);
	if (entry === null) return unsupported;
	try {
		if (typeof process.dlopen !== "function") return unsupported;
		if (identityOfStat(fs.fstatSync(entry.fd)) !== entry.identity) return unsupported;
		const module = { exports: {} };
		process.dlopen(module, `/dev/fd/${entry.fd}`);
		const binding = module.exports;
		if (!validateDiagnosticBinding(binding, packageManifest.version)) return unsupported;
		return {
			ok: true,
			value: {
				openDiagnosticSnapshot: (agentDir, budgetMs) => binding[DIAGNOSTIC_EXPORT](agentDir, budgetMs),
			},
		};
	} catch {
		return unsupported;
	} finally {
		closeDescriptor(entry.fd);
	}
}

/**
 * Accept a loaded binding only when it carries the diagnostic entry point AND
 * reports this package's exact build version. This is a consistency check on top
 * of the trusted-digest proof, never the trust anchor itself.
 *
 * @param {unknown} binding
 * @param {string} expectedVersion
 * @returns {boolean}
 */
export function validateDiagnosticBinding(binding, expectedVersion) {
	if (typeof binding !== "object" || binding === null) return false;
	const candidate = /** @type {Record<string, unknown>} */ (binding);
	if (typeof candidate[DIAGNOSTIC_EXPORT] !== "function") return false;
	if (typeof candidate.nativeBuildInfo !== "function") return false;
	try {
		const info = /** @type {() => { version?: unknown }} */ (candidate.nativeBuildInfo)();
		return info?.version === expectedVersion;
	} catch {
		return false;
	}
}

/**
 * Load the read-only diagnostic native entry point.
 *
 * @param {{ platform?: string; arch?: string; bunVersion?: string }} [runtimeOverride] optional
 *   additional runtime assertion; it can only narrow admission.
 * @returns {{ ok: true, value: { openDiagnosticSnapshot: (agentDir: string, budgetMs: number) => unknown } } | { ok: false, reason: "unsupported" }}
 */
export function loadDiagnosticNativeReadOnly(runtimeOverride) {
	const actualRuntime = {
		platform: process.platform,
		arch: process.arch,
		bunVersion: typeof Bun === "undefined" ? undefined : Bun.version,
	};
	// The decision always uses the ACTUAL runtime; an optional descriptor can only
	// narrow admission further (tests inject unsupported tuples), never widen it.
	if (!supportedRuntime(actualRuntime)) return unsupported;
	if (runtimeOverride !== undefined && !supportedRuntime(runtimeOverride)) return unsupported;
	try {
		const require = createRequire(import.meta.url);
		const layout = selectArtifactLayout(require);
		if (layout === null) return unsupported;
		const verified = verifyDiagnosticArtifact(layout);
		if (!verified.ok) return unsupported;
		return activateVerifiedArtifact(verified);
	} catch {
		return unsupported;
	}
}
