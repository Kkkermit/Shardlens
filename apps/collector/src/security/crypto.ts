import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for audit-mode data and alert webhook URLs, under a 32-byte base64 key kept outside the database.
 * Blob layout: 12-byte IV, 16-byte auth tag, ciphertext.
 */
export function auditCipher(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (base64)');
  return {
    encrypt(plaintext: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    /** Throws if the blob was tampered with or encrypted under another key. */
    decrypt(blob: Buffer): string {
      if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext too short');
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
      d.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([d.update(blob.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString('utf8');
    },
    /** Deterministic lookup key, so exact-ID search doesn't need to decrypt every row. */
    lookupHash(userId: string): Buffer {
      return createHmac('sha256', key).update(`audit-lookup:${userId}`).digest().subarray(0, 16);
    },
  };
}
