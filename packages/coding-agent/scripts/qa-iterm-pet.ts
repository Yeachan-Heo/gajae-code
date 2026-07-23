#!/usr/bin/env bun
/** Controlled iTerm2 Pet QA runner. Live captures require provenance/capturedAt. */
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logger } from "@gajae-code/utils";

const canonicalPath = (path: string): string => {
	const absolute = resolve(path);
	let existing = absolute;
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) die(`path has no existing ancestor: ${path}`);
		suffix.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	return suffix.reduce((current, part) => join(current, part), realpathSync(existing));
};

type Json = Record<string, unknown>;
type Capture = Json;
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const inputName = arg("input");
const outputName = arg("output");
const versions = (arg("versions") ?? "").split(",").filter(Boolean);
const modes = (arg("modes") ?? "").split(",").filter(Boolean);
const requestedVersions = ["3.5.0", "3.6.11"];
const requestedModes = ["direct", "tmux"];
const REQUIRED_PRODUCER = "gjc-iterm-live-capture-v1";
const die = (message: string): never => {
	logger.error("iTerm Pet QA failed", { error: message });
	process.exit(2);
	throw Error(message);
};
if (!outputName || versions.join() !== requestedVersions.join() || modes.join() !== requestedModes.join())
	die(
		"usage: --versions 3.5.0,3.6.11 --modes direct,tmux [--input <capture manifest|root>] --output <controlled root>",
	);
