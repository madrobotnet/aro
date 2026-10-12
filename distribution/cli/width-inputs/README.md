# Independently licensed width compatibility module

This module implements the four public `eastasianwidth` 0.2.0 APIs from
Unicode property data and observed API behavior. It does not copy the old
implementation or grant rights to its original source. It is an integration
candidate, not a published npm package or a completed Irang release.

## Sources and notices

The preferred data source is the complete Unicode 6.0.0 `EastAsianWidth.txt`
under `sources/`. Its original 1991-2010 Unicode copyright header remains
unchanged. `licenses/Unicode.txt` is the complete official Unicode License V3
downloaded on 2026-10-01; its permission covers data copying, modification and
distribution with the required notice. Retain both the source headers and this
notice with the generated ranges.

The independently authored JavaScript is under the project's MIT license,
copied unchanged to `licenses/Project-MIT.txt`. Do not attribute the new code to
the old package author. Source URLs, HTTP headers, byte counts and SHA-256
identities are in `acquisition.json`; the parser and complete range derivation
are in `generate.mjs` and `generation.json`.

## Reproduce and check

From the repository root:

```sh
bun --no-env-file .omo/evidence/packaging-resume-20261001/repair/eastasianwidth-licensed/generate.mjs
node .omo/evidence/packaging-resume-20261001/repair/eastasianwidth-licensed/verify-compatibility.cjs
bun --no-env-file .omo/evidence/packaging-resume-20261001/repair/eastasianwidth-licensed/negative.mjs
```

`index.cjs` reads `ranges.json`. The compatibility check invokes the installed
old module as a black-box oracle; it does not inspect or copy its implementation.
It compares all 1,114,112 code points through three public functions, then checks
mixed strings and `slice` boundaries. Empty strings, ambiguous width, supplementary
characters, discarded lone surrogates, negative indices and the existing
default end of 1 are retained rather than silently changed.

The negative check corrupts an owned copy of the Unicode input, invokes the
real generator and requires exit 1 before any output changes. It removes its
temporary directory and verifies the original input and generated output hashes.
`compatibility.json` and `negative.json` record actual outcomes after execution.

## Integration boundary

Ship the new code, generated ranges, complete preferred data and both license
notices together. Replace the relevant npm module through an explicit owned build
recipe; preserve npm capabilities and every provider/Auth choice. Record the
new implementation hash instead of claiming it is the upstream package's
original code. Preserve all inherited warning objects and identify replaced
original code as historical evidence only.

The final image and delivered source archives must not include the unresolved
old implementation as if this module licensed it. The lead must verify actual
npm entry behavior, source-archive contents and final-image correspondence.
Native build/relink, installation and private publication remain separate gates.
