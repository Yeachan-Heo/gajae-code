### Fixed

- `gjc gc` now also reports and prunes SDK snapshot spill roots (`<tmp>/gjc-sdk-snapshots-*`) and Python runner roots (`<tmp>/gjc-python-runner-*`) left by killed or crashed sessions. Like shell snapshot roots, both were removed only by an exit hook. All three now carry the owner pid in their name (`<prefix><pid>-<random>`) and share one gc rule: removable only when that owner is dead (ESRCH), re-probed right before removal. Roots without a recorded owner are reported but kept.
