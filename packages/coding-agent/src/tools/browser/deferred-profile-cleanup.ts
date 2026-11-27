/**
 * Profile directories whose removal failed with EBUSY after a failed browser launch.
 *
 * Kept free of `@gajae-code/utils` and native imports because `launch.ts` is part of
 * the tab-worker runtime graph, which must stay native-free. The registry drains this
 * set opportunistically (on browser acquire) once Chrome has released the files.
 */
const deferredProfileDirs = new Set<string>();

export function deferProfileDirCleanup(dir: string): void {
	deferredProfileDirs.add(dir);
}

export function deferredProfileDirSnapshot(): string[] {
	return Array.from(deferredProfileDirs);
}

export function forgetDeferredProfileDir(dir: string): void {
	deferredProfileDirs.delete(dir);
}
