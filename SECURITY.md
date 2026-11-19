# Security Policy

## Supported versions

Only the latest release (the `latest` image tag) receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository
(<https://github.com/mrquentin/bambu-controller/security/advisories/new>).

Include the affected version, steps to reproduce and the impact you expect. You can expect an
acknowledgement within a week; fixes are released as a patch version and credited in the
advisory unless you prefer otherwise.

## Scope

In scope: the web app, its API, the container image and the release pipeline.
Out of scope: Bambu Lab printer firmware and cloud services (report those to Bambu Lab).

The current threat model, hardening measures and accepted risks are documented in
[docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).
