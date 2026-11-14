import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  ambientDefaultRegion,
  namedEnvAwsRegion,
  regionOrAmbientDefault,
  setAmbientDefaultRegion,
} from '../../../src/utils/ambient-default-region.js';
import * as internal from '../../../src/internal.js';

// go-to-k/cdk-local#963: the host-default record behind every region chain.
describe('ambient default region', () => {
  const saved = process.env['AWS_REGION'];

  beforeEach(() => {
    setAmbientDefaultRegion(undefined);
  });

  afterEach(() => {
    setAmbientDefaultRegion(undefined);
    if (saved === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved;
  });

  it('without a recorded default, AWS_REGION is the named region and nothing is a default', () => {
    process.env['AWS_REGION'] = 'eu-south-1';
    expect(namedEnvAwsRegion()).toBe('eu-south-1');
    expect(ambientDefaultRegion()).toBeUndefined();
    expect(regionOrAmbientDefault('us-west-2')).toBe('us-west-2');
    // No default: the stack region passes through exactly, placeholder included.
    expect(regionOrAmbientDefault('unknown-region')).toBe('unknown-region');
    expect(regionOrAmbientDefault(undefined)).toBeUndefined();
  });

  it('while AWS_REGION holds the recorded default, it is a default, not a named region', () => {
    process.env['AWS_REGION'] = 'eu-south-1';
    setAmbientDefaultRegion('eu-south-1');
    expect(namedEnvAwsRegion()).toBeUndefined();
    expect(ambientDefaultRegion()).toBe('eu-south-1');
    expect(regionOrAmbientDefault('us-west-2')).toBe('us-west-2');
    expect(regionOrAmbientDefault(undefined)).toBe('eu-south-1');
    expect(regionOrAmbientDefault('')).toBe('eu-south-1');
    expect(regionOrAmbientDefault('unknown-region')).toBe('eu-south-1');
  });

  it('a later AWS_REGION write (a region the user named) outranks the record', () => {
    setAmbientDefaultRegion('eu-south-1');
    process.env['AWS_REGION'] = 'ap-south-1';
    expect(namedEnvAwsRegion()).toBe('ap-south-1');
    expect(ambientDefaultRegion()).toBeUndefined();
    expect(regionOrAmbientDefault(undefined)).toBeUndefined();
  });

  it('setAmbientDefaultRegion(undefined) and an empty string forget the record', () => {
    process.env['AWS_REGION'] = 'eu-south-1';
    setAmbientDefaultRegion('eu-south-1');
    setAmbientDefaultRegion(undefined);
    expect(namedEnvAwsRegion()).toBe('eu-south-1');
    // An empty AWS_REGION is not a recorded default: '' records nothing.
    process.env['AWS_REGION'] = '';
    setAmbientDefaultRegion('');
    expect(ambientDefaultRegion()).toBeUndefined();
    expect(namedEnvAwsRegion()).toBe('');
  });

  it('is exported from cdk-local/internal for a host to call (one shared record)', () => {
    expect(internal.setAmbientDefaultRegion).toBe(setAmbientDefaultRegion);
    expect(internal.namedEnvAwsRegion).toBe(namedEnvAwsRegion);
    expect(internal.ambientDefaultRegion).toBe(ambientDefaultRegion);
  });
});
