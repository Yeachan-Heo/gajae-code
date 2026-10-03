import { vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function pauseManagedStagingWriter(directory: string): {
	entered: Promise<void>;
	release: () => void;
	restore: () => void;
} {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const restoreWrites: Array<() => void> = [];
	const open = fs.open;
	const spy = vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
		const handle = await open(pathname, flags, mode);
		if (
			typeof pathname === "string" &&
			pathname.startsWith(`${directory}${path.sep}`) &&
			pathname.endsWith(".staging")
		) {
			const delayedWrite = new Proxy(handle.write, {
				apply(target, _receiver: unknown, args: unknown[]): Promise<unknown> {
					entered.resolve();
					return release.promise.then(() => Reflect.apply(target, handle, args));
				},
			});
			const writeSpy = vi.spyOn(handle, "write").mockImplementation(delayedWrite);
			restoreWrites.push(() => writeSpy.mockRestore());
		}
		return handle;
	});
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		restore: () => {
			spy.mockRestore();
			for (const restore of restoreWrites) restore();
		},
	};
}
