# Rebuild the independent replacement

Extract the replacement preferred-source archive into an owned directory.
Run from that directory with Bun 1.4.2:

```sh
bun --no-env-file generate.mjs
node -e 'const e=require("./index.cjs");console.log(JSON.stringify({width:e.eastAsianWidth("①"),length:e.length("①a"),slice:e.slice("abc",0,2)}))'
```

The copied generator's output directory defaults to the current directory;
`ARO_WIDTH_OUTPUT` can select another owned directory; the old
`IRANG_WIDTH_OUTPUT` key is still read when the new key is absent. Pass
`--input /path/to/sources/EastAsianWidth-6.0.0.txt` when the input is outside
the selected output directory. Its source hash check
requires the complete original Unicode 6.0 data. Preserve the data's genuine
copyright headers and both supplied notices. The generated ranges must hash to
`0e8a6564a9bae1f35ae3065b8c9e4c0b879720d1ad1547151035d09367efe609`.
Expected module output: `{"width":"A","length":3,"slice":"ab"}`.

This source package contains new independent software. It does not license the
old implementation. Its module directory may satisfy the `eastasianwidth` require
name, but package metadata identifies the distinct private replacement. Integration
must replace whole runtime/source directories, not append a new license to old code.
Final image and source archives require separate validation; preserve native
build/incorporation and relink gates.
