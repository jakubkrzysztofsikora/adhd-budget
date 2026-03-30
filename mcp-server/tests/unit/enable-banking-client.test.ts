import { describe, it, expect, beforeAll } from 'vitest';
import { EnableBankingClient } from '../../src/enable-banking/client.js';
import { jwtVerify } from 'jose';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeyPem = privateKey as string;
  publicKeyPem = publicKey as string;
});

describe('EnableBankingClient', () => {
  describe('JWT generation', () => {
    it('generates a valid RS256 JWT with correct claims', async () => {
      const client = new EnableBankingClient('test-app-id', privateKeyPem, 'https://api.test.com');
      const jwt = await client.generateJwt();

      const pubKey = createPublicKey(publicKeyPem);
      const { payload, protectedHeader } = await jwtVerify(jwt, pubKey);

      expect(protectedHeader.alg).toBe('RS256');
      expect(protectedHeader.typ).toBe('JWT');
      expect(protectedHeader.kid).toBe('test-app-id');
      expect(payload.iss).toBe('enablebanking.com');
      expect(payload.aud).toBe('api.enablebanking.com');
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(payload.exp! - payload.iat!).toBe(3600);
    });

    it('generates valid JWTs on repeated calls', async () => {
      const client = new EnableBankingClient('test-app-id', privateKeyPem);
      const jwt1 = await client.generateJwt();
      const jwt2 = await client.generateJwt();
      // Both are valid 3-part JWTs (may be identical if generated in same second)
      expect(jwt1.split('.').length).toBe(3);
      expect(jwt2.split('.').length).toBe(3);
    });
  });

  describe('API request construction', () => {
    it('throws on failed requests to unreachable host', async () => {
      const client = new EnableBankingClient('test-app-id', privateKeyPem, 'http://127.0.0.1:1');
      await expect(client.listAspsps('FI')).rejects.toThrow();
    });
  });
});
