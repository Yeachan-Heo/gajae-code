# gajae-code

One-line npm package for the Gajae-Code `gjc` CLI.

```sh
bun install -g gajae-code
```

Nightly builds use the separate npm `nightly` dist-tag and never move `latest`:

```sh
bun install -g gajae-code@nightly
```

Once installed, `gjc update --channel nightly` / `gjc update --channel stable` switch channels in place; the **Update Channel** settings entry (`startup.updateChannel`) picks the default channel for `gjc update` and the startup update check.

This package is a thin public wrapper around `@gajae-code/coding-agent` so users can install the CLI without typing the npm organization scope.
