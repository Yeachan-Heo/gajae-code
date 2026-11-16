### Fixed

- `gjc gc` now reports and prunes shell snapshot roots left by killed or crashed sessions. Each session's `<tmp>/gjc-shell-snapshots-*` directory was only removed by an exit hook, so every hard kill (and every test file, whose isolates never fire exit hooks) left one behind indefinitely. Roots are now named `gjc-shell-snapshots-<pid>-<random>`, and a root is removable only when that owner process is dead (ESRCH), re-probed right before removal. Roots created before this change have no recorded owner and are reported but kept.
