### Fixed

- Bound the @ fuzzy walk with a 1500ms timeout to prevent hangs on large repositories (port omp 616669a3c3)
- Drop Kitty image protocol inside Paseo terminals since their xterm.js renderer doesn't support it (port omp 642aa8a0cc)
