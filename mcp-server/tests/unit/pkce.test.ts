import { describe, it, expect } from 'vitest';
import { verifyPkce, computeS256Challenge } from '../../src/auth/pkce.js';

describe('PKCE', () => {
  it('verifies a valid S256 challenge/verifier pair', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects invalid verifier', () => {
    const verifier = 'correct-verifier';
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkce('wrong-verifier', challenge)).toBe(false);
  });

  it('challenge is base64url encoded (no padding)', () => {
    const challenge = computeS256Challenge('test-verifier');
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });
});
