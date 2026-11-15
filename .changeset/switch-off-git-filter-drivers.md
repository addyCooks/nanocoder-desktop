---
"@nanocollective/nanocoder-desktop": patch
---

Stop a repository's Git filter drivers from running when the desktop reads status and diffs. Git runs a driver's clean command to compare a file with the index, so `status` and `diff` now switch off every `clean`, `smudge` and `process` command that the repository or your Git configuration defines. Files kept in a filter such as Git LFS can show as changed in the review panel. A repository that defines a filter driver with an `=` in its name is refused, because Git cannot switch that driver off.
