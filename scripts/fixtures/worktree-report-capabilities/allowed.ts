import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

export async function allowed(path: string): Promise<void> {
	let handle: FileHandle;
	handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	await handle.stat({ bigint: true });
	const buffer = Buffer.alloc(1);
	await handle.read(buffer, 0, 1, 0);
	await handle.close();
}
