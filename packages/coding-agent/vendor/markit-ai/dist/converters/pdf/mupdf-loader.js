let mupdfPromise;

export function loadMuPdf() {
	mupdfPromise ??= import("mupdf").catch(error => {
		mupdfPromise = undefined;
		throw error;
	});
	return mupdfPromise;
}
