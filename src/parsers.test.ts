import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { detectFormat, extractVersion, getValueByPath, parseFile, resolveVersion } from './parsers'

/** Trimmed down version of https://github.com/rxliuli/LinkPure project.yml */
const XCODEGEN_PROJECT = `
name: LinkPure
options:
  bundleIdPrefix: com.rxliuli
  deploymentTarget:
    macOS: "15.0"
    iOS: "17.0"

settings:
  base:
    MARKETING_VERSION: "0.6.0"
    CURRENT_PROJECT_VERSION: "600"
    SWIFT_VERSION: "5.0"

targets:
  LinkPureMac:
    type: application
    platform: macOS
    settings:
      base:
        PRODUCT_NAME: LinkPure
      configs:
        Release:
          PRODUCT_BUNDLE_IDENTIFIER: com.rxliuli.linkpure2
  LinkPureIOS:
    type: application
    platform: iOS
    info:
      properties:
        CFBundleShortVersionString: "$(MARKETING_VERSION)"
        CFBundleVersion: "$(CURRENT_PROJECT_VERSION)"
`

function parse(content: string, format: string): unknown {
  return parseFile(content, format)
}

describe('detectFormat', () => {
  it('detects XcodeGen specs by file name', () => {
    expect(detectFormat('project.yml')).toBe('xcodegen')
    expect(detectFormat('Apps/macOS/project.yaml')).toBe('xcodegen')
  })

  it('detects the other formats by extension', () => {
    expect(detectFormat('./package.json')).toBe('json')
    expect(detectFormat('build/config.yml')).toBe('yaml')
    expect(detectFormat('Cargo.toml')).toBe('toml')
    expect(detectFormat('Info.plist')).toBe('plist')
  })

  it('lets an explicit format win', () => {
    expect(detectFormat('project.yml', 'yaml')).toBe('yaml')
    expect(detectFormat('version.txt', 'xcodegen')).toBe('xcodegen')
  })

  it('rejects unknown formats', () => {
    expect(() => detectFormat('version.ini')).toThrow('Unsupported file format: ini')
    expect(() => detectFormat('Makefile')).toThrow('Cannot determine the format')
  })
})

