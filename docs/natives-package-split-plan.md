# Native package split plan

Issue #1280 reports Bun 1.3.14 extraction failures when installing the published `@gajae-code/natives` tarball because the package ships every platform's prebuilt `.node` file in one mandatory dependency. PR #1281 added the safe `gjc update` partial-success verifier; this follow-up implements the package-topology split that prevents the oversized native tarball in the first place.

The stable loader package remains `@gajae-code/natives`; platform binaries now publish as optional packages so package managers install only the host package.

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

## Release-script work

1. The release npm job still downloads every `pi_natives.*.node` artifact into `packages/natives/native`.
2. `scripts/ci-release-publish.ts` stages matching artifacts into the platform package directories and publishes the optional native packages before `@gajae-code/natives` / `@gajae-code/coding-agent`.
3. The monorepo release version bump keeps all new package manifests in lockstep.
4. Release/loader tests pin publish ordering, stable-package file inclusion, optional-package resolution, and fallback to the legacy bundled path.

## Compatibility notes

- The legacy `@gajae-code/natives/native/*.node` fallback should remain for one release cycle so local dev, older release artifacts, and compiled standalone binaries keep working.
- The `gjc --smoke-test` verification path should remain the final update guard even after the split, because optional dependency installation semantics vary by package manager.
