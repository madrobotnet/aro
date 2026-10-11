# Support

Aro is a self-hosted notebook for one owner. Start with the full
[setup guide](docs/SETUP.md) for installation, proxy configuration, backups,
upgrades, and recovery. For development and patches, see
[Contributing](CONTRIBUTING.md).

## Choose the right channel

| What you need | Where to go |
| --- | --- |
| A reproducible software bug | Search [existing issues](https://github.com/madrobotnet/aro/issues), then use the [bug report form](https://github.com/madrobotnet/aro/issues/new?template=bug_report.yml) |
| A concrete feature request | Use the [feature request form](https://github.com/madrobotnet/aro/issues/new?template=feature_request.yml) |
| Help with installation, a reverse proxy, backups, or recovery | Read the setup guide, then email [hello@madrobot.net](mailto:hello@madrobot.net) with a sanitized question |
| A suspected vulnerability or private-data exposure | Follow [Security](SECURITY.md) and email the private report; don't open a public issue |
| Provider billing, subscription, quota, model policy, or account access | Contact the provider or your organization's administrator |

Issue access depends on the repository's visibility and access settings.
Support has no guaranteed response time and doesn't include managed hosting.
Keep secrets out of email as well as public reports.

## Before asking about a deployment

- Record the Aro version or source commit, host OS and architecture, and
  whether you're using a prebuilt image, a local image, or Bun development.
- Check `docker compose version`. Installation requires Compose 5.1.0 or newer;
  CI and contribution instructions use 5.5.1.
- For a source installation, run ordinary `docker build` and explicitly set
  `IRANG_IMAGE=irang:local` in the installation env file. The production
  `compose.yml` selects an image and has no `build` entry.
- For loopback HTTP, keep `INSECURE_COOKIES=1` in the env file, not only in one
  shell invocation. HTTPS needs `INSECURE_COOKIES=0`. With a reverse proxy,
  preserve `Host`, restrict app ingress, and match `TRUSTED_PROXY_HOPS` to the
  actual chain.
- A health check can be made locally with
  `curl -i http://127.0.0.1:3000/api/health`, using your configured port.
  Report the status and whether `ok` is true, not a full HTTP transcript.
- Before an upgrade or recovery attempt, make the documented backup. Keep the
  original env file, installation directory, Compose project, and volumes.
  Logical volume keys are Compose-project scoped. A different project can
  create an empty notebook instead of opening the existing one.
- Never use `docker compose down -v` to fix an installation. Don't regenerate
  an existing env file or replace legacy database passwords and volume
  selections without following the setup guide.

The source repository and release assets are public; the GHCR package remains
private. Public source access doesn't grant package access. A denied private image pull isn't by itself
an app defect. Don't send registry credentials or a broad access token to get
help. Use the documented source build if you don't have registry access.

## AI capability isn't provider entitlement

AI is optional. Capture, notes, editing, local search, and graphs don't require
an AI account. Configure chat and Jev separately, and give data-transfer
consent for each connection. Saving a connection doesn't automatically select
it for use.

The software supports these connection modes:

| Purpose and provider | API mode | Auth mode |
| --- | --- | --- |
| ChatGPT / OpenAI chat | OpenAI API key | ChatGPT device authorization |
| Claude chat | Anthropic API key | Not supported |
| Gemini chat | Gemini API key | Google browser authorization code |
| GitHub Copilot chat | Copilot API token | GitHub device authorization |
| OpenRouter chat | OpenRouter API key | Browser PKCE authorization |
| xAI / Grok chat | xAI API key | xAI device authorization |
| OpenAI Compatible chat | Custom key or explicitly keyless endpoint | Not supported |
| Anthropic Compatible chat | Custom key or explicitly keyless endpoint | Not supported |
| TypeSafe Jev | TypeSafe API key | Not supported |
| OpenRouter Jev | OpenRouter API key | Browser PKCE authorization |

Supporting a connection mode or listing a model doesn't grant access to the
provider's service. API billing and consumer subscriptions can be separate.
Copilot API mode needs a usable Copilot token, not an arbitrary GitHub personal
access token. OpenRouter Auth issues an OpenRouter key; it doesn't import
subscriptions from other providers.

For a legacy CLI connection, "ready" means an executable and a readable,
non-empty credential file were found. It doesn't prove valid login, successful
refresh, available quota, or model entitlement. Revoked credentials may require
reconnecting. Check provider account and administrator policies if a login
works but a model request is denied.

Gemini Auth uses the official Gemini CLI for inference and its public OAuth
client for authorization. Google hasn't reviewed or endorsed Aro. Read the
[Gemini CLI terms and privacy notice](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
and the [setup guide](docs/SETUP.md) before choosing it.

For an Aro integration defect, report the provider name, API or Auth mode,
model ID, selected protocol where relevant, and a sanitized status or error
code. Reproduce with invented content if possible. Don't log in to extra
provider accounts or make paid requests solely to prepare a report.

## What to include, and what to leave out

A useful report includes short reproduction steps, expected and actual behavior,
the affected version, and non-sensitive environment facts. For deployment
questions, say whether access is loopback HTTP, an SSH tunnel, or HTTPS behind
a proxy. Describe the topology without publishing private hostnames or IPs.

Never attach passwords or hashes, `.env` files, database URLs with credentials,
installation codes, session cookies, authorization headers, AI keys or tokens,
provider auth files, database backups, or private notes. Don't paste complete
logs, rendered Compose config, or browser network exports. If an error excerpt
is necessary, share only a few reviewed lines with secrets, personal paths,
account identifiers, and note content removed.

Use a made-up note and crop or redact screenshots. Check browser URLs for
authorization codes before sharing. If you aren't sure an attachment is safe,
describe the result in words instead.
