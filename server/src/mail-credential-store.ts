import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DATA_DIR } from './data-paths.js'
import type { MailProvider } from './mail-client.js'

const SECRET_DIR = path.join(DATA_DIR, 'secrets')
const configuredKeyDir = process.env.JOB_TRACER_KEY_DIR?.trim()
const defaultKeyDir = process.env.LOCALAPPDATA?.trim()
  ? path.join(process.env.LOCALAPPDATA.trim(), 'job-tracer')
  : path.join(os.homedir(), '.job-tracer')
const KEY_DIR = configuredKeyDir ? path.resolve(configuredKeyDir) : defaultKeyDir
const MASTER_KEY_PATH = path.join(KEY_DIR, 'mail-master.key')
function credentialRef(provider: MailProvider, scope?: string): string {
  if (scope) {
    const normalized = scope.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!normalized) throw new Error('邮箱凭据作用域无效')
    return `cloud-${normalized}-${provider}-mail-v1`
  }
  // 保持 QQ 的旧引用不变，已有账号无需重新填写授权码。
  return `${provider}-mail-v1`
}

function credentialPath(ref: string): string {
  return path.join(SECRET_DIR, `${ref}.json`)
}

export interface EncryptedSecret {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

function ensureSecretDir(): void {
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(SECRET_DIR, 0o700) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
}

function loadOrCreateMasterKey(): Buffer {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(KEY_DIR, 0o700) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  if (!existsSync(MASTER_KEY_PATH)) {
    try {
      writeFileSync(MASTER_KEY_PATH, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const key = readFileSync(MASTER_KEY_PATH)
  if (key.length !== 32) throw new Error('本机邮箱凭据密钥损坏，请删除邮箱连接后重新配置')
  try { chmodSync(MASTER_KEY_PATH, 0o600) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  return key
}

function credentialAad(provider: MailProvider, email: string, scope?: string): Buffer {
  // 未传 scope 时保持旧版 AAD，已有本地邮箱凭据无需重新填写授权码。
  const prefix = scope ? `job-tracer:mail:${scope}:${provider}` : `job-tracer:mail:${provider}`
  return Buffer.from(`${prefix}:${email.trim().toLowerCase()}`, 'utf8')
}

export function encryptSecret(secret: string, key: Buffer, aad: Buffer): EncryptedSecret {
  if (key.length !== 32) throw new Error('加密密钥长度无效')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

export function decryptSecret(payload: EncryptedSecret, key: Buffer, aad: Buffer): string {
  if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('不支持的邮箱凭据格式')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
}

export function storeMailAuthorizationCode(provider: MailProvider, email: string, authorizationCode: string, scope?: string): string {
  ensureSecretDir()
  const key = loadOrCreateMasterKey()
  const ref = credentialRef(provider, scope)
  const filePath = credentialPath(ref)
  const payload = encryptSecret(authorizationCode, key, credentialAad(provider, email, scope))
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  renameSync(tempPath, filePath)
  try { chmodSync(filePath, 0o600) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  return ref
}

export function loadMailAuthorizationCode(provider: MailProvider, storedRef: string, email: string, scope?: string): string {
  const expectedRef = credentialRef(provider, scope)
  const filePath = credentialPath(expectedRef)
  if (storedRef !== expectedRef || !existsSync(filePath)) {
    throw new Error('本机没有找到邮箱授权码，请重新连接')
  }
  try {
    const payload = JSON.parse(readFileSync(filePath, 'utf8')) as EncryptedSecret
    return decryptSecret(payload, loadOrCreateMasterKey(), credentialAad(provider, email, scope))
  } catch (error) {
    if ((error as Error).message.includes('本机没有找到')) throw error
    throw new Error('本机邮箱凭据无法解密，请删除连接后重新配置')
  }
}

export function hasMailAuthorizationCode(provider: MailProvider, storedRef: string, scope?: string): boolean {
  return storedRef === credentialRef(provider, scope)
    && existsSync(credentialPath(storedRef))
    && existsSync(MASTER_KEY_PATH)
}

export function deleteMailAuthorizationCode(provider: MailProvider, storedRef: string, scope?: string): void {
  if (storedRef !== credentialRef(provider, scope)) return
  rmSync(credentialPath(storedRef), { force: true })
}
