### Fixed

- A global `auth.credentialPins` entry whose account was removed or disabled (for example after a failed OAuth refresh) no longer aborts session startup with `No credential found for <provider> matching <selector>`. Only that provider is marked unavailable, so sessions whose model authenticates through another provider keep starting (#8012).
