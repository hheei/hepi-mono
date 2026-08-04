# Third-Party Notices

## mpatch

`bin/mpatch/` contains executable files from
[Romelium/mpatch](https://github.com/Romelium/mpatch) release `v1.6.4`.

Copyright 2025 Romelium

Licensed under the MIT License. The upstream license text is reproduced below.

```text
MIT License

Copyright 2025 Romelium

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## HEPI FFF

`src/fff/` was initially adapted from [ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff)
at revision `694837d0644abc8527ebfa3ea50135e0f5d1ece4`.

Copyright (c) 2026 Shpetim Alimi

Licensed under the MIT License. The upstream license text is reproduced below.

```text
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Native bridge

The N-API bridge built from `crates/pi-ext-bridge` links vendored crates from
`can1357/oh-my-pi`.

- Repository: https://github.com/can1357/oh-my-pi
- Revision: `01c1f91ff529c6af3fc27724a8ba429d83d41aed`
- License and notices: `crates/vendor/oh-my-pi/**/LICENSE`, `crates/vendor/oh-my-pi/**/NOTICE`

The mpatch executable remains a separately bundled third-party artifact (see
above); the bridge only invokes its package-owned path.
