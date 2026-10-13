### Fixed

- `gjc gc` ignores a project `.env` value for `GJC_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR`, and still uses an operator value the project does not declare. For the process environment that decision uses the dotenv provenance captured when the environment was loaded, so deleting or rewriting the declaration afterward cannot make the loaded value trusted.
