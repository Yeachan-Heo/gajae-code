import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";

const MAX_ENDPOINT_BYTES = 4_096n;

export type EndpointFileRead = {
	source: string;
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	mtimeMs: number;
};

export type EndpointAuthorityFilesystem = Pick<typeof fs, "open">;

export type IndexedEndpointAuthority = {
	endpointMtimeMs?: number;
	endpointFileId?: string;
};

function readFlags(): number {
	return fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0) | (fsSync.constants.O_NONBLOCK ?? 0);
}

/**
 * Reads one endpoint from the descriptor opened for its pathname. The opened
 * object must remain a small, singly-linked regular file with stable identity
 * and metadata for the whole read; a pathname replacement cannot affect the
 * bytes returned by this function.
 */
export async function readEndpointFile(
	filePath: string,
	filesystem: EndpointAuthorityFilesystem = fs,
): Promise<EndpointFileRead | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await filesystem.open(filePath, readFlags());
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.nlink !== 1n || before.size > MAX_ENDPOINT_BYTES) return undefined;
		if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead <= 0) return undefined;
			offset += bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.nlink !== after.nlink ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs
		)
			return undefined;
		return {
			source: bytes.toString("utf8"),
			dev: before.dev,
			ino: before.ino,
			nlink: before.nlink,
			size: before.size,
			mtimeNs: before.mtimeNs,
			mtimeMs: Number(before.mtimeNs) / 1_000_000,
		};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Match a descriptor-bound endpoint read to the index representation. */
export function matchesIndexedEndpointFile(
	file: Pick<EndpointFileRead, "dev" | "ino" | "mtimeMs">,
	authority: IndexedEndpointAuthority,
): boolean {
	if (authority.endpointMtimeMs === undefined || !Number.isFinite(authority.endpointMtimeMs)) return false;
	if (authority.endpointFileId === undefined) return file.mtimeMs === authority.endpointMtimeMs;
	return (
		authority.endpointFileId === `${file.dev}:${file.ino}` &&
		Math.abs(file.mtimeMs - authority.endpointMtimeMs) <= 0.001
	);
}