describe('resolveVersion', () => {
  it('reads MARKETING_VERSION from an XcodeGen project', () => {
    const resolved = resolveVersion(parse(XCODEGEN_PROJECT, 'xcodegen'), { format: 'xcodegen' })
    expect(resolved.version).toBe('0.6.0')
    expect(resolved.path).toBe('settings.base.MARKETING_VERSION')
    expect(resolved.alternatives).toEqual([])
  })

  it('finds MARKETING_VERSION in a YAML file without an explicit format', () => {
    const resolved = resolveVersion(parse(XCODEGEN_PROJECT, 'yaml'), {})
    expect(resolved.version).toBe('0.6.0')
  })

  it('keeps plain scalar versions verbatim instead of YAML numbers', () => {
    const project = 'settings:\n  base:\n    MARKETING_VERSION: 1.0\n'
    expect(resolveVersion(parse(project, 'xcodegen'), { format: 'xcodegen' }).version).toBe('1.0')

    const yaml = 'version: 1.10\n'
    expect(resolveVersion(parse(yaml, 'yaml'), {}).version).toBe('1.10')

    const nested = 'info:\n  version: 0.1.0\n'
    expect(resolveVersion(parse(nested, 'yaml'), { query: 'info.version' }).version).toBe('0.1.0')
  })

  it('prefers the application target over the project settings', () => {
    const project = `
settings:
  base:
    MARKETING_VERSION: "1.0.0"
targets:
  LinkPureMac:
    type: application
    settings:
      base:
        MARKETING_VERSION: "2.0.0"
`
    const resolved = resolveVersion(parse(project, 'xcodegen'), { format: 'xcodegen' })
    expect(resolved.version).toBe('2.0.0')
    expect(resolved.path).toBe('targets.LinkPureMac.settings.base.MARKETING_VERSION')
    expect(resolved.alternatives).toEqual([{ version: '1.0.0', path: 'settings.base.MARKETING_VERSION' }])
  })

  it('ignores a test target version in favour of the project one', () => {
    const project = `
settings:
  base:
    MARKETING_VERSION: "1.0.0"
targets:
  LinkPureMacTests:
    type: bundle.unit-test
    settings:
      base:
        MARKETING_VERSION: "0.0.1"
`
    const resolved = resolveVersion(parse(project, 'xcodegen'), { format: 'xcodegen' })
    expect(resolved.version).toBe('1.0.0')
    expect(resolved.path).toBe('settings.base.MARKETING_VERSION')
    expect(resolved.alternatives).toEqual([
      { version: '0.0.1', path: 'targets.LinkPureMacTests.settings.base.MARKETING_VERSION' },
    ])
  })

  it('follows $(SETTING) references from Info.plist properties', () => {
    const project = `
settings:
  base:
    APP_VERSION: "3.1.4"
targets:
  LinkPureMac:
    type: application
    info:
      properties:
        CFBundleShortVersionString: "$(APP_VERSION)"
`
    const resolved = resolveVersion(parse(project, 'xcodegen'), { format: 'xcodegen' })
    expect(resolved.version).toBe('3.1.4')
    expect(resolved.path).toBe('targets.LinkPureMac.info.properties.CFBundleShortVersionString')
  })

  it('does not hang on circular $(SETTING) references', () => {
    const project = `
settings:
  base:
    MARKETING_VERSION: "$(A)"
    A: "$(MARKETING_VERSION)"
`
    expect(() => resolveVersion(parse(project, 'xcodegen'), { format: 'xcodegen' })).toThrow(
      'No MARKETING_VERSION',
    )
  })

  it('supports wildcards in an explicit query', () => {
    expect(getValueByPath(parse(XCODEGEN_PROJECT, 'yaml'), 'targets.*.settings.base.PRODUCT_NAME')).toBe('LinkPure')
    expect(getValueByPath(parse(XCODEGEN_PROJECT, 'yaml'), 'targets.*.info.properties.CFBundleVersion')).toBe(
      '$(CURRENT_PROJECT_VERSION)',
    )
  })

  it('honours an explicit query over the default', () => {
    const resolved = resolveVersion(parse(XCODEGEN_PROJECT, 'yaml'), { query: 'name' })
    expect(resolved.version).toBe('LinkPure')
    expect(resolved.path).toBe('name')
  })

  it('resolves YAML anchors and merge keys', () => {
    const project = `
shared: &shared
  MARKETING_VERSION: "4.0.0"
  PRODUCT_NAME: LinkPure
settings:
  base:
    <<: *shared
    PRODUCT_NAME: LinkPureMac
`
    const data = parse(project, 'xcodegen')
    expect(resolveVersion(data, { format: 'xcodegen' }).version).toBe('4.0.0')
    expect(getValueByPath(data, 'settings.base.PRODUCT_NAME')).toBe('LinkPureMac')
  })

  it('keeps working for the other formats', () => {
    expect(resolveVersion(parseFile('{"name":"pkg","version":"1.2.3"}', 'json'), {}).version).toBe('1.2.3')
    expect(
      resolveVersion(parseFile('[package]\nname = "pkg"\nversion = "0.1.0"\n', 'toml'), {
        query: 'package.version',
      }).version,
    ).toBe('0.1.0')
  })

  it('falls back to CFBundleShortVersionString in an Info.plist', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>1.4.0</string>
  <key>CFBundleVersion</key>
  <string>42</string>
</dict>
</plist>`
    expect(resolveVersion(parseFile(plist, 'plist'), { format: 'plist' }).version).toBe('1.4.0')
  })

  it('explains how to fix a missing version', () => {
    expect(() => resolveVersion(parse('name: LinkPure\n', 'xcodegen'), { format: 'xcodegen' })).toThrow(
      'settings.base.MARKETING_VERSION',
    )
    expect(() => resolveVersion(parse('{}', 'json'), { format: 'json' })).toThrow('Path "version" not found')
    expect(() => resolveVersion(parse('{"a":{"b":1}}', 'json'), { format: 'json', query: 'a' })).toThrow(
      'points to an object',
    )
  })
})

describe('extractVersion', () => {
  it('detects an XcodeGen project.yml on disk', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'version-check-'))
    const filePath = path.join(directory, 'project.yml')
    await writeFile(filePath, XCODEGEN_PROJECT)

    const resolved = await extractVersion(filePath, { query: '', format: 'auto' })
    expect(resolved.version).toBe('0.6.0')
    expect(resolved.path).toBe('settings.base.MARKETING_VERSION')
  })
})
