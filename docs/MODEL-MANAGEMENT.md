# Optional desktop local model management

Linux is the currently verified host. macOS and Windows are unverified and
rejected by this workflow. Lexical search needs neither weights nor a runtime.
There are no model downloads on install, desktop start, status, or configure.
No cloud provider, container, app database or web handler is used by this CLI.

## Prerequisites and consent

Review the upstream model terms/access requirements yourself before downloading.
`--consent-download` authorizes this transfer only; it does **not** accept any
third-party terms or prove license acceptance. No authentication token or
automated gated-repository agreement is provided. If the repository requires
access/acceptance not already available anonymously, download fails; resolve
that prerequisite outside this tool rather than weakening TLS or bypassing access.

The only production artifact is:

| Property | Pin |
| --- | --- |
| URL | `https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf` |
| Size | 309855456 bytes |
| SHA-256 | `2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135` |
| Index | `eg2-2188ac1d-q8-mean-768-search-chunks-v3` |
| Reference llama.cpp commit | `78651c410dd8d97e3e22e533e0e7117889e3863a` (b11460) |

The download allows at most five HTTPS redirects, only to `huggingface.co`,
`cas-bridge.xethub.hf.co`, `cdn-lfs.hf.co` or `cdn-lfs-us-1.hf.co`, with standard
TLS verification. Other CDN destinations fail closed and require a reviewed
code update, not a user-supplied URL. Ten minutes bounds the entire transfer.
Bytes stream into a private partial file and are bounded by the exact size;
both size and SHA-256 must match before atomic, no-overwrite publication.

Supply a native CPU `llama-server` built by the operator from the reference
commit, with its upstream license/notices, or separately verified by the
operator. This tool downloads/distributes **no native runtime** and does not
attest its provenance, commit, license acceptance or model-output equivalence.
`--trust-runtime` explicitly trusts that executable; configure records its
SHA-256 and every start verifies it has not changed. The executable must be
an absolute canonical regular file, operator/root-owned, executable and not
group/world writable; its checksum scan is capped at 256 MiB. Symlinked paths
are refused. Untrusted executables cannot be made safe just by hashing them.

## One workflow

Use the same absolute private data directory as the desktop launcher. Run
from the checkout, with Bun and the existing installed dependencies:

```sh
bun --no-env-file scripts/model.ts download --data-dir /absolute/private/data --consent-download
bun --no-env-file scripts/model.ts configure --data-dir /absolute/private/data --runtime /absolute/llama-server --trust-runtime
bun --no-env-file scripts/model.ts status --data-dir /absolute/private/data
bun --no-env-file scripts/desktop.ts start --data-dir /absolute/private/data
```

Configure requires the pinned verified weights and enables the optional lane.
The desktop starts and owns the runtime automatically. For a standalone health
check, while the desktop is stopped:

```sh
bun --no-env-file scripts/model.ts start --data-dir /absolute/private/data
```

`start` stays in the foreground and prints a JSON readiness record only after
HTTP health returns 200. Ctrl-C/SIGTERM stops its owned child. It cannot run at
the same time as a desktop model runtime for this directory.

Stop the owning desktop or foreground `start` command before disabling,
reconfiguring, downloading or removing:

```sh
bun --no-env-file scripts/model.ts disable --data-dir /absolute/private/data
bun --no-env-file scripts/model.ts remove --data-dir /absolute/private/data
```

Disable retains weights and the runtime pin; configure with explicit runtime
trust enables it again. Remove deletes only managed weights, partials and config,
not the supplied executable, unrelated files, notes or the app database. The
small control-lock database is retained. Busy operations fail rather than kill
an unowned PID. Status reports configured enablement, checksum state and whether
the control lock is held; `inUse` is not a claim of inference readiness.
The standalone start readiness record is the actual runtime health evidence.

## Private activation contract for the parent integration

`DATA_DIR/models` is user-owned mode 0700, symlink-free including ancestors.
Managed regular files are user-owned, single-link and mode 0600. Existing shared,
symlinked or hard-linked files fail closed. A same-user hostile process is outside
this local filesystem trust boundary.

`models/config.json` is bounded to 8192 bytes and strictly accepts only:

