### Fixed

- `gjc accounts prefer` can order the accounts of one login that holds an OAuth row per organization (same email and account id). It used to refuse with "no unique email or account id"; it now stores `org:<organization-id>`, and `auth.credentialPreferences` accepts that entry. The entry matches the organization id only, never a display name. This also works when credentials come from an auth broker.