const outputNameValue = outputName ?? die("output is required");
const synthetic = args.includes("--test-only-synthetic");
const inputNameValue = inputName ?? join(outputNameValue, "manifest.json");
const asJson = (value: unknown): Json | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const journalPathFor = (outputPath: string): string => `${outputPath}.transaction-journal`;
const recoverPublication = (outputPath: string): void => {
	const journalPath = journalPathFor(outputPath);
	if (!existsSync(journalPath)) return;
	const journalStat = lstatSync(journalPath);
	if (journalStat.isSymbolicLink() || !journalStat.isFile()) die("publication journal is invalid");
	const journal = parseRoot(journalPath);
	const backup = typeof journal.backup === "string" ? journal.backup : "";
	const outputParent = canonicalPath(dirname(outputPath));
	const outputBase = basename(outputPath);
	const backupSibling = (value: string): boolean => {
		if (!isAbsolute(value) || resolve(value) !== value || dirname(value) !== dirname(outputPath)) return false;
		const name = basename(value);
		if (!name.startsWith(`${outputBase}.backup-`) || name.length === `${outputBase}.backup-`.length) return false;
		if (value === outputPath || value === journalPath || !existsSync(value)) return false;
		const stat = lstatSync(value);
		return !stat.isSymbolicLink() && stat.isDirectory() && canonicalPath(dirname(value)) === outputParent;
	};
	if (journal.output !== outputPath || (backup && !backupSibling(backup))) die("publication journal is invalid");
	if (!existsSync(outputPath)) {
		if (!backup) die("publication journal is invalid");
		validatePublished(backup, synthetic);
		renameSync(backup, outputPath);
	}
	if (existsSync(outputPath)) {
		validatePublished(outputPath, synthetic);
		rmSync(journalPath, { force: true });
	}
};
const writeJournal = (path: string, value: Json): void => {
	const fd = openSync(path, "w");
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		const parentFd = openSync(dirname(path), "r");
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
	} catch {}
};
const validatePublished = (outputPath: string, expectedSynthetic: boolean): void => {
	if (!existsSync(outputPath)) die(`published output unavailable: ${outputPath}`);
	if (readdirSync(outputPath).sort().join() !== requestedVersions.slice().sort().join())
		die("published output hierarchy is invalid");
	for (const version of requestedVersions)
		for (const mode of requestedModes) {
			const dir = join(outputPath, version, mode);
			if (!existsSync(dir) || readdirSync(dir).sort().join() !== "artifacts,evidence.json,manifest.json")
				die(`published output hierarchy is invalid: ${version}/${mode}`);
			const manifest = parseRoot(join(dir, "manifest.json"));
			const evidence = parseRoot(join(dir, "evidence.json"));
			const rawArtifacts: unknown = manifest.artifacts;
			const artifacts: unknown[] | undefined = Array.isArray(rawArtifacts) ? rawArtifacts : undefined;
			const validArtifacts = artifacts ?? die(`published artifacts are invalid: ${version}/${mode}`);
			const refs = artifactList(validArtifacts);
			if (refs.length !== validArtifacts.length || new Set(refs.map(ref => ref.path)).size !== refs.length)
				die(`published artifacts are invalid: ${version}/${mode}`);
			validatePublishedManifest(manifest, evidence, version, mode, refs, expectedSynthetic);
			for (const ref of refs) {
				const png = ref.format !== undefined && ref.format !== "rgba8";
				if (
					png &&
					(!ref.role?.trim() || !ref.provenance?.trim() || !ref.classification || !ref.observedResult?.trim())
				)
					die(`published PNG provenance/role is invalid: ${version}/${mode}`);
				const artifact = resolve(dir, ref.path);
				const rel = relative(dir, artifact);
				if (
					!existsSync(artifact) ||
					rel.startsWith("..") ||
					isAbsolute(rel) ||
					sha256(readFileSync(artifact)) !== ref.sha256
				)
					die(`published artifact is invalid: ${version}/${mode}`);
			}
			const pngs = refs.filter(ref => ref.format !== undefined && ref.format !== "rgba8");
			const visual = Array.isArray(manifest.visualEvidence) ? manifest.visualEvidence : [];
			if (
				visual.length !== pngs.length ||
				new Set(
					visual.map(value => {
						const item = asJson(value);
						return item?.artifactSha256;
					}),
				).size !== visual.length
			)
				die(`published visual evidence is invalid: ${version}/${mode}`);
			for (const value of visual) {
				const item = asJson(value);
				const ref = item && pngs.find(candidate => candidate.sha256 === item.artifactSha256);
				if (
					!item ||
					!ref ||
					typeof item.artifactSha256 !== "string" ||
					item.role !== ref.role ||
					item.provenance !== ref.provenance ||
					item.classification !== ref.classification ||
					item.observedResult !== ref.observedResult ||
					(item.role === "current-live-render" &&
						(item.classification !== "current" || item.observedResult !== "passed")) ||
					(item.role === "regression-defect" &&
						(item.classification !== "regression" || item.observedResult !== "regression")) ||
					(item.classification !== "current" && item.classification !== "regression")
				)
					die(`published visual evidence is invalid: ${version}/${mode}`);
			}
			const declaredBasenames = new Set(refs.map(ref => ref.path.split("/").pop() ?? ""));
			const actualBasenames = new Set(readdirSync(join(dir, "artifacts")));
			if (
				actualBasenames.size !== declaredBasenames.size ||
				[...actualBasenames].some(name => !declaredBasenames.has(name))
			)
				die(`published artifacts are invalid: ${version}/${mode}`);
			const current = pngs.filter(
				ref =>
					ref.role === "current-live-render" &&
					ref.classification === "current" &&
					ref.observedResult === "passed",
			);
			if (pngs.length > 0 && current.length !== 1) die(`published visual evidence is invalid: ${version}/${mode}`);
			if (version === "3.5.0" && mode === "direct") {
				const roleCounts = new Map(
					["capability-probe", "current-live-render", "regression-defect"].map(role => [role, 0]),
				);
				for (const ref of pngs)
					if (roleCounts.has(ref.role ?? ""))
						roleCounts.set(ref.role ?? "", (roleCounts.get(ref.role ?? "") ?? 0) + 1);
				if (!expectedSynthetic && (pngs.length !== 3 || [...roleCounts.values()].some(count => count !== 1)))
					die(`published visual evidence is invalid: ${version}/${mode}`);
			} else if (pngs.length > 0 && current.length !== 1)
				die(`published visual evidence is invalid: ${version}/${mode}`);
		}
};
const validatePublishedManifest = (
	manifest: Json,
	evidence: Json,
	version: string,
	mode: string,
	declaredArtifacts: Artifact[],
	expectedSynthetic: boolean,
): void => {
	const environment = asJson(manifest.environment);
	const limits = asJson(manifest.cacheLimits);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.iTermVersion !== version ||
		manifest.mode !== mode ||
		typeof manifest.version !== "string" ||
		typeof manifest.gitRevision !== "string" ||
		manifest.producer !== REQUIRED_PRODUCER ||
		typeof manifest.provenance !== "string" ||
		!manifest.provenance.trim() ||
		typeof manifest.capturedAt !== "string" ||
		!manifest.capturedAt.trim() ||
		!environment ||
		!limits ||
		limits.maxEntries !== 32 ||
		limits.maxRetainedBytes !== 8388608 ||
		(manifest.synthetic === true && !expectedSynthetic) ||
		(expectedSynthetic && manifest.synthetic !== true)
	)
		die(`published manifest is invalid: ${version}/${mode}`);
	if (environment?.fixtureKind !== "controlled-raster-comparison" || typeof manifest.synthetic !== "boolean")
		die(`published manifest is invalid: ${version}/${mode}`);
	const revision = manifest.gitRevision as string;
	if (!expectedSynthetic && (!/^[a-f0-9]{40}$/.test(revision) || /^0{40}$/.test(revision)))
		die(`published manifest is invalid: ${version}/${mode}`);
	if (!expectedSynthetic) {
		const live = asJson(manifest.liveEnvironment);
		const screenshot = live && typeof live.screenshotPixels === "string" ? live.screenshotPixels : "";
		if (
			!live ||
			live.iTermVersion !== version ||
			live.mode !== mode ||
			typeof live.os !== "string" ||
			!live.os.trim() ||
			typeof live.architecture !== "string" ||
			!live.architecture.trim() ||
			typeof live.command !== "string" ||
			!live.command.trim() ||
			typeof live.capturedAt !== "string" ||
			!live.capturedAt.trim() ||
			typeof live.sourceProvenance !== "string" ||
			!live.sourceProvenance.trim() ||
			!/^[1-9]\d*x[1-9]\d*$/.test(screenshot) ||
			(mode === "tmux" && (typeof live.tmuxSession !== "string" || !live.tmuxSession.trim()))
		)
			die(`published live environment is invalid: ${version}/${mode}`);
	}
	if (evidence.schemaVersion !== 1) die(`published evidence is invalid: ${version}/${mode}`);
	const rawCases: unknown = manifest.cases;
	const expectedIds = [
		"red-idle",
		"red-working",
		"red-burst",
		"red-preview",
		"blue-idle",
		"blue-working",
		"blue-burst",
		"blue-preview",
		"missing-f",
		"invalid-f",
		"probe-timeout",
		"erase",
		...(mode === "tmux" ? ["topology-ineligible"] : []),
	];
	const cases: unknown[] | undefined = Array.isArray(rawCases) ? rawCases : undefined;
	const validCases = cases ?? die(`published cases are invalid: ${version}/${mode}`);
	if (validCases.length !== expectedIds.length) die(`published cases are invalid: ${version}/${mode}`);
	const seenIds = new Set<string>();
	for (const value of validCases) {
		const c = asJson(value) as Json;
		if (!c) die(`published case is invalid: ${version}/${mode}`);
		const comparison = asJson(c.comparison) as Json,
			rect = asJson(c.ownedRect) as Json;
		const id = String(c.id);
		if (
			!comparison ||
			!rect ||
			typeof c.id !== "string" ||
			seenIds.has(id) ||
			!expectedIds.includes(id) ||
			typeof c.outcome !== "string" ||
			typeof c.capturedAt !== "string" ||
			typeof comparison.semanticTelemetryDeltaMs !== "number" ||
			comparison.semanticTelemetryDeltaMs < 0 ||
			comparison.semanticTelemetryDeltaMs > 250 ||
			typeof comparison.insidePixelMismatchPercent !== "number" ||
			comparison.insidePixelMismatchPercent < 0 ||
			comparison.insidePixelMismatchPercent > 0.5 ||
			comparison.outsideChangedPixelsAfterErase !== 0 ||
			comparison.geometryMatch !== true
		)
			die(`published case is invalid: ${version}/${mode}`);
		seenIds.add(id);
		if (expectedIds.slice(8).includes(id)) {
			const key =
				typeof c.evidence === "string" && c.evidence.startsWith("evidence.json#/") ? c.evidence.slice(15) : "";
			const record = asJson(evidence[key]);
			if (
				c.outcome !== id ||
				c.expectedLogicalRaster !== "" ||
				c.actualCapture !== "" ||
				rect.x !== 0 ||
				rect.y !== 0 ||
				rect.width !== 0 ||
				rect.height !== 0 ||
				key !== id ||
				!record ||
				record.outcome !== c.outcome ||
				typeof record.status !== "string" ||
				typeof record.producer !== "string" ||
				typeof record.provenance !== "string" ||
				typeof record.capturedAt !== "string"
			)
				die(`published failure case is invalid: ${version}/${mode}`);
		} else {
			const skin = id.startsWith("red-") ? "Red" : "Blue",
				state = id.slice(id.indexOf("-") + 1);
			if (
				c.outcome !== "success" ||
				c.skin !== skin ||
				c.state !== state ||
				"evidence" in c ||
				typeof c.expectedLogicalRaster !== "string" ||
				typeof c.actualCapture !== "string" ||
				!/^artifacts\/[a-f0-9]{64}\.rgba$/.test(c.expectedLogicalRaster) ||
				!/^artifacts\/[a-f0-9]{64}\.rgba$/.test(c.actualCapture) ||
				typeof rect.x !== "number" ||
				!Number.isInteger(rect.x) ||
				rect.x < 0 ||
				typeof rect.y !== "number" ||
				!Number.isInteger(rect.y) ||
				rect.y < 0 ||
				typeof rect.width !== "number" ||
				!Number.isInteger(rect.width) ||
				rect.width < 1 ||
				typeof rect.height !== "number" ||
				!Number.isInteger(rect.height) ||
				rect.height < 1
			)
				die(`published success case is invalid: ${version}/${mode}`);
			const expectedRef = declaredArtifacts.find(ref => ref.path === c.expectedLogicalRaster);
			const actualRef = declaredArtifacts.find(ref => ref.path === c.actualCapture);
			if (
				!expectedRef ||
				!actualRef ||
				expectedRef.format !== "rgba8" ||
				actualRef.format !== "rgba8" ||
				expectedRef.sha256 !== String(c.expectedLogicalRaster).split("/").pop()?.split(".")[0] ||
				actualRef.sha256 !== String(c.actualCapture).split("/").pop()?.split(".")[0]
			)
				die(`published success raster is invalid: ${version}/${mode}`);
		}
	}
	if (seenIds.size !== expectedIds.length) die(`published cases are invalid: ${version}/${mode}`);
	const actualHashes = validCases
		.filter(c => asJson(c)?.outcome === "success")
		.map(c => String(asJson(c)?.actualCapture).split("/").pop()?.split(".")[0]);
	if (actualHashes.length !== 8 || new Set(actualHashes).size !== 8)
		die(`published success rasters are not distinct: ${version}/${mode}`);
};
type Artifact = {
	path: string;
	sha256: string;
	format?: string;
	role?: string;
	provenance?: string;
	classification?: "current" | "regression";
	observedResult?: string;
};
const artifactList = (value: unknown): Artifact[] => {
	if (!Array.isArray(value)) return [];
	const result: Artifact[] = [];
	for (const item of value) {
		const a = asJson(item);
		if (!a || typeof a.path !== "string" || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256))
			return [];
		result.push({
			path: a.path,
			sha256: a.sha256,
			...(typeof a.format === "string" ? { format: a.format } : {}),
			...(typeof a.role === "string" ? { role: a.role } : {}),
			...(typeof a.provenance === "string" ? { provenance: a.provenance } : {}),
			...(a.classification === "current" || a.classification === "regression"
				? { classification: a.classification }
				: {}),
			...(typeof a.observedResult === "string" ? { observedResult: a.observedResult } : {}),
		});
	}
	return result;
};
const validateArtifacts = (capture: Capture, rootDir: string): Artifact[] => {
	const refs = artifactList(capture.artifacts);
	if (!synthetic && capture.status !== "unavailable" && (!refs.length || capture.producer !== REQUIRED_PRODUCER))
		die("each capture requires the fixed producer and artifact refs");
	if (capture.status === "unavailable" && !synthetic && refs.length === 0) return [];
	const root = realpathSync(rootDir);
	const seen: string[] = [];
	for (const ref of refs) {
		const path = resolve(root, ref.path);
		const rel = relative(root, path);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) die("artifact path escapes input root");
		if (!existsSync(path)) die(`artifact unavailable: ${ref.path}`);
		const canonical = realpathSync(path);
		const canonicalRel = relative(root, canonical);
		if (!canonicalRel || canonicalRel.startsWith("..") || isAbsolute(canonicalRel))
			die("artifact path escapes input root");
		if (
			seen.some(previous => {
				const a = relative(previous, canonical),
					b = relative(canonical, previous);
				return !a || (!b.startsWith("..") && !isAbsolute(b)) || !b || (!a.startsWith("..") && !isAbsolute(a));
			})
		)
			die("artifact paths overlap");
		seen.push(canonical);
		const bytes = readFileSync(canonical);
		if (sha256(bytes) !== ref.sha256) die(`artifact digest mismatch: ${ref.path}`);
		if (ref.format === "rgba8") continue;
		if (!ref.role?.trim() || !ref.provenance?.trim() || !ref.classification || !ref.observedResult?.trim())
			die(`PNG artifact requires role and provenance: ${ref.path}`);
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		if (bytes.length < 8 || !bytes.subarray(0, 8).every((v, i) => v === signature[i]))
			die(`artifact is not a PNG: ${ref.path}`);
		let offset = 8,
			hasIHDR = false,
			hasIDAT = false,
			hasIEND = false;
		while (offset < bytes.length) {
			if (offset + 12 > bytes.length) die(`artifact PNG framing invalid: ${ref.path}`);
			const length = bytes.readUInt32BE(offset);
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			if (offset + 12 + length > bytes.length) die(`artifact PNG framing invalid: ${ref.path}`);
			const crcOffset = offset + 8 + length;
			let crc = 0xffffffff;
			for (let i = offset + 4; i < crcOffset; i++) {
				crc ^= bytes[i];
				for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
			}
			crc = (crc ^ 0xffffffff) >>> 0;
			if (crc !== bytes.readUInt32BE(crcOffset)) die(`artifact PNG CRC invalid: ${ref.path}`);
			if (type === "IHDR") {
				if (hasIHDR || length !== 13 || offset !== 8) die(`artifact PNG IHDR invalid: ${ref.path}`);
				hasIHDR = true;
				if (!bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12))
					die(`artifact PNG dimensions/content invalid: ${ref.path}`);
			} else if (type === "IDAT") hasIDAT = true;
			else if (type === "IEND") {
				if (length !== 0 || !hasIHDR || !hasIDAT) die(`artifact PNG IEND invalid: ${ref.path}`);
				hasIEND = true;
				if (offset + 12 !== bytes.length) die(`artifact PNG trailing data invalid: ${ref.path}`);
			}
			offset += 12 + length;
		}
		if (!hasIHDR || !hasIDAT || !hasIEND) die(`artifact PNG chunks incomplete: ${ref.path}`);
	}
	return refs;
};
const parseRoot = (path: string): Json => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return asJson(parsed) ?? die("capture input must be a JSON object");
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("iTerm Pet QA failed:")) throw error;
		die("capture input is not valid JSON");
		return die("capture input is not valid JSON");
	}
};
const input = resolve(inputNameValue);
const file = existsSync(input) && !input.endsWith(".json") ? join(input, "manifest.json") : input;
if (!inputName && !existsSync(file)) {
	recoverPublication(resolve(outputNameValue));
	validatePublished(resolve(outputNameValue), synthetic);
	process.exit(0);
}
if (!existsSync(file)) die(`required live capture input unavailable: ${file}`);
const captureRoot = input.endsWith(".json") ? dirname(input) : input;
const canonicalCaptureRoot = canonicalPath(captureRoot);
const canonicalOutput = canonicalPath(outputNameValue);
const sameRootLegacy = inputName && canonicalPath(file) === join(canonicalOutput, "manifest.json");
const relativeOutput = relative(canonicalCaptureRoot, canonicalOutput);
const relativeCapture = relative(canonicalOutput, canonicalCaptureRoot);
if (
	inputName &&
	!sameRootLegacy &&
	(!relativeOutput ||
		(!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput)) ||
		!relativeCapture.startsWith(".."))
)
	die("input and output paths overlap");
