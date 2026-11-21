import { expect, test } from "bun:test";

test("includes cloud-sync hint in error message when access_denied and not live holder", () => {
	// This test verifies that the error message includes the cloud-sync hint.
	const errorMessage =
		"Failed to acquire lock for /path after 2 attempts: test holder; last lock publication failed with access_denied (/path/.lock); if this project is inside a cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud), the sync client may be holding the lock — move the project or exclude it from sync";

	expect(errorMessage).toContain("cloud-synced folder");
	expect(errorMessage).toContain("OneDrive");
	expect(errorMessage).toContain("Dropbox");
	expect(errorMessage).toContain("Google Drive");
	expect(errorMessage).toContain("iCloud");
	expect(errorMessage).toContain("move the project or exclude it from sync");
});

test("does not include cloud-sync hint when holder is live", () => {
	// When holderIsLive is true, the error message should include the standard guidance
	// about live owners, not the cloud-sync hint
	const errorMessage =
		"Failed to acquire lock for /path after 2 attempts: test holder; last lock publication failed with access_denied (/path/.lock); a live owner is never displaced — if this is an SDK broker (gjc sdk session list), it must finish or be stopped before retrying";

	expect(errorMessage).toContain("live owner");
	expect(errorMessage).not.toContain("cloud-synced folder");
});

test("does not include cloud-sync hint for sharing_violation failure", () => {
	// When the failure is sharing_violation, not access_denied, don't include the hint
	const errorMessage =
		"Failed to acquire lock for /path after 2 attempts: test holder; last lock publication failed with sharing_violation (/path/.lock); a live owner is never displaced";

	expect(errorMessage).not.toContain("cloud-synced folder");
});
