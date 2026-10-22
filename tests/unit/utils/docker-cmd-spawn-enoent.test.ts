/**
 * go-to-k/cdk-local#761 (body, item (c)): Node reports a missing spawn `cwd`
 * with the same ENOENT as a missing binary, so an asset executable whose
 * working directory is gone used to read "Install Docker". The cwd is now
 * checked first, and both values render through `displayUntrustedValue`.
 */
import { describe, expect, it } from 'vite-plus/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSpawnEnoent, spawnForeground, spawnStreaming } from '../../../src/utils/docker-cmd.js';

describe('describeSpawnEnoent', () => {
  it('names a missing working directory instead of asking to install Docker', () => {
    expect(describeSpawnEnoent('./build.sh', '/no/such/dir-761')).toBe(
      'Failed to execute ./build.sh: its working directory /no/such/dir-761 does not exist.'
    );
  });

  it('quotes a forging command and directory', () => {
    expect(describeSpawnEnoent("b' x", "/no/such/d' y")).toBe(
      `Failed to execute "b' x": its working directory "/no/such/d' y" does not exist.`
    );
  });

  it('keeps the Install-Docker hint when the cwd exists or is unset', () => {
    const msg = describeSpawnEnoent('no-such-binary-761', undefined);
    expect(msg).toBe(
      "Failed to find and execute no-such-binary-761. Install Docker (or set the 'CDK_DOCKER' environment variable to a compatible binary such as podman / finch)."
    );
    expect(describeSpawnEnoent('no-such-binary-761', tmpdir())).toBe(msg);
  });
});

describe('the spawn helpers report a missing cwd', () => {
  const gone = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'cdkl-761-cwd-'));
    rmSync(d, { recursive: true, force: true });
    return d;
  };

  it('spawnStreaming', async () => {
    const cwd = gone();
    const err = await spawnStreaming(process.execPath, ['-e', '0'], { cwd }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `Failed to execute ${process.execPath}: its working directory ${cwd} does not exist.`
    );
  });

  it('spawnForeground', async () => {
    const cwd = gone();
    const err = await spawnForeground(process.execPath, ['-e', '0'], { cwd }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `Failed to execute ${process.execPath}: its working directory ${cwd} does not exist.`
    );
  });
});

describe('a non-ENOENT spawn failure names the code, not Node\'s raw-command message', () => {
  it('spawnForeground: EACCES on a non-executable file', async () => {
    const d = mkdtempSync(join(tmpdir(), "cdkl-761-eacces' x-"));
    const file = join(d, 'not-exec');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    try {
      const err = await spawnForeground(file, [], {}).catch((e: unknown) => e);
      expect((err as Error).message).toBe(`${JSON.stringify(file)} failed: EACCES`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('describeSpawnEnoent keeps the CDK_DOCKER override hint', () => {
    const prev = process.env['CDK_DOCKER'];
    process.env['CDK_DOCKER'] = 'podman-761';
    try {
      expect(describeSpawnEnoent('podman-761', undefined)).toBe(
        "Failed to find and execute podman-761 (resolved via CDK_DOCKER). Install podman-761 or unset CDK_DOCKER to fall back to 'docker'."
      );
    } finally {
      if (prev === undefined) delete process.env['CDK_DOCKER'];
      else process.env['CDK_DOCKER'] = prev;
    }
  });
});