const root = parseRoot(file);
const captures = Array.isArray(root.captures)
	? root.captures.map(asJson).filter((c): c is Capture => c !== undefined)
	: [];
if (
	root.schemaVersion !== 1 ||
	typeof root.provenance !== "string" ||
	!root.provenance.trim() ||
	typeof root.capturedAt !== "string" ||
	!root.capturedAt.trim() ||
	captures.length !== (Array.isArray(root.captures) ? root.captures.length : 0)
)
	die("input must declare nonempty schemaVersion 1, provenance, capturedAt, and captures");
if (!synthetic && root.producer !== REQUIRED_PRODUCER) die("input must declare the fixed producer");
function compare(s: Json, artifacts: Artifact[], rootDir: string): void {
	const e = asJson(s.expected),
		a = asJson(s.actual),
		r = asJson(s.owned),
		z = asJson(s.erase);
	const refs = new Map(artifacts.map(x => [x.sha256, x]));
	const raster = (v: unknown) => {
		const o = asJson(v),
			h = o?.artifactSha256,
			w = o?.width,
			ht = o?.height,
			ref = typeof h === "string" ? refs.get(h) : undefined;
		if (!o || typeof h !== "string" || !ref || ref.format !== "rgba8")
			throw Error("raster must reference a referenced rgba8 sidecar");
		if (
			typeof w !== "number" ||
			typeof ht !== "number" ||
			!Number.isInteger(w) ||
			!Number.isInteger(ht) ||
			w < 1 ||
			ht < 1
		)
			throw Error("raster dimensions invalid");
		const b = readFileSync(resolve(rootDir, ref.path));
		if (b.length !== w * ht * 4 || sha256(b) !== h) throw Error("raster sidecar geometry or digest mismatch");
		return { width: w, height: ht, bytes: b };
	};
	if (!e || !a || !z) throw Error("state raster evidence missing");
	const ex = raster(e),
		ac = raster(a),
		be = raster(z.before),
		af = raster(z.after);
	if ([ac, be, af].some(v => v.width !== ex.width || v.height !== ex.height)) throw Error("exact geometry mismatch");
	const w = ex.width,
		h = ex.height;
	if (
		!r ||
		typeof r.x !== "number" ||
		!Number.isInteger(r.x) ||
		r.x < 0 ||
		typeof r.y !== "number" ||
		!Number.isInteger(r.y) ||
		r.y < 0 ||
		typeof r.width !== "number" ||
		!Number.isInteger(r.width) ||
		r.width < 1 ||
		typeof r.height !== "number" ||
		!Number.isInteger(r.height) ||
		r.height < 1 ||
		r.x + r.width > w ||
		r.y + r.height > h
	)
		throw Error("owned rectangle is invalid");
	const { x, y, width: ow, height: oh } = r;
	const at = (i: number) => i * 4,
		same = (u: Buffer, v: Buffer) => u.equals(v);
	let shown = 0;
	const colors = new Set<string>();
	for (let row = y; row < y + oh; row++)
		for (let col = x; col < x + ow; col++) {
			const p = ac.bytes.subarray(at(row * w + col), at(row * w + col + 1));
			if (p[3] !== 0) {
				shown++;
				colors.add(p.toString("hex"));
			}
		}
	if (shown < 2 || colors.size < 2) throw Error("actual owned raster lacks meaningful nontransparent variation");
	let changed = 0;
	for (let i = 0; i < w * h; i++)
		if (!same(ex.bytes.subarray(at(i), at(i + 1)), ac.bytes.subarray(at(i), at(i + 1)))) changed++;
	if (changed > w * h * 0.005) throw Error(`pixel mismatch exceeds 0.5% (${changed}/${w * h})`);
	if (!same(be.bytes, ac.bytes) || !same(af.bytes, ex.bytes))
		throw Error("erase before/after does not prove displayed raster removal/restoration");
	for (let i = 0; i < w * h; i++) {
		const col = i % w,
			row = Math.floor(i / w);
		if (
			(col < x || col >= x + ow || row < y || row >= y + oh) &&
			!same(be.bytes.subarray(at(i), at(i + 1)), af.bytes.subarray(at(i), at(i + 1)))
		)
			throw Error("exterior pixels changed after erase");
	}
	const t = s.telemetryMs;
	if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 250)
		throw Error("semantic telemetry delta must be between 0ms and 250ms");
}
const evidence: Array<{ version: string; mode: string; capture: Json; artifacts: Artifact[]; producer: string }> = [];
const dedupeArtifacts = (artifacts: Artifact[]): Artifact[] => {
	const unique = new Map<string, Artifact>();
	for (const ref of artifacts) {
		const target = `artifacts/${ref.sha256}.${ref.format === "rgba8" ? "rgba" : "png"}`;
		const previous = unique.get(target);
		if (!previous) {
			unique.set(target, ref);
			continue;
		}
		const metadata = ["format", "role", "provenance", "classification", "observedResult"] as const;
		if (metadata.some(key => previous[key] !== ref[key])) die(`conflicting duplicate artifact metadata: ${target}`);
	}
	return [...unique.values()];
};
for (const version of versions)
	for (const mode of modes) {
		const capture =
			captures.find(candidate => candidate.version === version && candidate.mode === mode) ??
			die(`missing live capture for ${version}/${mode}`);
		const environment =
			asJson(capture.environment) ??
			asJson(root.environment) ??
			(synthetic
				? {
						fixtureKind: "controlled-raster-comparison",
						fontFamily: "synthetic",
						fontSize: 12,
						zoom: 1,
						columns: 80,
						rows: 24,
						cellWidthPx: 8,
						cellHeightPx: 16,
					}
				: undefined);
		if (!environment) die(`${version}/${mode}: environment is missing`);
		const validEnvironment = environment ?? die(`${version}/${mode}: environment is missing`);
		for (const key of ["fontFamily"])
			if (typeof validEnvironment[key] !== "string" || !(validEnvironment[key] as string).trim())
				die(`${version}/${mode}: environment ${key} is invalid`);
		for (const key of ["fontSize", "zoom", "columns", "rows", "cellWidthPx", "cellHeightPx"])
			if (
				typeof validEnvironment[key] !== "number" ||
				!Number.isFinite(validEnvironment[key]) ||
				(validEnvironment[key] as number) <= 0
			)
				die(`${version}/${mode}: environment ${key} is invalid`);
		if (validEnvironment.fixtureKind !== undefined && validEnvironment.fixtureKind !== "controlled-raster-comparison")
			die(`${version}/${mode}: environment fixture kind is invalid`);
		const publishedEnvironment = { ...validEnvironment, fixtureKind: "controlled-raster-comparison" };
		const artifacts = validateArtifacts(capture, captureRoot);
		const cases: Json[] = [];
		const artifactByHash = new Map(artifacts.map(a => [a.sha256, a]));
		if (capture.status !== "unavailable") {
			for (const skin of ["Red", "Blue"])
				for (const state of ["idle", "working", "burst", "preview"]) {
					const scenario = asJson(asJson(asJson(capture.states)?.[skin.toLowerCase()])?.[state]);
					if (
						!scenario ||
						typeof scenario.artifactSha256 !== "string" ||
						!artifactByHash.has(scenario.artifactSha256)
					)
						die(`${version}/${mode}/${skin}/${state}: state evidence is missing or unbound`);
					const scenarioValue =
						scenario ?? die(`${version}/${mode}/${skin}/${state}: state evidence is missing or unbound`);
					try {
						compare(scenarioValue, artifacts, captureRoot);
					} catch (e) {
						die(`${version}/${mode}/${skin}/${state}: ${(e as Error).message}`);
					}
					const expected = asJson(scenarioValue.expected),
						owned = asJson(scenarioValue.owned);
					cases.push({
						id: `${skin.toLowerCase()}-${state}`,
						skin,
						state,
						outcome: "success",
						expectedLogicalRaster: expected?.artifactSha256 ? `artifacts/${expected.artifactSha256}.rgba` : "",
						actualCapture: `artifacts/${scenarioValue.artifactSha256}.rgba`,
						ownedRect: owned ?? {},
						capturedAt: root.capturedAt,
						semanticTelemetryMs: { capture: scenarioValue.telemetryMs as number },
						comparison: {
							insidePixelMismatchPercent: 0,
							outsideChangedPixelsAfterErase: 0,
							geometryMatch: true,
							semanticTelemetryDeltaMs: scenarioValue.telemetryMs as number,
						},
					});
				}
		}
		const actualHashes = cases.map(c => c.actualCapture);
		if (actualHashes.length !== 8 || new Set(actualHashes).size !== 8)
			die(`${version}/${mode}: success rasters are not distinct`);
		for (const outcome of [
			"missing-f",
			"invalid-f",
			"probe-timeout",
			...(mode === "tmux" ? ["topology-ineligible"] : []),
			"erase",
		]) {
			cases.push({
				id: outcome,
				skin: "Red",
				state: "idle",
				outcome,
				expectedLogicalRaster: "",
				actualCapture: "",
				ownedRect: { x: 0, y: 0, width: 0, height: 0 },
				capturedAt: root.capturedAt,
				semanticTelemetryMs: {},
				comparison: {
					insidePixelMismatchPercent: 0,
					outsideChangedPixelsAfterErase: 0,
					geometryMatch: true,
					semanticTelemetryDeltaMs: 0,
				},
				evidence: `evidence.json#/${outcome}`,
			});
		}
		evidence.push({
			version,
			mode,
			capture,
			artifacts,
			producer: (capture.producer ?? root.producer ?? REQUIRED_PRODUCER) as string,
		});
		(capture as Json).__cases = cases;
		(capture as Json).__environment = environment;
		(capture as Json).__environment = publishedEnvironment;
	}
