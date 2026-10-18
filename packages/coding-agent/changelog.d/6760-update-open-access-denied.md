### Fixed

- Report a denied Windows open of the staged update or the live `gjc.exe` during `gjc update` as `access_denied` with its NTSTATUS code instead of a misleading `owner_mismatch`, so the activation is kept pending for a safe retry (#6760).
