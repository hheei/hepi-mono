# Pi Upstream Reference

This project-only skill reads the Pi source through `references/pi`.

- Remote: `https://github.com/earendil-works/pi.git`
- Tag: `v0.82.1`
- Revision: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Local worktree: `references/repos/earendil-works-pi-v0.82.1`
- Skill link: `.pi/skills/pi-development/references/pi`

The source worktree is ignored local research material. It is not a runtime dependency and must not be copied under `packages/` or included in an HEPI aggregate bundle.

## Refreshing the reference

Keep the existing worktree pinned while investigating a task. To add a future pinned version, fetch its tag from the existing Pi clone and create a new detached worktree under `references/repos/`; then update this file and the skill's version reference together. Do not silently move the pin while a review or implementation is in progress.

```bash
git -C references/repos/earendil-works-pi fetch --depth=1 origin tag vX.Y.Z
git -C references/repos/earendil-works-pi worktree add --detach ../earendil-works-pi-vX.Y.Z vX.Y.Z
```
