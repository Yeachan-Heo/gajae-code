### Fixed

- Atomic writes inside an explicit artifacts local root now use that root as the trust boundary. A symlink there whose target was moved outside is refused, and a normal file inside the root is still written.
