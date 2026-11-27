import { isPlainObject } from './utils'

/**
 * Apple / Xcode project support.
 *
 * `MARKETING_VERSION` is the Xcode build setting that ends up as
 * `CFBundleShortVersionString` in the shipping app. It appears in:
 *
 * - XcodeGen `project.yml` specs, under `settings.base` or per-target `settings`
 * - Xcode JSON `project.xcproj` files (Xcode 27.2+), under project or target
 *   `build-settings` (including conditional keys like `MARKETING_VERSION[config=Release]`)
 * - Standalone `Info.plist` files via `CFBundleShortVersionString`
 *
 * This module locates that setting across all of those shapes, following
 * `$(SETTING)` / `${SETTING}` references so a version can be read without
 * hand-writing the exact dot path.
 */

export interface VersionCandidate {
  /** Version value, e.g. `0.6.0`. */
  version: string
  /** Dot path inside the file, e.g. `settings.base.MARKETING_VERSION`. */
  path: string
}

export interface AppleVersionResult {
  version: string
  path: string
  /** Other declarations of a different version in the same file, most relevant first. */
  alternatives: VersionCandidate[]
}

/** Keys that carry the user facing version, most canonical first. */
export const APPLE_VERSION_KEYS = ['MARKETING_VERSION', 'CFBundleShortVersionString']

/** All setting/plist keys recognized as version carriers. */
const RECOGNIZED_VERSION_KEYS = [...APPLE_VERSION_KEYS, 'INFOPLIST_KEY_CFBundleShortVersionString']

/** `$(MARKETING_VERSION)` or `${MARKETING_VERSION}` references used by Xcode / Info.plist. */
const VARIABLE_REFERENCE = /^\$(?:\(([^()]+)\)|\{([^{}]+)\})$/

/** Conditional Xcode build setting key, e.g. `MARKETING_VERSION[config=Release][sdk=iphoneos*]`. */
const CONDITIONAL_SETTING_KEY = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]+\])+)$/
const CONDITION_CLAUSE = /\[([^\]]+)\]/g

const PRODUCT_TYPE_PREFIX = 'com.apple.product-type.'

const DEFAULT_SETTINGS_SCORE = 25
const SETTINGS_SHAPE_SCORES: Record<string, number> = {
  // `settings.base` applies to every configuration, `settings.configs.<config>`
  // only to a single one, a bare setting applies unconditionally.
  base: 40,
  configs: 5,
}

interface SettingCondition {
  axis: string
  value: string
}

interface ParsedSettingKey {
  name: string
  conditions: SettingCondition[]
}

interface InternalCandidate extends VersionCandidate {
  segments: string[]
  parsedKey: ParsedSettingKey
}

function parseSettingKey(key: string): ParsedSettingKey {
  const match = CONDITIONAL_SETTING_KEY.exec(key)
  if (!match) return { name: key, conditions: [] }

  const conditions: SettingCondition[] = []
  CONDITION_CLAUSE.lastIndex = 0
  let clause: RegExpExecArray | null
  while ((clause = CONDITION_CLAUSE.exec(match[2])) !== null) {
    const raw = clause[1]
    const eqIndex = raw.indexOf('=')
    if (eqIndex === -1) {
      conditions.push({ axis: raw.trim().toLowerCase(), value: '' })
    } else {
      conditions.push({
        axis: raw.slice(0, eqIndex).trim().toLowerCase(),
        value: raw.slice(eqIndex + 1).trim(),
      })
    }
  }
  return { name: match[1], conditions }
}

function scalarToString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * In `project.xcproj`, `targets` is an array of objects with unique `name`
 * fields. Using a target's name as its path segment keeps reported paths human
 * readable and stable across target reordering (and matches `getValueByPath`).
 */
function arrayItemSegment(array: unknown[], item: unknown, index: number, pathParts: string[]): string {
  if (pathParts.length === 1 && pathParts[0] === 'targets' && isPlainObject(item)) {
    const name = item.name
    if (
      typeof name === 'string' &&
      name.length > 0 &&
      !name.includes('.') &&
      !/^\d+$/.test(name) &&
      array.filter((entry) => isPlainObject(entry) && entry.name === name).length === 1
    ) {
      return name
    }
  }
  return String(index)
}

function walkEntries(
  node: unknown,
  pathParts: string[],
  visit: (key: string, value: unknown, segments: string[]) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      const segment = arrayItemSegment(node, item, index, pathParts)
      walkEntries(item, [...pathParts, segment], visit)
    })
    return
  }
  if (!isPlainObject(node)) return
  for (const [key, value] of Object.entries(node)) {
    const segments = [...pathParts, key]
    visit(key, value, segments)
    walkEntries(value, segments, visit)
  }
}

