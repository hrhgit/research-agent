function scalar(raw: string): unknown {
  const value = raw.trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  if (value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    try { return JSON.parse(value.replaceAll("'", '"')) } catch { return value }
  }
  return value
}

/** Small YAML subset for the frontmatter emitted by experiment-log. It deliberately keeps unknown values as text. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const result: Record<string, unknown> = {}
  let key: string | undefined
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const listItem = line.match(/^\s*-\s*(.*)$/)
    if (listItem && key) {
      const current = Array.isArray(result[key]) ? result[key] as unknown[] : []
      current.push(scalar(listItem[1]!)); result[key] = current; continue
    }
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (entry) { key = entry[1]; result[key] = scalar(entry[2]!); continue }
    if (key && line.trim()) {
      const current = result[key]
      const continuation = line.trim()
      result[key] = `${current === undefined ? '' : String(current)}\n${continuation}`
    }
  }
  return result
}
