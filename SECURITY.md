# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through GitHub Security Advisories:

- `https://github.com/TrevorJ-AI/noortasks/security/advisories/new`

Please include:

- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal proof of concept.
- Affected NoorTasks version or commit SHA, deployment mode (Docker, bare Node, Android APK), and configuration details.

You can expect an initial acknowledgment within 72 hours and updates as the issue is investigated and patched.

## Supported Versions

| Version | Supported |
|---|---|
| `0.1.x` (latest minor release) | Yes |
| Older snapshots / unreleased branches | No |

## Operational Security Notes for Self-Hosters

- Always protect NoorTasks with TLS via a reverse proxy (Caddy, Nginx, Traefik) or a private overlay network when accessing it outside `localhost`.
- Never commit `config.json`, `vapid.json`, `calendar-oauth.json`, or SQLite databases containing real tokens.
- Keep `NOORTASKS_CONFIG` and `NOORTASKS_VAPID_FILE` readable only by the server user (`chmod 600`).

## Legal, Copyright, or Takedown Contact

For copyright, trademark, or DMCA takedown inquiries, contact the maintainer directly at:

- Use GitHub private vulnerability reporting: https://github.com/TrevorJ-AI/noortasks/security/advisories/new (it reaches the maintainer privately), or open an issue titled "Legal contact request" without details and the maintainer will reply with a private channel.
