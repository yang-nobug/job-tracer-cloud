/** 任何来自邮件、导入数据或用户输入的外链都只能是 http(s)。 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

export function openExternalUrl(value: unknown): boolean {
  const url = safeExternalUrl(value)
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
