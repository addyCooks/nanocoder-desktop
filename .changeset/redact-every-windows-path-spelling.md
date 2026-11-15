---
"@nanocollective/nanocoder-desktop": patch
---

Redact the home directory from Nanocoder's captured diagnostics however a Windows path is spelled. Paths printed with doubled backslashes, with forward slashes, inside JSON or as `file:///` addresses used to keep the user name, and the same gap hid the startup record (process ID and project folder) from the diagnostics view. Each of those spellings now becomes `~`, including `file:///` addresses whose account name is percent-encoded (`#`, `?`, `%`, spaces, non-ASCII characters and an encoded drive colon). Redaction also no longer throws for an unusual account name.
