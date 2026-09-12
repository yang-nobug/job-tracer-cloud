import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
const KEY_LENGTH = 64
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

export class PasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordError'
  }
}

function deriveKey(password: string, salt: Buffer, length: number, cost = SCRYPT_COST, blockSize = SCRYPT_BLOCK_SIZE, parallelization = SCRYPT_PARALLELIZATION): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') throw new PasswordError('密码格式不正确')
  if (password.length < 12) throw new PasswordError('密码至少需要 12 个字符')
  if (password.length > 200) throw new PasswordError('密码不能超过 200 个字符')
  return password
}

export async function hashPassword(input: string): Promise<string> {
  const password = validatePassword(input)
  const salt = randomBytes(16)
  const hash = await deriveKey(password, salt, KEY_LENGTH)
  return [
    'scrypt',
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$')
}

export async function verifyPassword(input: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const cost = Number(parts[1])
  const blockSize = Number(parts[2])
  const parallelization = Number(parts[3])
  if (![cost, blockSize, parallelization].every(Number.isInteger)) return false

  try {
    const salt = Buffer.from(parts[4], 'base64url')
    const expected = Buffer.from(parts[5], 'base64url')
    const actual = await deriveKey(input, salt, expected.length, cost, blockSize, parallelization)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
