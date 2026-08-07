import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";

export interface PathIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
}

export interface IdentityReference {
	readonly dev: bigint;
	readonly ino: bigint;
}

export interface ComponentPin extends IdentityReference {
	readonly name: string;
	readonly absolutePath: string;
}

export interface RootPin extends IdentityReference {
	readonly canonicalPath: string;
	readonly components: readonly ComponentPin[];
}

export interface ContainedPath {
	readonly root: RootPin;
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly parentPath: string;
	readonly components: readonly ComponentPin[];
	readonly leafIdentity: PathIdentity | null;
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9][0-9]*|lpt[1-9][0-9]*)(?:\..*)?$/i;
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}

function identityFromStat(stat: fs.BigIntStats): PathIdentity {
	return Object.freeze({
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
	});
}

function sameIdentity(left: IdentityReference, right: IdentityReference): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isSafeExistingDirectory(stat: fs.BigIntStats): boolean {
	return stat.isDirectory() && !stat.isSymbolicLink();
}

function hasWritableAncestorWithoutStickyBit(canonicalPath: string): boolean {
	let current = path.dirname(canonicalPath);
	for (;;) {
		const stat = fs.lstatSync(current, { bigint: true });
		const mode = stat.mode & 0o7777n;
		if ((mode & 0o22n) !== 0n && (mode & 0o1000n) === 0n) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function hasExpectedOwner(stat: fs.BigIntStats): boolean {
	if (process.platform === "win32") return true;
	const getuid = process.getuid;
	if (typeof getuid !== "function") return false;
	const owner = stat.uid;
	if (typeof owner !== "bigint" && typeof owner !== "number") return false;
	return BigInt(owner) === BigInt(getuid());
}

function validateRootPath(root: unknown): MemoryResult<string> {
	if (typeof root !== "string" || root.length === 0) return invalidInput("memory root must be a non-empty path");
	if (!path.isAbsolute(root) || root.includes("\u0000")) {
		return invalidInput("memory root must be an absolute path without NUL");
	}
	return { ok: true, value: path.resolve(root) };
}

function validPercentEncoding(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "%") continue;
		if (
			index + 2 >= value.length ||
			!HEX_DIGIT.test(value[index + 1] ?? "") ||
			!HEX_DIGIT.test(value[index + 2] ?? "")
		) {
			return false;
		}
		index += 2;
	}
	return true;
}

function containsEncodedTraversal(value: string): boolean {
	if (!validPercentEncoding(value)) return true;
	let decoded = value;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (decoded.includes("\u0000") || decoded.includes("\\")) return true;
		const pieces = decoded.split("/");
		if (pieces.some(piece => piece === "." || piece === "..")) return true;
		if (!decoded.includes("%")) return false;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return false;
			if (next.includes("/") || next.includes("\\")) return true;
			decoded = next;
		} catch {
			return true;
		}
	}
	return true;
}

function validateRelativePath(value: unknown): MemoryResult<string> {
	if (typeof value !== "string") return invalidInput("relative path must be a string");
	if (value.includes("\u0000") || value.includes("\\")) {
		return policyDenied("relative path contains an unsafe separator");
	}
	if (containsEncodedTraversal(value)) return policyDenied("relative path contains encoded traversal");
	const normalized = value.normalize("NFC");
	if (normalized === "" || normalized === ".") return { ok: true, value: "" };
	if (isAbsolutePath(normalized)) return policyDenied("relative path is absolute");
	const components = normalized.split("/");
	if (components.some(component => component.length === 0))
		return policyDenied("relative path contains an empty component");
	for (const component of components) {
		if (component === "." || component === "..") return policyDenied("relative path contains traversal");
		if (WINDOWS_DEVICE_NAME.test(component)) return policyDenied("relative path contains a reserved device name");
		if (/[. ]$/.test(component)) return policyDenied("relative path contains a trailing dot or space");
		for (const character of component) {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined || codePoint < 0x20 || character === ":") {
				return policyDenied("relative path contains a control character");
			}
		}
	}
	return { ok: true, value: components.join("/") };
}

