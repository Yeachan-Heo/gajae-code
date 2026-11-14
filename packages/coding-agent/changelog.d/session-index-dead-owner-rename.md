### Fixed

- SDK broker startup renames aside a same-host `sessions/index.jsonl.lock` whose recorded owner pid is proven dead, instead of deleting it, and then starts. A live owner, an empty info file, another host, or an incarnation mismatch is left in place and startup is refused.
