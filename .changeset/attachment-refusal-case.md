---
"@nanocollective/nanocoder-desktop": patch
---

A refused attachment now keeps the capitals in its reason. A file that is not valid UTF-8 is refused with "UTF-8" and "Latin-1" as written, and a file over 1 MiB with "MiB", where all of it used to be lower-cased.
