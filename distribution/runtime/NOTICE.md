# Runtime component notices

These materials concern Bun `1.4.2+744846f84` and Node `22.23.3`, native Linux amd64 and arm64.
`manifest.json` records their executable hashes and associates each retained
upstream text with its exact source archive and component identity.

Bun contains statically linked JavaScriptCore/WebKit and TinyCC. Their LGPL
texts and copyright notices are included under `notices/webkit/` and
`notices/tinycc/`. The complete matching source, Bun-side code, build recipes
and patches are supplied under `sources/`; `sources/REBUILD.md` describes
rebuilding and relinking with modifications. Library modification and reverse
engineering for debugging such modifications must remain permitted. These
materials do not constitute a written source offer.

This software is based in part on the work of the Independent JPEG Group.
The libjpeg-turbo materials include `README.ijg`, its BSD and zlib terms.
BoringSSL's mixed terms, ls-hpack's bundled xxHash notice, lsquic's Chromium
notice and all other retained component texts remain applicable.

WebKit's vendored simdutf 9.0.0 is identified by
`Source/WTF/wtf/simdutf/simdutf_impl.h`; its own `LICENSE-simdutf.txt` is MIT,
despite the Apache label in Bun's generic overview. The full amalgamated
sources retain their additional attributions. Bun's current base64 source
calls simdutf; the overview's libbase64 label is not used as a substitute
for this source trace.

ICU 78.3 uses the exact archive hash in the matching WebKit Dockerfile.
WebKit's `icu/` patch and data-processing inputs are retained. Bun's
in-tree uSockets/uWebSockets notices are associated with the Bun commit.
The exact Cargo and JavaScript build graphs are retained conservatively,
including build-only and other-platform dependencies. Their inclusion is
not a claim that every retained source file is linked into this executable.

The glibc compatibility fallback in `workaround-missing-symbols.cpp` explicitly
names LLVM libc++abi `llvmorg-19.1.0`. Its full license, LLVM exceptions, credits
and original source are retained, even though the glibc 2.17 fallback is not
normally selected on this image's newer glibc.

`Bun.stringWidth` still contains a uucode-derived grapheme algorithm and tables.
The exact vendored uucode 0.1.0 license immediately before Bun's Rust port
retains Jacob Sandlund's 2025 copyright. The later C++ port explicitly carries
that algorithm and its tables forward. The separate current upstream Jacob
Sandlund, Bjoern Hoehrmann and Unicode texts remain supplemental; they are not
substituted for the original vendored notice. The modified Bun source and
table generator are retained.

Bun's own overview and derived-code credits are preserved unchanged.
The CSS source credits Lightning CSS and Servo, and the parser credits
esbuild. `PERMISSIONS.md` describes their retained historical grants, secondary
notices and preferred modified source. Exact original import revisions are not
claimed. Executable distribution must provide the source access described there.
Credits alone do not satisfy the notice or source-access conditions.

Node's full bundled LICENSE is preserved unchanged, including its component
notices. Aro's application license does not relicense any runtime component.
