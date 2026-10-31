import { describe, expect, it } from "bun:test";
import { InstallationAclPresentError } from "../src/cli/install-activation";

const STAGED = String.raw`C:\Users\Alice\.local\bin\gjc.new.0123.exe`;

describe("InstallationAclPresentError", () => {
	it("identifies an inherited unsafe principal and preserves the ACL error code", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: true,
		});

		expect(error.code).toBe("acl_present");
		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Users\Alice\.local\bin\gjc.exe: ACE for "BUILTIN\Users" is inherited from a parent directory. Run: icacls "C:\Users\Alice\.local\bin" /inheritance:d && icacls "C:\Users\Alice\.local\bin" /remove "BUILTIN\Users" && gjc update`,
		);
	});

	it("identifies an explicitly set unsafe principal when inherited is false", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-32-545",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Tools\gjc.exe: ACE for "S-1-5-32-545" is explicitly set. Run: icacls "C:\Tools\gjc.exe" /remove *S-1-5-32-545 && gjc update`,
		);
	});

	it("falls back to the bare error when both diagnostic fields are absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the principal is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailureInherited: true,
		});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the inherited flag is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
		});

		expect(error.message).toBe("acl_present");
	});

	it("quotes directory and principal names containing spaces in the ordered remedy commands", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`CONTOSO\Domain Users`,
			aclFailureInherited: true,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "CONTOSO\Domain Users" is inherited from a parent directory. Run: icacls "C:\Program Files\GJC" /inheritance:d && icacls "C:\Program Files\GJC" /remove "CONTOSO\Domain Users" && gjc update`,
		);
	});

	it("includes the exact target file path while directing the remedy to its UNC parent directory", () => {
		const error = new InstallationAclPresentError(String.raw`\\server\share\GJC Tools\gjc-custom.exe`, STAGED, {
			aclFailurePrincipal: "Everyone",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of \\server\share\GJC Tools\gjc-custom.exe: ACE for "Everyone" is explicitly set. Run: icacls "\\server\share\GJC Tools\gjc-custom.exe" /remove "Everyone" && gjc update`,
		);
	});

	it("targets the file for explicit ACE removal and uses SID syntax with asterisk prefix", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-21-123456-123456-123456-1001",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "S-1-5-21-123456-123456-123456-1001" is explicitly set. Run: icacls "C:\Program Files\GJC\gjc.exe" /remove *S-1-5-21-123456-123456-123456-1001 && gjc update`,
		);
	});

	it("handles inherited numeric SID with correct syntax", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-32-544",
			aclFailureInherited: true,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Tools\gjc.exe: ACE for "S-1-5-32-544" is inherited from a parent directory. Run: icacls "C:\Tools" /inheritance:d && icacls "C:\Tools" /remove *S-1-5-32-544 && gjc update`,
		);
	});

	it("targets the file for explicit ACE with account name and spaces", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`CONTOSO\Domain Users`,
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "CONTOSO\Domain Users" is explicitly set. Run: icacls "C:\Program Files\GJC\gjc.exe" /remove "CONTOSO\Domain Users" && gjc update`,
		);
	});

	it("identifies source-side ACL failure with source indicator", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: false,
			aclFailureSide: "source",
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Users\Alice\.local\bin\gjc.exe: ACE for "BUILTIN\Users" is explicitly set on the source file C:\Users\Alice\.local\bin\gjc.new.0123.exe. Run: icacls "C:\Users\Alice\.local\bin\gjc.new.0123.exe" /remove "BUILTIN\Users" && gjc update`,
		);
		expect(error.code).toBe("acl_present");
	});

	it("identifies destination-side ACL failure with destination indicator", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: false,
			aclFailureSide: "destination",
		});

		expect(error.message).toContain("on the destination file");
		expect(error.code).toBe("acl_present");
	});

	it("removes inheritance on the staged source directory when the source ACE is inherited", () => {
		const error = new InstallationAclPresentError(
			String.raw`C:\Program Files\GJC\gjc.exe`,
			String.raw`D:\Staging\gjc.new.9.exe`,
			{
				aclFailurePrincipal: "S-1-5-21-1-2-3-1001",
				aclFailureInherited: true,
				aclFailureSide: "source",
			},
		);

		expect(error.message).toContain(
			String.raw`icacls "D:\Staging" /inheritance:d && icacls "D:\Staging" /remove *S-1-5-21-1-2-3-1001`,
		);
		expect(error.message).not.toContain(String.raw`icacls "C:\Program Files\GJC"`);
	});
});
