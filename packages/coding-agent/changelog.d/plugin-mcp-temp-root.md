### Fixed

- Plugin MCP launchers no longer trust startup `node` executables located under temporary roots, even when the GJC checkout is also under `/tmp`; transient first-use digest failures can be retried against the original startup identity.
