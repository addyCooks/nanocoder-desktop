---
"@nanocollective/nanocoder-desktop": patch
---

Report a project whose folder was replaced by a file as changed instead of available. The sidebar and project list showed such a project as normal, while opening it, browsing its files and sending a prompt all failed with unrelated messages. It now shows the same "folder changed" state as other changed project roots.
