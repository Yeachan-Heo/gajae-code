import { describe, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRawSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import { openArchive } from "../src/tools/archive-reader";

const exec = promisify(execFile);
const ENTRY_LIMIT = 16 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const COUNT_LIMIT = 8192;
const DEPTH_LIMIT = 48;
const TAR_CONTAINER_LIMIT = TOTAL_LIMIT + COUNT_LIMIT * 1024 + 1024;

function ustarHeader(name: string, size: number, typeFlag = "0"): Uint8Array {
	const header = new Uint8Array(512);
	const enc = new TextEncoder();
	const put = (text: string, at: number) => header.set(enc.encode(text), at);
	const nameBytes = enc.encode(name);
	if (nameBytes.byteLength > 100) throw new Error(`ustar name exceeds 100 bytes: ${name}`);
	header.set(nameBytes, 0);
	put("0000644\0", 100);
	put("0000000\0", 108);
	put("0000000\0", 116);
	put(`${size.toString(8).padStart(11, "0")}\0`, 124);
	put("00000000000\0", 136);
	header.fill(0x20, 148, 156);
	header[156] = typeFlag.charCodeAt(0);
	put("ustar\0", 257);
	put("00", 263);
	let sum = 0;
	for (const byte of header) sum += byte;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
}

async function writeUstarBytes(file: string, chunks: Uint8Array[]): Promise<void> {
	await writeFile(file, concat([...chunks, new Uint8Array(1024)]));
}

async function writeUstar(
	file: string,
	writeBody: (push: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
	const handle = await open(file, "w");
	try {
		await writeBody(async chunk => {
			await handle.write(chunk);
		});
		await handle.write(new Uint8Array(1024));
	} finally {
		await handle.close();
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function pad512(data: Uint8Array): Uint8Array {
	const pad = (512 - (data.byteLength % 512)) % 512;
	if (pad === 0) return data;
	const out = new Uint8Array(data.byteLength + pad);
	out.set(data, 0);
	return out;
}

function paxRecords(records: Array<[string, string]>): Uint8Array {
	let body = "";
	for (const [key, value] of records) {
		const suffix = ` ${key}=${value}\n`;
		let size = suffix.length;
		while (String(size).length + suffix.length !== size) size = String(size).length + suffix.length;
		body += `${size}${suffix}`;
	}
	return new TextEncoder().encode(body);
}

function appendPaxHeader(chunks: Uint8Array[], records: Array<[string, string]>, typeFlag: "g" | "x" = "x"): void {
	const body = paxRecords(records);
	chunks.push(ustarHeader(typeFlag === "g" ? "global" : "paxheader", body.byteLength, typeFlag), pad512(body));
}

function appendTarFile(chunks: Uint8Array[], name: string, body: Uint8Array): void {
	chunks.push(ustarHeader(name, body.byteLength), pad512(body));
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomInteger(random: () => number, min: number, max: number): number {
	return min + Math.floor(random() * (max - min + 1));
}

function randomAscii(random: () => number, length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let value = "";
	for (let index = 0; index < length; index++) {
		value += alphabet[randomInteger(random, 0, alphabet.length - 1)];
	}
	return value;
}

function randomBytes(random: () => number, length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index++) bytes[index] = randomInteger(random, 0, 255);
	return bytes;
}

function openInChild(archivePath: string): Promise<{ timedOut: boolean; output: string }> {
	const reader = path.join(import.meta.dir, "../src/tools/archive-reader.ts");
	const script = `
		import { openArchive } from ${JSON.stringify(reader)};
		try {
			await openArchive(${JSON.stringify(archivePath)});
			console.log("OPENED");
		} catch {
			console.log("REJECTED");
		}
	`;
	return new Promise(resolve => {
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let settled = false;
		const finish = (timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ timedOut, output });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(true);
		}, 3000);
		child.stdout.on("data", chunk => {
			output += String(chunk);
		});
		child.on("exit", () => finish(false));
	});
}

function zipUnknownSize(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
	const parts: Uint8Array[] = [];
	const zip = new Zip((error, chunk) => {
		if (error) throw error;
		if (chunk?.byteLength) parts.push(chunk);
	});
	for (const file of files) {
		const entry = new ZipDeflate(file.name, { level: 1 });
		zip.add(entry);
		entry.push(file.data, true);
	}
	zip.end();
	return concat(parts);
}

function zipStoredSingle(name: string, data: Uint8Array): Uint8Array {
	return zipSync({ [name]: data }, { level: 0 });
}

function unsignedStoredZip(name: string, data: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	const zip = new Zip((error, chunk) => {
		if (error) throw error;
		if (chunk?.byteLength) parts.push(chunk);
	});
	const entry = new ZipPassThrough(name);
	zip.add(entry);
	entry.push(data, true);
	zip.end();
	const bytes = concat(parts);
	const view = zipView(bytes);
	const descriptorAt = 30 + view.getUint16(26, true) + view.getUint16(28, true) + data.byteLength;
	if (view.getUint32(descriptorAt, true) !== 0x08074b50) throw new Error("missing descriptor signature");
	const stripped = concat([bytes.subarray(0, descriptorAt), bytes.subarray(descriptorAt + 4)]);
	const strippedView = zipView(stripped);
	const eocdOffset = stripped.byteLength - 22;
	strippedView.setUint32(eocdOffset + 16, strippedView.getUint32(eocdOffset + 16, true) - 4, true);
	return stripped;
}

function zipView(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function addZipExtraField(bytes: Uint8Array, id: number, data: Uint8Array): Uint8Array {
	const view = zipView(bytes);
	const eocdOffset = bytes.byteLength - 22;
	const centralOffset = view.getUint32(eocdOffset + 16, true);
	const localNameLength = view.getUint16(26, true);
	const localExtraLength = view.getUint16(28, true);
	const centralNameLength = view.getUint16(centralOffset + 28, true);
	const centralExtraLength = view.getUint16(centralOffset + 30, true);
	const field = zipExtraField(id, data);

	const localHeaderEnd = 30 + localNameLength;
	const localHeader = bytes.slice(0, localHeaderEnd);
	zipView(localHeader).setUint16(28, localExtraLength + field.byteLength, true);
	const localPart = concat([localHeader, field, bytes.subarray(localHeaderEnd, centralOffset)]);

	const centralNameEnd = centralOffset + 46 + centralNameLength;
	const centralHeader = bytes.slice(centralOffset, centralNameEnd);
	zipView(centralHeader).setUint16(30, centralExtraLength + field.byteLength, true);
	const centralDirectory = concat([centralHeader, field, bytes.subarray(centralNameEnd, eocdOffset)]);
	const eocd = bytes.slice(eocdOffset);
	const eocdView = zipView(eocd);
	eocdView.setUint32(12, view.getUint32(eocdOffset + 12, true) + field.byteLength, true);
	eocdView.setUint32(16, centralOffset + field.byteLength, true);
	return concat([localPart, centralDirectory, eocd]);
}

function zipLocalRecordEnd(bytes: Uint8Array): number {
	const view = zipView(bytes);
	return 30 + view.getUint16(26, true) + view.getUint16(28, true) + view.getUint32(18, true);
}

function zip64EndRecordOffset(bytes: Uint8Array): number {
	const locatorOffset = bytes.byteLength - 22 - 20;
	return Number(zipView(bytes).getBigUint64(locatorOffset + 8, true));
}

function zipWithEmbeddedMemberDirectories(): { bytes: Uint8Array; memberBytes: Uint8Array } {
	const embeddedFiles: Record<string, Uint8Array> = {};
	for (let index = 0; index < 16; index++) {
		embeddedFiles[`embedded-${index}.txt`] = new TextEncoder().encode(`member-${index}`);
	}
	const embeddedZip = zipSync(embeddedFiles, { level: 0 });
	const embeddedView = zipView(embeddedZip);
	const embeddedEocdOffset = embeddedZip.byteLength - 22;
	const embeddedDirectoryOffset = embeddedView.getUint32(embeddedEocdOffset + 16, true);
	const embeddedDirectorySize = embeddedView.getUint32(embeddedEocdOffset + 12, true);
	const memberBytes = embeddedZip.subarray(0, embeddedDirectoryOffset);
	const outerZip = zipStoredSingle("outer.bin", memberBytes);
	const outerView = zipView(outerZip);
	const outerEocdOffset = outerZip.byteLength - 22;
	const outerPayloadOffset = 30 + outerView.getUint16(26, true) + outerView.getUint16(28, true);
	const fakeDirectoryRecords: Uint8Array[] = [];
	for (let offset = embeddedDirectoryOffset; offset < embeddedDirectoryOffset + embeddedDirectorySize; ) {
		const nameLength = embeddedView.getUint16(offset + 28, true);
		const extraLength = embeddedView.getUint16(offset + 30, true);
		const commentLength = embeddedView.getUint16(offset + 32, true);
		const recordLength = 46 + nameLength + extraLength + commentLength;
		const record = embeddedZip.slice(offset, offset + recordLength);
		const innerLocalOffset = embeddedView.getUint32(offset + 42, true);
		zipView(record).setUint32(42, outerPayloadOffset + innerLocalOffset, true);
		fakeDirectoryRecords.push(record);
		offset += recordLength;
	}

	const commentLength = fakeDirectoryRecords.reduce((total, record) => total + record.byteLength + 22, 0);
	const commentParts: Uint8Array[] = [];
	let commentOffset = 0;
	for (const record of fakeDirectoryRecords) {
		const endRecord = new Uint8Array(22);
		const view = zipView(endRecord);
		view.setUint32(0, 0x06054b50, true);
		view.setUint16(8, 1, true);
		view.setUint16(10, 1, true);
		view.setUint32(12, record.byteLength, true);
		view.setUint32(16, outerZip.byteLength + commentOffset, true);
		view.setUint16(20, commentLength - commentOffset - record.byteLength - endRecord.byteLength, true);
		commentParts.push(record, endRecord);
		commentOffset += record.byteLength + endRecord.byteLength;
	}
	const eocd = outerZip.slice(outerEocdOffset);
	zipView(eocd).setUint16(20, commentLength, true);
	return { bytes: concat([outerZip.subarray(0, outerEocdOffset), eocd, ...commentParts]), memberBytes };
}

function zip64SingleEntry(name: string, data: Uint8Array, extra?: { id: number; data: Uint8Array }): Uint8Array {
	const bytes = zipSync({ [name]: data }, { level: 0 });
	const view = zipView(bytes);
	const eocdOffset = bytes.byteLength - 22;
	const centralOffset = view.getUint32(eocdOffset + 16, true);
	const localNameLength = view.getUint16(26, true);
	const localExtraLength = view.getUint16(28, true);
	const compressedSize = view.getUint32(18, true);
	const localHeader = bytes.slice(0, 30 + localNameLength);
	const localHeaderView = zipView(localHeader);
	localHeaderView.setUint32(18, 0xffff_ffff, true);
	localHeaderView.setUint32(22, 0xffff_ffff, true);
	localHeaderView.setUint16(28, 20, true);
	const localZip64Extra = new Uint8Array(20);
	const localZip64View = zipView(localZip64Extra);
	localZip64View.setUint16(0, 0x0001, true);
	localZip64View.setUint16(2, 16, true);
	localZip64View.setBigUint64(4, BigInt(data.byteLength), true);
	localZip64View.setBigUint64(12, BigInt(compressedSize), true);
	const localExtra = extra ? concat([zipExtraField(extra.id, extra.data), localZip64Extra]) : localZip64Extra;
	localHeaderView.setUint16(28, localExtra.byteLength, true);
	const payloadStart = 30 + localNameLength + localExtraLength;
	const payload = bytes.subarray(payloadStart, payloadStart + compressedSize);
	const localRecord = concat([localHeader, localExtra, payload]);

	const centralNameLength = view.getUint16(centralOffset + 28, true);
	const centralExtraLength = view.getUint16(centralOffset + 30, true);
	const centralCommentLength = view.getUint16(centralOffset + 32, true);
	const centralHeader = bytes.slice(centralOffset, centralOffset + 46 + centralNameLength);
	const centralHeaderView = zipView(centralHeader);
	centralHeaderView.setUint32(20, 0xffff_ffff, true);
	centralHeaderView.setUint32(24, 0xffff_ffff, true);
	centralHeaderView.setUint16(30, 28, true);
	centralHeaderView.setUint32(42, 0xffff_ffff, true);
	const centralZip64Extra = new Uint8Array(28);
	const centralZip64View = zipView(centralZip64Extra);
	centralZip64View.setUint16(0, 0x0001, true);
	centralZip64View.setUint16(2, 24, true);
	centralZip64View.setBigUint64(4, BigInt(data.byteLength), true);
	centralZip64View.setBigUint64(12, BigInt(compressedSize), true);
	centralZip64View.setBigUint64(20, 0n, true);
	const centralExtra = extra ? concat([zipExtraField(extra.id, extra.data), centralZip64Extra]) : centralZip64Extra;
	centralHeaderView.setUint16(30, centralExtra.byteLength, true);
	const commentStart = centralOffset + 46 + centralNameLength + centralExtraLength;
	const comment = bytes.subarray(commentStart, commentStart + centralCommentLength);
	const centralDirectory = concat([centralHeader, centralExtra, comment]);

	const zip64EndOffset = localRecord.byteLength + centralDirectory.byteLength;
	const zip64End = new Uint8Array(56);
	const zip64EndView = zipView(zip64End);
	zip64EndView.setUint32(0, 0x06064b50, true);
	zip64EndView.setBigUint64(4, 44n, true);
	zip64EndView.setUint16(12, 45, true);
	zip64EndView.setUint16(14, 45, true);
	zip64EndView.setBigUint64(24, 1n, true);
	zip64EndView.setBigUint64(32, 1n, true);
	zip64EndView.setBigUint64(40, BigInt(centralDirectory.byteLength), true);
	zip64EndView.setBigUint64(48, BigInt(localRecord.byteLength), true);
	const locator = new Uint8Array(20);
	const locatorView = zipView(locator);
	locatorView.setUint32(0, 0x07064b50, true);
	locatorView.setBigUint64(8, BigInt(zip64EndOffset), true);
	locatorView.setUint32(16, 1, true);
	const eocd = new Uint8Array(22);
	const eocdView = zipView(eocd);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, 0xffff, true);
	eocdView.setUint16(10, 0xffff, true);
	eocdView.setUint32(12, 0xffff_ffff, true);
	eocdView.setUint32(16, 0xffff_ffff, true);
	return concat([localRecord, centralDirectory, zip64End, locator, eocd]);
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP_DESCRIPTOR_SIG = 0x08074b50;
const ZIP_U16_MAX = 0xffff;
const ZIP_U32_MAX = 0xffff_ffff;
const ZIP_FIXED_CRC = 0x11111111;
const ZIP_FORBIDDEN = new Set<number>([
	ZIP_LOCAL_SIG,
	ZIP_CENTRAL_SIG,
	ZIP_EOCD_SIG,
	ZIP64_EOCD_SIG,
	ZIP64_LOCATOR_SIG,
	ZIP_DESCRIPTOR_SIG,
	0x05054b50,
]);

function zipDeflateWithDeclaredSize(name: string, compressed: Uint8Array, uncompressedSize: number): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const localHeader = new Uint8Array(30);
	const localView = zipView(localHeader);
	localView.setUint32(0, ZIP_LOCAL_SIG, true);
	localView.setUint16(4, 20, true);
	localView.setUint16(8, 8, true);
	localView.setUint32(18, compressed.byteLength, true);
	localView.setUint32(22, uncompressedSize, true);
	localView.setUint16(26, nameBytes.byteLength, true);

	const centralHeader = new Uint8Array(46);
	const centralView = zipView(centralHeader);
	centralView.setUint32(0, ZIP_CENTRAL_SIG, true);
	centralView.setUint16(4, 20, true);
	centralView.setUint16(6, 20, true);
	centralView.setUint16(10, 8, true);
	centralView.setUint32(20, compressed.byteLength, true);
	centralView.setUint32(24, uncompressedSize, true);
	centralView.setUint16(28, nameBytes.byteLength, true);
	const centralDirectoryOffset = localHeader.byteLength + nameBytes.byteLength + compressed.byteLength;
	const centralDirectorySize = centralHeader.byteLength + nameBytes.byteLength;

	const eocd = new Uint8Array(22);
	const eocdView = zipView(eocd);
	eocdView.setUint32(0, ZIP_EOCD_SIG, true);
	eocdView.setUint16(8, 1, true);
	eocdView.setUint16(10, 1, true);
	eocdView.setUint32(12, centralDirectorySize, true);
	eocdView.setUint32(16, centralDirectoryOffset, true);
	return concat([localHeader, nameBytes, compressed, centralHeader, nameBytes, eocd]);
}

function zipU16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function zipU32(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function zipU64(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	bytes.set(zipU32(value >>> 0), 0);
	return bytes;
}

function zipSig32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function scrubZipBytes(bytes: Uint8Array): void {
	for (let index = 0; index + 4 <= bytes.length; index++) {
		if (ZIP_FORBIDDEN.has(zipSig32(bytes, index))) bytes[index] = 0x5a;
	}
}

function zipByteLength(parts: Uint8Array[]): number {
	let total = 0;
	for (const part of parts) total += part.byteLength;
	return total;
}

function zipExtraField(id: number, data: Uint8Array): Uint8Array {
	return concat([zipU16(id), zipU16(data.byteLength), data]);
}

interface ZipGenMember {
	name: string;
	payload: Uint8Array;
	descriptor: "none" | "signature" | "bare";
	zip64Sizes: boolean;
	zip64Offset: boolean;
	zip64Disk: boolean;
	utf8: boolean;
	unknownBefore: number;
	unknownAfter: number;
	zip64Pad: number;
}

interface ZipBuiltMember {
	name: string;
	payload: Uint8Array;
	localOffset: number;
	centralOffset: number;
	centralNameOffset: number;
	centralZip64CompOffset: number;
	centralZip64OffsetOffset: number;
	descriptorCrcOffset: number;
}

interface ZipBuilt {
	bytes: Uint8Array;
	members: ZipBuiltMember[];
	eocdOffset: number;
	zip64EndOffset: number;
}

function zipFlags(member: ZipGenMember): number {
	return (member.descriptor === "none" ? 0 : 0x0008) | (member.utf8 ? 0x0800 : 0);
}

function zipUnknownField(tag: number, length: number, random: () => number): Uint8Array {
	if (length <= 0) return new Uint8Array(0);
	const payload = randomBytes(random, length);
	scrubZipBytes(payload);
	return zipExtraField(tag, payload);
}

function zip64Body(member: ZipGenMember, localOffset: number, central: boolean): Uint8Array {
	const parts: Uint8Array[] = [];
	if (member.zip64Sizes) parts.push(zipU64(member.payload.byteLength), zipU64(member.payload.byteLength));
	if (central && member.zip64Offset) parts.push(zipU64(localOffset));
	if (central && member.zip64Disk) parts.push(zipU32(0));
	const needsBody = parts.length > 0;
	if (needsBody && member.zip64Pad > 0) parts.push(new Uint8Array(member.zip64Pad));
	return concat(parts);
}

function memberExtra(member: ZipGenMember, localOffset: number, central: boolean, random: () => number): Uint8Array {
	const body = zip64Body(member, localOffset, central);
	return concat([
		zipUnknownField(central ? 0x7875 : 0x5455, member.unknownBefore, random),
		body.byteLength > 0 ? zipExtraField(0x0001, body) : new Uint8Array(0),
		zipUnknownField(central ? 0x9902 : 0x9901, member.unknownAfter, random),
	]);
}

function findZip64Data(extra: Uint8Array): number {
	let offset = 0;
	while (offset + 4 <= extra.length) {
		const id = extra[offset]! | (extra[offset + 1]! << 8);
		const length = extra[offset + 2]! | (extra[offset + 3]! << 8);
		if (id === 1) return offset + 4;
		offset += 4 + length;
	}
	return -1;
}

function makeZipPayload(random: () => number, plantSignature: boolean): Uint8Array {
	const payload = randomBytes(
		random,
		plantSignature ? Math.max(4, randomInteger(random, 0, 24)) : randomInteger(random, 0, 24),
	);
	if (plantSignature) payload.set(zipU32(ZIP_LOCAL_SIG), 0);
	return payload;
}

function generatedZipMember(random: () => number, index: number, ordinal: number): ZipGenMember {
	const modes: Array<ZipGenMember["descriptor"]> = ["none", "signature", "bare"];
	const descriptor = modes[(index + ordinal) % modes.length] ?? "none";
	const layout = (index + ordinal * 3) % 6;
	const nested = index % 4 === 0;
	return {
		name: `${nested ? `d${index}/` : ""}m${index}x${ordinal}${randomAscii(random, 6)}.bin`,
		payload: makeZipPayload(random, index % 7 === 0),
		descriptor,
		zip64Sizes: index % 2 === 0,
		zip64Offset: index % 4 === 1,
		zip64Disk: index % 4 === 3,
		utf8: index % 2 === 1,
		unknownBefore: layout === 1 || layout === 3 || layout === 5 ? randomInteger(random, 1, 8) : 0,
		unknownAfter: layout === 2 || layout === 3 || layout === 5 ? randomInteger(random, 1, 6) : 0,
		zip64Pad: layout >= 4 ? randomInteger(random, 1, 5) : 0,
	};
}

function descriptorBytes(member: ZipGenMember): Uint8Array {
	if (member.descriptor === "none") return new Uint8Array(0);
	const parts: Uint8Array[] = [];
	if (member.descriptor === "signature") parts.push(zipU32(ZIP_DESCRIPTOR_SIG));
	parts.push(zipU32(ZIP_FIXED_CRC));
	const size = member.payload.byteLength;
	if (member.zip64Sizes) parts.push(zipU64(size), zipU64(size));
	else parts.push(zipU32(size), zipU32(size));
	return concat(parts);
}

function buildGeneratedZip(members: ZipGenMember[], eocd64: boolean, random: () => number): ZipBuilt {
	const localParts: Uint8Array[] = [];
	const staged: Array<{ member: ZipGenMember; localOffset: number; descriptorCrcOffset: number }> = [];
	for (const member of members) {
		const localOffset = zipByteLength(localParts);
		const name = new TextEncoder().encode(member.name);
		const extra = memberExtra(member, localOffset, false, random);
		const size32 = member.zip64Sizes ? ZIP_U32_MAX : member.descriptor === "none" ? member.payload.byteLength : 0;
		const header = new Uint8Array(30);
		const view = zipView(header);
		view.setUint32(0, ZIP_LOCAL_SIG, true);
		view.setUint16(4, member.zip64Sizes ? 45 : 20, true);
		view.setUint16(6, zipFlags(member), true);
		view.setUint32(14, member.descriptor === "none" ? ZIP_FIXED_CRC : 0, true);
		view.setUint32(18, size32, true);
		view.setUint32(22, size32, true);
		view.setUint16(26, name.byteLength, true);
		view.setUint16(28, extra.byteLength, true);
		const descriptor = descriptorBytes(member);
		const descriptorCrcOffset =
			member.descriptor === "none"
				? -1
				: localOffset +
					header.byteLength +
					name.byteLength +
					extra.byteLength +
					member.payload.byteLength +
					(member.descriptor === "signature" ? 4 : 0);
		localParts.push(header, name, extra, member.payload, descriptor);
		staged.push({ member, localOffset, descriptorCrcOffset });
	}

	const centralBase = zipByteLength(localParts);
	const centralParts: Uint8Array[] = [];
	const builtMembers: ZipBuiltMember[] = [];
	for (const stage of staged) {
		const centralOffset = centralBase + zipByteLength(centralParts);
		const name = new TextEncoder().encode(stage.member.name);
		const extra = memberExtra(stage.member, stage.localOffset, true, random);
		const header = new Uint8Array(46);
		const view = zipView(header);
		const size32 = stage.member.zip64Sizes ? ZIP_U32_MAX : stage.member.payload.byteLength;
		view.setUint32(0, ZIP_CENTRAL_SIG, true);
		view.setUint16(4, 45, true);
		view.setUint16(6, stage.member.zip64Sizes || stage.member.zip64Offset || stage.member.zip64Disk ? 45 : 20, true);
		view.setUint16(8, zipFlags(stage.member), true);
		view.setUint32(16, ZIP_FIXED_CRC, true);
		view.setUint32(20, size32, true);
		view.setUint32(24, size32, true);
		view.setUint16(28, name.byteLength, true);
		view.setUint16(30, extra.byteLength, true);
		view.setUint16(34, stage.member.zip64Disk ? ZIP_U16_MAX : 0, true);
		view.setUint32(42, stage.member.zip64Offset ? ZIP_U32_MAX : stage.localOffset, true);
		centralParts.push(header, name, extra);
		const zip64Data = findZip64Data(extra);
		const extraStart = centralOffset + header.byteLength + name.byteLength;
		builtMembers.push({
			name: stage.member.name,
			payload: stage.member.payload,
			localOffset: stage.localOffset,
			centralOffset,
			centralNameOffset: centralOffset + header.byteLength,
			centralZip64CompOffset: zip64Data >= 0 && stage.member.zip64Sizes ? extraStart + zip64Data + 8 : -1,
			centralZip64OffsetOffset:
				zip64Data >= 0 && stage.member.zip64Offset
					? extraStart + zip64Data + (stage.member.zip64Sizes ? 16 : 0)
					: -1,
			descriptorCrcOffset: stage.descriptorCrcOffset,
		});
	}

	const centralSize = zipByteLength(centralParts);
	const endParts: Uint8Array[] = [];
	let zip64EndOffset = -1;
	if (eocd64) {
		zip64EndOffset = centralBase + centralSize;
		const record = new Uint8Array(56);
		const recordView = zipView(record);
		recordView.setUint32(0, ZIP64_EOCD_SIG, true);
		recordView.setBigUint64(4, 44n, true);
		recordView.setUint16(12, 45, true);
		recordView.setUint16(14, 45, true);
		recordView.setBigUint64(24, BigInt(members.length), true);
		recordView.setBigUint64(32, BigInt(members.length), true);
		recordView.setBigUint64(40, BigInt(centralSize), true);
		recordView.setBigUint64(48, BigInt(centralBase), true);
		const locator = new Uint8Array(20);
		const locatorView = zipView(locator);
		locatorView.setUint32(0, ZIP64_LOCATOR_SIG, true);
		locatorView.setBigUint64(8, BigInt(zip64EndOffset), true);
		locatorView.setUint32(16, 1, true);
		endParts.push(record, locator);
	}
	const eocdOffset = centralBase + centralSize + zipByteLength(endParts);
	const eocd = new Uint8Array(22);
	const eocdView = zipView(eocd);
	eocdView.setUint32(0, ZIP_EOCD_SIG, true);
	eocdView.setUint16(8, eocd64 ? ZIP_U16_MAX : members.length, true);
	eocdView.setUint16(10, eocd64 ? ZIP_U16_MAX : members.length, true);
	eocdView.setUint32(12, eocd64 ? ZIP_U32_MAX : centralSize, true);
	eocdView.setUint32(16, eocd64 ? ZIP_U32_MAX : centralBase, true);
	endParts.push(eocd);
	const bytes = concat([...localParts, ...centralParts, ...endParts]);
	return { bytes, members: builtMembers, eocdOffset, zip64EndOffset };
}

function mutateGeneratedZip(built: ZipBuilt, kind: number): Uint8Array {
	const bytes = built.bytes.slice();
	const view = zipView(bytes);
	const member = built.members[0];
	if (!member) throw new Error("missing generated member");
	switch (kind % 8) {
		case 0:
			return bytes.subarray(0, member.localOffset + 10);
		case 1:
			return bytes.subarray(0, built.eocdOffset);
		case 2:
			if (built.zip64EndOffset >= 0) {
				view.setBigUint64(built.zip64EndOffset + 32, view.getBigUint64(built.zip64EndOffset + 32, true) + 1n, true);
			} else {
				view.setUint16(built.eocdOffset + 10, view.getUint16(built.eocdOffset + 8, true) + 1, true);
			}
			return bytes;
		case 3:
			bytes[member.centralNameOffset] = (bytes[member.centralNameOffset] ?? 0) ^ 1;
			return bytes;
		case 4:
			if (member.centralZip64CompOffset >= 0) {
				view.setBigUint64(
					member.centralZip64CompOffset,
					view.getBigUint64(member.centralZip64CompOffset, true) + 1n,
					true,
				);
			} else {
				view.setUint32(member.centralOffset + 20, view.getUint32(member.centralOffset + 20, true) + 1, true);
			}
			return bytes;
		case 5:
			if (member.centralZip64OffsetOffset >= 0) {
				view.setBigUint64(
					member.centralZip64OffsetOffset,
					view.getBigUint64(member.centralZip64OffsetOffset, true) + 1n,
					true,
				);
			} else {
				view.setUint32(member.centralOffset + 42, view.getUint32(member.centralOffset + 42, true) + 1, true);
			}
			return bytes;
		case 6:
			if (member.descriptorCrcOffset >= 0) bytes[member.descriptorCrcOffset] ^= 0xff;
			else bytes[member.localOffset + 14] ^= 0xff;
			return bytes;
		default:
			if (built.zip64EndOffset >= 0) {
				view.setBigUint64(built.zip64EndOffset + 48, view.getBigUint64(built.zip64EndOffset + 48, true) + 1n, true);
			} else {
				view.setUint32(built.eocdOffset + 16, view.getUint32(built.eocdOffset + 16, true) + 1, true);
			}
			return bytes;
	}
}

async function expectZipMembers(bytes: Uint8Array, members: ZipBuiltMember[], label: string): Promise<void> {
	await withFile(`${label}.zip`, bytes, async file => {
		const archive = await openArchive(file);
		for (const member of members) {
			const actual = await archive.readFile(member.name);
			expect(actual.path, label).toBe(member.name);
			expect(actual.size, label).toBe(member.payload.byteLength);
			expect(actual.bytes, label).toEqual(member.payload);
		}
	});
}

async function withFile(name: string, bytes: Uint8Array, run: (file: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "archive-cap-"));
	try {
		const file = path.join(dir, name);
		await writeFile(file, bytes);
		await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function noted(name: string, run: () => Promise<void>): () => Promise<void> {
	return async () => {
		try {
			await run();
			console.log(`(pass) ${name}`);
		} catch (error) {
			console.log(`(fail) ${name}`);
			throw error;
		}
	};
}

async function expectZipMember(name: string, bytes: Uint8Array, expected: Uint8Array): Promise<void> {
	await withFile("generated.zip", bytes, async file => {
		const archive = await openArchive(file);
		expect(archive.getNode(name)?.path).toBe(name);
		expect([...(await archive.readFile(name)).bytes]).toEqual([...expected]);
	});
}

async function expectInvalidZip(bytes: Uint8Array): Promise<void> {
	await withFile("generated-invalid.zip", bytes, async file => {
		await expect(openArchive(file)).rejects.toThrow(/Invalid ZIP archive/);
	});
}

describe("openArchive inflate caps", () => {
	test(
		"still allows a small zip member",
		noted("still allows a small zip member", async () => {
			const bytes = zipSync({ "src/hello.txt": new TextEncoder().encode("hello") });
			await withFile("ok.zip", bytes, async file => {
				const archive = await openArchive(file);
				const entry = await archive.readFile("src/hello.txt");
				expect(new TextDecoder().decode(entry.bytes)).toBe("hello");
				expect(archive.listDirectory("src").map(item => item.name)).toContain("hello.txt");
			});
		}),
	);

	test(
		"rejects a ZIP ending after a complete local member without an end directory",
		noted("rejects a ZIP ending after a complete local member without an end directory", async () => {
			const bytes = zipSync({ "complete.txt": new TextEncoder().encode("complete") }, { level: 0 });
			const view = zipView(bytes);
			const localEnd = 30 + view.getUint16(26, true) + view.getUint16(28, true) + view.getUint32(18, true);
			await withFile("missing-directory.zip", bytes.subarray(0, localEnd), async file => {
				await expect(openArchive(file)).rejects.toThrow(/Invalid ZIP archive/);
			});
		}),
	);

	test(
		"rejects a ZIP truncated partway through its central directory",
		noted("rejects a ZIP truncated partway through its central directory", async () => {
			const bytes = zipSync(
				{
					"first.txt": new TextEncoder().encode("first"),
					"second.txt": new TextEncoder().encode("second"),
				},
				{ level: 0 },
			);
			const view = zipView(bytes);
			const eocdOffset = bytes.byteLength - 22;
			const centralOffset = view.getUint32(eocdOffset + 16, true);
			const firstCentralLength =
				46 + view.getUint16(centralOffset + 28, true) + view.getUint16(centralOffset + 30, true);
			const partialDirectoryEnd = centralOffset + firstCentralLength + 8;
			const truncated = concat([bytes.subarray(0, partialDirectoryEnd), bytes.subarray(eocdOffset)]);
			await withFile("partial-directory.zip", truncated, async file => {
				await expect(openArchive(file)).rejects.toThrow(/Invalid ZIP archive/);
			});
		}),
	);

	test(
		"rejects a ZIP whose end record entry count disagrees with its directory",
		noted("rejects a ZIP whose end record entry count disagrees with its directory", async () => {
			const bytes = zipSync({ "one.txt": new TextEncoder().encode("one") });
			const corrupted = bytes.slice();
			const view = zipView(corrupted);
			view.setUint16(corrupted.byteLength - 12, 2, true);
			await withFile("inconsistent-count.zip", corrupted, async file => {
				await expect(openArchive(file)).rejects.toThrow(/Invalid ZIP archive/);
			});
		}),
	);

	test(
		"finds the actual end record before thousands of count-matching comment records",
		noted("finds the actual end record before thousands of count-matching comment records", async () => {
			const files = Object.fromEntries(
				Array.from({ length: COUNT_LIMIT }, (_, index) => [`entry-${index}.txt`, new Uint8Array(0)]),
			);
			const bytes = zipSync(files);
			const eocdOffset = bytes.byteLength - 22;
			const bytesWithComment = bytes.slice();
			const fakeRecordCount = Math.floor(65_516 / 22);
			const comment = new Uint8Array(fakeRecordCount * 22);
			zipView(bytesWithComment).setUint16(eocdOffset + 20, comment.byteLength, true);
			for (let index = 0; index < fakeRecordCount; index++) {
				const recordOffset = index * 22;
				const fakeEndRecord = comment.subarray(recordOffset, recordOffset + 22);
				const fakeView = zipView(fakeEndRecord);
				fakeView.setUint32(0, 0x06054b50, true);
				fakeView.setUint16(8, COUNT_LIMIT, true);
				fakeView.setUint16(10, COUNT_LIMIT, true);
				fakeView.setUint16(20, comment.byteLength - recordOffset - 22, true);
			}
			await withFile("count-matching-comments.zip", concat([bytesWithComment, comment]), async file => {
				const archive = await openArchive(file);
				expect((await archive.readFile("entry-0.txt")).bytes).toEqual(new Uint8Array(0));
			});
		}),
	);

	test(
		"ignores comment directories that point into a stored member",
		noted("ignores comment directories that point into a stored member", async () => {
			const { bytes, memberBytes } = zipWithEmbeddedMemberDirectories();
			await withFile("embedded-comment-directories.zip", bytes, async file => {
				const archive = await openArchive(file);
				expect([...(await archive.readFile("outer.bin")).bytes]).toEqual([...memberBytes]);
			});
		}),
	);

	test(
		"rejects a central directory name that disagrees with its local header",
		noted("rejects a central directory name that disagrees with its local header", async () => {
			const bytes = zipSync({ "one.txt": new TextEncoder().encode("one") });
			const corrupted = bytes.slice();
			const view = zipView(corrupted);
			const eocdOffset = corrupted.byteLength - 22;
			const centralOffset = view.getUint32(eocdOffset + 16, true);
			corrupted[centralOffset + 46] = (corrupted[centralOffset + 46] ?? 0) ^ 1;
			await withFile("inconsistent-name.zip", corrupted, async file => {
				await expect(openArchive(file)).rejects.toThrow(/Invalid ZIP archive/);
			});
		}),
	);

	test(
		"still allows a ZIP64 archive with matching local and central records",
		noted("still allows a ZIP64 archive with matching local and central records", async () => {
			const content = new TextEncoder().encode("zip64 member");
			const bytes = zip64SingleEntry("zip64.txt", content);
			await withFile("valid-zip64.zip", bytes, async file => {
				const archive = await openArchive(file);
				expect(new TextDecoder().decode((await archive.readFile("zip64.txt")).bytes)).toBe("zip64 member");
			});
		}),
	);

	test(
		"holds fixed-seed generated ZIP and ZIP64 directory properties (seed 0x6847d17b)",
		noted("holds fixed-seed generated ZIP and ZIP64 directory properties (seed 0x6847d17b)", async () => {
			const random = seededRandom(0x6847d17b);
			for (let caseIndex = 0; caseIndex < 8; caseIndex++) {
				const name = `member-${caseIndex}-${randomAscii(random, 6)}.bin`;
				const payload = randomBytes(random, randomInteger(random, 1, 64));
				const plain = zipSync({ [name]: payload }, { level: caseIndex % 2 === 0 ? 0 : 6 });
				const descriptor = zipUnknownSize([{ name, data: payload }]);
				const plainExtra = addZipExtraField(
					plain,
					0xcafe + caseIndex,
					randomBytes(random, randomInteger(random, 0, 8)),
				);
				const descriptorExtra = addZipExtraField(
					descriptor,
					0xbeef - caseIndex,
					randomBytes(random, randomInteger(random, 0, 8)),
				);
				const zip64 = zip64SingleEntry(name, payload, {
					id: 0xd000 + caseIndex,
					data: randomBytes(random, randomInteger(random, 0, 8)),
				});
				const zip64Plain = zip64SingleEntry(name, payload);

				for (const valid of [plain, descriptor, plainExtra, descriptorExtra, zip64]) {
					await expectZipMember(name, valid, payload);
				}

				const plainView = zipView(plain);
				const eocdOffset = plain.byteLength - 22;
				const centralOffset = plainView.getUint32(eocdOffset + 16, true);
				const centralRecordLength =
					46 +
					plainView.getUint16(centralOffset + 28, true) +
					plainView.getUint16(centralOffset + 30, true) +
					plainView.getUint16(centralOffset + 32, true);
				const partialCentralEnd = centralOffset + Math.floor(centralRecordLength / 2);
				const truncatedCentral = concat([plain.subarray(0, partialCentralEnd), plain.subarray(eocdOffset)]);
				const wrongCount = plain.slice();
				zipView(wrongCount).setUint16(eocdOffset + 10, 2, true);
				const wrongCentralOffset = plain.slice();
				zipView(wrongCentralOffset).setUint32(eocdOffset + 16, centralOffset + 1, true);
				const wrongCentralLength = plain.slice();
				zipView(wrongCentralLength).setUint16(
					centralOffset + 30,
					plainView.getUint16(centralOffset + 30, true) + 1,
					true,
				);
				const wrongLocalNameLength = plain.slice();
				zipView(wrongLocalNameLength).setUint16(26, plainView.getUint16(26, true) + 1, true);
				const wrongLocalSize = plain.slice();
				zipView(wrongLocalSize).setUint32(18, plainView.getUint32(18, true) + 1, true);

				const descriptorView = zipView(descriptor);
				const descriptorEocdOffset = descriptor.byteLength - 22;
				const descriptorCentralOffset = descriptorView.getUint32(descriptorEocdOffset + 16, true);
				const wrongDescriptor = descriptor.slice();
				wrongDescriptor[descriptorCentralOffset - 1] = (wrongDescriptor[descriptorCentralOffset - 1] ?? 0) ^ 1;

				const zip64View = zipView(zip64Plain);
				const zip64EndOffset = zip64EndRecordOffset(zip64Plain);
				const zip64CentralOffset = Number(zip64View.getBigUint64(zip64EndOffset + 48, true));
				const zip64NameLength = zip64View.getUint16(zip64CentralOffset + 28, true);
				const zip64ExtraStart = zip64CentralOffset + 46 + zip64NameLength;
				const wrongZip64Offset = zip64Plain.slice();
				zipView(wrongZip64Offset).setBigUint64(zip64ExtraStart + 4 + 16, 1n, true);
				const wrongZip64Count = zip64Plain.slice();
				zipView(wrongZip64Count).setBigUint64(zip64EndOffset + 32, 2n, true);
				const truncatedZip64 = zip64Plain.subarray(0, zip64CentralOffset);

				for (const invalid of [
					plain.subarray(0, zipLocalRecordEnd(plain)),
					truncatedCentral,
					wrongCount,
					wrongCentralOffset,
					wrongCentralLength,
					wrongLocalNameLength,
					wrongLocalSize,
					wrongDescriptor,
					wrongZip64Offset,
					wrongZip64Count,
					truncatedZip64,
				]) {
					await expectInvalidZip(invalid);
				}
			}
		}),
		20_000,
	);

	test(
		"rejects one entry that inflates past the per-entry cap",
		noted("rejects one entry that inflates past the per-entry cap", async () => {
			const bytes = zipUnknownSize([{ name: "bomb.txt", data: new Uint8Array(ENTRY_LIMIT + 1) }]);
			await withFile("entry.zip", bytes, async file => {
				await expect(openArchive(file)).rejects.toThrow(/per-entry limit/);
			});
		}),
		20_000,
	);

	test(
		"stops high-ratio deflate inflation at the per-entry cap before a malformed tail",
		noted("stops high-ratio deflate inflation at the per-entry cap before a malformed tail", async () => {
			const inflated = new Uint8Array(64 * 1024 * 1024);
			const deflateStream = deflateRawSync(inflated, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
			const compressed = concat([deflateStream, Uint8Array.of(0x06)]);
			expect(compressed.byteLength).toBeGreaterThan(512);
			const bytes = zipDeflateWithDeclaredSize("bomb.txt", compressed, ENTRY_LIMIT);
			await withFile("high-ratio.zip", bytes, async file => {
				await expect(openArchive(file)).rejects.toThrow(/per-entry limit/);
			});
		}),
		20_000,
	);

	test(
		"rejects a total inflate past the cap when each entry is under it",
		noted("rejects a total inflate past the cap when each entry is under it", async () => {
			const part = new Uint8Array(15 * 1024 * 1024);
			const bytes = zipUnknownSize(
				Array.from({ length: 5 }, (_, index) => ({ name: `part-${index}.bin`, data: part })),
			);
			expect(part.byteLength).toBeLessThan(ENTRY_LIMIT);
			expect(part.byteLength * 5).toBeGreaterThan(TOTAL_LIMIT);
			await withFile("total.zip", bytes, async file => {
				await expect(openArchive(file)).rejects.toThrow(/total limit/);
			});
		}),
		20_000,
	);

	test(
		"rejects an archive with too many entries",
		noted("rejects an archive with too many entries", async () => {
			const files: Record<string, Uint8Array> = {};
			for (let index = 0; index < COUNT_LIMIT + 1; index++) files[`f${index}.txt`] = new Uint8Array(0);
			await withFile("count.zip", zipSync(files, { level: 0 }), async file => {
				await expect(openArchive(file)).rejects.toThrow(/too many entries/);
			});
		}),
	);

	test(
		"rejects an entry nested past the depth cap",
		noted("rejects an entry nested past the depth cap", async () => {
			const deepParts = Array.from({ length: DEPTH_LIMIT + 1 }, (_, index) => `d${index}`);
			deepParts[DEPTH_LIMIT] = `${deepParts[DEPTH_LIMIT]}.txt`;
			const name = deepParts.join("/");
			await withFile("deep.zip", zipSync({ [name]: new Uint8Array([1]) }, { level: 0 }), async file => {
				await expect(openArchive(file)).rejects.toThrow(/nested too deeply/);
			});
		}),
	);

	test(
		"still allows a shallow entry under every cap",
		noted("still allows a shallow entry under every cap", async () => {
			const name = "d0/d1.txt";
			await withFile("shallow.zip", zipSync({ [name]: new TextEncoder().encode("ok") }), async file => {
				const archive = await openArchive(file);
				expect(new TextDecoder().decode((await archive.readFile(name)).bytes)).toBe("ok");
			});
		}),
	);

	test(
		"still allows a small tar.gz member",
		noted("still allows a small tar.gz member", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-tar-"));
			try {
				await writeFile(path.join(dir, "hello.txt"), "hello");
				const archivePath = path.join(dir, "ok.tar.gz");
				await exec("tar", ["-czf", archivePath, "-C", dir, "hello.txt"]);
				const archive = await openArchive(archivePath);
				expect(new TextDecoder().decode((await archive.readFile("hello.txt")).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects a tar.gz that inflates past the total cap",
		noted("rejects a tar.gz that inflates past the total cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-tarbomb-"));
			try {
				const big = path.join(dir, "big.bin");
				await writeFile(big, new Uint8Array(TOTAL_LIMIT + 1));
				const archivePath = path.join(dir, "bomb.tar.gz");
				await exec("tar", ["-czf", archivePath, "-C", dir, "big.bin"]);
				await expect(openArchive(archivePath)).rejects.toThrow(/total limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		20_000,
	);

	test(
		"still allows a crafted ustar member",
		noted("still allows a crafted ustar member", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-ustar-"));
			try {
				const archivePath = path.join(dir, "ok.tar");
				const body = new TextEncoder().encode("hello");
				await writeUstar(archivePath, async push => {
					await push(ustarHeader("hello.txt", body.byteLength));
					await push(body);
					await push(new Uint8Array((512 - (body.byteLength % 512)) % 512));
				});
				const archive = await openArchive(archivePath);
				expect(new TextDecoder().decode((await archive.readFile("hello.txt")).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"still allows a small gzip payload with a tar name",
		noted("still allows a small gzip payload with a tar name", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gzname-"));
			try {
				await writeFile(path.join(dir, "hello.txt"), "hello");
				const gzipPath = path.join(dir, "ok.tar.gz");
				await exec("tar", ["-czf", gzipPath, "-C", dir, "hello.txt"]);
				const namedTar = path.join(dir, "ok.tar");
				await writeFile(namedTar, await Bun.file(gzipPath).bytes());
				const archive = await openArchive(namedTar);
				expect(new TextDecoder().decode((await archive.readFile("hello.txt")).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects gzip bytes in a tar name past the total cap",
		noted("rejects gzip bytes in a tar name past the total cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gztar-"));
			try {
				await writeFile(path.join(dir, "big.bin"), new Uint8Array(TOTAL_LIMIT + 1));
				const gzipPath = path.join(dir, "bomb.tar.gz");
				await exec("tar", ["-czf", gzipPath, "-C", dir, "big.bin"]);
				const namedTar = path.join(dir, "bomb.tar");
				await writeFile(namedTar, await Bun.file(gzipPath).bytes());
				await expect(openArchive(namedTar)).rejects.toThrow(/total limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"still allows a small tar under two gzip wrappers",
		noted("still allows a small tar under two gzip wrappers", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gz2-"));
			try {
				await writeFile(path.join(dir, "hello.txt"), "hello");
				const once = path.join(dir, "once.tar.gz");
				await exec("tar", ["-czf", once, "-C", dir, "hello.txt"]);
				const twice = path.join(dir, "twice.tar.gz");
				await writeFile(twice, gzipSync(await Bun.file(once).bytes()));
				const archive = await openArchive(twice);
				expect(new TextDecoder().decode((await archive.readFile("hello.txt")).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"still allows a small tar under 24 gzip wrappers",
		noted("still allows a small tar under 24 gzip wrappers", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gz24-"));
			try {
				await writeFile(path.join(dir, "hello.txt"), "hello");
				const raw = path.join(dir, "ok.tar");
				await exec("tar", ["-cf", raw, "-C", dir, "hello.txt"]);
				let wrapped = await Bun.file(raw).bytes();
				for (let layer = 0; layer < 24; layer++) wrapped = gzipSync(wrapped);
				const archivePath = path.join(dir, "wrapped.tar.gz");
				await writeFile(archivePath, wrapped);
				const archive = await openArchive(archivePath);
				expect(new TextDecoder().decode((await archive.readFile("hello.txt")).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects a 25th gzip wrapper",
		noted("rejects a 25th gzip wrapper", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gz25-"));
			try {
				await writeFile(path.join(dir, "hello.txt"), "hello");
				const raw = path.join(dir, "ok.tar");
				await exec("tar", ["-cf", raw, "-C", dir, "hello.txt"]);
				let wrapped = await Bun.file(raw).bytes();
				for (let layer = 0; layer < 25; layer++) wrapped = gzipSync(wrapped);
				const archivePath = path.join(dir, "wrapped.tar.gz");
				await writeFile(archivePath, wrapped);
				await expect(openArchive(archivePath)).rejects.toThrow(/total limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects a second gzip wrapper past the total cap",
		noted("rejects a second gzip wrapper past the total cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gz2bomb-"));
			try {
				await writeFile(path.join(dir, "big.bin"), new Uint8Array(TOTAL_LIMIT + 1));
				const once = path.join(dir, "once.tar.gz");
				await exec("tar", ["-czf", once, "-C", dir, "big.bin"]);
				const twice = path.join(dir, "twice.tar.gz");
				await writeFile(twice, gzipSync(await Bun.file(once).bytes()));
				await expect(openArchive(twice)).rejects.toThrow(/total limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"rejects directory-only tar entries past the count cap",
		noted("rejects directory-only tar entries past the count cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-dircount-"));
			try {
				const archivePath = path.join(dir, "dirs.tar");
				const headers: Uint8Array[] = [];
				for (let index = 0; index < COUNT_LIMIT + 1; index++) headers.push(ustarHeader(`d${index}/`, 0, "5"));
				await writeUstarBytes(archivePath, headers);
				await expect(openArchive(archivePath)).rejects.toThrow(/too many entries/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		20_000,
	);

	test(
		"still allows a directory-only tar at the count cap",
		noted("still allows a directory-only tar at the count cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-dirkeep-"));
			try {
				const archivePath = path.join(dir, "dirs.tar");
				const headers: Uint8Array[] = [];
				for (let index = 0; index < COUNT_LIMIT; index++) headers.push(ustarHeader(`d${index}/`, 0, "5"));
				await writeUstarBytes(archivePath, headers);
				await openArchive(archivePath);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		20_000,
	);

	test(
		"rejects a directory-only tar nested past the depth cap",
		noted("rejects a directory-only tar nested past the depth cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-dirdeep-"));
			try {
				const archivePath = path.join(dir, "deep.tar");
				const name = "a/".repeat(DEPTH_LIMIT + 1);
				await writeUstar(archivePath, async push => {
					await push(ustarHeader(name, 0, "5"));
				});
				await expect(openArchive(archivePath)).rejects.toThrow(/nested too deeply/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"still allows a tar member at the depth cap",
		noted("still allows a tar member at the depth cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-tardepth-"));
			try {
				const archivePath = path.join(dir, "deep.tar");
				const name = `${"a/".repeat(DEPTH_LIMIT - 1)}f.txt`;
				await writeUstar(archivePath, async push => {
					await push(ustarHeader(name, 1));
					await push(new Uint8Array([65]));
					await push(new Uint8Array(511));
				});
				const archive = await openArchive(archivePath);
				expect((await archive.readFile(name)).bytes[0]).toBe(65);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects duplicate tar paths past the count cap",
		noted("rejects duplicate tar paths past the count cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-dup-"));
			try {
				const archivePath = path.join(dir, "dup.tar");
				const headers: Uint8Array[] = [];
				for (let index = 0; index < COUNT_LIMIT + 1; index++) headers.push(ustarHeader("a.txt", 0));
				await writeUstarBytes(archivePath, headers);
				await expect(openArchive(archivePath)).rejects.toThrow(/too many entries/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		20_000,
	);

	test(
		"rejects a tar entry from its declared size before the body",
		noted("rejects a tar entry from its declared size before the body", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-decl-"));
			try {
				const archivePath = path.join(dir, "declared.tar");
				await writeUstar(archivePath, async push => {
					await push(ustarHeader("big.bin", ENTRY_LIMIT + 1));
				});
				await expect(openArchive(archivePath)).rejects.toThrow(/per-entry limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"still allows four max-size tar members",
		noted("still allows four max-size tar members", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-four-"));
			try {
				const archivePath = path.join(dir, "four.tar");
				const chunk = new Uint8Array(1024 * 1024);
				await writeUstar(archivePath, async push => {
					for (let index = 0; index < 4; index++) {
						await push(ustarHeader(`p${index}.bin`, ENTRY_LIMIT));
						let left = ENTRY_LIMIT;
						while (left > 0) {
							const n = Math.min(chunk.byteLength, left);
							await push(chunk.subarray(0, n));
							left -= n;
						}
					}
				});
				const archive = await openArchive(archivePath);
				expect((await archive.readFile("p0.bin")).bytes.byteLength).toBe(ENTRY_LIMIT);
				expect((await archive.readFile("p3.bin")).bytes.byteLength).toBe(ENTRY_LIMIT);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"still allows four max-size tar.gz members",
		noted("still allows four max-size tar.gz members", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-fourgz-"));
			try {
				const rawPath = path.join(dir, "four.tar");
				const chunk = new Uint8Array(1024 * 1024);
				await writeUstar(rawPath, async push => {
					for (let index = 0; index < 4; index++) {
						await push(ustarHeader(`p${index}.bin`, ENTRY_LIMIT));
						let left = ENTRY_LIMIT;
						while (left > 0) {
							const n = Math.min(chunk.byteLength, left);
							await push(chunk.subarray(0, n));
							left -= n;
						}
					}
				});
				const gzipPath = path.join(dir, "four.tar.gz");
				await exec("gzip", ["-c", "-n", rawPath], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }).then(
					async result => {
						await writeFile(gzipPath, result.stdout);
					},
				);
				const archive = await openArchive(gzipPath);
				expect((await archive.readFile("p0.bin")).bytes.byteLength).toBe(ENTRY_LIMIT);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"rejects a malformed pax record",
		noted("rejects a malformed pax record", async () => {
			const bodies = ["0 path=x\n", "-1 path=\n", "1a path=\n", "4 a\n=x\n", "8 path=x"];
			for (const body of bodies) {
				const dir = await mkdtemp(path.join(tmpdir(), "archive-badpax-"));
				try {
					const archivePath = path.join(dir, "bad.tar");
					const bytes = new TextEncoder().encode(body);
					await writeUstar(archivePath, async push => {
						await push(ustarHeader("paxheader", bytes.byteLength, "x"));
						await push(pad512(bytes));
					});
					const result = await openInChild(archivePath);
					expect(result.timedOut).toBe(false);
					expect(result.output).toContain("REJECTED");
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			}
		}),
		20_000,
	);

	test(
		"still allows a pax long path",
		noted("still allows a pax long path", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-pax-"));
			try {
				const archivePath = path.join(dir, "long.tar");
				const name = `${"a".repeat(120)}.txt`;
				const records = paxRecords([["path", name]]);
				const hello = new TextEncoder().encode("hello");
				await writeUstar(archivePath, async push => {
					await push(ustarHeader("paxheader", records.byteLength, "x"));
					await push(pad512(records));
					await push(ustarHeader(name.slice(0, 100), hello.byteLength));
					await push(pad512(hello));
				});
				const archive = await openArchive(archivePath);
				expect(archive.listDirectory().map(item => item.name)).toContain(name);
				expect(new TextDecoder().decode((await archive.readFile(name)).bytes)).toBe("hello");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"rejects a pax path nested past the depth cap",
		noted("rejects a pax path nested past the depth cap", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-paxdeep-"));
			try {
				const archivePath = path.join(dir, "deep.tar");
				const name = `${"d/".repeat(DEPTH_LIMIT)}f.txt`;
				const records = paxRecords([["path", name]]);
				await writeUstar(archivePath, async push => {
					await push(ustarHeader("paxheader", records.byteLength, "x"));
					await push(pad512(records));
					await push(ustarHeader("f.txt", 1));
					await push(pad512(new Uint8Array([65])));
				});
				await expect(openArchive(archivePath)).rejects.toThrow(/nested too deeply/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"still allows the last zip member when names repeat",
		noted("still allows the last zip member when names repeat", async () => {
			const bytes = zipUnknownSize([
				{ name: "a.txt", data: new TextEncoder().encode("old") },
				{ name: "a.txt", data: new TextEncoder().encode("newer") },
			]);
			await withFile("dup.zip", bytes, async file => {
				const archive = await openArchive(file);
				const entry = await archive.readFile("a.txt");
				expect(new TextDecoder().decode(entry.bytes)).toBe("newer");
				expect(entry.bytes.byteLength).toBe(5);
			});
		}),
	);

	test(
		"rejects duplicate zip names past the total cap",
		noted("rejects duplicate zip names past the total cap", async () => {
			const part = new Uint8Array(15 * 1024 * 1024);
			const bytes = zipUnknownSize(Array.from({ length: 5 }, () => ({ name: "a.bin", data: part })));
			expect(part.byteLength).toBeLessThan(ENTRY_LIMIT);
			expect(part.byteLength * 5).toBeGreaterThan(TOTAL_LIMIT);
			await withFile("dup-total.zip", bytes, async file => {
				await expect(openArchive(file)).rejects.toThrow(/total limit/);
			});
		}),
		20_000,
	);

	test(
		"rejects duplicate zip names past the count cap",
		noted("rejects duplicate zip names past the count cap", async () => {
			const files = Array.from({ length: COUNT_LIMIT + 1 }, () => ({ name: "a.txt", data: new Uint8Array(0) }));
			await withFile("dup-count.zip", zipUnknownSize(files), async file => {
				await expect(openArchive(file)).rejects.toThrow(/too many entries/);
			});
		}),
		20_000,
	);

	test(
		"still allows an empty deflate member at the total cap",
		noted("still allows an empty deflate member at the total cap", async () => {
			const part = new Uint8Array(ENTRY_LIMIT);
			const bytes = zipUnknownSize([
				...Array.from({ length: 4 }, (_, index) => ({ name: `p${index}.bin`, data: part })),
				{ name: "empty.txt", data: new Uint8Array(0) },
			]);
			await withFile("exact.zip", bytes, async file => {
				const archive = await openArchive(file);
				expect((await archive.readFile("empty.txt")).bytes.byteLength).toBe(0);
				expect((await archive.readFile("p3.bin")).bytes.byteLength).toBe(ENTRY_LIMIT);
			});
		}),
		60_000,
	);

	test(
		"rejects one byte after the total cap",
		noted("rejects one byte after the total cap", async () => {
			const part = new Uint8Array(ENTRY_LIMIT);
			const bytes = zipUnknownSize([
				...Array.from({ length: 4 }, (_, index) => ({ name: `p${index}.bin`, data: part })),
				{ name: "extra.txt", data: new Uint8Array([1]) },
			]);
			await withFile("over.zip", bytes, async file => {
				await expect(openArchive(file)).rejects.toThrow(/total limit/);
			});
		}),
		60_000,
	);

	test(
		"accepts tar members at the advertised byte limit with block padding",
		noted("accepts tar members at the advertised byte limit with block padding", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-tar-padding-"));
			try {
				const archivePath = path.join(dir, "padding.tar");
				const shortBody = new Uint8Array(8191);
				const longBody = new Uint8Array(8193);
				await writeUstar(archivePath, async push => {
					for (let index = 0; index < COUNT_LIMIT; index++) {
						const body = index % 2 === 0 ? shortBody : longBody;
						await push(ustarHeader(`f${index}.bin`, body.byteLength));
						await push(body);
						await push(new Uint8Array(index % 2 === 0 ? 1 : 511));
					}
				});

				expect(Bun.file(archivePath).size).toBe(70 * 1024 * 1024 + 1024);
				const archive = await openArchive(archivePath);
				expect(archive.listDirectory()).toHaveLength(COUNT_LIMIT);
				expect((await archive.readFile("f0.bin")).bytes.byteLength).toBe(8191);
				expect((await archive.readFile("f8191.bin")).bytes.byteLength).toBe(8193);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"stops gzip output at the TAR container ceiling",
		noted("stops gzip output at the TAR container ceiling", async () => {
			const overLimit = gzipSync(new Uint8Array(TAR_CONTAINER_LIMIT + 1));
			await withFile("over-limit.tar.gz", overLimit, async file => {
				await expect(openArchive(file)).rejects.toThrow(/total limit/);
			});
		}),
		60_000,
	);

	test(
		"bounds cumulative output across nested gzip layers",
		noted("bounds cumulative output across nested gzip layers", async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "archive-gzip-cumulative-"));
			try {
				const rawPath = path.join(dir, "inner.tar");
				const member = new Uint8Array(15 * 1024 * 1024);
				await writeUstar(rawPath, async push => {
					for (let index = 0; index < 2; index++) {
						await push(ustarHeader(`part-${index}.bin`, member.byteLength));
						await push(member);
					}
				});

				const innerGzip = gzipSync(await Bun.file(rawPath).bytes());
				const intermediate = new Uint8Array(45 * 1024 * 1024);
				intermediate.set(innerGzip);
				const outerGzip = gzipSync(intermediate);
				const archivePath = path.join(dir, "nested.tar.gz");
				await writeFile(archivePath, outerGzip);
				await expect(openArchive(archivePath)).rejects.toThrow(/total limit/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
		60_000,
	);

	test(
		"fixed-seed generated PAX metadata preserves paths, sizes, and member bytes",
		noted("fixed-seed generated PAX metadata preserves paths, sizes, and member bytes", async () => {
			const random = seededRandom(0x6847_2026);
			const boundaryCommentLengths = [86, 87, 88, 986, 987, 988];
			const chunks: Uint8Array[] = [];
			const expected: Array<{ path: string; bytes: Uint8Array }> = [];
			const makePath = (kind: string, index: number): string => {
				const depth = randomInteger(random, 1, DEPTH_LIMIT);
				const parts = Array.from({ length: depth - 1 }, (_, part) => `d${index}-${part}`);
				parts.push(`${kind}-${index}-${randomAscii(random, 8)}.bin`);
				return parts.join("/");
			};
			const addOverriddenFile = (kind: string, index: number, global: boolean, commentLength: number) => {
				const archivePath = makePath(kind, index);
				const body = randomBytes(random, randomInteger(random, 0, 512));
				appendPaxHeader(
					chunks,
					[
						["comment", randomAscii(random, commentLength)],
						["path", archivePath],
						["size", String(body.byteLength)],
					],
					global ? "g" : "x",
				);
				appendTarFile(chunks, `base-${kind}-${index}`, body);
				expected.push({ path: archivePath, bytes: body });
			};

			for (let index = 0; index < 24; index++) {
				const boundaryLength = boundaryCommentLengths[index % boundaryCommentLengths.length];
				addOverriddenFile("global", index, true, boundaryLength ?? 0);
				addOverriddenFile("local", index, false, randomInteger(random, 0, 256));
				addOverriddenFile("global-next", index, true, randomInteger(random, 0, 256));
			}

			const dir = await mkdtemp(path.join(tmpdir(), "archive-pax-properties-"));
			try {
				const archivePath = path.join(dir, "generated.tar");
				await writeUstarBytes(archivePath, chunks);
				const archive = await openArchive(archivePath);
				for (const entry of expected) {
					const actual = await archive.readFile(entry.path);
					expect(actual.path).toBe(entry.path);
					expect(actual.size).toBe(entry.bytes.byteLength);
					expect(actual.bytes).toEqual(entry.bytes);
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"empty global PAX values clear inherited path and size",
		noted("empty global PAX values clear inherited path and size", async () => {
			const chunks: Uint8Array[] = [];
			appendPaxHeader(
				chunks,
				[
					["path", "inherited.bin"],
					["size", "1"],
				],
				"g",
			);
			appendTarFile(chunks, "first-header.bin", Uint8Array.of(0x11));
			appendPaxHeader(
				chunks,
				[
					["path", ""],
					["size", ""],
				],
				"g",
			);
			const fallbackBytes = Uint8Array.of(0x22, 0x33);
			appendTarFile(chunks, "fallback.bin", fallbackBytes);

			const dir = await mkdtemp(path.join(tmpdir(), "archive-pax-global-reset-"));
			try {
				const archivePath = path.join(dir, "global-reset.tar");
				await writeUstarBytes(archivePath, chunks);
				const archive = await openArchive(archivePath);
				const inherited = await archive.readFile("inherited.bin");
				const fallback = await archive.readFile("fallback.bin");
				expect(inherited.bytes).toEqual(Uint8Array.of(0x11));
				expect(fallback.path).toBe("fallback.bin");
				expect(fallback.size).toBe(fallbackBytes.byteLength);
				expect(fallback.bytes).toEqual(fallbackBytes);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"fixed-seed generated malformed PAX boundaries terminate with rejection",
		noted("fixed-seed generated malformed PAX boundaries terminate with rejection", async () => {
			const random = seededRandom(0x6847_2027);
			const dir = await mkdtemp(path.join(tmpdir(), "archive-pax-malformed-properties-"));
			try {
				for (let index = 0; index < 32; index++) {
					const pathValue = `p${index}-${randomAscii(random, randomInteger(random, 1, 120))}`;
					const validRecord = paxRecords([["path", pathValue]]);
					const separator = validRecord.indexOf(32);
					const validLength = Number(new TextDecoder().decode(validRecord.subarray(0, separator)));
					const suffix = new TextDecoder().decode(validRecord.subarray(separator));
					const wrongLength = validLength + (index % 2 === 0 ? -1 : 1);
					const malformedRecord = new TextEncoder().encode(`${wrongLength}${suffix}`);
					const chunks = [ustarHeader("paxheader", malformedRecord.byteLength, "x"), pad512(malformedRecord)];
					const archivePath = path.join(dir, `malformed-${index}.tar`);
					await writeUstarBytes(archivePath, chunks);
					await expect(openArchive(archivePath)).rejects.toThrow(/Unsupported tar pax header/);
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);

	test(
		"fixed-seed generated PAX overrides cannot bypass effective size or path limits",
		noted("fixed-seed generated PAX overrides cannot bypass effective size or path limits", async () => {
			const random = seededRandom(0x6847_2028);
			const dir = await mkdtemp(path.join(tmpdir(), "archive-pax-limit-properties-"));
			try {
				for (let index = 0; index < 16; index++) {
					const chunks: Uint8Array[] = [];
					const overriddenSize = ENTRY_LIMIT + 1 + randomInteger(random, 0, 1024);
					appendPaxHeader(chunks, [
						["path", `large-${index}-${randomAscii(random, 8)}.bin`],
						["size", String(overriddenSize)],
					]);
					appendTarFile(chunks, `small-header-${index}.bin`, new Uint8Array(0));
					const archivePath = path.join(dir, `oversized-${index}.tar`);
					await writeUstarBytes(archivePath, chunks);
					await expect(openArchive(archivePath)).rejects.toThrow(/per-entry limit/);
				}

				for (let index = 0; index < 8; index++) {
					const depth = randomInteger(random, DEPTH_LIMIT + 1, DEPTH_LIMIT + 16);
					const longPath = Array.from({ length: depth }, (_, part) => `${part}-${randomAscii(random, 128)}`).join(
						"/",
					);
					const chunks: Uint8Array[] = [];
					appendPaxHeader(chunks, [
						["path", longPath],
						["size", "0"],
					]);
					appendTarFile(chunks, `depth-${index}.bin`, new Uint8Array(0));
					const archivePath = path.join(dir, `deep-${index}.tar`);
					await writeUstarBytes(archivePath, chunks);
					let rejection: unknown;
					try {
						await openArchive(archivePath);
					} catch (error) {
						rejection = error;
					}
					expect(rejection).toBeInstanceOf(Error);
					if (!(rejection instanceof Error)) throw new Error("expected depth-limit rejection");
					expect(rejection.message).toMatch(/nested too deeply/);
					expect(rejection.message.length).toBeLessThan(300);
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}),
	);
	test(
		"still allows a stored ZIP with an unsigned data descriptor",
		noted("still allows a stored ZIP with an unsigned data descriptor", async () => {
			const payload = new TextEncoder().encode("hello");
			await withFile("unsigned-descriptor.zip", unsignedStoredZip("hello.txt", payload), async file => {
				const entry = await (await openArchive(file)).readFile("hello.txt");
				expect(new TextDecoder().decode(entry.bytes)).toBe("hello");
				expect(entry.bytes).toEqual(payload);
			});
		}),
	);

	test(
		"fixed-seed generated ZIP and ZIP64 members preserve names and bytes",
		noted("fixed-seed generated ZIP and ZIP64 members preserve names and bytes", async () => {
			const random = seededRandom(0x6847_2111);
			for (let index = 0; index < 64; index++) {
				const count = index % 5 === 0 ? 2 : 1;
				const members = Array.from({ length: count }, (_, ordinal) => generatedZipMember(random, index, ordinal));
				const built = buildGeneratedZip(members, index % 3 === 0, random);
				await expectZipMembers(built.bytes, built.members, `zip-prop-${index}`);
			}
		}),
	);

	test(
		"fixed-seed generated ZIP truncation and inconsistent records reject",
		noted("fixed-seed generated ZIP truncation and inconsistent records reject", async () => {
			const random = seededRandom(0x6847_2112);
			for (let index = 0; index < 64; index++) {
				const member = generatedZipMember(random, index, 0);
				const built = buildGeneratedZip([member], index % 2 === 0, random);
				const mutated = mutateGeneratedZip(built, index);
				await withFile(`zip-bad-${index}.zip`, mutated, async file => {
					await expect(openArchive(file), `zip-bad-${index}`).rejects.toThrow(/Invalid ZIP archive/);
				});
			}
		}),
	);
});
