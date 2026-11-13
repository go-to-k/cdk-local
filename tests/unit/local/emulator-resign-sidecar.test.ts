import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { Server, IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  MIXED_MODE_RESIGN_BODY_CAP_BYTES,
  RESIGN_SIDECAR_CORE,
  RESIGN_SIDECAR_SCRIPT,
  type ResignSidecarConfig,
} from '../../../src/local/emulator-resign-sidecar.js';
import { createMixedModeTlsMaterials } from '../../../src/local/mixed-mode-tls.js';
import {
  LOOPBACK_FORWARDER_SCRIPT,
  describeForwarderFailure,
  parseForwarderStatus,
} from '../../../src/local/loopback-forwarder.js';

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
  localQueueUrl(u: string, origin: string): string;
  rewriteSqsQueueUrls(text: string, contentType: string, origin: string): string | undefined;
  isSqsRequest(headers: Record<string, string>, service: string | undefined): boolean;
  sqsResponseMayCarryQueueUrl(headers: Record<string, string>): boolean;
  passthroughHeaders(h: Record<string, string>): Record<string, string>;
}
const core = new Function(
  'require',
  `${RESIGN_SIDECAR_CORE}; return { decodeAwsChunked, prepareResign, tooLargeByHeaders, parseAuthScope, localQueueUrl, rewriteSqsQueueUrls, isSqsRequest, sqsResponseMayCarryQueueUrl, passthroughHeaders };`
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

describe('SQS queue URL rewrite (#910)', () => {
  const O = 'https://127.0.0.1:47297';
  const Q = 'https://sqs.us-east-1.amazonaws.com/000000000000/orders';

  it('points a real-shaped queue URL at the sidecar, in every SQS host form', () => {
    expect(core.localQueueUrl(Q, O)).toBe(`${O}/000000000000/orders`);
    expect(core.localQueueUrl('https://sqs.cn-north-1.amazonaws.com.cn/123456789012/q.fifo', O)).toBe(
      `${O}/123456789012/q.fifo`
    );
    expect(core.localQueueUrl('https://eu-west-1.queue.amazonaws.com/123456789012/a-b_c', O)).toBe(
      `${O}/123456789012/a-b_c`
    );
    expect(core.localQueueUrl('http://sqs.us-east-1.amazonaws.com/000000000000/q', O)).toBe(`${O}/000000000000/q`);
  });

  it('leaves anything that is not exactly an SQS queue URL alone', () => {
    for (const u of [
      `${O}/000000000000/orders`, // already local
      'https://sqs.us-east-1.amazonaws.com.evil.example/000000000000/q',
      'https://evil.example/sqs.us-east-1.amazonaws.com/000000000000/q',
      'https://user@sqs.us-east-1.amazonaws.com/000000000000/q',
      'https://sqs.us-east-1.amazonaws.com:8443/000000000000/q',
      'https://sqs.us-east-1.amazonaws.com/000000000000/q?x=1',
      'https://sqs.us-east-1.amazonaws.com/000000000000/q#f',
      'https://sqs.us-east-1.amazonaws.com/0000/q',
      'https://sqs.us-east-1.amazonaws.com/000000000000/q/extra',
      'https://sqs.us-east-1.amazonaws.com/000000000000/' + 'a'.repeat(81),
      'https://s3.us-east-1.amazonaws.com/000000000000/q',
    ]) {
      expect(core.localQueueUrl(u, O)).toBe(u);
    }
  });

  it('JSON: rewrites QueueUrl, QueueUrls and queueUrls only', () => {
    const create = core.rewriteSqsQueueUrls(JSON.stringify({ QueueUrl: Q }), 'application/x-amz-json-1.0', O);
    expect(JSON.parse(create!)).toEqual({ QueueUrl: `${O}/000000000000/orders` });
    const list = core.rewriteSqsQueueUrls(
      JSON.stringify({ QueueUrls: [Q, 'https://other.example/x'], NextToken: 't' }),
      'application/x-amz-json-1.0',
      O
    );
    expect(JSON.parse(list!)).toEqual({ QueueUrls: [`${O}/000000000000/orders`, 'https://other.example/x'], NextToken: 't' });
    const dlq = core.rewriteSqsQueueUrls(JSON.stringify({ queueUrls: [Q] }), 'application/x-amz-json-1.0', O);
    expect(JSON.parse(dlq!)).toEqual({ queueUrls: [`${O}/000000000000/orders`] });
  });

  it('JSON: a message body that mentions a queue URL is never touched, and nothing to change is undefined', () => {
    const receive = JSON.stringify({ Messages: [{ Body: Q, MD5OfBody: 'x' }] });
    expect(core.rewriteSqsQueueUrls(receive, 'application/x-amz-json-1.0', O)).toBeUndefined();
    expect(core.rewriteSqsQueueUrls(JSON.stringify({ QueueUrl: `${O}/0/q` }), 'application/json', O)).toBeUndefined();
    expect(core.rewriteSqsQueueUrls('not json', 'application/x-amz-json-1.0', O)).toBeUndefined();
    expect(core.rewriteSqsQueueUrls(JSON.stringify([Q]), 'application/x-amz-json-1.0', O)).toBeUndefined();
    expect(core.rewriteSqsQueueUrls(Q, 'text/plain', O)).toBeUndefined();
  });

  it('XML (query protocol): rewrites QueueUrl elements only, never escaped message text', () => {
    const xml =
      '<ListQueuesResponse><ListQueuesResult><QueueUrl>' + Q + '</QueueUrl><QueueUrl> ' + Q +
      ' </QueueUrl></ListQueuesResult></ListQueuesResponse>';
    const out = core.rewriteSqsQueueUrls(xml, 'text/xml', O)!;
    expect(out).not.toContain('amazonaws.com');
    expect(out.match(/<QueueUrl>https:\/\/127\.0\.0\.1:47297\/000000000000\/orders<\/QueueUrl>/g)).toHaveLength(2);
    const receive = '<ReceiveMessageResponse><Body>&lt;QueueUrl&gt;' + Q + '&lt;/QueueUrl&gt;</Body></ReceiveMessageResponse>';
    expect(core.rewriteSqsQueueUrls(receive, 'text/xml', O)).toBeUndefined();
  });

  it('only SQS operations that answer with queue URLs are held', () => {
    expect(core.isSqsRequest({}, 'sqs')).toBe(true);
    expect(core.isSqsRequest({ 'x-amz-target': 'AmazonSQS.GetQueueUrl' }, undefined)).toBe(true);
    expect(core.isSqsRequest({ 'x-amz-target': 'DynamoDB_20120810.GetItem' }, 'dynamodb')).toBe(false);
    for (const op of ['CreateQueue', 'GetQueueUrl', 'ListQueues', 'ListDeadLetterSourceQueues']) {
      expect(core.sqsResponseMayCarryQueueUrl({ 'x-amz-target': `AmazonSQS.${op}` })).toBe(true);
    }
    expect(core.sqsResponseMayCarryQueueUrl({ 'x-amz-target': 'AmazonSQS.ReceiveMessage' })).toBe(false);
    expect(core.sqsResponseMayCarryQueueUrl({})).toBe(true); // query protocol: the action is in the body
  });

  it('passthrough keeps every header but the hop-by-hop ones (the signature and Host stay)', () => {
    const h = core.passthroughHeaders({
      host: '127.0.0.1:47297',
      authorization: 'AWS4-HMAC-SHA256 Credential=K/20261113/us-east-1/sqs/aws4_request, SignedHeaders=host, Signature=ab',
      'x-amz-date': '20261113T000000Z',
      'x-amz-security-token': 'T',
      'content-length': '2',
      connection: 'keep-alive',
      expect: '100-continue',
      'transfer-encoding': 'chunked',
    });
    expect(Object.keys(h).sort()).toEqual(['authorization', 'content-length', 'host', 'x-amz-date', 'x-amz-security-token']);
  });
});

describe('the sidecar server, end to end with the AWS SDK', () => {
  // A fake emulator: verifies every request's signature against the emulator
  // keys and records what arrived.
  const received: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer; sigOk: boolean }[] = [];
  let upstream: Server;
  let sidecar: ChildProcess;
  let sidecarOut = '';
  let started: { port: number; address: string } | undefined;
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
            // `/slow` holds its response, so the request's body stays in flight.
            setTimeout(
              () => {
                res.writeHead(200, { etag: '"e"' });
                res.end();
              },
              req.url?.startsWith('/b/slow') ? 1500 : 0
            );
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
    sidecar.stdout!.on('data', (d: Buffer) => (sidecarOut += d.toString()));
    await new Promise<void>((resolve, reject) => {
      sidecar.stdout!.on('data', (d: Buffer) => {
        const m = /STARTED (\{"port".*\})/.exec(d.toString());
        if (m) {
          started = JSON.parse(m[1]!) as { port: number; address: string };
          resolve();
        }
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
    // The streaming guard dropped the body as it arrived (not after holding it all).
    expect(sidecarOut).toContain('over the cap without holding it');
  });

  it('Expect: 100-continue over the cap is refused before the body is sent', async () => {
    const before = received.length;
    const r = await new Promise<{ code: number; body: string; sentBody: boolean }>((resolve, reject) => {
      let sentBody = false;
      const req = httpsRequest({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: '/b/huge',
        ca: [tls.caCertPem],
        headers: {
          authorization: REAL_AUTH.replace('dynamodb', 's3'),
          expect: '100-continue',
          'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
          'x-amz-decoded-content-length': String(5 * 1024 * 1024),
          'content-length': '10',
        },
      });
      req.on('continue', () => {
        sentBody = true;
        req.end('0123456789');
      });
      req.on('response', (res) => {
        let b = '';
        res.on('data', (c: Buffer) => (b += c.toString()));
        res.on('end', () => resolve({ code: res.statusCode!, body: b, sentBody }));
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(r).toMatchObject({ code: 413, sentBody: false });
    expect(r.body).toContain('EntityTooLarge');
    expect(received.length).toBe(before);
  });

  it('listens on loopback only: the signing oracle is never reachable from the network', async () => {
    expect(started?.address).toBe('127.0.0.1');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (external) {
      const code = await new Promise<string | undefined>((resolve) => {
        const sock = connect(port, external);
        sock.once('connect', () => {
          sock.destroy();
          resolve(undefined);
        });
        sock.once('error', (e: NodeJS.ErrnoException) => resolve(e.code));
      });
      expect(code).toBe('ECONNREFUSED');
    }
  });

  it('charges a held body twice: a second large body while one is in flight gets 503', async () => {
    const put = (p: string, size: number) =>
      new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'PUT',
            path: p,
            ca: [tls.caCertPem],
            headers: {
              authorization: REAL_AUTH.replace('dynamodb', 's3'),
              'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          }
        );
        req.on('error', reject);
        req.end(Buffer.alloc(size, 1));
      });
    const size = 3 * 1024 * 1024; // under the 4 MiB cap; 2 x 3 MiB x 2 bodies > 2 x rawCap (10 MiB)
    const slow = put('/b/slow', size);
    await new Promise((r) => setTimeout(r, 500));
    expect(await put('/b/second', size)).toBe(503);
    expect(await slow).toBe(200);
    // Once the first response is over its charge is released.
    expect(await put('/b/third', size)).toBe(200);
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

describe('SQS queue URLs through the sidecar, end to end with the AWS SDK (#910)', () => {
  // A fake AWS Emulator: verifies each request's signature against the
  // emulator keys (with the Host header as it arrived) and answers SQS the way
  // AWS Emulator does, with real-shaped queue URLs.
  const REAL_QURL = 'https://sqs.us-east-1.amazonaws.com/000000000000/orders';
  const received: { url: string; host: string; target: string; body: Buffer; sigOk: boolean }[] = [];
  const procs: ChildProcess[] = [];
  let upstream: Server;
  let dir: string;
  const tls = createMixedModeTlsMaterials();
  const upstreamTls = createMixedModeTlsMaterials();
  const ports = { passthrough: 0, resign: 0 };

  beforeAll(async () => {
    upstream = createHttpsServer({ key: upstreamTls.keyPem, cert: upstreamTls.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        void verifySignature({ method: req.method!, url: req.url!, headers: req.headers }, body, EMU).then((v) => {
          const target = String(req.headers['x-amz-target'] ?? '');
          received.push({ url: req.url!, host: String(req.headers.host), target, body, sigOk: v.ok });
          const json = (o: unknown, gzip = false): void => {
            const text = Buffer.from(JSON.stringify(o));
            const out = gzip ? gzipSync(text) : text;
            res.writeHead(200, {
              'content-type': 'application/x-amz-json-1.0',
              'content-length': out.length,
              'x-amz-crc32': '1',
              ...(gzip ? { 'content-encoding': 'gzip' } : {}),
            });
            res.end(out);
          };
          if (target === 'AmazonSQS.CreateQueue' || target === 'AmazonSQS.GetQueueUrl') json({ QueueUrl: REAL_QURL });
          else if (target === 'AmazonSQS.ListQueues') {
            const prefix = (JSON.parse(body.toString() || '{}') as { QueueNamePrefix?: string }).QueueNamePrefix;
            if (prefix === 'big' || prefix === 'biglen') {
              // Past the 16 MiB hold cap: streamed as-is.
              const big = Buffer.from(JSON.stringify({ QueueUrls: [REAL_QURL], Pad: 'x'.repeat(17 * 1024 * 1024) }));
              res.writeHead(200, {
                'content-type': 'application/x-amz-json-1.0',
                ...(prefix === 'biglen' ? { 'content-length': big.length } : {}),
              });
              if (prefix === 'big') {
                for (let i = 0; i < big.length; i += 1024 * 1024) res.write(big.subarray(i, i + 1024 * 1024));
                res.end();
              } else res.end(big);
            } else if (prefix === 'none') json({}, true); // held, nothing to change: stays gzip
            else if (prefix === 'cut') {
              res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
              res.write('{"QueueUrls":[');
              setTimeout(() => res.socket?.destroy(), 50);
            } else json({ QueueUrls: [REAL_QURL] }, true);
          } else if (target === 'AmazonSQS.DeleteQueue') {
            res.writeHead(400, { 'content-type': 'application/x-amz-json-1.0' });
            res.end(JSON.stringify({ __type: 'QueueDoesNotExist', message: REAL_QURL, QueueUrl: REAL_QURL }));
          }
          else if (target === 'AmazonSQS.SendMessage') {
            const b = JSON.parse(body.toString()) as { MessageBody: string };
            json({ MessageId: 'm1', MD5OfMessageBody: createHash('md5').update(b.MessageBody).digest('hex') });
          } else if (target === 'AmazonSQS.ReceiveMessage') {
            json({
              Messages: [{ MessageId: 'm1', ReceiptHandle: 'r', Body: REAL_QURL, MD5OfBody: createHash('md5').update(REAL_QURL).digest('hex') }],
            });
          } else if (target) json({ QueueUrl: REAL_QURL }); // not SQS: must come back untouched
          else {
            res.writeHead(200, { 'content-type': 'text/xml' });
            res.end(`<GetQueueUrlResponse><GetQueueUrlResult><QueueUrl>${REAL_QURL}</QueueUrl></GetQueueUrlResult></GetQueueUrlResponse>`);
          }
        });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    dir = mkdtempSync(path.join(tmpdir(), 'resign-sqs-'));
    for (const mode of ['passthrough', 'resign'] as const) {
      const port = 45000 + Math.floor(Math.random() * 900) + (mode === 'resign' ? 1000 : 0);
      const cfg: ResignSidecarConfig = {
        port,
        upstream: `https://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        upstreamCaPem: upstreamTls.caCertPem,
        certPem: tls.certPem,
        keyPem: tls.keyPem,
        capBytes: 4 * 1024 * 1024,
        ...(mode === 'passthrough' ? { passthrough: true } : { credentials: EMU }),
      };
      const cfgPath = path.join(dir, `${mode}.json`);
      writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
      const p = spawn(
        process.execPath,
        ['-e', `${RESIGN_SIDECAR_SCRIPT}\nstartResigner(process.argv[1]).then((r)=>process.stdout.write('STARTED '+JSON.stringify(r)+'\\n'));`, cfgPath],
        { stdio: ['ignore', 'pipe', 'inherit'] }
      );
      procs.push(p);
      await new Promise<void>((resolve, reject) => {
        p.stdout!.on('data', (d: Buffer) => {
          if (/STARTED \{"port"/.test(d.toString())) resolve();
          else if (d.toString().includes('STARTED')) reject(new Error(d.toString()));
        });
      });
      ports[mode] = port;
    }
  });

  afterAll(async () => {
    for (const p of procs) {
      if (p.exitCode === null && p.signalCode === null) {
        const exited = new Promise((r) => p.once('exit', r));
        p.kill();
        await exited;
      }
    }
    upstream?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A request handler that refuses any host but the sidecar: no test call can leave loopback. */
  function localOnly(): NodeHttpHandler {
    const inner = new NodeHttpHandler({ httpsAgent: new HttpsAgent({ ca: [tls.caCertPem] }) });
    const handle = inner.handle.bind(inner);
    inner.handle = (req, opts) => {
      if (req.hostname !== '127.0.0.1') throw new Error(`left the sidecar for ${req.hostname}`);
      return handle(req, opts);
    };
    return inner;
  }

  for (const mode of ['passthrough', 'resign'] as const) {
    it(`${mode}: CreateQueue / GetQueueUrl answer the sidecar's URL, and SendMessage / ReceiveMessage stay on it`, async () => {
      const origin = `https://127.0.0.1:${ports[mode]}`;
      const sqs = new SQSClient({
        region: 'us-east-1',
        endpoint: origin,
        credentials: mode === 'passthrough' ? EMU : { accessKeyId: 'REALKEYIDREALKEYID00', secretAccessKey: 'real' },
        requestHandler: localOnly(),
      });
      const created = await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }));
      expect(created.QueueUrl).toBe(`${origin}/000000000000/orders`);
      const got = await sqs.send(new GetQueueUrlCommand({ QueueName: 'orders' }));
      expect(got.QueueUrl).toBe(`${origin}/000000000000/orders`);
      const before = received.length;
      const sent = await sqs.send(new SendMessageCommand({ QueueUrl: got.QueueUrl, MessageBody: 'hello' }));
      expect(sent.MessageId).toBe('m1');
      // The message body names a real queue URL: it comes back byte for byte (the SDK checks its MD5).
      const msgs = await sqs.send(new ReceiveMessageCommand({ QueueUrl: got.QueueUrl }));
      expect(msgs.Messages?.[0]?.Body).toBe(REAL_QURL);
      const after = received.slice(before);
      expect(after.map((r) => r.target)).toEqual(['AmazonSQS.SendMessage', 'AmazonSQS.ReceiveMessage']);
      expect(after.every((r) => r.sigOk)).toBe(true);
      // Passthrough keeps the workload's own Host (the signature covers it).
      if (mode === 'passthrough') expect(after[0]!.host).toBe(`127.0.0.1:${ports.passthrough}`);
    });
  }

  async function raw(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
    const signer = new SignatureV4({ credentials: EMU, region: 'us-east-1', service: 'sqs', sha256: Sha256 });
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: { host: `127.0.0.1:${port}`, ...headers },
      body,
    });
    return new Promise((resolve, reject) => {
      const r = httpsRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/', headers: signed.headers, ca: [tls.caCertPem] },
        (m) => {
          const c: Buffer[] = [];
          m.on('data', (d: Buffer) => c.push(d));
          m.on('end', () => resolve({ status: m.statusCode!, headers: m.headers, body: Buffer.concat(c) }));
        }
      );
      r.on('error', reject);
      r.end(body);
    });
  }

  it('a gzip response is decoded, rewritten and sent as identity with a fresh length (no stale CRC)', async () => {
    const r = await raw(ports.passthrough, { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ListQueues' }, '{}');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['x-amz-crc32']).toBeUndefined();
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(JSON.parse(r.body.toString())).toEqual({ QueueUrls: [`https://127.0.0.1:${ports.passthrough}/000000000000/orders`] });
  });

  it('query protocol (no target): a QueueUrl element in the XML answer is rewritten', async () => {
    const r = await raw(ports.passthrough, { 'content-type': 'application/x-www-form-urlencoded' }, 'Action=GetQueueUrl&QueueName=orders');
    expect(r.body.toString()).toContain(`<QueueUrl>https://127.0.0.1:${ports.passthrough}/000000000000/orders</QueueUrl>`);
  });

  it('a response over the hold cap streams through byte for byte (chunked and with a length)', async () => {
    for (const prefix of ['big', 'biglen']) {
      const r = await raw(
        ports.passthrough,
        { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ListQueues' },
        JSON.stringify({ QueueNamePrefix: prefix })
      );
      expect(r.body.length).toBeGreaterThan(16 * 1024 * 1024);
      expect(r.body.subarray(0, 80).toString()).toContain(REAL_QURL);
      expect(JSON.parse(r.body.toString()).QueueUrls).toEqual([REAL_QURL]);
    }
  });

  it('a held response with nothing to change keeps its encoding and length; an error answer is never rewritten', async () => {
    const r = await raw(
      ports.passthrough,
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ListQueues' },
      JSON.stringify({ QueueNamePrefix: 'none' })
    );
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    const { gunzipSync } = await import('node:zlib');
    expect(JSON.parse(gunzipSync(r.body).toString())).toEqual({});
    const e = await raw(
      ports.passthrough,
      { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.DeleteQueue' },
      '{}'
    );
    expect(e.status).toBe(400);
    expect(JSON.parse(e.body.toString()).QueueUrl).toBe(REAL_QURL);
  });

  it('an emulator that drops the connection mid-answer fails the client call (no truncated 200)', async () => {
    await expect(
      raw(
        ports.passthrough,
        { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ListQueues' },
        JSON.stringify({ QueueNamePrefix: 'cut' })
      )
    ).rejects.toThrow();
  });

  it('passthrough with Expect: 100-continue forwards the body after the 100, without the Expect header', async () => {
    const port = ports.passthrough;
    const body = JSON.stringify({ QueueName: 'orders' });
    const signer = new SignatureV4({ credentials: EMU, region: 'us-east-1', service: 'sqs', sha256: Sha256 });
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonSQS.GetQueueUrl',
        'content-length': String(body.length),
      },
      body,
    });
    const before = received.length;
    const out = await new Promise<string>((resolve, reject) => {
      const q = httpsRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/', headers: { ...signed.headers, expect: '100-continue' }, ca: [tls.caCertPem] },
        (m) => {
          let b = '';
          m.on('data', (d: Buffer) => (b += d.toString()));
          m.on('end', () => resolve(b));
        }
      );
      q.on('continue', () => q.end(body));
      q.on('error', reject);
    });
    expect(JSON.parse(out)).toEqual({ QueueUrl: `https://127.0.0.1:${port}/000000000000/orders` });
    const got = received.slice(before)[0]!;
    expect(got.sigOk).toBe(true);
    expect(got.body.toString()).toBe(body);
  });

  it('a response to another service passes through untouched, CRC header included', async () => {
    const signer = new SignatureV4({ credentials: EMU, region: 'us-east-1', service: 'dynamodb', sha256: Sha256 });
    const port = ports.passthrough;
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.ListTables' },
      body: '{}',
    });
    const r = await new Promise<{ headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
      const q = httpsRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: signed.headers, ca: [tls.caCertPem] }, (m) => {
        let b = '';
        m.on('data', (d: Buffer) => (b += d.toString()));
        m.on('end', () => resolve({ headers: m.headers, body: b }));
      });
      q.on('error', reject);
      q.end('{}');
    });
    expect(JSON.parse(r.body)).toEqual({ QueueUrl: REAL_QURL });
    expect(r.headers['x-amz-crc32']).toBe('1');
    expect(received.at(-1)!.sigOk).toBe(true);
  });
});

describe('passthrough upstream TLS', () => {
  it('refuses an emulator whose certificate is not from the trusted CA (502, nothing forwarded); verifies by host name', async () => {
    const good = createMixedModeTlsMaterials();
    const other = createMixedModeTlsMaterials();
    const tls = createMixedModeTlsMaterials();
    let hits = 0;
    const emu = createHttpsServer({ key: good.keyPem, cert: good.certPem }, (_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => emu.listen(0, '127.0.0.1', () => r()));
    const dir = mkdtempSync(path.join(tmpdir(), 'resign-tls-'));
    const procs: ChildProcess[] = [];
    try {
      const start = async (upstream: string, caPem: string): Promise<number> => {
        const port = 44000 + Math.floor(Math.random() * 900) + procs.length;
        const cfgPath = path.join(dir, `${port}.json`);
        const cfg: ResignSidecarConfig = { port, upstream, upstreamCaPem: caPem, certPem: tls.certPem, keyPem: tls.keyPem, capBytes: 1024, passthrough: true };
        writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
        const p = spawn(process.execPath, ['-e', `${RESIGN_SIDECAR_SCRIPT}\nstartResigner(process.argv[1]).then((r)=>process.stdout.write('STARTED '+JSON.stringify(r)+'\\n'));`, cfgPath], { stdio: ['ignore', 'pipe', 'ignore'] });
        procs.push(p);
        await new Promise<void>((resolve) => p.stdout!.on('data', (d: Buffer) => d.toString().includes('STARTED') && resolve()));
        return port;
      };
      const get = (port: number): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const q = httpsRequest({ host: '127.0.0.1', port, path: '/__admin/health', ca: [tls.caCertPem] }, (m) => {
            let b = '';
            m.on('data', (d: Buffer) => (b += d.toString()));
            m.on('end', () => resolve({ status: m.statusCode!, body: b }));
          });
          q.on('error', reject);
          q.end();
        });
      const emuPort = (emu.address() as AddressInfo).port;
      const wrong = await get(await start(`https://127.0.0.1:${emuPort}`, other.caCertPem));
      expect(wrong.status).toBe(502);
      expect(wrong.body).toMatch(/--aws-emulator: the AWS Emulator at .* did not answer/);
      expect(hits).toBe(0);
      // A host-name upstream: SNI and the identity check use the emulator's name (the leaf names localhost).
      const byName = await get(await start(`https://localhost:${emuPort}`, good.caCertPem));
      expect(byName).toEqual({ status: 200, body: 'ok' });
    } finally {
      for (const p of procs) p.kill();
      await new Promise((r) => emu.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the forwarder script with the sidecar (the code a mixed-mode container runs)', () => {
  const tls = createMixedModeTlsMaterials();
  const upstreamTls = createMixedModeTlsMaterials();
  let dir: string;
  const procs: ChildProcess[] = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'resign-fwd-'));
  });
  afterAll(async () => {
    for (const p of procs) {
      if (p.exitCode === null && p.signalCode === null) {
        const exited = new Promise((r) => p.once('exit', r));
        p.kill();
        await exited;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(upstreamPort: number, sidecarPort: number): Promise<string> {
    const cfgPath = path.join(dir, `resign-${sidecarPort}.json`);
    const caPath = path.join(dir, `ca-${sidecarPort}.pem`);
    writeFileSync(caPath, tls.caCertPem);
    const cfg: ResignSidecarConfig = {
      port: sidecarPort,
      upstream: `https://127.0.0.1:${upstreamPort}`,
      upstreamCaPem: upstreamTls.caCertPem,
      certPem: tls.certPem,
      keyPem: tls.keyPem,
      credentials: EMU,
      capBytes: 1024,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
    // argv as forwarderCommand builds it: no TCP port, health probe, CA, resign config.
    const p = spawn(
      process.execPath,
      ['-e', RESIGN_SIDECAR_SCRIPT + LOOPBACK_FORWARDER_SCRIPT, '-', 'health', caPath, cfgPath],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    procs.push(p);
    let out = '';
    return new Promise((resolve) => {
      p.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        const line = out.split('\n').find((l) => l.startsWith('CDKL-FWD '));
        if (line) resolve(line);
      });
    });
  }

  it('reports READY once a health check through the sidecar reaches the emulator', async () => {
    const emu = createHttpsServer({ key: upstreamTls.keyPem, cert: upstreamTls.certPem }, (req, res) => {
      res.writeHead(req.url === '/__admin/health' && !req.headers['authorization'] ? 200 : 500);
      res.end();
    });
    await new Promise<void>((r) => emu.listen(0, '127.0.0.1', () => r()));
    try {
      const line = await run((emu.address() as AddressInfo).port, 46000 + Math.floor(Math.random() * 900));
      // The upstream is `none` where nothing resolves (macOS) and the default
      // gateway on Linux; with no TCP port it is unused either way.
      expect(line).toMatch(/^CDKL-FWD READY \S+$/);
      expect(parseForwarderStatus(line)?.ok).toBe(true);
    } finally {
      await new Promise((r) => emu.close(r));
    }
  });

  it('an unreachable emulator is a RESIGN_UPSTREAM failure whose message is about the emulator', async () => {
    const closed = createHttpsServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const sidecarPort = 46000 + Math.floor(Math.random() * 900);
    const line = await run(deadPort, sidecarPort);
    const status = parseForwarderStatus(line)!;
    expect(status).toMatchObject({ ok: false, failedPort: sidecarPort, reason: 'RESIGN_UPSTREAM_HTTP_502' });
    expect(describeForwarderFailure({ name: 'f', ...status }, '--aws-emulator x (mixed mode)')).toMatch(
      /did not reach the emulator \(HTTP_502\)/
    );
  });

  it('a config the container cannot read names no port', () => {
    expect(
      describeForwarderFailure(
        { name: 'f', ...parseForwarderStatus('CDKL-FWD FAIL 0 RESIGN_CONFIG_ENOENT none')! },
        'x'
      )
    ).toMatch(/could not start inside the workload container \(CONFIG_ENOENT\)/);
  });
});
