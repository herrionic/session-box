import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_PARAMS: ScryptOptions = { N: 16_384, r: 8, p: 1 };

/**
 * Password hashing with Node's built-in scrypt — no native dependencies.
 * The stored format is self-describing: `scrypt$N$r$p$salt$hash` (base64).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

  return [
    "scrypt",
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltBase64, hashBase64] = parts;
  const salt = Buffer.from(saltBase64 ?? "", "base64");
  const expected = Buffer.from(hashBase64 ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
