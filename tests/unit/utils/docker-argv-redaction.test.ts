import { describe, expect, it } from 'vite-plus/test';
import { redactDockerArgvValues } from '../../../src/utils/docker-argv-redaction.js';

// Ported with the implementation from the host CLI's suite (go-to-k/cdkd
// tests/unit/utils/docker-cmd.test.ts, describe 'redactDockerArgvValues').
describe('redactDockerArgvValues', () => {
  it('masks the VALUE of -e / --env / --opt / --label and keeps the KEY', () => {
    expect(
      redactDockerArgvValues([
        'run',
        '-e',
        'DB_URL=postgres://u:pw@h/db',
        '--env',
        'API_TOKEN=t0ps3cret',
        '--opt',
        'o=addr=fs,password=hunter2',
        '--label',
        'owner=alice',
        'img',
      ])
    ).toEqual([
      'run',
      '-e',
      'DB_URL=***',
      '--env',
      'API_TOKEN=***',
      '--opt',
      'o=***',
      '--label',
      'owner=***',
      'img',
    ]);
  });

  it('masks an EMPTY key (`-e =value`) — a non-sensitive `` key reaches the argv verbatim', () => {
    // `partitionSensitiveEnv` fail-closes a malformed key only on its
    // SENSITIVE branch, so `{ Name: '', Value: <secret> }` in an ECS
    // `Environment` (or a `--env-vars` override) is emitted as `-e =<secret>`.
    // A `> 0` guard on the `=` index walks straight past it.
    expect(redactDockerArgvValues(['run', '-e', '=hunter2-empty-key', 'img'])).toEqual([
      'run',
      '-e',
      '=***',
      'img',
    ]);
  });

  it('leaves a value-less `-e KEY` alone (the form partitionSensitiveEnv emits)', () => {
    const args = ['run', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'PLAIN=v', 'img'];
    expect(redactDockerArgvValues(args)).toEqual([
      'run',
      '-e',
      'AWS_SECRET_ACCESS_KEY',
      '-e',
      'PLAIN=***',
      'img',
    ]);
  });

  it('does not mutate the input array and tolerates a trailing bare flag', () => {
    const args = ['run', '-e', 'K=v'];
    const copy = [...args];
    redactDockerArgvValues(args);
    expect(args).toEqual(copy);
    expect(redactDockerArgvValues(['-e'])).toEqual(['-e']);
    expect(redactDockerArgvValues([])).toEqual([]);
  });

  it('leaves a non-value-bearing flag alone — a container id / image / CIDR is the diagnostic', () => {
    const args = ['network', 'create', '--subnet', '169.254.170.0/24', 'cdkd-local-task-x'];
    expect(redactDockerArgvValues(args)).toEqual(args);
  });

  // ---- issue #2623: `docker build` flags -------------------------------

  it('masks a --build-arg VALUE and keeps its KEY (issue #2623)', () => {
    const args = [
      'build',
      '--tag',
      'cdkd-asset-abc',
      '--build-arg',
      'NPM_TOKEN=npm_2623LaneRegistryToken',
      '--build-arg',
      'NODE_VERSION=20',
      '.',
    ];
    expect(redactDockerArgvValues(args)).toEqual([
      'build',
      '--tag',
      'cdkd-asset-abc',
      '--build-arg',
      'NPM_TOKEN=***',
      '--build-arg',
      'NODE_VERSION=***',
      '.',
    ]);
    // `--tag` is the neighbouring flag and must be untouched: the mask is
    // positional, so an off-by-one in the pair walk would blank it too.
    expect(redactDockerArgvValues(args)[2]).toBe('cdkd-asset-abc');
  });

  it('masks the JOINED `--flag=KEY=VALUE` spelling too (issue #2623 review)', () => {
    // Valid docker syntax for every long flag in the set, and UNMASKED until
    // the review: harmless while every argv this repo builds emits two tokens,
    // but `docker-build.ts`'s `executable` mode renders a USER-AUTHORED
    // command line, where a wrapper script may spell it this way.
    expect(
      redactDockerArgvValues([
        './build.sh',
        '--build-arg=NPM_TOKEN=npm_2623JoinedSpelling',
        '--env=API_KEY=k_2623Joined',
        '--output=type=docker',
        'NOT_A_FLAG=keepme-2623',
      ])
    ).toEqual([
      './build.sh',
      '--build-arg=NPM_TOKEN=***',
      '--env=API_KEY=***',
      // Not in the set: an unrelated `--flag=k=v` and a bare positional
      // `KEY=VALUE` both survive whole.
      '--output=type=docker',
      'NOT_A_FLAG=keepme-2623',
    ]);
  });

  it('masks a cache backend CREDENTIAL param and keeps the rest of the list (issue #2623 review)', () => {
    // BuildKit's s3 / azblob / gha cache backends take real credentials inline
    // in the comma-separated param list, so `--cache-to` is NOT the pure
    // locator the first cut of this set's JSDoc claimed.
    expect(
      redactDockerArgvValues([
        'build',
        '--cache-to',
        'type=s3,region=us-east-1,bucket=b,access_key_id=AKIA2623,secret_access_key=wJal2623Secret',
        '--cache-from',
        'type=gha,Token=gha_2623CaseInsensitive',
        '.',
      ])
    ).toEqual([
      'build',
      '--cache-to',
      // "which backend, where" survives — that is the diagnostic — and
      // EVERYTHING past the first masked param is masked whole, including what
      // looks like a well-formed `secret_access_key=` param. The join is
      // lossy, so past that point a "param" is indistinguishable from the tail
      // of the credential before it (round-3 review measured
      // `token=aa,name=bbTAIL` surviving).
      'type=s3,region=us-east-1,bucket=b,access_key_id=***,***',
      '--cache-from',
      // Matched case-insensitively: BuildKit's own option parsing is.
      'type=gha,Token=***',
      '.',
    ]);
  });

  it('masks a cache credential whose value CONTAINS a comma, tail and all (issue #2623 round 2)', () => {
    // `cacheOptionToFlag` joins params with a bare `,` and no quoting, and
    // BuildKit itself parses `--cache-to` as CSV, so a comma inside a value
    // splits into a masked head and a bare tail. Both round-2 reviewers
    // measured the tail printing verbatim under the first cut's denylist —
    // output that LOOKS redacted. The allowlist masks a continuation fragment
    // by construction: it has no recognised param name.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,region=us-east-1,secret_access_key=head2623,tail2623Secret,bucket=b',
      ])
    ).toEqual([
      '--cache-to',
      // `bucket=b` is masked too: it FOLLOWS the credential, so it may be its
      // tail rather than a param. The prefix before the credential survives.
      'type=s3,region=us-east-1,secret_access_key=***,***,***',
    ]);
    expect(redactDockerArgvValues(['--cache-to', 'type=gha,token=aa,bb2623'])).toEqual([
      '--cache-to',
      'type=gha,token=***,***',
    ]);
  });

  it('masks a continuation that LOOKS like an allowlisted param (issue #2623 round 3)', () => {
    // The measured hole in round 3: `token=aa,name=bbTAIL` re-read `name=` as
    // a new param and printed the tail. Nothing past the first mask is trusted.
    expect(redactDockerArgvValues(['--cache-to', 'type=gha,token=aa,name=bb2623Tail'])).toEqual([
      '--cache-to',
      'type=gha,token=***,***',
    ]);
  });

  it("keeps buildx's legacy `--cache-from <NAME>` shorthand whole (issue #2623 round 3)", () => {
    // A bare image ref is documented buildx syntax, a pure locator, and the
    // WHOLE diagnostic. The continuation rule ate it for one round; a
    // continuation can only occur at index > 0, so index 0 survives.
    const args = ['build', '--cache-from', 'myrepo/img:cache', '.'];
    expect(redactDockerArgvValues(args)).toEqual(args);
    expect(redactDockerArgvValues(['--cache-from=alpine:latest'])).toEqual([
      '--cache-from=alpine:latest',
    ]);
  });

  it('leaves an EMPTY cache value alone — `***` would assert a secret (issue #2623 round 3)', () => {
    expect(redactDockerArgvValues(['--cache-to', ''])).toEqual(['--cache-to', '']);
  });

  it('strips userinfo and query from a URL locator param (issue #2623 round 3)', () => {
    // azblob builds an UNAUTHENTICATED client from `account_url` when
    // `secret_access_key` is absent, so a SAS token in its query is that
    // backend's supported auth path, not an incidental URL credential.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=azblob,account_url=https://acct.blob.core.windows.net?sig=SAS2623Secret',
      ])
    ).toEqual(['--cache-to', 'type=azblob,account_url=https://acct.blob.core.windows.net?***']);
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://user:pw2623@minio.local:9000',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=https://***@minio.local:9000']);
    // A plain endpoint has nothing to strip and is left byte-identical.
    const plain = ['--cache-to', 'type=s3,endpoint_url=https://minio.local:9000'];
    expect(redactDockerArgvValues(plain)).toEqual(plain);
  });

  it("masks pflag's CLUSTERED shorthand `-itdeKEY=VALUE` (issue #2623 round 3)", () => {
    // `docker run -itd` is the most common docker shorthand there is, and
    // pflag reads `-itdeK=v` as `-i -t -d -e K=v`. Anchoring on a `-e` PREFIX
    // saw only the un-clustered form.
    expect(redactDockerArgvValues(['run', '-itdeNPM_TOKEN=npm_2623Clustered', 'img'])).toEqual([
      'run',
      '-itdeNPM_TOKEN=***',
      'img',
    ]);
  });

  it("masks a CLUSTERED shorthand whose value is a SEPARATE token (issue #2623 round 4)", () => {
    // pflag's `parseSingleShortArg` falls through to `value = args[0]` when
    // the cluster runs out, so `-itde K=v` is `-i -t -d -e K=v`. The attached
    // scan bails (nothing after the letter) and the two-token branch looked
    // `-itde` up as a whole flag and missed, so this printed verbatim.
    expect(redactDockerArgvValues(['run', '-itde', 'K=npm_2623Separated', 'img'])).toEqual([
      'run',
      '-itde',
      'K=***',
      'img',
    ]);
    expect(redactDockerArgvValues(['run', '-de', 'K=npm_2623Separated', 'img'])).toEqual([
      'run',
      '-de',
      'K=***',
      'img',
    ]);
    // A cluster NOT ending in a value-bearing letter still pairs with nothing.
    const untouched = ['run', '-itd', 'K=keepme-2623', 'img'];
    expect(redactDockerArgvValues(untouched)).toEqual(untouched);
  });

  it('fails CLOSED on a URL locator with no recognisable authority (issue #2623 round 4)', () => {
    // These four params are the ONLY ones exempt from the allowlist's
    // mask-by-default rule, so an unparseable shape must mask rather than pass
    // through. A scheme-less `user:pw@host:9000` is a real `endpoint_url`
    // spelling and printed verbatim for one round.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=user:pw2623@minio.local:9000'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***']);
    // Protocol-relative still parses, so the host survives.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=//user:pw2623@minio.local'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=//***@minio.local']);
  });

  it('strips a userinfo containing a literal slash, and a fragment (issue #2623 round 4)', () => {
    // A literal `/` in userinfo is invalid URL syntax, but docker prints what
    // it was given -- anchoring the authority on the first `/` let
    // `AKIA:wJal/rX@host` through whole.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://AKIA:wJal/rX2623@minio.local',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=https://***@minio.local']);
    expect(
      redactDockerArgvValues(['--cache-to', 'type=azblob,account_url=https://h#sig=SAS2623'])
    ).toEqual(['--cache-to', 'type=azblob,account_url=https://h#***']);
    // A password containing `?` must not read as "no userinfo". Bounding the
    // authority at the first `?` did exactly that and printed `user:p` --
    // measured on this branch, which is why the strip anchors on the LAST `@`
    // rather than on any computed boundary.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=https://user:p?w2623@h/x'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=https://***@h/x']);
  });

  it('fails CLOSED when a COMMA inside userinfo cuts the `@` away (issue #2623 round 5)', () => {
    // `maskArgvFlagValue` splits the param list on `,` BEFORE this URL ever
    // reaches `redactUrlLocator`, so a comma inside the userinfo arrives as a
    // head with no `@` at all -- indistinguishable from a plain host, and it
    // passed through whole (round-5 security review enumerated 1008 leaking
    // shapes, all one root cause). A `:` in the host whose right side is not a
    // pure port is `user:password` with its `@` cut off.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://AKIAX:wJalr2623,XyZ@minio.local',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***,***']);
    // A real host:PORT is not that shape and keeps working.
    const port = ['--cache-to', 'type=s3,endpoint_url=https://minio.local:9000'];
    expect(redactDockerArgvValues(port)).toEqual(port);
  });

  it('masks a URL param when a LATER part carries the severed `@` (issue #2623 round 6)', () => {
    // The head-shape guard only recognised `user:password`. Two spellings
    // walked past it, both measured: a BARE-TOKEN userinfo (no `:` at all, so
    // the severed head is indistinguishable from a hostname -- and it is the
    // dominant registry / GHA spelling), and an ALL-DIGIT password, which
    // satisfies the port test. The caller still holds the parts the split
    // produced, and an orphaned `@` downstream of a URL param can only be that
    // URL's own userinfo terminator.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://ghp_2623BareToken,TAIL@github.com',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***,***']);
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://admin:12345,tail2623@minio.local',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***,***']);
    // Same root cause reached through a `/` rather than a `:`.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://tok2623/x,TAIL@h',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***,***']);
    // MULTIPLE later parts, so `some` and `every` are distinguishable. Every
    // other case here has exactly ONE part after the URL param, which makes
    // that mutation unkillable -- and `every` LEAKS: it only fires when the
    // last part happens to hold the `@`, so `…,TAIL@github.com,region=…` would
    // print the token head.
    expect(
      redactDockerArgvValues([
        '--cache-to',
        'type=s3,endpoint_url=https://ghp_2623MultiTail,TAIL@github.com,region=us-east-1,bucket=b',
      ])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***,***,***,***']);
    // And the other direction: no later `@` means no severance, so a real
    // endpoint beside a real param is untouched.
    const intact = ['--cache-to', 'type=s3,endpoint_url=https://h:9000,region=us-east-1'];
    expect(redactDockerArgvValues(intact)).toEqual(intact);
  });

  it('masks a `user:password` host even with NO `@` anywhere (issue #2623 round 6)', () => {
    // The case the severed-`@` rule CANNOT see, and therefore the one that
    // keeps the host-colon rule from being an unkillable line: a malformed
    // URL that simply carries credentials and never had an `@` at all. No
    // later part holds one, so only the head's own shape can refuse it.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=https://AKIA:wJalr2623Secret'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***']);
    // And the `\d{1,5}` bound: a port is at most 65535, so a longer digit run
    // is a password, not a port.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=https://admin:1234567'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***']);
    // A real port still survives, which is what makes the bound a bound.
    const port = ['--cache-to', 'type=s3,endpoint_url=https://minio.local:65535'];
    expect(redactDockerArgvValues(port)).toEqual(port);
  });

  it('keeps a bracketed IPv6 endpoint intact (issue #2623 round 6)', () => {
    // The port test matched the FIRST `:` of a bracketed literal, so a
    // legitimate local-MinIO spelling masked -- and because a mask cascades,
    // took `region` and `bucket` with it. Verified as a regression the
    // implausible-authority rule introduced, not a pre-existing one.
    const args = [
      '--cache-to',
      'type=s3,endpoint_url=http://[::1]:9000,region=us-east-1,bucket=b',
    ];
    expect(redactDockerArgvValues(args)).toEqual(args);
    const linkLocal = ['--cache-to', 'type=s3,endpoint_url=http://[fd00::1]:5000'];
    expect(redactDockerArgvValues(linkLocal)).toEqual(linkLocal);
    // But a bracket is not a blanket exemption: bracketed CREDENTIAL material
    // has no `@` anywhere, so the caller's severed-`@` scan cannot see it
    // either, and exempting all bracket content re-opened the one case the
    // head-shape rule is kept for. `K`/`w`/`J` are not hex digits.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,endpoint_url=https://[AKIA:wJalr2623]'])
    ).toEqual(['--cache-to', 'type=s3,endpoint_url=***']);
  });

  it('leaves an EMPTY URL locator value alone (issue #2623 round 5)', () => {
    // `***` would assert a secret that is not there -- and because a mask
    // cascades, it would take every later param's diagnostic with it.
    const args = ['--cache-to', 'type=s3,endpoint_url=,region=us-east-1'];
    expect(redactDockerArgvValues(args)).toEqual(args);
  });

  it('leaves an EMPTY cache param part alone at ANY index (issue #2623 round 4)', () => {
    // Same reason the index-0 carve-out gives, applied consistently: `***`
    // asserts a secret, and an empty part carries none.
    expect(redactDockerArgvValues(['--cache-to', 'type=s3,,region=us-east-1'])).toEqual([
      '--cache-to',
      'type=s3,,region=us-east-1',
    ]);
  });

  it('masks an UNRECOGNISED cache param — the list is an ALLOWLIST (issue #2623 round 2)', () => {
    // Fail-CLOSED is the whole point of the inversion: a param BuildKit adds
    // after this list was written costs one degraded diagnostic, where a
    // denylist would cost a printed credential.
    expect(
      redactDockerArgvValues(['--cache-to', 'type=s3,bucket=b,future_param=cred2623Unknown'])
    ).toEqual(['--cache-to', 'type=s3,bucket=b,future_param=***']);
  });

  it('masks pflag ATTACHED short-flag form `-eKEY=VALUE` (issue #2623 round 2)', () => {
    // docker uses pflag, which glues a short flag to its value. No argv this
    // repo builds spells it, but `docker-build.ts`'s `executable` mode hands a
    // user's own command line straight to `spawn`.
    expect(
      redactDockerArgvValues(['run', '-eNPM_TOKEN=npm_2623Attached', '-e', 'K=v', 'img'])
    ).toEqual(['run', '-eNPM_TOKEN=***', '-e', 'K=***', 'img']);
    // A bare `-e` still pairs with the NEXT token, and a short flag with no
    // `=` in its tail is left alone.
    expect(redactDockerArgvValues(['-eNOEQUALS'])).toEqual(['-eNOEQUALS']);
  });

  it('leaves a cache flag with NO credential param untouched (issue #2623 review)', () => {
    // The other direction: blanking the whole value would destroy the
    // diagnostic to hide a field that is not there.
    const args = ['build', '--cache-from', 'type=registry,ref=example.com/cache:latest', '.'];
    expect(redactDockerArgvValues(args)).toEqual(args);
  });

  it('leaves --secret and --build-context alone — both carry a LOCATOR, not a value (issue #2623)', () => {
    // The other direction of the guarantee. `--secret id=<id>,src=<path>` names
    // a file BuildKit reads itself (docker has no inline-value form), and
    // `--build-context <name>=<path>` is a path or an image ref. Masking either
    // would blank the diagnostic — the `id`, and the path that failed — for no
    // disclosure prevented. If someone adds one to ARGV_VALUE_BEARING_FLAGS,
    // this goes red and the JSDoc's reasoning has to be re-argued first.
    const args = [
      'build',
      '--secret',
      'id=npmrc,src=./.npmrc',
      '--build-context',
      'sources=../sources',
      '--ssh',
      'default',
      '.',
    ];
    expect(redactDockerArgvValues(args)).toEqual(args);
  });
});

