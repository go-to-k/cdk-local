import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { Server, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  MIXED_MODE_RESIGN_BODY_CAP_BYTES,
  RESIGN_SIDECAR_CORE,
  RESIGN_SIDECAR_SCRIPT,
  type ResignSidecarConfig,
} from '../../../src/local/emulator-resign-sidecar.js';
import { createMixedModeTlsMaterials } from '../../../src/local/mixed-mode-tls.js';

// The shipped sidecar code, loaded as-is.
interface Core {
  decodeAwsChunked(buf: Buffer): { body: Buffer; trailers: Record<string, string> };
  prepareResign(
    req: { method: string; url: string; headers: Record<string, string> },
    body: Buffer,
    cfg: Partial<ResignSidecarConfig> & { upstreamHost: string; capBytes: number },
    now: Date
  ): {
    error?: { status: number; code: string; message: string };
    path?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    service?: string;
  };
  tooLargeByHeaders(headers: Record<string, string>, cap: number): number;
  parseAuthScope(a: string): { region?: string; service: string } | undefined;
}
const core = new Function(
  'require',
  `${RESIGN_SIDECAR_CORE}; return { decodeAwsChunked, prepareResign, tooLargeByHeaders, parseAuthScope };`
)(createRequire(import.meta.url)) as Core;

const EMU = { accessKeyId: 'EMULATORKEY000000001', secretAccessKey: 'emulator-secret-0123456789' };
const REAL_AUTH =
  'AWS4-HMAC-SHA256 Credential=REALKEYIDREALKEYID00/20261112/eu-west-1/dynamodb/aws4_request, ' +
  'SignedHeaders=host;x-amz-date, Signature=deadbeef';

/** Verify a request's SigV4 independently, with the AWS SDK's own signer. */
async function verifySignature(
  req: { method: string; url: string; headers: Record<string, string | string[] | undefined> },
  body: Buffer,
  creds: { accessKeyId: string; secretAccessKey: string }
): Promise<{ ok: boolean; service: string; region: string; keyId: string }> {
  const auth = String(req.headers['authorization']);
  const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(
    auth
  );
  if (!m) return { ok: false, service: '', region: '', keyId: '' };
  const [, keyId, , region, service, signedHeaders, signature] = m as unknown as string[];
  const headers: Record<string, string> = {};
  for (const h of signedHeaders!.split(';')) headers[h] = String(req.headers[h]);
  const u = new URL(req.url, 'https://placeholder');
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  const signer = new SignatureV4({
    credentials: creds,
    region: region!,
    service: service!,
    sha256: Sha256,
    uriEscapePath: service !== 's3',
  });
  const amzDate = headers['x-amz-date']!;
  const date = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  const signed = await signer.sign(
    {
      method: req.method,
      protocol: 'https:',
      hostname: headers['host']!.split(':')[0]!,
      // The path as sent (already escaped once): SigV4 escapes it again for non-S3.
      path: u.pathname,
      query,
      headers,
      body,
    },
    { signingDate: date }
  );
  const expected = /Signature=([0-9a-f]+)/.exec(String(signed.headers['authorization']))![1];
  return { ok: expected === signature, service: service!, region: region!, keyId: keyId! };
}

