### Fixed

- Admit firstborn native sessions through a genuine single-use allocation of a new header identity, without treating missing transcript bytes as takeover authority.
- Account for actual factory metadata before native runtime publication and use the public handle-bound runtime facade instead of raw session mutations.
- Certify exact already-published owned preparation before asynchronous producer dispatch while keeping consumer entry verification-only and failed or foreign proofs fenced.
- Stop and join registered side/operator executor and cleanup futures before transcript closure, and reacquire side attempt authority after credential preflight and before each transport start.
