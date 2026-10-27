/**
 * One authoritative, reference-counted lease for work that still needs a
 * session host. Each admitted work state owns one handle and releases that
 * handle at its terminal boundary; the host only observes whether any handle
 * remains held.
 */
export interface SessionWorkLeaseHandle {
	release(): void;
}

export interface SessionWorkLease {
	acquire(): SessionWorkLeaseHandle;
	isHeld(): boolean;
}

export function createSessionWorkLease(): SessionWorkLease {
	let holders = 0;
	return {
		acquire(): SessionWorkLeaseHandle {
			holders += 1;
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					holders = Math.max(0, holders - 1);
				},
			};
		},
		isHeld(): boolean {
			return holders > 0;
		},
	};
}
