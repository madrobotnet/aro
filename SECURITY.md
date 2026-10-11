# Security policy

Aro is a self-hosted notebook for one owner. If you think you've found a
vulnerability, report it privately by email, not in an issue or pull request.
For ordinary bugs and installation questions, see [Support](SUPPORT.md).

## Supported versions

| Version | Security fixes |
| --- | --- |
| 2.3.x | Supported |
| Earlier versions | Not supported |

Use the latest available patch in the 2.3.x line. Reports about older
installations can still help identify a problem, but a fix may require an
upgrade. This support policy doesn't mean a container release has been published.

## Report a vulnerability

Email [hello@madrobot.net](mailto:hello@madrobot.net) with the subject
`Aro security report`. This is the private reporting contact. Don't post
vulnerabilities in public issues, discussions, pull requests, or comments.

Include only what's needed to understand the problem:

- The Aro version or source commit, installation method, and affected component.
- The access an attacker needs, such as no login, owner login, or server access.
- Expected behavior, observed behavior, and the possible impact.
- Reproduction steps using a disposable local instance and invented notes.
- A small sanitized example, if needed, and whether you've found a workaround.

Don't send passwords, password hashes, installation codes, session cookies,
authorization headers, API keys, access or refresh tokens, provider auth files,
private notes, database backups, or complete environment files and logs.
Replace sensitive values with descriptive placeholders. Review screenshots
for note text, account details, browser URLs, and login codes before attaching
them. Keep production credentials out of email too.

If the impact can't be described without sensitive material, start with a
sanitized summary and explain what makes reproduction difficult. Report
against systems you own or have permission to test.

## Handling and disclosure

The maintainer will assess the affected version, reproduction, and impact.
Keep follow-up questions in the same private email thread and coordinate
public disclosure there. This lets a fix or mitigation be explained without
exposing unprotected installations.

There's no guaranteed response or fix deadline. GitHub private vulnerability
reporting isn't a verified reporting channel for this repository; use the
email address above. Follow up by email rather than opening a public issue.

If you accidentally expose a secret, revoke or rotate it at its source and
remove it from the report where possible. Deleting a message doesn't revoke
a credential.

## Deployment responsibilities

- Keep the app's port on loopback. For remote access, use an SSH tunnel or a
  TLS-terminating reverse proxy with restricted ingress.
- Keep `INSECURE_COOKIES=1` in the deployment env file only for loopback HTTP.
  Use `INSECURE_COOKIES=0` for HTTPS. Preserve the original `Host` header and
  configure `TRUSTED_PROXY_HOPS` for the actual proxy chain.
- Protect the server, database, attachment volume, backups, env files, and
  provider credential directories. Aro isn't end-to-end encrypted.
- Keep installation secrets private and use a distinct owner password.
  Don't put secrets in image build arguments, repository files, or support reports.
- Leave optional AI disabled unless you want to send data to the selected
  provider. Chat and Jev have separate consent. URL capture and remote Markdown
  resources can also make network requests.
- Back up before upgrades. Keep the existing env file, installation directory,
  Compose project, and data volumes. Never use `docker compose down -v` on an
  installation whose data you need.

See the full [setup guide](docs/SETUP.md) for proxy configuration, backup,
recovery, and legacy upgrades. Provider billing or model-access restrictions
are support questions, not by themselves vulnerabilities.
