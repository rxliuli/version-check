import * as fs from 'fs/promises'
import * as path from 'path'
import * as YAML from 'yaml'
import * as TOML from 'toml'
import { APPLE_VERSION_KEYS, resolveAppleVersion, type VersionCandidate } from './xcodegen'
import { isPlainObject } from './utils'

export type FileFormat = 'json' | 'yaml' | 'toml' | 'plist' | 'xcodegen'

/** XcodeGen specs, treated as Apple projects rather than plain YAML. */
const APPLE_PROJECT_FILES = ['project.yml', 'project.yaml']

const FORMAT_ALIASES: Record<string, FileFormat> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  plist: 'plist',
  xcodegen: 'xcodegen',
  xcode: 'xcodegen',
  apple: 'xcodegen',
}

const SUPPORTED_FORMATS = 'json, yaml, toml, plist, xcodegen'

export function normalizeFormat(format: string): FileFormat {
  const normalized = format.trim().toLowerCase()
  const resolved = FORMAT_ALIASES[normalized]
  if (!resolved) {
    throw new Error(`Unsupported file format: ${normalized || '(empty)'}. Supported formats: ${SUPPORTED_FORMATS}`)
  }
  return resolved
}

export function detectFormat(filePath: string, format = ''): FileFormat {
  const requested = format.trim().toLowerCase()
  if (requested && requested !== 'auto') return normalizeFormat(requested)

  if (APPLE_PROJECT_FILES.includes(path.basename(filePath).toLowerCase())) return 'xcodegen'

  const extension = path.extname(filePath).slice(1)
  if (!extension) {
    throw new Error(`Cannot determine the format of "${filePath}" from its name. Pass "format" explicitly.`)
  }
  return normalizeFormat(extension)
}

function parsePlist(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const regex = /<key>(.+?)<\/key>\s*(?:<string>(.+?)<\/string>|<(true|false)\s*\/>)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    result[match[1]] = match[3] !== undefined ? match[3] === 'true' : match[2]
  }
  return result
}

/**
 * YAML resolves plain scalars such as `MARKETING_VERSION: 1.0` to the number 1,
 * so stringifying the parsed value would silently report "1" instead of "1.0"
 * (and `1.10` as "1.1"). Use the raw source text for every plain scalar that
 * YAML would coerce to a non-string, keeping versions verbatim.
 */
function yamlScalarToValue(node: YAML.Scalar): unknown {
  const { value } = node
  const source = (node as YAML.Scalar.Parsed).source
  if (node.type === YAML.Scalar.PLAIN && value != null && typeof value !== 'string' && typeof source === 'string') {
    return source
  }
  return value
}

function yamlMapToValue(node: YAML.YAMLMap, doc: YAML.Document.Parsed): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const item of node.items) {
    const key = String(yamlNodeToValue(item.key as YAML.Node | null, doc))
    const value = yamlNodeToValue(item.value as YAML.Node | null, doc)

    if (key === '<<') {
      // YAML merge key (`<<: *anchor`): explicit keys win, merged keys fill the gaps.
      for (const merged of Array.isArray(value) ? value : [value]) {
        if (!isPlainObject(merged)) continue
        for (const [mergedKey, mergedValue] of Object.entries(merged)) {
          if (!(mergedKey in result)) result[mergedKey] = mergedValue
        }
      }
      continue
    }

    result[key] = value
  }
  return result
}

function yamlNodeToValue(node: YAML.Node | null, doc: YAML.Document.Parsed): unknown {
  if (node == null) return null
  if (YAML.isAlias(node)) return yamlNodeToValue(node.resolve(doc) ?? null, doc)
  if (YAML.isScalar(node)) return yamlScalarToValue(node)
  if (YAML.isSeq(node)) return node.items.map((item) => yamlNodeToValue(item as YAML.Node | null, doc))
  if (YAML.isMap(node)) return yamlMapToValue(node, doc)
  return null
}

export function parseYaml(content: string): unknown {
  const doc = YAML.parseDocument(content)
  const error = doc.errors[0]
  if (error) throw error
  return yamlNodeToValue(doc.contents, doc)
}

export function parseFile(content: string, format: FileFormat | string): unknown {
  switch (normalizeFormat(format)) {
    case 'json':
      return JSON.parse(content)

    case 'yaml':
    case 'xcodegen':
      return parseYaml(content)

    case 'toml':
      return TOML.parse(content)

    case 'plist':
      return parsePlist(content)
  }
}

const NOT_FOUND = Symbol('not-found')

function searchPath(node: unknown, keys: string[]): unknown {
  if (keys.length === 0) return node

  const [key, ...rest] = keys
  if (key === '*') {
    // Wildcard: the first match wins, so `targets.*.settings.base.MARKETING_VERSION`
    // works without knowing the target name.
    const children = Array.isArray(node) ? node : isPlainObject(node) ? Object.values(node) : []
    for (const child of children) {
      const value = searchPath(child, rest)
      if (value !== NOT_FOUND) return value
    }
    return NOT_FOUND
  }

  if (node !== null && typeof node === 'object' && key in node) {
    return searchPath((node as Record<string, unknown>)[key], rest)
  }
  return NOT_FOUND
}

export function getValueByPath(data: unknown, queryPath: string): unknown {
  const value = searchPath(data, queryPath.split('.'))
  if (value === NOT_FOUND) throw new Error(`Path "${queryPath}" not found`)
  return value
}

function toVersionString(value: unknown, queryPath: string): string {
  if (value !== null && typeof value === 'object') {
    throw new Error(`Path "${queryPath}" points to an object, not a version`)
  }
  return String(value)
}

export interface ResolvedVersion {
  version: string
  /** Where the version was read from, e.g. `settings.base.MARKETING_VERSION`. */
  path: string
  /** Other declarations of a different version in the same file (Apple projects). */
  alternatives: VersionCandidate[]
}

export interface VersionQuery {
  /** Dot-notation path, `*` matches any key. Empty falls back to the format default. */
  query?: string
  format?: FileFormat | string
}

export function resolveVersion(data: unknown, options: VersionQuery = {}): ResolvedVersion {
  const query = (options.query ?? '').trim()
  const format = normalizeFormat(options.format ?? 'json')

  if (query) {
    return { version: toVersionString(getValueByPath(data, query), query), path: query, alternatives: [] }
  }

  // `version` is the convention for JSON/YAML/TOML files, but XcodeGen keeps it
  // in a build setting and Info.plist uses `CFBundleShortVersionString`.
  if (format !== 'xcodegen') {
    try {
      return { version: toVersionString(getValueByPath(data, 'version'), 'version'), path: 'version', alternatives: [] }
    } catch (error) {
      const apple = resolveAppleVersion(data)
      if (apple) return apple
      throw new Error(
        `${(error as Error).message}. Also looked for ${APPLE_VERSION_KEYS.join(' / ')}; ` +
          'pass "query" with an explicit path, e.g. settings.base.MARKETING_VERSION',
      )
    }
  }

  const apple = resolveAppleVersion(data)
  if (apple) return apple

  throw new Error(
    `No ${APPLE_VERSION_KEYS.join(' / ')} found in the XcodeGen project. ` +
      'Pass "query" with an explicit path, e.g. settings.base.MARKETING_VERSION',
  )
}

export async function extractVersion(filePath: string, options: VersionQuery = {}): Promise<ResolvedVersion> {
  const content = await fs.readFile(filePath, 'utf-8')
  const format = detectFormat(filePath, options.format)
  return resolveVersion(parseFile(content, format), { ...options, format })
}
