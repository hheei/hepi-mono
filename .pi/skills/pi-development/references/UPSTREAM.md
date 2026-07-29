# Pi Upstream Reference

This project-only skill uses the public Pi source at the recorded tag.

- Remote: `https://github.com/earendil-works/pi.git`
- Tag: `v0.82.1`
- Revision: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
Pi source is not a runtime dependency and must not be copied under `packages/` or included in an HEPI aggregate bundle.

## Refreshing the reference

For source-level investigation, use GitHub at the recorded tag or a temporary clone outside this repository. To add a future pin, update this file and the skill's version reference together. Do not silently move the pin while a review or implementation is in progress.

```bash
git clone --depth=1 --branch vX.Y.Z https://github.com/earendil-works/pi.git /tmp/pi-vX.Y.Z
```
