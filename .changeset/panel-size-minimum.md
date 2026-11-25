---
"@nanocollective/nanocoder-desktop": patch
---

Keep a saved sidebar, side panel or terminal size between the smallest and largest size you can drag them to. A saved size that was too small, for example 1, shrank the sidebar to about 17px, and the resize handle reported the unclamped value. The sizes are now limited on both ends when they are applied.