```json
{"version":1,"enabled":true,"runtime":"/absolute/llama-server","runtimeSha256":"64 lowercase hex characters"}
```

No arbitrary arguments, environment, model path, model URL or external endpoint
are accepted. CLI option parsing refuses unknown, repeated or misplaced flags.
Operator executable trust is the only execution authority. Never import web
handlers into this CLI or replace that boundary with a command string.

Desktop activation calls `startConfiguredModel(DATA_DIR, shutdownSignal)`.
Absent/disabled config returns no runtime. Enabled config is reread under an
OS-released lock, weights and executable are verified, and a direct argv spawn
uses only `LANG=C`, `PATH=/usr/bin:/bin`, ignored stdin/output, and fixed flags:

```text
-m DATA_DIR/models/embeddinggemma-2-Q8_0.gguf --embeddings --pooling mean
--flash-attn on -t 2 -tb 2 -np 1 -c 2048 -b 2048 -ub 1024
--host 127.0.0.1 --port 18080
```

The port is not configurable through config/CLI. Occupied ports fail before
spawn; health requests use loopback with no redirects and a 30-second overall
readiness bound, racing child exit and shutdown. llama-server has no stable
parent IPC readiness event, so health retries use bounded 100-ms waits and
one-second per-request timeouts. SIGTERM has a two-second grace period before
SIGKILL; owned exit is awaited before releasing the control lock.

Only after readiness does the launcher add
`EMBEDDING_BASE_URL=http://127.0.0.1:18080` to the sanitized app child environment.
Caller-provided `EMBEDDING_BASE_URL` remains stripped. Configuration, checksum,
spawn, port or readiness failures leave it unset and desktop continues lexical
search. Later runtime failure is handled by existing learned-search unavailable
fallback. Desktop shutdown/app exit stops the model it owns. Uncatchable parent
SIGKILL/power loss cannot run cleanup; a surviving runtime is not adopted or
killed by PID and its occupied port causes later optional activation to fail.
The endpoint is loopback, not authenticated; other processes of the local host
can reach it.

Two threads, one slot, and bounded context/batch constrain inference work. The
native launcher does not enforce the Docker 2-GiB memory cap documented in
`SEMANTIC-SEARCH.md`; an operator requiring an OS memory cap must supply one.
Actual native llama-server inference is not claimed by fixture verification.

The independent `models/management.lock.sqlite` uses an immediate transaction
solely as an OS-released workflow/process ownership lock. It is never
`aro.sqlite`: no app writer is held while downloading or running inference.
Existing SQL-native indexing awaits embeddings **before** its app write
transaction, then rechecks source identity; this patch does not change it.
Interrupted transfers discard a safe stale `.weights.part` under the recovered
control lock and restart from byte zero. Failed checks never create/replace a
final file. Downloads refuse any existing final, including a corrupt one;
explicit remove is required. A crash immediately after successful hard-link
publication can leave both managed names linked to the same private inode.
The next control-lock acquisition removes only that matching partial link;
the complete final remains, and later verification still checks its pin.
Unrelated hard links are refused, not removed.

`package-desktop.mjs` bundles the isolated CLI as `scripts/model.js` and includes
this document; the already-bundled desktop launcher includes its model module.
In such a package substitute `scripts/model.js` for `scripts/model.ts`.
No weights or runtime are included. The build source hash includes the model
CLI inputs; packaging copies the matching prebuilt launcher and model CLI and
checks their recorded hashes. Model management remains CLI-only: settings has
no local-model download or activation controls. An in-app workflow is deferred
until runtime distribution and a local launcher control contract are available.

## Verification

```sh
bun --no-env-file test scripts/model-management.test.ts scripts/desktop.test.ts src/server/search/sqlite-semantic.test.ts
```

Tests use real local HTTP transport and actual executable child fixtures with
the same argv/process/health boundaries. They cover checksums, oversized and
interrupted streams, retries, no overwrite, unsafe paths/config permissions,
strict config, changed executables, startup failure/cancellation, occupied ports,
graceful and forced process cleanup, crash-released locking, and CLI consent,
status/disable/remove. No real model transfer, third-party provider, production
container, native-model license acceptance or cross-platform validation is
implied by these tests.
