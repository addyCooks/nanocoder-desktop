---
"@nanocollective/nanocoder-desktop": patch
---

Show Windows names that cannot be opened as unreadable in the file tree. A file or folder called `CON`, `aux.txt` or `name.` (possible only when made outside Windows Explorer) was listed like any other, and opening it failed with "That path is not valid inside a project". The tree now flags it as unreadable, and opening it, or an agent reading it, says "Windows cannot open a file or folder with this name".
