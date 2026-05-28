import { describe, it, expect } from 'vite-plus/test';
import { resolvePublishHostPort } from '../../../src/local/ecs-task-runner.js';

describe('resolvePublishHostPort', () => {
  it('remaps privileged host ports (<1024) by +8000 on macOS', () => {
    expect(resolvePublishHostPort(80, 'darwin')).toBe(8080);
    expect(resolvePublishHostPort(443, 'darwin')).toBe(8443);
    expect(resolvePublishHostPort(22, 'darwin')).toBe(8022);
    expect(resolvePublishHostPort(1023, 'darwin')).toBe(9023);
  });

  it('leaves non-privileged host ports unchanged on macOS', () => {
    expect(resolvePublishHostPort(1024, 'darwin')).toBe(1024);
    expect(resolvePublishHostPort(3000, 'darwin')).toBe(3000);
    expect(resolvePublishHostPort(8080, 'darwin')).toBe(8080);
  });

  it('never remaps on Linux (daemon runs as root, binds <1024 directly)', () => {
    expect(resolvePublishHostPort(80, 'linux')).toBe(80);
    expect(resolvePublishHostPort(443, 'linux')).toBe(443);
    expect(resolvePublishHostPort(3000, 'linux')).toBe(3000);
  });

  it('does not remap on win32 (scoped to the confirmed macOS vmnetd case)', () => {
    expect(resolvePublishHostPort(80, 'win32')).toBe(80);
  });
});
