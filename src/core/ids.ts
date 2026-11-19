import { randomUUID } from 'node:crypto'

export function id(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function now(): string {
  return new Date().toISOString()
}
