### Fixes

- **ultragoal change-set**: Support SHA-256 unborn repository baselines. The empty tree object ID was hard-coded to the SHA-1 value, which caused git diff commands to fail (exit code 128) when applied to repositories initialized with `git init --object-format=sha256`. The empty tree ID is now derived dynamically from the repository format using `git hash-object -t tree`, ensuring compatibility with both SHA-1 and SHA-256 object formats.