describe('decodeAwsChunked', () => {
  it('decodes signed chunks and drops the chunk signatures', () => {
    const raw = Buffer.from(
      '5;chunk-signature=aaaa\r\nhello\r\n6;chunk-signature=bbbb\r\n world\r\n0;chunk-signature=cccc\r\n\r\n',
      'latin1'
    );
    const r = core.decodeAwsChunked(raw);
    expect(r.body.toString()).toBe('hello world');
    expect(Object.keys(r.trailers)).toEqual([]);
  });

  it('decodes an unsigned trailer body into a body plus its checksum trailer', () => {
    const raw = Buffer.from(
      '3\r\nabc\r\n0\r\nx-amz-checksum-crc32:NSRBwg==\r\nx-amz-trailer-signature:ffff\r\n\r\n',
      'latin1'
    );
    const r = core.decodeAwsChunked(raw);
    expect(r.body.toString()).toBe('abc');
    expect({ ...r.trailers }).toEqual({ 'x-amz-checksum-crc32': 'NSRBwg==' });
  });

  it('keeps binary chunk data byte for byte', () => {
    const data = Buffer.from([0, 13, 10, 255, 128, 13, 10]);
    const raw = Buffer.concat([
      Buffer.from(`${data.length.toString(16)};chunk-signature=x\r\n`, 'latin1'),
      data,
      Buffer.from('\r\n0;chunk-signature=y\r\n\r\n', 'latin1'),
    ]);
    expect(core.decodeAwsChunked(raw).body.equals(data)).toBe(true);
  });

  it('rejects a truncated or malformed body', () => {
    expect(() => core.decodeAwsChunked(Buffer.from('a\r\nabc'))).toThrow(/truncated/);
    expect(() => core.decodeAwsChunked(Buffer.from('zz\r\nabc\r\n'))).toThrow(/chunk size/);
    expect(() => core.decodeAwsChunked(Buffer.from('3\r\nabcXX0\r\n\r\n'))).toThrow(/terminator/);
  });
});

