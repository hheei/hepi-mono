# @hheei/pi-inturl

Internal URL and safe path shortcut helpers for Pi.

## Path Shortcuts

When installed as a Pi extension, `pi-inturl` expands safe shortcut URI paths before supported tool calls run:

- `tmp://name` expands to `<system temp dir>/name`.
- `tmp://dir/file.txt` expands under the same temp root.
- `..`, absolute paths, and invalid encodings are blocked.

The expansion applies only to selected Pi built-in tools with a `path` input: `read`, `grep`, `find`, `ls`, `write`, and `edit`. Configure it in `/extension-setting -> [PI Inturl] -> Path shortcuts` and `/extension-setting -> [PI Inturl] -> Tools`.

`pi-inturl` depends on `pi-extcore` for the shared settings command and picker UI. Load `pi-extcore` too when testing this extension directly.
