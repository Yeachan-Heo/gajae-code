# Native package split follow-up plan

Issue #1280 reports Bun 1.3.14 extraction failures when installing the published `@gajae-code/natives` tarball because the package ships every platform's prebuilt `.node` file in one mandatory dependency. The safe minimal fix in this PR is to make `gjc update` verify the resulting install state before treating a package-manager nonzero exit as fatal.

A full per-platform native split should be a separate release-engineering change because it changes published package topology and must be validated on every release runner.

## Target package topology

- Keep `@gajae-code/natives` as the stable JS/types loader package.
- Move prebuilt binaries into optional packages named by host triple, for example:
  - `@gajae-code/natives-darwin-arm64`
  - `@gajae-code/natives-darwin-x64`
  - `@gajae-code/natives-linux-arm64`
  - `@gajae-code/natives-linux-x64`
  - `@gajae-code/natives-win32-x64`
- Add those packages as `optionalDependencies` of `@gajae-code/natives` with the lockstep release version.
- Publish each platform package with exactly its relevant `pi_natives.<platform>-<arch>*.node` file(s), `README.md`, and `package.json` using `os` / `cpu` fields so non-host package-manager failures remain optional.
- Update `native/loader-state.js` to search the host optional package before falling back to the legacy bundled `native/` directory and compiled-binary embedded addons.

## Required release-script work

1. Teach the native release artifact download step to stage every `pi_natives.*.node` into the matching platform package directory.
2. Teach `scripts/ci-release-publish.ts` to publish the optional native packages before `@gajae-code/natives` / `@gajae-code/coding-agent`.
3. Keep the existing monorepo release version bump in lockstep for the new package manifests.
4. Add package-smoke tests that pack `@gajae-code/natives` and prove the host tarball no longer includes all non-host `.node` files.
5. Add loader tests for optional-package resolution and fallback to the legacy bundled path.

## Compatibility notes

- The legacy `@gajae-code/natives/native/*.node` fallback should remain for one release cycle so local dev, older release artifacts, and compiled standalone binaries keep working.
- The `gjc --smoke-test` verification path should remain the final update guard even after the split, because optional dependency installation semantics vary by package manager.
