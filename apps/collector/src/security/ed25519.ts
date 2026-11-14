import { createPublicKey, verify } from 'node:crypto';

/** Discord's replay window for webhook events: reject timestamps more than 5 minutes from now. */
const SIGNATURE_MAX_AGE_SECONDS = 300;

/**
 * Verifies Discord webhook events (`X-Signature-Ed25519` over `X-Signature-Timestamp` + raw body) with the app's
 * public key. Any failure, including malformed headers or a stale timestamp, returns `false`.
 */
export function makeDiscordVerifier(publicKeyHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new Error('DISCORD_PUBLIC_KEY must be 32 bytes of hex');
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') },
    format: 'jwk',
  });
  return (
    rawBody: Buffer,
    signatureHex: string | undefined,
    timestamp: string | undefined,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): boolean => {
    if (!signatureHex || !timestamp) return false;
    if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,12}$/.test(timestamp)) return false;
    if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) return false;
    try {
      return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signatureHex, 'hex'));
    } catch {
      return false;
    }
  };
}
