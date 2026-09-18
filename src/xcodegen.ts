import { isPlainObject } from './utils'

/**
 * Apple / Xcode project support.
 *
 * `MARKETING_VERSION` is the Xcode build setting that ends up as
 * `CFBundleShortVersionString` in the shipping app, and in an XcodeGen project it
 * lives in `project.yml` either at the project level or per target:
 *
 * ```yaml
 * settings:
 *   base:
 *     MARKETING_VERSION: "0.6.0"
 * targets:
 *   LinkPureMac:
 *     type: application
 *     settings:
 *       base:
 *         MARKETING_VERSION: "0.6.0"
 * ```
 *
 * This module finds that setting (any of those shapes, plus `$(SETTING)`
 * references coming from `info.properties`) so a version can be read without
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

/** `$(MARKETING_VERSION)` style references used by XcodeGen / Info.plist. */
const VARIABLE_REFERENCE = /^\$\(([^()]+)\)$/

const DEFAULT_SETTINGS_SCORE = 25
const SETTINGS_SHAPE_SCORES: Record<string, number> = {
  // `settings.base` applies to every configuration, `settings.configs.<config>`
  // only to a single one, a bare setting applies unconditionally.
  base: 40,
  configs: 5,
}

function scalarToString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

function walkEntries(
  node: unknown,
  pathParts: string[],
  visit: (key: string, value: unknown, entryPath: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkEntries(item, [...pathParts, String(index)], visit))
    return
  }
  if (!isPlainObject(node)) return
  for (const [key, value] of Object.entries(node)) {
    visit(key, value, [...pathParts, key].join('.'))
    walkEntries(value, [...pathParts, key], visit)
  }
}

/** Every occurrence of one of `names` that holds a scalar value. */
function findSetting(data: unknown, names: string[]): VersionCandidate[] {
  const matches: VersionCandidate[] = []
  walkEntries(data, [], (key, value, entryPath) => {
    if (!names.includes(key)) return
    const version = scalarToString(value)
    if (version !== null) matches.push({ version, path: entryPath })
  })
  return matches
}

/**
 * How likely a candidate is the version that ships in the app: target settings
 * override project settings, the application target is the one that gets built,
 * `settings.base` is the default for every configuration, and
 * `MARKETING_VERSION` outranks an Info.plist property.
 */
function scoreCandidate(data: unknown, candidate: VersionCandidate): number {
  const segments = candidate.path.split('.')
  const name = segments[segments.length - 1]
  let score = name === 'MARKETING_VERSION' ? 10 : 0

  const settingsIndex = segments.indexOf('settings')
  if (settingsIndex === -1) {
    score += 20
  } else {
    score += SETTINGS_SHAPE_SCORES[segments[settingsIndex + 1]] ?? DEFAULT_SETTINGS_SCORE
  }

  const targetName = segments[0] === 'targets' ? segments[1] : undefined
  if (targetName !== undefined) {
    const targets = isPlainObject(data) ? data.targets : undefined
    const target = isPlainObject(targets) ? targets[targetName] : undefined
    score += isPlainObject(target) && target.type === 'application' ? 30 : 15
  } else {
    score += 25
  }

  return score
}

function rankCandidates(data: unknown, candidates: VersionCandidate[]): VersionCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(data, candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate)
}

/** Follow `$(SETTING)` references; returns `null` for a missing or circular one. */
function resolveCandidate(data: unknown, candidate: VersionCandidate, seen: Set<string>): string | null {
  const match = VARIABLE_REFERENCE.exec(candidate.version)
  if (!match) return candidate.version

  const name = match[1].trim()
  if (seen.has(name)) return null

  const referenced = rankCandidates(data, findSetting(data, [name]))[0]
  if (!referenced) return null

  seen.add(name)
  return resolveCandidate(data, referenced, seen)
}

function collectAlternatives(
  data: unknown,
  candidates: VersionCandidate[],
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
  const ranked = rankCandidates(data, findSetting(data, APPLE_VERSION_KEYS))

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
