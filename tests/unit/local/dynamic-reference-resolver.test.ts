/**
 * Issue #784 — CloudFormation dynamic references resolved locally before a
 * value reaches a container. Covers the grammar of each reference form, the
 * fetch each segment drives, the region each fetch uses, the hard-fail error
 * paths, and that the resolved plaintext reaches neither a log line nor an
 * error message.
 *
 * The SDK command classes are the REAL ones, so `command.input` is exactly
 * what would go on the wire; the clients are fakes injected through the
 * resolver's factory seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  DynamicReferenceResolutionError,
  DynamicReferenceResolver,
  containsDynamicReference,
  firstUsableRegion,
  keysNotFromTemplate,
  keysOverriddenBy,
  templateValueHoldsDynamicReference,
  withoutKeys,
  parseDynamicReference,
  resolveDynamicReferencesInEnv,
} from '../../../src/local/dynamic-reference-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

const PLAINTEXT = 'pl41ntext-S3CRET-value';
const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:app-db-AbCdEf';

interface Call {
  region: string | undefined;
  input: Record<string, unknown>;
}

function fakeClients(handlers: {
  sm?: (input: Record<string, unknown>) => unknown;
  ssm?: (input: Record<string, unknown>) => unknown;
}) {
  const smCalls: Call[] = [];
  const ssmCalls: Call[] = [];
  const destroyed: string[] = [];
  const resolver = new DynamicReferenceResolver({
    secretsManagerClientFactory: (region) => ({
      send: (async (cmd: GetSecretValueCommand) => {
        expect(cmd).toBeInstanceOf(GetSecretValueCommand);
        const input = cmd.input as Record<string, unknown>;
        smCalls.push({ region, input });
        return handlers.sm ? handlers.sm(input) : { SecretString: PLAINTEXT };
      }) as never,
      destroy: () => destroyed.push(`sm:${region}`),
    }),
    ssmClientFactory: (region) => ({
      send: (async (cmd: GetParameterCommand) => {
        expect(cmd).toBeInstanceOf(GetParameterCommand);
        const input = cmd.input as Record<string, unknown>;
        ssmCalls.push({ region, input });
        return handlers.ssm
          ? handlers.ssm(input)
          : { Parameter: { Value: PLAINTEXT, Type: 'String' } };
      }) as never,
      destroy: () => destroyed.push(`ssm:${region}`),
    }),
  });
  return { resolver, smCalls, ssmCalls, destroyed };
}

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { $fault: 'client', $metadata: { httpStatusCode: 400 } });
  return err;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DynamicReferenceResolutionError);
    return (err as Error).message;
  }
  throw new Error('expected the resolve to fail');
}

describe('containsDynamicReference', () => {
  it('detects a well-formed token anywhere in a string', () => {
    expect(containsDynamicReference('{{resolve:ssm:/a}}')).toBe(true);
    expect(containsDynamicReference('pre-{{resolve:secretsmanager:s}}-post')).toBe(true);
  });
  it('ignores non-strings, plain text and an unterminated token', () => {
    expect(containsDynamicReference(42)).toBe(false);
    expect(containsDynamicReference('hello')).toBe(false);
    expect(containsDynamicReference('{{resolve:ssm:/a')).toBe(false);
    expect(containsDynamicReference('{{resolve}}')).toBe(false);
  });
  it('detects a malformed token too, so it fails instead of reaching the container as text', async () => {
    expect(containsDynamicReference('{{resolve:ssm}}')).toBe(true);
    expect(containsDynamicReference('{{resolve:ssm:/a{b}}')).toBe(true);
    const { resolver, ssmCalls } = fakeClients({});
    for (const bad of ['{{resolve:ssm}}', 'x-{{resolve:secretsmanager}}', '{{resolve:ssm:/a{b}}']) {
      const msg = await failure(resolver.resolveString(bad, { consumer: 'Lambda Fn env var K' }));
      expect(msg).toMatch(/Malformed CloudFormation dynamic reference/);
      expect(msg).toContain('Lambda Fn env var K');
    }
    expect(ssmCalls).toHaveLength(0);
  });
});

describe('parseDynamicReference', () => {
  it('secretsmanager by name, every segment defaulted', () => {
    expect(parseDynamicReference('{{resolve:secretsmanager:MySecret}}')).toEqual({
      service: 'secretsmanager',
      raw: '{{resolve:secretsmanager:MySecret}}',
      secretId: 'MySecret',
    });
  });

  it('secretsmanager by ARN with SecretString + json-key (the CDK SecretValue shape)', () => {
    const raw = `{{resolve:secretsmanager:${SECRET_ARN}:SecretString:password::}}`;
    expect(parseDynamicReference(raw)).toEqual({
      service: 'secretsmanager',
      raw,
      secretId: SECRET_ARN,
      arnRegion: 'eu-west-1',
      jsonKey: 'password',
    });
  });

  it('secretsmanager version-stage and version-id segments', () => {
    expect(
      parseDynamicReference('{{resolve:secretsmanager:MySecret:SecretString::AWSPREVIOUS}}')
    ).toMatchObject({ versionStage: 'AWSPREVIOUS' });
    expect(
      parseDynamicReference('{{resolve:secretsmanager:MySecret:SecretString:::v-id-1}}')
    ).toMatchObject({ versionId: 'v-id-1' });
    expect(parseDynamicReference('{{resolve:secretsmanager:MySecret::k}}')).toMatchObject({
      jsonKey: 'k',
    });
  });

  it('rejects malformed secretsmanager references', () => {
    expect(() => parseDynamicReference('{{resolve:secretsmanager:S:SecretBinary}}')).toThrow(
      /only supported value segment is SecretString/
    );
    expect(() => parseDynamicReference('{{resolve:secretsmanager:S:SecretString::st:id}}')).toThrow(
      /not both/
    );
    expect(() => parseDynamicReference('{{resolve:secretsmanager:S:SecretString:a:b:c:d}}')).toThrow(
      /too many segments/
    );
    expect(() => parseDynamicReference('{{resolve:secretsmanager:}}')).toThrow(/secret id is empty/);
    expect(() =>
      parseDynamicReference('{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:1}}')
    ).toThrow(/secret ARN/);
  });

  it('ssm and ssm-secure, with and without a version', () => {
    expect(parseDynamicReference('{{resolve:ssm:/app/url}}')).toEqual({
      service: 'ssm',
      raw: '{{resolve:ssm:/app/url}}',
      name: '/app/url',
    });
    expect(parseDynamicReference('{{resolve:ssm:/app/url:3}}')).toMatchObject({
      name: '/app/url',
      version: '3',
    });
    expect(parseDynamicReference('{{resolve:ssm-secure:/app/pw:2}}')).toMatchObject({
      service: 'ssm-secure',
      name: '/app/pw',
      version: '2',
    });
  });

  it('ssm by ARN carries the ARN region and an optional version', () => {
    const arn = 'arn:aws:ssm:ap-northeast-1:123456789012:parameter/shared/p';
    expect(parseDynamicReference(`{{resolve:ssm:${arn}:4}}`)).toMatchObject({
      name: arn,
      arnRegion: 'ap-northeast-1',
      version: '4',
    });
  });

  it('rejects malformed ssm references and unknown services', () => {
    expect(() => parseDynamicReference('{{resolve:ssm:/p:latest}}')).toThrow(/positive integer/);
    expect(() => parseDynamicReference('{{resolve:ssm:/p:0}}')).toThrow(/positive integer/);
    expect(() => parseDynamicReference('{{resolve:ssm:/p:1:2}}')).toThrow(/too many segments/);
    expect(() => parseDynamicReference('{{resolve:ssm:}}')).toThrow(/parameter name is empty/);
    expect(() => parseDynamicReference('{{resolve:vault:x}}')).toThrow(/unsupported service/);
  });
});

describe('DynamicReferenceResolver.resolveString — fetch shape', () => {
  it('secretsmanager: whole SecretString, no version fields', async () => {
    const { resolver, smCalls } = fakeClients({});
    const out = await resolver.resolveString('{{resolve:secretsmanager:MySecret}}', {
      region: 'us-east-2',
      consumer: 'test',
    });
    expect(out).toBe(PLAINTEXT);
    expect(smCalls).toEqual([{ region: 'us-east-2', input: { SecretId: 'MySecret' } }]);
  });

  it('secretsmanager: json-key extracts one field; a non-string field is JSON-encoded', async () => {
    const { resolver } = fakeClients({
      sm: () => ({ SecretString: JSON.stringify({ password: PLAINTEXT, port: 5432 }) }),
    });
    expect(
      await resolver.resolveString(`{{resolve:secretsmanager:${SECRET_ARN}:SecretString:password::}}`, {
        consumer: 't',
      })
    ).toBe(PLAINTEXT);
    expect(
      await resolver.resolveString('{{resolve:secretsmanager:S:SecretString:port}}', { consumer: 't' })
    ).toBe('5432');
  });

  it('secretsmanager: version-stage / version-id reach GetSecretValue', async () => {
    const { resolver, smCalls } = fakeClients({});
    await resolver.resolveString('{{resolve:secretsmanager:S:SecretString::AWSPREVIOUS}}', {
      consumer: 't',
    });
    await resolver.resolveString('{{resolve:secretsmanager:S:SecretString:::vid-9}}', {
      consumer: 't',
    });
    expect(smCalls.map((c) => c.input)).toEqual([
      { SecretId: 'S', VersionStage: 'AWSPREVIOUS' },
      { SecretId: 'S', VersionId: 'vid-9' },
    ]);
  });

  it('ssm reads without decryption, ssm-secure with it, and the version rides on Name', async () => {
    const { resolver, ssmCalls } = fakeClients({});
    await resolver.resolveString('{{resolve:ssm:/a:3}}', { consumer: 't' });
    await resolver.resolveString('{{resolve:ssm-secure:/b}}', { consumer: 't' });
    expect(ssmCalls.map((c) => c.input)).toEqual([
      { Name: '/a:3', WithDecryption: false },
      { Name: '/b', WithDecryption: true },
    ]);
  });

  it('an ARN reference uses the ARN region over the owner region; a name uses the owner region', async () => {
    const { resolver, smCalls, ssmCalls } = fakeClients({});
    await resolver.resolveString(`{{resolve:secretsmanager:${SECRET_ARN}}}`, {
      region: 'us-east-1',
      consumer: 't',
    });
    await resolver.resolveString('{{resolve:ssm:/p}}', { region: 'us-east-1', consumer: 't' });
    await resolver.resolveString('{{resolve:ssm:/q}}', { consumer: 't' });
    expect(smCalls[0]!.region).toBe('eu-west-1');
    expect(ssmCalls.map((c) => c.region)).toEqual(['us-east-1', undefined]);
  });

  it("never uses an env-agnostic stack's `unknown-region` placeholder as a region", async () => {
    const { resolver, ssmCalls } = fakeClients({});
    await resolver.resolveString('{{resolve:ssm:/p}}', { region: 'unknown-region', consumer: 't' });
    expect(ssmCalls[0]!.region).toBeUndefined();
    expect(firstUsableRegion('unknown-region', undefined, '', 'eu-west-3')).toBe('eu-west-3');
    expect(firstUsableRegion(undefined, 'unknown-region')).toBeUndefined();
  });

  it('substitutes embedded and multiple tokens in place', async () => {
    const { resolver } = fakeClients({
      ssm: (input) => ({ Parameter: { Value: `v(${String(input['Name'])})`, Type: 'String' } }),
    });
    expect(
      await resolver.resolveString('postgres://{{resolve:ssm:/u}}:{{resolve:ssm:/h}}/db', {
        consumer: 't',
      })
    ).toBe('postgres://v(/u):v(/h)/db');
  });

  it('never re-scans a resolved value that itself looks like a token', async () => {
    const { resolver, ssmCalls } = fakeClients({
      ssm: () => ({ Parameter: { Value: '{{resolve:ssm:/inner}}', Type: 'String' } }),
    });
    expect(await resolver.resolveString('{{resolve:ssm:/outer}}', { consumer: 't' })).toBe(
      '{{resolve:ssm:/inner}}'
    );
    expect(ssmCalls).toHaveLength(1);
  });

  it('caches per (reference, region) and destroys every client on dispose', async () => {
    const { resolver, ssmCalls, destroyed } = fakeClients({});
    await resolver.resolveString('{{resolve:ssm:/p}}', { region: 'r1', consumer: 't' });
    await resolver.resolveString('{{resolve:ssm:/p}}', { region: 'r1', consumer: 't' });
    await resolver.resolveString('{{resolve:ssm:/p}}', { region: 'r2', consumer: 't' });
    expect(ssmCalls.map((c) => c.region)).toEqual(['r1', 'r2']);
    resolver.dispose();
    expect(destroyed.sort()).toEqual(['ssm:r1', 'ssm:r2']);
  });

  it('a string without a token makes no AWS call', async () => {
    const { resolver, smCalls, ssmCalls } = fakeClients({});
    expect(await resolver.resolveString('plain', { consumer: 't' })).toBe('plain');
    expect(smCalls.length + ssmCalls.length).toBe(0);
  });
});

describe('DynamicReferenceResolver — hard-fail errors', () => {
  it('AccessDenied names the reference, the consumer, the region and the permission', async () => {
    const { resolver } = fakeClients({
      sm: () => {
        throw awsError('AccessDeniedException', 'User is not authorized to GetSecretValue');
      },
    });
    const raw = `{{resolve:secretsmanager:${SECRET_ARN}:SecretString:password::}}`;
    const msg = await failure(
      resolver.resolveString(raw, { consumer: 'Lambda Fn env var DB_PASSWORD' })
    );
    expect(msg).toContain(raw);
    expect(msg).toContain('Lambda Fn env var DB_PASSWORD');
    expect(msg).toContain('eu-west-1');
    expect(msg).toContain('secretsmanager:GetSecretValue');
    expect(msg).toContain('AccessDeniedException');
    expect(msg).toMatch(/does not fall back/);
  });

  it('ParameterNotFound names ssm:GetParameter and says it does not exist', async () => {
    const { resolver } = fakeClients({
      ssm: () => {
        throw awsError('ParameterNotFound', 'Parameter /missing not found.');
      },
    });
    const msg = await failure(
      resolver.resolveString('{{resolve:ssm:/missing}}', { region: 'us-east-1', consumer: 'c' })
    );
    expect(msg).toContain('{{resolve:ssm:/missing}}');
    expect(msg).toContain('ssm:GetParameter');
    expect(msg).toMatch(/does not exist in us-east-1/);
  });

  it('a boundary lookup that no override can skip does not suggest --env-vars', async () => {
    const { resolver } = fakeClients({
      ssm: () => {
        throw awsError('AccessDeniedException', 'denied');
      },
    });
    const boundary = await failure(
      resolver.resolveString('{{resolve:ssm:/p}}', { consumer: 'c', overridable: false })
    );
    expect(boundary).not.toContain('--env-vars');
    expect(boundary).toContain('does not fall back to the unresolved token.');
    const regular = await failure(resolver.resolveString('{{resolve:ssm:/q}}', { consumer: 'c' }));
    expect(regular).toContain('override the variable with --env-vars');
  });

  it('ssm-secure failures name kms:Decrypt as well', async () => {
    const { resolver } = fakeClients({
      ssm: () => {
        throw awsError('AccessDeniedException', 'kms denied');
      },
    });
    const msg = await failure(resolver.resolveString('{{resolve:ssm-secure:/pw}}', { consumer: 'c' }));
    expect(msg).toContain('ssm:GetParameter and kms:Decrypt');
  });

  it('an ssm reference to a SecureString is refused (CloudFormation refuses it too)', async () => {
    const { resolver } = fakeClients({
      ssm: () => ({ Parameter: { Value: 'AQICAH-ciphertext', Type: 'SecureString' } }),
    });
    const msg = await failure(resolver.resolveString('{{resolve:ssm:/pw}}', { consumer: 'c' }));
    expect(msg).toMatch(/ssm-secure/);
    expect(msg).not.toContain('AQICAH-ciphertext');
  });

  it('a malformed reference fails with the consumer named', async () => {
    const { resolver } = fakeClients({});
    const msg = await failure(
      resolver.resolveString('{{resolve:ssm:/p:x}}', { consumer: 'Container web env var X' })
    );
    expect(msg).toContain('Container web env var X');
  });

  it('a failed fetch is not cached, so a retry fetches again', async () => {
    let n = 0;
    const { resolver } = fakeClients({
      ssm: () => {
        n += 1;
        if (n === 1) throw awsError('ThrottlingException', 'slow down');
        return { Parameter: { Value: 'ok', Type: 'String' } };
      },
    });
    await failure(resolver.resolveString('{{resolve:ssm:/p}}', { consumer: 'c' }));
    expect(await resolver.resolveString('{{resolve:ssm:/p}}', { consumer: 'c' })).toBe('ok');
  });
});

describe('no plaintext in logs or errors (#554 precedent)', () => {
  let lines: string[];
  let previousLevel: ReturnType<ReturnType<typeof getLogger>['getLevel']>;
  beforeEach(() => {
    lines = [];
    previousLevel = getLogger().getLevel();
    getLogger().setLevel('debug');
    for (const m of ['log', 'debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => {
    getLogger().setLevel(previousLevel);
    vi.restoreAllMocks();
  });

  it('a successful resolve logs at debug without the value', async () => {
    const { resolver } = fakeClients({});
    const out = await resolver.resolveString('{{resolve:secretsmanager:S}}', {
      consumer: 'Lambda Fn env var TOKEN',
    });
    expect(out).toBe(PLAINTEXT);
    // Positive: the debug line fired, so the negative below is not vacuous.
    expect(lines.some((l) => l.includes('Lambda Fn env var TOKEN'))).toBe(true);
    expect(lines.join('\n')).not.toContain(PLAINTEXT);
  });

  it('a json-key over a non-JSON secret withholds the parser detail', async () => {
    const short = 'hunter2'; // V8 quotes an input this short in FULL
    const { resolver } = fakeClients({ sm: () => ({ SecretString: short }) });
    const msg = await failure(
      resolver.resolveString('{{resolve:secretsmanager:S:SecretString:password}}', { consumer: 'c' })
    );
    expect(msg).toMatch(/not valid JSON \(SyntaxError\)/);
    expect(msg).toContain('password');
    expect(msg).not.toContain(short);
    expect(lines.join('\n')).not.toContain(short);
  });

  it('a missing json-key / non-object root / binary secret name no value', async () => {
    const { resolver } = fakeClients({
      sm: (input) =>
        input['SecretId'] === 'Bin'
          ? { SecretBinary: new Uint8Array([1]) }
          : input['SecretId'] === 'Arr'
            ? { SecretString: JSON.stringify([PLAINTEXT]) }
            : { SecretString: JSON.stringify({ other: PLAINTEXT }) },
    });
    const missing = await failure(
      resolver.resolveString('{{resolve:secretsmanager:Obj:SecretString:password}}', { consumer: 'c' })
    );
    const arr = await failure(
      resolver.resolveString('{{resolve:secretsmanager:Arr:SecretString:password}}', { consumer: 'c' })
    );
    const bin = await failure(resolver.resolveString('{{resolve:secretsmanager:Bin}}', { consumer: 'c' }));
    expect(missing).toMatch(/no such key/);
    expect(arr).toMatch(/not a JSON object/);
    expect(bin).toMatch(/no SecretString/);
    for (const m of [missing, arr, bin]) expect(m).not.toContain(PLAINTEXT);
  });
});

describe('resolveDynamicReferencesInEnv', () => {
  it('resolves token-bearing keys, leaves the rest, and reports the resolved keys', async () => {
    const { resolver } = fakeClients({});
    const env = { A: '{{resolve:ssm:/a}}', B: 'plain', C: 'x-{{resolve:secretsmanager:S}}' };
    const out = await resolveDynamicReferencesInEnv(env, { label: 'Lambda Fn', resolver });
    expect(out.env).toEqual({ A: PLAINTEXT, B: 'plain', C: `x-${PLAINTEXT}` });
    expect(out.resolvedKeys.sort()).toEqual(['A', 'C']);
    // Input not mutated.
    expect(env.A).toBe('{{resolve:ssm:/a}}');
  });

  it('skipKeys are never scanned or fetched', async () => {
    const { resolver, ssmCalls } = fakeClients({});
    const out = await resolveDynamicReferencesInEnv(
      { A: '{{resolve:ssm:/a}}' },
      { label: 'L', resolver, skipKeys: new Set(['A']) }
    );
    expect(out.env['A']).toBe('{{resolve:ssm:/a}}');
    expect(out.resolvedKeys).toEqual([]);
    expect(ssmCalls).toHaveLength(0);
  });

  it('keeps a variable named __proto__ as an own key (#769)', async () => {
    const { resolver } = fakeClients({});
    const env: Record<string, string> = {};
    Object.defineProperty(env, '__proto__', {
      value: '{{resolve:ssm:/a}}',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const out = await resolveDynamicReferencesInEnv(env, { label: 'L', resolver });
    expect(Object.hasOwn(out.env, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out.env, '__proto__')!.value).toBe(PLAINTEXT);
  });

  it('passes the owner region and names the env key in errors', async () => {
    const { resolver, ssmCalls } = fakeClients({
      ssm: () => {
        throw awsError('AccessDeniedException', 'denied');
      },
    });
    const msg = await failure(
      resolveDynamicReferencesInEnv(
        { DB_URL: '{{resolve:ssm:/db}}' },
        { label: 'Lambda Fn', region: 'sa-east-1', resolver }
      )
    );
    expect(ssmCalls[0]!.region).toBe('sa-east-1');
    expect(msg).toContain('Lambda Fn env var DB_URL');
  });
});

describe('keysNotFromTemplate', () => {
  it('flags overridden and undeclared keys, keeps template-derived ones', () => {
    const template = { A: '{{resolve:ssm:/a}}', B: 3, C: { Ref: 'X' }, D: 'same' };
    const finalEnv = { A: '{{resolve:ssm:/a}}', B: '3', C: 'resolved', D: 'same', E: 'extra' };
    expect([...keysNotFromTemplate(template, { ...finalEnv, D: 'overridden' })].sort()).toEqual([
      'C',
      'D',
      'E',
    ]);
    expect([...keysNotFromTemplate(undefined, { A: 'x' })]).toEqual(['A']);
  });
});

describe('override / template helpers', () => {
  it('keysOverriddenBy finds replaced and cleared keys, not untouched ones', () => {
    const template = { A: 'x', B: { Ref: 'R' }, C: 'y' };
    const out = keysOverriddenBy(template, (env) => {
      const next = { ...env, A: 'override' };
      delete (next as Record<string, string>)['B'];
      return next;
    });
    expect([...out].sort()).toEqual(['A', 'B']);
    expect([...keysOverriddenBy(undefined, (e) => e)]).toEqual([]);
  });

  it('withoutKeys drops the named keys and keeps __proto__ as an own key', () => {
    const env: Record<string, string> = { A: '1', B: '2' };
    Object.defineProperty(env, '__proto__', { value: '3', enumerable: true, writable: true, configurable: true });
    const out = withoutKeys(env, new Set(['A']));
    expect(Object.keys(out).sort()).toEqual(['B', '__proto__']);
  });

  it('templateValueHoldsDynamicReference sees a token split across Fn::Join parts', () => {
    expect(templateValueHoldsDynamicReference('{{resolve:ssm:/a}}')).toBe(true);
    expect(
      templateValueHoldsDynamicReference({
        'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'S' }, ':SecretString:k}}']],
      })
    ).toBe(true);
    expect(templateValueHoldsDynamicReference({ Ref: 'Table' })).toBe(false);
    expect(templateValueHoldsDynamicReference(undefined)).toBe(false);
  });
});
