# Security Policy

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Fill in the details (affected version, reproduction steps, impact)

This opens a private channel with the maintainer. You can also reach the
maintainer through the contact links on their GitHub profile if you prefer.

## What to Expect

- An acknowledgment as soon as possible (typically within a few days)
- An assessment of the report and, if confirmed, a remediation plan shared
  with you before any public disclosure
- Credit in the published security advisory (and a CVE where applicable),
  unless you prefer to remain anonymous

## Supported Versions

cdk-local is a local development tool and is early in development. Only the
latest released version receives security fixes.

## Scope Notes

cdk-local runs a CDK app's application compute locally in Docker with the
caller's AWS credentials, while managed services stay in real AWS.

In scope:

- A secret or credential (AWS credentials, a resolved `{{resolve:...}}` or
  Secrets Manager / SSM value, an authorization token) reaching logs, CLI
  output, a cache or file on disk, a child process's command line, or a
  container that does not need it.
- Terminal control characters or escape sequences from a template, request,
  container or AWS value reaching the terminal unstripped.
- cdk-local itself passing an untrusted value to a shell or a child process,
  or resolving a file path outside where it belongs.
- A local emulator's authorizer, JWT, signature or mTLS client-certificate
  check accepting a request AWS would reject.
- Removal of a container, network, image, file or directory cdk-local did not
  create.
- A local server reachable from outside the machine when the operator did not
  ask for it.

Out of scope:

- **A value cdk-local prints that would run if an operator copied the line
  into a shell.** The values in question — logical ids, stack names, resource
  names, AWS error text — come from the operator's own CDK app (which already
  runs arbitrary code at synth), the operator's own deployment, or a principal
  in the account who can already change the deployed resources directly. The
  attack also needs the operator to paste a crafted line.
- **The non-boundaries the docs already state**: the CloudFront Function
  runtime is not a security boundary, and a failed role assumption falls back to the
  caller's own credentials (see `docs/cli-reference.md`).
