import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import {
	classifyManagedTreePayloadRetirement,
	ManagedSessionDescendantStore,
	ManagedTreeRemovalError,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";

const roots: string[] = [];
const stores: ManagedSessionDescendantStore[] = [];
afterEach(() => {
	delete ManagedTreeRemovalTestHooks.afterNativeRemoval;
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name = "tree") {
	const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-removal-evidence-")));
	roots.push(temporary);
	const root = path.join(temporary, "store");
	fs.mkdirSync(root, { mode: 0o700 });
	const policy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const authority = prepareManagedDirectoryRoot(root, policy);
	const store = new ManagedSessionDescendantStore(authority, root, undefined, policy, root, authority);
	stores.push(store);
	store.ensureDirectory(name);
	fs.writeFileSync(path.join(root, name, "payload"), "owned secret bytes", { mode: 0o600 });
	return { temporary, root, store, name, target: path.join(root, name), expected: store.captureTree(name) };
}

function caught(action: () => void): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected removal failure");
}

// Darwin uses direct POSIX scrub; Linux stores auto-acquire retained recovery authority,
// whose different contract does not scrub payloads. Windows uses handle-bound deletion.
const directPosix = process.platform === "darwin";
describe("managed tree removal evidence", () => {
	it.skipIf(!directPosix)("preserves actual durable scrub evidence without claiming physical deletion", () => {
		const f = fixture();
		let observed: ManagedTreeRemovalOutcome | undefined;
		ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
			observed = outcome;
		};
		const error = caught(() => f.store.removeTreeExpected(f.name, f.expected));
		expect(error).toBeInstanceOf(ManagedTreeRemovalError);
		if (!(error instanceof ManagedTreeRemovalError)) throw error;
		expect(error.outcome).toBe(observed);
		expect(error.expected).toBe(f.expected);
		expect(error.targetPath).toBe(f.target);
		expect(error.phase).toBe("native_returned");
		expect(error.message).toBe("cleanup_pending");
		expect(error.outcome?.result.ok).toBe(false);
		const retirement = classifyManagedTreePayloadRetirement(error);
		expect(retirement?.kind).toBe("payload_retired");
		expect(retirement?.detachedPath).toBe(`${f.target}.removing`);
		expect(retirement?.retainedPlaceholderPath).toBeUndefined();
		expect(fs.existsSync(f.target)).toBe(false);
		expect(fs.statSync(`${f.target}.removing`).isDirectory()).toBe(true);
		expect(fs.readFileSync(path.join(`${f.target}.removing`, "payload")).length).toBe(0);
	});

	it.skipIf(!directPosix)("matches actual bounded-component and already-detached native destinations", () => {
		for (const name of ["x".repeat(250), "already.removing"]) {
			const f = fixture(name);
			const error = caught(() => f.store.removeTreeExpected(name, f.expected));
			const retirement = classifyManagedTreePayloadRetirement(error);
			expect(retirement).toBeDefined();
			if (!retirement) throw error;
			expect(fs.statSync(retirement.detachedPath).isDirectory()).toBe(true);
			expect(fs.readFileSync(path.join(retirement.detachedPath, "payload")).length).toBe(0);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"preserves actual retained recovery evidence without certifying payload retirement",
		() => {
			const f = fixture();
			const error = caught(() => f.store.removeTreeExpected(f.name, f.expected));
			if (!(error instanceof ManagedTreeRemovalError)) throw error;
			expect(error.outcome?.route).toBe("retained");
			if (error.outcome?.route !== "retained") throw new Error("expected retained native outcome");
			const result = error.outcome.result;
			expect(result.ok).toBe(false);
			expect(result.recoveryPath).toBeDefined();
			expect(result.treeSnapshot).toBeDefined();
			expect(classifyManagedTreePayloadRetirement(error)).toBeUndefined();
			expect(fs.existsSync(f.target)).toBe(false);
			if (!result.recoveryPath) throw new Error("missing native recovery evidence");
			expect(fs.readFileSync(path.join(f.root, result.recoveryPath, "payload"), "utf8")).toBe("owned secret bytes");
		},
	);

	it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"returns the original parent-bound exact non-ok result without converting it to an error",
		() => {
			const f = fixture();
			const parent = fs.lstatSync(f.root, { bigint: true });
			const directory = fs.lstatSync(f.target, { bigint: true });
			const payload = fs.lstatSync(path.join(f.target, "payload"), { bigint: true });
			let observed: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterNativeRemoval = (target, outcome) => {
				expect(target).toBe(f.target);
				observed = outcome;
			};
			const result = f.store.removeTreeExpectedWithParentIdentity(f.name, f.expected, parent);
			if (observed?.route !== "exact") throw new Error("expected exact native outcome");
			expect(result).toBe(observed.result);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("cleanup_pending");
			expect(result.payloadDurable).toBe(true);
			if (!result.detachedPath) throw new Error("missing exact native detached path");
			expect(fs.existsSync(f.target)).toBe(false);
			const retained = fs.lstatSync(result.detachedPath, { bigint: true });
			expect([retained.dev, retained.ino]).toEqual([directory.dev, directory.ino]);
			const retainedPayload = fs.lstatSync(path.join(result.detachedPath, "payload"), { bigint: true });
			expect([retainedPayload.dev, retainedPayload.ino]).toEqual([payload.dev, payload.ino]);
			expect(fs.readFileSync(path.join(result.detachedPath, "payload"))).toEqual(Buffer.alloc(0));
		},
	);

	it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"preserves parent-bound exact evidence without certification after actual root replacement",
		() => {
			const f = fixture();
			const parent = fs.lstatSync(f.root, { bigint: true });
			const directory = fs.lstatSync(f.target, { bigint: true });
			const payload = fs.lstatSync(path.join(f.target, "payload"), { bigint: true });
			const displaced = path.join(f.temporary, "displaced");
			let observed: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterNativeRemoval = (target, outcome) => {
				expect(target).toBe(f.target);
				observed = outcome;
				fs.renameSync(f.root, displaced);
				fs.mkdirSync(f.root, { mode: 0o700 });
			};
			const error = caught(() => f.store.removeTreeExpectedWithParentIdentity(f.name, f.expected, parent));
			expect(error).toBeInstanceOf(ManagedTreeRemovalError);
			if (!(error instanceof ManagedTreeRemovalError)) throw error;
			expect(error.phase).toBe("post_effect_authority_check");
			expect(error.targetPath).toBe(f.target);
			expect(error.expected).toBe(f.expected);
			expect(error.outcome).toBe(observed);
			expect(error.outcome?.route).toBe("exact");
			expect(error.outcome?.result.ok).toBe(false);
			expect(error.outcome?.result.code).toBe("cleanup_pending");
			if (error.outcome?.route !== "exact") throw new Error("expected exact native outcome");
			expect(error.outcome.result.payloadDurable).toBe(true);
			expect(error.authorityCheckFailure).toBeInstanceOf(Error);
			expect(error.cause).toBe(error.authorityCheckFailure);
			expect(classifyManagedTreePayloadRetirement(error)).toBeUndefined();
			if (observed?.route !== "exact" || !observed.result.detachedPath)
				throw new Error("missing exact native detached path");
			const retainedPath = path.join(displaced, path.relative(f.root, observed.result.detachedPath));
			const retained = fs.lstatSync(retainedPath, { bigint: true });
			expect([retained.dev, retained.ino]).toEqual([directory.dev, directory.ino]);
			const retainedPayload = fs.lstatSync(path.join(retainedPath, "payload"), { bigint: true });
			expect([retainedPayload.dev, retainedPayload.ino]).toEqual([payload.dev, payload.ino]);
			expect(fs.readFileSync(path.join(retainedPath, "payload"))).toEqual(Buffer.alloc(0));
			const displacedRoot = fs.lstatSync(displaced, { bigint: true });
			expect([displacedRoot.dev, displacedRoot.ino]).toEqual([parent.dev, parent.ino]);
			const replacementRoot = fs.lstatSync(f.root, { bigint: true });
			expect([replacementRoot.dev, replacementRoot.ino]).not.toEqual([parent.dev, parent.ino]);
			expect(fs.readdirSync(f.root)).toEqual([]);
		},
	);

	it("rejects incomplete, foreign and ambiguous certificates and reports placeholders separately", () => {
		const f = fixture();
		const certified: NativeExactUnlinkResult = {
			ok: false,
			code: "cleanup_pending",
			payloadDurable: true,
			detachedPath: `${f.target}.removing`,
		};
		const wrap = (result: NativeExactUnlinkResult) =>
			new ManagedTreeRemovalError(f.target, f.expected, "native_returned", { route: "exact", result });
		for (const patch of [
			{ payloadDurable: undefined },
			{ payloadDurable: false },
			{ detachedPath: undefined },
			{ detachedPath: `${f.target}.foreign` },
			{ retainedSuccessorPath: "successor" },
			{ retainedUnknownPath: "unknown" },
			{ code: "identity_mismatch" },
			{ ok: true },
		])
			expect(classifyManagedTreePayloadRetirement(wrap({ ...certified, ...patch }))).toBeUndefined();
		expect(classifyManagedTreePayloadRetirement(new Error("cleanup_pending"))).toBeUndefined();
		const placeholder = `${f.root}/placeholder`;
		expect(
			classifyManagedTreePayloadRetirement(wrap({ ...certified, retainedPlaceholderPath: placeholder }))
				?.retainedPlaceholderPath,
		).toBe(placeholder);
		const retained = {
			ok: false,
			code: "cleanup_pending",
			recoveryPath: certified.detachedPath,
			treeSnapshot: f.expected,
		};
		const retainedError = new ManagedTreeRemovalError(f.target, f.expected, "native_returned", {
			route: "retained",
			result: retained,
		});
		expect(retainedError.outcome?.result).toBe(retained);
		expect(classifyManagedTreePayloadRetirement(retainedError)).toBeUndefined();
	});

	it.skipIf(!directPosix)("retains actual native evidence when post-effect authority binding changes", () => {
		const f = fixture();
		let observed: ManagedTreeRemovalOutcome | undefined;
		const displaced = path.join(f.temporary, "displaced");
		ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
			observed = outcome;
			fs.renameSync(f.root, displaced);
			fs.mkdirSync(f.root, { mode: 0o700 });
		};
		const error = caught(() => f.store.removeTreeExpected(f.name, f.expected));
		if (!(error instanceof ManagedTreeRemovalError)) throw error;
		expect(error.phase).toBe("post_effect_authority_check");
		expect(error.outcome).toBe(observed);
		expect(error.outcome?.result.code).toBe("cleanup_pending");
		expect(error.authorityCheckFailure).toBeInstanceOf(Error);
		expect(error.cause).toBe(error.authorityCheckFailure);
		expect(classifyManagedTreePayloadRetirement(error)).toBeUndefined();
		expect(fs.readFileSync(path.join(displaced, "tree.removing", "payload")).length).toBe(0);
	});

	it("keeps pre-effect binding failures outside removal evidence", () => {
		const f = fixture();
		fs.renameSync(f.root, path.join(f.temporary, "displaced"));
		fs.mkdirSync(f.root, { mode: 0o700 });
		let nativeCalled = false;
		ManagedTreeRemovalTestHooks.afterNativeRemoval = () => {
			nativeCalled = true;
		};
		const error = caught(() => f.store.removeTreeExpected(f.name, f.expected));
		expect(error).not.toBeInstanceOf(ManagedTreeRemovalError);
		expect(nativeCalled).toBe(false);
		expect(fs.readFileSync(path.join(f.temporary, "displaced", f.name, "payload"), "utf8")).toBe(
			"owned secret bytes",
		);
	});

	it.skipIf(process.platform !== "win32")(
		"returns actual physical native success without inventing retained paths",
		() => {
			const f = fixture();
			let observed: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
				observed = outcome;
			};
			f.store.removeTreeExpected(f.name, f.expected);
			expect(observed?.route).toBe("exact");
			expect(observed?.result.ok).toBe(true);
			if (observed?.route !== "exact") throw new Error("expected direct native outcome");
			expect(observed.result.detachedPath).toBeUndefined();
			expect(fs.existsSync(f.target)).toBe(false);
			expect(fs.existsSync(`${f.target}.removing`)).toBe(false);
		},
	);
});
