<!--
Don't submit vulnerabilities through a public pull request. Follow
https://github.com/madrobotnet/aro/blob/main/SECURITY.md and email hello@madrobot.net privately.

Never include passwords or hashes, installation codes, full env files or logs,
rendered Compose config, cookies, authorization headers, provider auth files,
AI keys or tokens, database backups, or private notes in this description,
the patch, screenshots, or attachments. Use synthetic examples.
-->

## Change and reason

Describe the user-visible result and why it's needed. Link a non-sensitive
issue if there is one. Explain any effects on data, auth, providers, or deployment.

## Verification

List the commands you actually ran and their results. Explain which checks you
couldn't run and why. Don't present checks from another commit as evidence for this patch.
See [Contributing](https://github.com/madrobotnet/aro/blob/main/CONTRIBUTING.md)
for the isolated database and exact toolchain.

| Check | Result or reason not run |
| --- | --- |
| `bun run typecheck` | |
| `bun run lint -- --max-warnings=0` | |
| Full `bun test` with an explicit disposable `TEST_DATABASE_URL` | |
| Production `docker build` | |
| `git diff --check` | |
| Affected behavior exercised with synthetic data | |

For UI changes, include reviewed desktop and mobile screenshots. For docs,
record the separate prose-polishing pass and any link or command checks.
Share a short sanitized failure summary, not complete logs or files.

## Checklist

- [ ] The patch is focused and behavior changes have appropriate regression coverage.
- [ ] API and Auth provider modes, AI-off use, consent, and credential isolation are preserved.
- [ ] Affected documentation and translations are updated and separately polished.
- [ ] I've reviewed the patch, description, and attachments for secrets and private data.
- [ ] Verification used disposable local fixtures, not a live provider login or paid AI request.
- [ ] Any incomplete checks, compatibility effects, and data-migration needs are stated above.
