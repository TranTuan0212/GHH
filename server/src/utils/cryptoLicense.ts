import crypto from 'crypto';

// Secret salt for hardware hashing and license key signing
export const DEVICE_SECRET_SALT = process.env.DEVICE_SECRET_SALT || 'AGI_CARDGAME_DEVICE_SECURITY_SALT_2026_#99';
export const LICENSE_MASTER_KEY = process.env.LICENSE_MASTER_KEY || 'VOICE_LICENSE_MASTER_HMAC_KEY_SECURE_2026';

// Crockford Base32 alphabet (excludes I, L, O, U to avoid human transcription confusion)
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encodes a Buffer to Crockford Base32 string
 */
export function encodeCrockfordBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Computes a 2-byte (3-4 char Base32) checksum for data integrity
 */
function computeChecksum(dataStr: string, salt: string): string {
  const hmac = crypto.createHmac('sha256', salt).update(dataStr).digest();
  return encodeCrockfordBase32(hmac.subarray(0, 3)).slice(0, 4);
}

/**
 * Standardizes a machine fingerprint format: AGI-XXXX-YYYY-ZZZZ-CCCC
 * High-entropy (HMAC-SHA256 from Hardware UUID + Model) + Checksum protection.
 */
export function generateDeviceFingerprint(hardwareRawUuid: string, model: string): string {
  const cleanUuid = hardwareRawUuid.trim().toLowerCase();
  const cleanModel = model.trim().toLowerCase();

  const hmac = crypto
    .createHmac('sha256', DEVICE_SECRET_SALT)
    .update(`${cleanUuid}:${cleanModel}`)
    .digest();

  // 10 bytes -> 16 Base32 characters
  const rawBase32 = encodeCrockfordBase32(hmac.subarray(0, 10)).slice(0, 16);

  // Compute 4-character checksum
  const checksum = computeChecksum(rawBase32, DEVICE_SECRET_SALT);

  // Format: AGI-XXXX-YYYY-ZZZZ-CCCC
  const part1 = rawBase32.slice(0, 4);
  const part2 = rawBase32.slice(4, 8);
  const part3 = rawBase32.slice(8, 12);
  const part4 = rawBase32.slice(12, 16);

  return `AGI-${part1}-${part2}-${part3}-${part4}-${checksum}`;
}

/**
 * Verifies if a given device fingerprint has valid syntax and intact checksum
 */
export function verifyDeviceFingerprint(fingerprint: string): boolean {
  if (!fingerprint || typeof fingerprint !== 'string') return false;
  const clean = fingerprint.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  
  // Format: AGI (3 chars) + 16 chars body + 4 chars checksum = 23 chars
  if (!clean.startsWith('AGI') || clean.length !== 23) {
    return false;
  }

  const rawBase32 = clean.slice(3, 19);
  const expectedChecksum = clean.slice(19, 23);
  const calculatedChecksum = computeChecksum(rawBase32, DEVICE_SECRET_SALT);

  return expectedChecksum === calculatedChecksum;
}

/**
 * Normalizes fingerprint string (removes dashes, uppercase)
 */
export function normalizeFingerprint(fp: string): string {
  return fp.trim().toUpperCase().replace(/\s+/g, '');
}

export interface LicenseKeyVerificationResult {
  valid: boolean;
  deviceFingerprint: string;
  durationDays: number | 'LIFETIME';
  isLifetime: boolean;
  error?: string;
}

/**
 * Generates an unguessable cryptographic Voice License Key locked to a specific device fingerprint.
 * Format: VOX-XXXX-YYYY-ZZZZ-WWWW-SSSS
 */
export function generateVoiceLicenseKey(
  deviceFingerprint: string,
  durationDays: number | 'LIFETIME'
): string {
  const normFp = normalizeFingerprint(deviceFingerprint);
  const durationCode = durationDays === 'LIFETIME' ? 'INF' : `${durationDays}D`;
  const nonce = crypto.randomBytes(4).toString('hex').toUpperCase();

  // Payload: Fingerprint + Duration + Nonce
  const payload = `${normFp}|${durationCode}|${nonce}`;

  // HMAC-SHA256 signature
  const hmac = crypto
    .createHmac('sha256', LICENSE_MASTER_KEY)
    .update(payload)
    .digest();

  // Encode payload parts and signature to compact Base32
  const durBase32 = encodeCrockfordBase32(Buffer.from(durationCode)).slice(0, 4).padEnd(4, '0');
  const nonceBase32 = encodeCrockfordBase32(Buffer.from(nonce, 'hex')).slice(0, 4).padEnd(4, '0');
  const sigBase32 = encodeCrockfordBase32(hmac.subarray(0, 8)).slice(0, 12);

  // Format: VOX-XXXX-YYYY-ZZZZ-WWWW (20 chars total)
  return `VOX-${durBase32}-${nonceBase32}-${sigBase32.slice(0, 4)}-${sigBase32.slice(4, 8)}-${sigBase32.slice(8, 12)}`;
}

/**
 * Generates a signed Offline License Token that iOS can verify without an internet connection
 */
export function generateOfflineLicenseToken(
  deviceFingerprint: string,
  registeredAt: string,
  expiresAt: string,
  isLifetime: boolean
): string {
  const payloadObj = {
    fp: normalizeFingerprint(deviceFingerprint),
    reg: registeredAt,
    exp: expiresAt,
    life: isLifetime ? 1 : 0
  };

  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadJson, 'utf-8').toString('base64url');

  const sig = crypto
    .createHmac('sha256', LICENSE_MASTER_KEY)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${sig}`;
}

/**
 * Verifies an Offline License Token
 */
export function verifyOfflineLicenseToken(
  token: string,
  expectedDeviceFingerprint: string
): { valid: boolean; registeredAt?: string; expiresAt?: string; isLifetime?: boolean; error?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Token cấu trúc không hợp lệ.' };
    }

    const [payloadB64, providedSig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', LICENSE_MASTER_KEY)
      .update(payloadB64)
      .digest('base64url');

    if (providedSig !== expectedSig) {
      return { valid: false, error: 'Chữ ký Token không hợp lệ.' };
    }

    const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const data = JSON.parse(jsonStr);

    if (data.fp !== normalizeFingerprint(expectedDeviceFingerprint)) {
      return { valid: false, error: 'Token không khớp với thiết bị này.' };
    }

    const isLifetime = data.life === 1;
    if (!isLifetime) {
      const expDate = new Date(data.exp);
      if (isNaN(expDate.getTime()) || expDate < new Date()) {
        return { valid: false, expiresAt: data.exp, error: 'Bản quyền giọng nói đã hết hạn.' };
      }
    }

    return {
      valid: true,
      registeredAt: data.reg,
      expiresAt: data.exp,
      isLifetime
    };
  } catch (err: any) {
    return { valid: false, error: 'Lỗi giải mã Token: ' + err.message };
  }
}
