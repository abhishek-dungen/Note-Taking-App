import { normalizeTag } from './tags'

export type ShlokaStatus = 'memorizing' | 'memorized'

export type Shloka = {
  id: string
  title: string
  reference: string
  text: string
  tags: string[]
  status: ShlokaStatus
  createdAt: string
  updatedAt: string
}

export type ShlokaTagSummary = {
  id: string
  label: string
  count: number
}

export const SHLOKAS_STORAGE_KEY = 'quiet-notes::shlokas'

const TAG_PATTERN = /#([^\s#,]+)/g

function getScopedStorageKey(baseKey: string, scope?: string) {
  return scope ? `${baseKey}::${scope}` : baseKey
}

function normalizeShloka(shloka: Partial<Shloka>): Shloka {
  const now = new Date().toISOString()

  return {
    id: typeof shloka.id === 'string' && shloka.id ? shloka.id : crypto.randomUUID(),
    title: typeof shloka.title === 'string' ? shloka.title : '',
    reference: typeof shloka.reference === 'string' ? shloka.reference : '',
    text: typeof shloka.text === 'string' ? shloka.text : '',
    tags: Array.isArray(shloka.tags)
      ? [...new Set(shloka.tags.map((tag) => normalizeTag(String(tag))).filter(Boolean))]
      : [],
    status: shloka.status === 'memorized' ? 'memorized' : 'memorizing',
    createdAt: typeof shloka.createdAt === 'string' ? shloka.createdAt : now,
    updatedAt: typeof shloka.updatedAt === 'string' ? shloka.updatedAt : now,
  }
}

export function createShloka(): Shloka {
  return normalizeShloka({})
}

export function parseStoredShlokas(raw: string | null): Shloka[] | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Shloka>[]

    if (!Array.isArray(parsed)) {
      return null
    }

    return parsed.map(normalizeShloka)
  } catch {
    return null
  }
}

export function loadShlokas(scope?: string): Shloka[] {
  try {
    return (
      parseStoredShlokas(window.localStorage.getItem(getScopedStorageKey(SHLOKAS_STORAGE_KEY, scope))) ??
      []
    )
  } catch {
    return []
  }
}

export function saveShlokas(shlokas: Shloka[], scope?: string) {
  try {
    window.localStorage.setItem(
      getScopedStorageKey(SHLOKAS_STORAGE_KEY, scope),
      JSON.stringify(shlokas),
    )
    return { ok: true as const }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Unable to save shlokas locally.',
    }
  }
}

export function parseShlokaTags(value: string) {
  const tags = new Set<string>()

  for (const match of value.matchAll(TAG_PATTERN)) {
    const tag = normalizeTag(match[1] ?? '')
    if (tag) {
      tags.add(tag)
    }
  }

  return [...tags]
}

export function formatShlokaTags(tags: string[]) {
  return tags.map((tag) => `#${tag}`).join(' ')
}

export function getShlokaTagSummaries(shlokas: Shloka[]): ShlokaTagSummary[] {
  const tagMap = new Map<string, ShlokaTagSummary>()

  shlokas.forEach((shloka) => {
    ;[...new Set(shloka.tags)].forEach((tag) => {
      const existing = tagMap.get(tag)
      if (existing) {
        existing.count += 1
        return
      }

      tagMap.set(tag, {
        id: tag,
        label: tag,
        count: 1,
      })
    })
  })

  return [...tagMap.values()].sort((left, right) => left.label.localeCompare(right.label))
}

export function matchesShlokaSearch(shloka: Shloka, searchTerm: string) {
  const query = searchTerm.trim().toLowerCase()

  if (!query) {
    return true
  }

  return (
    shloka.title.toLowerCase().includes(query) ||
    shloka.reference.toLowerCase().includes(query) ||
    shloka.text.toLowerCase().includes(query) ||
    shloka.tags.some((tag) => tag.includes(query))
  )
}
