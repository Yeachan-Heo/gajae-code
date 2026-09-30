### Fixed

- `gjc stats --json` now writes only the JSON document to stdout, so `gjc stats --json | jq ...` works. The `Synced N new entries ...` summary goes to stderr in JSON mode, alongside the sync progress. The dashboard and `--summary` output are unchanged.
