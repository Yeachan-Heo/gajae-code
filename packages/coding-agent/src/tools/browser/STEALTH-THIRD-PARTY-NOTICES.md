# Stealth Third-Party Notices

Per the approved plan, anti-detection evasions are **reimplemented/adapted** as
first-party code (no vendored source tree, no runtime dependency). This file
records provenance for evasion techniques whose semantics were informed by the
following open-source projects. Each individual reimplemented script also
carries an attributing header comment.

| Source project | License | Techniques referenced |
|----------------|---------|-----------------------|
| rebrowser-patches | MIT | CDP `Runtime.enable` leak mitigation (data-driven; landed only if the offline baseline shows a runtime/CDP leak signal) |
| puppeteer-extra-plugin-stealth | MIT | Fingerprint evasion signal set (navigator/webgl/plugins/permissions surfaces) overlapping and complementing the existing 14 injection scripts |
| fingerprint-suite (fingerprint-injector / generator) | Apache-2.0 | Coherent fingerprint attribute generation ideas |

No source files from these projects are copied into this repository. Only the
observable behaviors/signal semantics were reimplemented against `puppeteer-core`
after being confirmed by the offline benchmark suite
(`test/fixtures/stealth-detectors/`, `src/tools/browser/benchmark/`).

## Detector fixtures

The offline detector fixtures under `test/fixtures/stealth-detectors/` are
first-party probes modeled on the public boolean signal sets used by
`bot.sannysoft.com` and CreepJS. They are self-contained (inline JS, zero
network) and are not verbatim copies of those sites. See that directory's
`MANIFEST.json` for the refresh procedure.