function validateRootPinShape(root: unknown): root is RootPin {
	if (!isRecord(root)) return false;
	if (typeof root.canonicalPath !== "string" || !path.isAbsolute(root.canonicalPath)) return false;
	if (typeof root.dev !== "bigint" || typeof root.ino !== "bigint" || !Array.isArray(root.components)) return false;
	return root.components.every(component => {
		if (!isRecord(component)) return false;
		return (
			typeof component.name === "string" &&
			typeof component.absolutePath === "string" &&
			typeof component.dev === "bigint" &&
			typeof component.ino === "bigint"
		);
	});
}

function pinRootIdentity(canonicalPath: string): MemoryResult<RootPin> {
	try {
		const stat = fs.lstatSync(canonicalPath, { bigint: true });
		if (!isSafeExistingDirectory(stat) || !hasExpectedOwner(stat)) {
			return policyDenied("memory root security admission failed");
		}
		if ((stat.mode & 0o7777n) !== 0o700n || hasWritableAncestorWithoutStickyBit(canonicalPath)) {
			return policyDenied("memory root security admission failed");
		}
		return {
			ok: true,
			value: Object.freeze({
				canonicalPath,
				dev: stat.dev,
				ino: stat.ino,
				components: Object.freeze([]),
			}),
		};
	} catch {
		return policyDenied("memory root security admission failed");
	}
}

/** Canonicalize and pin an already-existing memory root without creating paths. */
export function pinMemoryRoot(root: unknown): MemoryResult<RootPin> {
	const validated = validateRootPath(root);
	if (!validated.ok) return validated;
	const configuredPath = validated.value;
	try {
		const configuredStat = fs.lstatSync(configuredPath, { bigint: true });
		if (!isSafeExistingDirectory(configuredStat)) return policyDenied("memory root is not a trusted directory");
		const canonicalPath = fs.realpathSync.native(configuredPath);
		return pinRootIdentity(canonicalPath);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
			return policyDenied("memory root is not available");
		}
		return policyDenied("memory root security admission failed");
	}
}

/** Re-check the admitted root identity before a filesystem operation. */
export function assertRootBinding(root: RootPin): MemoryResult<true> {
	if (!validateRootPinShape(root)) return policyDenied("memory root pin is malformed");
	try {
		const stat = fs.lstatSync(root.canonicalPath, { bigint: true });
		if (!isSafeExistingDirectory(stat) || !sameIdentity(stat, root) || !hasExpectedOwner(stat)) {
			return policyDenied("memory root binding changed");
		}
		return { ok: true, value: true };
	} catch {
		return policyDenied("memory root binding could not be verified");
	}
}

function componentPin(name: string, absolutePath: string, stat: fs.BigIntStats): ComponentPin {
	return Object.freeze({ name, absolutePath, dev: stat.dev, ino: stat.ino });
}