describe('prepareResign', () => {
  const cfg = {
    upstreamHost: '127.0.0.1:9361',
    credentials: EMU,
    capBytes: 1024,
  };
  const now = new Date('2026-11-12T10:00:00Z');

  it('drops the real signature and token and signs with the emulator keys, keeping the scope', async () => {
    const body = Buffer.from('{"TableName":"t"}');
    const p = core.prepareResign(
      {
        method: 'POST',
        url: '/',
        headers: {
          authorization: REAL_AUTH,
          host: '127.0.0.1:47297',
          'x-amz-date': '20261112T095959Z',
          'x-amz-security-token': 'REAL-SESSION-TOKEN',
          'x-amz-target': 'DynamoDB_20120810.PutItem',
          'content-type': 'application/x-amz-json-1.0',
          'content-length': String(body.length),
          'user-agent': 'aws-sdk-js',
        },
      },
      body,
      cfg,
      now
    );
    expect(p.error).toBeUndefined();
    const h = p.headers!;
    expect(JSON.stringify(h)).not.toContain('REALKEYID');
    expect(JSON.stringify(h)).not.toContain('REAL-SESSION-TOKEN');
    expect(h['host']).toBe('127.0.0.1:9361');
    expect(h['x-amz-date']).toBe('20261112T100000Z');
    expect(h['content-length']).toBe(String(body.length));
    expect(h['x-amz-target']).toBe('DynamoDB_20120810.PutItem');
    const v = await verifySignature({ method: 'POST', url: p.path!, headers: h }, body, EMU);
    expect(v).toEqual({ ok: true, service: 'dynamodb', region: 'eu-west-1', keyId: EMU.accessKeyId });
  });

  it('S3: decodes aws-chunked, moves the trailing checksum into a signed header, and drops the chunking headers', async () => {
    const raw = Buffer.from(
      '5\r\nhello\r\n0\r\nx-amz-checksum-crc32:NhCmhg==\r\n\r\n',
      'latin1'
    );
    const p = core.prepareResign(
      {
        method: 'PUT',
        url: '/bucket/dir/my%20key.txt?x-id=PutObject',
        headers: {
          authorization: REAL_AUTH.replace('dynamodb', 's3'),
          'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
          'content-encoding': 'aws-chunked',
          'x-amz-decoded-content-length': '5',
          'x-amz-trailer': 'x-amz-checksum-crc32',
          'x-amz-sdk-checksum-algorithm': 'CRC32',
          'content-length': String(raw.length),
        },
      },
      raw,
      cfg,
      now
    );
    expect(p.body!.toString()).toBe('hello');
    const h = p.headers!;
    expect(h['content-encoding']).toBeUndefined();
    expect(h['x-amz-decoded-content-length']).toBeUndefined();
    expect(h['x-amz-trailer']).toBeUndefined();
    expect(h['x-amz-checksum-crc32']).toBe('NhCmhg==');
    expect(h['x-amz-content-sha256']).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(h['authorization']).toMatch(/SignedHeaders=[^,]*x-amz-checksum-crc32/);
    expect(p.path).toBe('/bucket/dir/my%20key.txt?x-id=PutObject');
    const v = await verifySignature({ method: 'PUT', url: p.path!, headers: h }, p.body!, EMU);
    expect(v.ok).toBe(true);
    expect(v.service).toBe('s3');
  });

  it('keeps a content-encoding other than aws-chunked', () => {
    const p = core.prepareResign(
      {
        method: 'PUT',
        url: '/b/k',
        headers: {
          authorization: REAL_AUTH.replace('dynamodb', 's3'),
          'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
          'content-encoding': 'aws-chunked,gzip',
        },
      },
      Buffer.from('2;chunk-signature=a\r\nhi\r\n0;chunk-signature=b\r\n\r\n'),
      cfg,
      now
    );
    expect(p.headers!['content-encoding']).toBe('gzip');
    expect(p.body!.toString()).toBe('hi');
  });

  it('presigned URL: strips every presign parameter (the real token too) and signs with headers', async () => {
    const url =
      '/bucket/obj?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=REALKEYID%2F20261112%2Fap-northeast-1%2Fs3%2Faws4_request' +
      '&X-Amz-Date=20261112T095959Z&X-Amz-Expires=900&X-Amz-Security-Token=REALTOKEN&X-Amz-Signature=abcd' +
      '&X-Amz-SignedHeaders=host&versionId=v1&x-id=GetObject';
    const p = core.prepareResign({ method: 'GET', url, headers: {} }, Buffer.alloc(0), cfg, now);
    expect(p.path).toBe('/bucket/obj?versionId=v1&x-id=GetObject');
    expect(JSON.stringify(p)).not.toContain('REAL');
    const v = await verifySignature({ method: 'GET', url: p.path!, headers: p.headers! }, Buffer.alloc(0), EMU);
    expect(v).toMatchObject({ ok: true, service: 's3', region: 'ap-northeast-1' });
  });

  it('strips presign parameters even when the request also carries a header signature', () => {
    const p = core.prepareResign(
      {
        method: 'GET',
        url: '/b/k?X-Amz-Security-Token=REALTOKEN&X-Amz-Signature=abcd&X-Amz-Credential=REALKEYID%2Fx&partNumber=1',
        headers: { authorization: REAL_AUTH.replace('dynamodb', 's3') },
      },
      Buffer.alloc(0),
      cfg,
      now
    );
    expect(p.path).toBe('/b/k?partNumber=1');
    expect(JSON.stringify(p)).not.toContain('REALTOKEN');
  });

  it('refuses a trailer whose name or value is not a valid header (never forwarded)', () => {
    for (const trailer of ['bad name:x', 'x-amz-checksum-crc32:a\u0000b']) {
      const p = core.prepareResign(
        {
          method: 'PUT',
          url: '/b/k',
          headers: {
            authorization: REAL_AUTH.replace('dynamodb', 's3'),
            'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
          },
        },
        Buffer.from(`1\r\na\r\n0\r\n${trailer}\r\n\r\n`, 'latin1'),
        cfg,
        now
      );
      expect(p.error).toMatchObject({ status: 400, code: 'IncompleteBody' });
    }
  });

  it('non-S3 paths are double-encoded the way the SDKs sign them', async () => {
    const p = core.prepareResign(
      {
        method: 'GET',
        url: '/2015-03-31/functions/my%3Afn/configuration',
        headers: { authorization: REAL_AUTH.replace('dynamodb', 'lambda') },
      },
      Buffer.alloc(0),
      cfg,
      now
    );
    const v = await verifySignature({ method: 'GET', url: p.path!, headers: p.headers! }, Buffer.alloc(0), EMU);
    expect(v.ok).toBe(true);
  });

  it('SigV4a: takes the region from X-Amz-Region-Set and signs SigV4', () => {
    const p = core.prepareResign(
      {
        method: 'GET',
        url: '/b/k',
        headers: {
          authorization:
            'AWS4-ECDSA-P256-SHA256 Credential=REALKEYID/20261112/s3/aws4_request, SignedHeaders=host, Signature=00',
          'x-amz-region-set': 'us-west-2',
        },
      },
      Buffer.alloc(0),
      cfg,
      now
    );
    expect(p.headers!['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=EMULATORKEY000000001\/20261112\/us-west-2\/s3\//);
  });

  it('forwards an unsigned request unsigned, and refuses an unreadable signature without forwarding it', () => {
    const unsigned = core.prepareResign(
      { method: 'GET', url: '/__admin/health', headers: {} },
      Buffer.alloc(0),
      cfg,
      now
    );
    expect(unsigned.headers!['authorization']).toBeUndefined();
    const bad = core.prepareResign(
      { method: 'GET', url: '/', headers: { authorization: 'AWS REALKEYID:sig' } },
      Buffer.alloc(0),
      cfg,
      now
    );
    expect(bad.error).toMatchObject({ status: 400, code: 'IncompleteSignature' });
    expect(bad.headers).toBeUndefined();
  });

  it('refuses a decoded body over the cap with a message naming it and multipart upload', () => {
    const p = core.prepareResign(
      { method: 'PUT', url: '/b/k', headers: { authorization: REAL_AUTH.replace('dynamodb', 's3') } },
      Buffer.alloc(1025),
      cfg,
      now
    );
    expect(p.error).toMatchObject({ status: 413, code: 'EntityTooLarge' });
    expect(p.error!.message).toMatch(/1024-byte cap.*multipart upload/);
  });

  it('tooLargeByHeaders: decoded length over the cap, or raw length over the cap plus framing slack', () => {
    expect(core.tooLargeByHeaders({ 'x-amz-decoded-content-length': '2000' }, 1024)).toBe(2000);
    expect(core.tooLargeByHeaders({ 'content-length': '2000' }, 1024)).toBe(0);
    expect(core.tooLargeByHeaders({ 'content-length': String(1024 + 1048577) }, 1024)).toBe(
      1024 + 1048577
    );
  });

  it('the cap is 100 MiB', () => {
    expect(MIXED_MODE_RESIGN_BODY_CAP_BYTES).toBe(104857600);
  });
});

describe('the sidecar server, end to end with the AWS SDK', () => {
  // A fake emulator: verifies every request's signature against the emulator
  // keys and records what arrived.
  const received: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer; sigOk: boolean }[] = [];
  let upstream: Server;
  let sidecar: ChildProcess;
  let dir: string;
  const port = 47000 + Math.floor(Math.random() * 900);
  const tls = createMixedModeTlsMaterials();
  const upstreamTls = createMixedModeTlsMaterials();
  const realCreds = {
    accessKeyId: 'REALKEYIDREALKEYID00',
    secretAccessKey: 'real-secret',
    sessionToken: 'REAL-SESSION-TOKEN',
  };

  beforeAll(async () => {
    upstream = createHttpsServer({ key: upstreamTls.keyPem, cert: upstreamTls.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        void verifySignature(
          { method: req.method!, url: req.url!, headers: req.headers },
          body,
          EMU
        ).then((v) => {
          received.push({ method: req.method!, url: req.url!, headers: req.headers, body, sigOk: v.ok });
          if (req.headers['x-amz-target']) {
            res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
            res.end('{}');
          } else {
            res.writeHead(200, { etag: '"e"' });
            res.end();
          }
        });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    dir = mkdtempSync(path.join(tmpdir(), 'resign-test-'));
    const cfgPath = path.join(dir, 'resign.json');
    const cfg: ResignSidecarConfig = {
      port,
      upstream: `https://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      upstreamCaPem: upstreamTls.caCertPem,
      certPem: tls.certPem,
      keyPem: tls.keyPem,
      credentials: EMU,
      capBytes: 4 * 1024 * 1024,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
    sidecar = spawn(
      process.execPath,
      [
        '-e',
        `${RESIGN_SIDECAR_SCRIPT}\nstartResigner(process.argv[1]).then((r)=>process.stdout.write('STARTED '+JSON.stringify(r)+'\\n'));`,
        cfgPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve, reject) => {
      sidecar.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('STARTED {"port"')) resolve();
        else if (d.toString().includes('STARTED')) reject(new Error(d.toString()));
      });
    });
  });

  afterAll(async () => {
    if (sidecar && sidecar.exitCode === null) {
      const exited = new Promise((r) => sidecar.once('exit', r));
      sidecar.kill();
      await exited;
    }
    upstream?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const handler = (): NodeHttpHandler =>
    new NodeHttpHandler({ httpsAgent: new HttpsAgent({ ca: [tls.caCertPem] }) });

  it('an SQS (JSON protocol) call signed with real keys arrives signed with the emulator keys', async () => {
    const sqs = new SQSClient({
      region: 'eu-west-1',
      endpoint: `https://127.0.0.1:${port}`,
      credentials: realCreds,
      requestHandler: handler(),
    });
    await sqs
      .send(new SendMessageCommand({ QueueUrl: 'https://127.0.0.1/000000000000/q', MessageBody: 'm' }))
      .catch(() => undefined); // the fake emulator's `{}` is not a full SendMessage result
    const r = received.at(-1)!;
    expect(r.sigOk).toBe(true);
    expect(String(r.headers['authorization'])).toContain(`Credential=${EMU.accessKeyId}/`);
    expect(String(r.headers['authorization'])).toContain('/eu-west-1/sqs/aws4_request');
    expect(JSON.stringify(r.headers)).not.toContain('REALKEYID');
    expect(JSON.stringify(r.headers)).not.toContain('REAL-SESSION-TOKEN');
    expect(JSON.parse(r.body.toString())).toMatchObject({ MessageBody: 'm' });
  });

  it('S3 PutObject (chunked when the SDK streams) arrives as a plain body, byte for byte', async () => {
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: `https://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: realCreds,
      requestHandler: handler(),
    });
    const data = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    const { Readable } = await import('node:stream');
    await s3.send(
      new PutObjectCommand({
        Bucket: 'b',
        Key: 'k.bin',
        Body: Readable.from([data.subarray(0, 1_000_000), data.subarray(1_000_000)]),
        ContentLength: data.length,
      })
    );
    const r = received.at(-1)!;
    expect(r.sigOk).toBe(true);
    expect(r.url).toMatch(/^\/b\/k\.bin/);
    // The SDK streamed the body as aws-chunked with a CRC32 trailer; the trailer
    // arrives as an ordinary (signed) header.
    expect(r.headers['x-amz-checksum-crc32']).toBeDefined();
    expect(r.headers['x-amz-trailer']).toBeUndefined();
    expect(r.body.equals(data)).toBe(true);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['x-amz-decoded-content-length']).toBeUndefined();
  });

  it('answers 413 past the cap and forwards nothing', async () => {
    const before = received.length;
    const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: '/b/big',
          ca: [tls.caCertPem],
          headers: {
            authorization: REAL_AUTH.replace('dynamodb', 's3'),
            'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          },
        },
        (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () => resolve({ code: res.statusCode!, body: b }));
        }
      );
      req.on('error', reject);
      req.end(Buffer.alloc(4 * 1024 * 1024 + 1024 * 1024 + 10));
    });
    expect(status.code).toBe(413);
    expect(status.body).toContain('<Code>EntityTooLarge</Code>');
    expect(received.length).toBe(before);
  });

  it('serves its certificate for 127.0.0.1 from the per-run CA (a client without that CA refuses it)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(undefined);
      });
      req.on('error', (e) => resolve(e));
      req.end();
    });
    expect(err?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
  });
});
