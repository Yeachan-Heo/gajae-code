### Fixed

- On POSIX, a managed local:// root and its temp parent are adopted only when this user owns them and they are not group- or world-writable, and a later resolve refuses that root when the directory has been replaced. A root this process recreated can finish initialization after a failed marker write. Windows does not apply the owner and mode checks.