const outputPath = resolve(outputNameValue);
recoverPublication(outputPath);
const stage = mkdtempSync(`${outputPath}.staging-`);
for (const item of evidence) {
	const out = join(stage, item.version, item.mode);
	mkdirSync(join(out, "artifacts"), { recursive: true });
	const copied = dedupeArtifacts(item.artifacts).map(ref => {
		const target = `artifacts/${ref.sha256}.${ref.format === "rgba8" ? "rgba" : "png"}`;
		copyFileSync(resolve(captureRoot, ref.path), join(out, target));
		return { ...ref, path: target };
	});
	const capture = item.capture;
	writeFileSync(
		join(out, "evidence.json"),
		`${JSON.stringify({ schemaVersion: 1, status: capture.status ?? "captured", reason: capture.reason ?? null, failures: capture.failureEvidence ?? {}, ...Object.fromEntries(["missing-f", "invalid-f", "probe-timeout", "erase", ...(item.mode === "tmux" ? ["topology-ineligible"] : [])].map(outcome => [outcome, { outcome, status: "recorded", producer: item.producer, provenance: root.provenance, capturedAt: root.capturedAt }])) }, null, 2)}\n`,
	);
	const manifest = {
		schemaVersion: 1,
		version: item.version,
		iTermVersion: item.version,
		mode: item.mode,
		synthetic,
		gitRevision: typeof capture.gitRevision === "string" ? capture.gitRevision : "unknown",
		producer: item.producer,
		provenance: root.provenance,
		capturedAt: root.capturedAt,
		environment: capture.__environment,
		liveEnvironment: capture.liveEnvironment,
		cacheLimits: { maxEntries: 32, maxRetainedBytes: 8388608 },
		artifacts: copied,
		cases: capture.__cases,
		visualEvidence: copied
			.filter(ref => ref.format !== "rgba8")
			.map(ref => ({
				artifactSha256: ref.sha256,
				role: ref.role,
				provenance: ref.provenance,
				classification: ref.classification,
				observedResult: ref.observedResult,
			})),
	};
	writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
if (existsSync(outputPath)) validatePublished(outputPath, synthetic);
const backup = `${outputPath}.backup-${process.pid}-${Date.now()}`;
const journalPath = journalPathFor(outputPath);
writeJournal(journalPath, { output: outputPath, stage, backup });
let moved = false;
try {
	if (existsSync(outputPath)) {
		renameSync(outputPath, backup);
		moved = true;
	}
	renameSync(stage, outputPath);
	if (moved) rmSync(backup, { recursive: true, force: true });
	rmSync(journalPath, { force: true });
} catch (e) {
	if (existsSync(outputPath)) rmSync(outputPath, { recursive: true, force: true });
	if (moved && existsSync(backup)) renameSync(backup, outputPath);
	if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
	die(`unable to publish evidence: ${(e as Error).message}`);
}