/** Every occurrence of one of `names` (including conditional `[config=...]` variants) holding a scalar. */
function findSetting(data: unknown, names: string[]): InternalCandidate[] {
  const matches: InternalCandidate[] = []
  walkEntries(data, [], (key, value, segments) => {
    const parsedKey = parseSettingKey(key)
    if (!names.includes(parsedKey.name)) return
    const version = scalarToString(value)
    if (version !== null) {
      matches.push({ version, path: segments.join('.'), segments, parsedKey })
    }
  })
  return matches
}

function findTarget(data: unknown, segment: string): Record<string, unknown> | undefined {
  const targets = isPlainObject(data) ? data.targets : undefined
  if (isPlainObject(targets)) {
    const target = targets[segment]
    return isPlainObject(target) ? target : undefined
  }
  if (Array.isArray(targets)) {
    if (/^\d+$/.test(segment)) {
      const target = targets[Number(segment)]
      return isPlainObject(target) ? target : undefined
    }
    const named = targets.find((entry) => isPlainObject(entry) && entry.name === segment)
    return isPlainObject(named) ? named : undefined
  }
  return undefined
}

function scoreTarget(target: Record<string, unknown> | undefined): number {
  if (!target) return 15
  const rawType =
    typeof target['product-type'] === 'string'
      ? target['product-type']
      : typeof target['full-product-type'] === 'string'
        ? target['full-product-type']
        : typeof target.type === 'string'
          ? target.type
          : ''

  const normalized = rawType.startsWith(PRODUCT_TYPE_PREFIX) ? rawType.slice(PRODUCT_TYPE_PREFIX.length) : rawType
  if (normalized === 'application') return 30
  if (normalized.includes('unit-test') || normalized.includes('ui-testing')) return 10
  return 15
}

function scoreBuildSettingsCondition(conditions: SettingCondition[]): number {
  if (conditions.length === 0) return 40
  const configCondition = conditions.find((condition) => condition.axis === 'config')
  if (configCondition) {
    const config = configCondition.value.toLowerCase()
    if (config === 'release') return conditions.length === 1 ? 42 : 41
    if (config.includes('debug')) return 5
    return 15
  }
  // Conditional on SDK/arch without restricting configuration (applies to Release builds too).
  return 25
}

/**
 * How likely a candidate is the version that ships in the app: target settings
 * override project settings, the application target is the one that gets built,
 * `Release` / unconditional settings outrank `Debug` overrides, and
 * `MARKETING_VERSION` outranks an Info.plist property.
 */
function scoreCandidate(data: unknown, candidate: InternalCandidate): number {
  const { segments, parsedKey } = candidate
  let score = parsedKey.name === 'MARKETING_VERSION' ? 10 : 0

  const buildSettingsIndex = segments.indexOf('build-settings')
  const settingsIndex = segments.indexOf('settings')
  if (buildSettingsIndex !== -1) {
    score += scoreBuildSettingsCondition(parsedKey.conditions)
  } else if (settingsIndex !== -1) {
    score += SETTINGS_SHAPE_SCORES[segments[settingsIndex + 1]] ?? DEFAULT_SETTINGS_SCORE
  } else {
    score += 20
  }

  const targetSegment = segments[0] === 'targets' ? segments[1] : undefined
  if (targetSegment !== undefined) {
    score += scoreTarget(findTarget(data, targetSegment))
  } else {
    score += 25
  }

  return score
}

function rankCandidates(data: unknown, candidates: InternalCandidate[]): InternalCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(data, candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate)
}

/** Follow `$(SETTING)` / `${SETTING}` references; returns `null` for a missing or circular one. */
function resolveCandidate(data: unknown, candidate: InternalCandidate, seen: Set<string>): string | null {
  const match = VARIABLE_REFERENCE.exec(candidate.version)
  if (!match) return candidate.version

  const name = (match[1] ?? match[2]).trim()
  if (seen.has(name)) return null

  const referenced = rankCandidates(data, findSetting(data, [name]))[0]
  if (!referenced) return null

  seen.add(name)
  return resolveCandidate(data, referenced, seen)
}

function collectAlternatives(
  data: unknown,
  candidates: InternalCandidate[],
  resolvedVersion: string,
): VersionCandidate[] {
  const seen = new Set([resolvedVersion])
  const alternatives: VersionCandidate[] = []
  for (const candidate of candidates) {
    const version = resolveCandidate(data, candidate, new Set())
    if (version === null || seen.has(version)) continue
    seen.add(version)
    alternatives.push({ version, path: candidate.path })
  }
  return alternatives
}

/** Locate the shipping version of an Apple project, or `null` when there is none. */
export function resolveAppleVersion(data: unknown): AppleVersionResult | null {
  const ranked = rankCandidates(data, findSetting(data, RECOGNIZED_VERSION_KEYS))

  for (const [index, candidate] of ranked.entries()) {
    const version = resolveCandidate(data, candidate, new Set())
    if (version === null) continue
    return {
      version,
      path: candidate.path,
      alternatives: collectAlternatives(data, ranked.slice(index + 1), version),
    }
  }

  return null
}