/** Resolve a normalized relative path under a previously admitted root. */
export function containPath(root: RootPin, relPath: string, allowMissingParents = false): MemoryResult<ContainedPath> {
	const rootBinding = assertRootBinding(root);
	if (!rootBinding.ok) return rootBinding;
	const validated = validateRelativePath(relPath);
	if (!validated.ok) return validated;
	const normalizedRelativePath = validated.value;
	const components = normalizedRelativePath.length === 0 ? [] : normalizedRelativePath.split("/");
	const parentComponents: ComponentPin[] = [];
	let parentPath = root.canonicalPath;
	try {
		for (const component of components.slice(0, -1)) {
			parentPath = path.join(parentPath, component);
			let stat: fs.BigIntStats | undefined;
			try {
				stat = fs.lstatSync(parentPath, { bigint: true });
			} catch (error) {
				if (errorCode(error) !== "ENOENT") return policyDenied("relative path containment could not be verified");
				try {
					// A concurrent authorized creator may materialize this exact parent
					// between the first lstat and the missing-parent decision. Re-check it
					// before treating the path as absent.
					stat = fs.lstatSync(parentPath, { bigint: true });
				} catch (recheckError) {
					if (errorCode(recheckError) === "ENOENT" && allowMissingParents) {
						return {
							ok: true,
							value: Object.freeze({
								root,
								relativePath: normalizedRelativePath,
								absolutePath: path.join(root.canonicalPath, ...components),
								parentPath,
								components: Object.freeze(parentComponents),
								leafIdentity: null,
							}),
						};
					}
					return policyDenied("relative path containment could not be verified");
				}
			}
			if (stat === undefined) return policyDenied("relative path containment could not be verified");
			if (!isSafeExistingDirectory(stat) || stat.dev !== root.dev) {
				return policyDenied("relative path contains an unsafe directory component");
			}
			parentComponents.push(componentPin(component, parentPath, stat));
		}
		const absolutePath = components.length === 0 ? root.canonicalPath : path.join(root.canonicalPath, ...components);
		const lexicalRelative = path.relative(root.canonicalPath, absolutePath);
		if (path.isAbsolute(lexicalRelative) || lexicalRelative.split(path.sep).includes("..")) {
			return policyDenied("relative path escapes the memory root");
		}
		let leafIdentity: PathIdentity | null = null;
		try {
			const leaf = fs.lstatSync(absolutePath, { bigint: true });
			if (leaf.isSymbolicLink() || leaf.dev !== root.dev) {
				return policyDenied("target path is not bound to the memory root");
			}
			if (leaf.isFile() && leaf.nlink > 1n) return policyDenied("target file has multiple hard links");
			leafIdentity = identityFromStat(leaf);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") return policyDenied("target path could not be inspected");
		}
		return {
			ok: true,
			value: Object.freeze({
				root,
				relativePath: normalizedRelativePath,
				absolutePath,
				parentPath,
				components: Object.freeze(parentComponents),
				leafIdentity,
			}),
		};
	} catch {
		return policyDenied("relative path containment could not be verified");
	}
}

/** Verify root, parent-component, and leaf identity after a publish or open. */
export function assertPathBinding(
	root: RootPin,
	contained: ContainedPath,
	expectedLeaf: IdentityReference,
): MemoryResult<true> {
	if (!validateRootPinShape(root) || !isRecord(contained)) return policyDenied("path binding state is malformed");
	const rootBinding = assertRootBinding(root);
	if (!rootBinding.ok) return rootBinding;
	const refreshed = containPath(root, contained.relativePath);
	if (!refreshed.ok) return refreshed;
	try {
		const real = fs.realpathSync.native(contained.absolutePath);
		const relative = path.relative(root.canonicalPath, real);
		if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
			return policyDenied("published path is outside the memory root");
		}
		const expectedComponents = contained.components;
		const currentComponents = refreshed.value.components;
		if (expectedComponents.length !== currentComponents.length) return policyDenied("path component binding changed");
		for (let index = 0; index < expectedComponents.length; index += 1) {
			if (
				expectedComponents[index].name !== currentComponents[index].name ||
				expectedComponents[index].absolutePath !== currentComponents[index].absolutePath ||
				!sameIdentity(expectedComponents[index], currentComponents[index])
			) {
				return policyDenied("path component binding changed");
			}
		}
		const leaf = fs.lstatSync(real, { bigint: true });
		if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1n || !sameIdentity(leaf, expectedLeaf)) {
			return policyDenied("published target binding changed");
		}
		return { ok: true, value: true };
	} catch {
		return policyDenied("published path binding could not be verified");
	}
}

export { validateRelativePath as validateSafeRelativePath };

export function validateSafePathComponent(value: unknown): MemoryResult<string> {
	if (typeof value !== "string" || value.length === 0 || value.includes("/")) {
		return policyDenied("path component is invalid");
	}
	const validated = validateRelativePath(value);
	if (!validated.ok || validated.value.length === 0 || validated.value.includes("/")) {
		return policyDenied("path component is invalid");
	}
	return validated;
}

export function isSafePathComponent(value: unknown): boolean {
	return validateSafePathComponent(value).ok;
}
