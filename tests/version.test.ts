import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/shared/version.js';

describe('client version comparison', () => {
  it('compares dotted numeric versions numerically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('orders prerelease text below a numeric release segment', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-1')).toBeLessThan(0);
  });
});
