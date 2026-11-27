import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import {
  detectFormat,
  extractVersion,
  getValueByPath,
  parseFile,
  resolveProjectFilePath,
  resolveVersion,
} from './parsers'

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
    expect(detectFormat('MyApp.xcodeproj/project.xcproj')).toBe('xcproj')
    expect(detectFormat('project.xcproj')).toBe('xcproj')
    expect(detectFormat('./MyApp.xcodeproj')).toBe('xcproj')
    expect(detectFormat('./MyApp.xcodeproj/')).toBe('xcproj')
  })

  it('lets an explicit format win', () => {
    expect(detectFormat('project.yml', 'yaml')).toBe('yaml')
    expect(detectFormat('version.txt', 'xcodegen')).toBe('xcodegen')
    expect(detectFormat('custom.json5', 'xcproj')).toBe('xcproj')
    expect(detectFormat('custom.json5', 'xcodeproj')).toBe('xcproj')
  })

  it('rejects unknown formats', () => {
    expect(() => detectFormat('version.ini')).toThrow('Unsupported file format: ini')
    expect(() => detectFormat('Makefile')).toThrow('Cannot determine the format')
  })
})

describe('resolveProjectFilePath', () => {
  it('resolves .xcodeproj bundle paths to project.xcproj', () => {
    expect(resolveProjectFilePath('./MyApp.xcodeproj')).toBe('./MyApp.xcodeproj/project.xcproj')
    expect(resolveProjectFilePath('./MyApp.xcodeproj/')).toBe('./MyApp.xcodeproj/project.xcproj')
    expect(resolveProjectFilePath('Apps/MyApp.xcodeproj')).toBe('Apps/MyApp.xcodeproj/project.xcproj')
    expect(resolveProjectFilePath('Apps\\MyApp.xcodeproj')).toBe('Apps\\MyApp.xcodeproj\\project.xcproj')
  })

  it('leaves non-bundle paths untouched', () => {
    expect(resolveProjectFilePath('./MyApp.xcodeproj/project.xcproj')).toBe('./MyApp.xcodeproj/project.xcproj')
    expect(resolveProjectFilePath('./project.yml')).toBe('./project.yml')
    expect(resolveProjectFilePath('./package.json')).toBe('./package.json')
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

  it('detects an Xcode JSON project.xcproj directly and via its .xcodeproj bundle', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'version-check-'))
    const bundleDir = path.join(directory, 'MyApp.xcodeproj')
    await mkdir(bundleDir)
    const xcprojPath = path.join(bundleDir, 'project.xcproj')
    await writeFile(xcprojPath, XCPROJ_PROJECT)

    const fromFile = await extractVersion(xcprojPath, { query: '', format: 'auto' })
    expect(fromFile.version).toBe('1.2.0')
    expect(fromFile.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION')

    const fromBundle = await extractVersion(bundleDir, { query: '', format: 'auto' })
    expect(fromBundle.version).toBe('1.2.0')
    expect(fromBundle.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION')
  })

  it('explains how to migrate when .xcodeproj only contains legacy project.pbxproj', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'version-check-'))
    const bundleDir = path.join(directory, 'Legacy.xcodeproj')
    await mkdir(bundleDir)
    await writeFile(path.join(bundleDir, 'project.pbxproj'), '// !$*UTF8*$!\n{}\n')

    await expect(extractVersion(bundleDir)).rejects.toThrow('legacy "project.pbxproj"')
  })
})

/** Xcode 27.2+ JSON5 project.xcproj (comments + trailing commas, per apple/xcode-project-format). */
const XCPROJ_PROJECT = `{
  // Generated by Xcode 27.2
  "default-configuration": "Release",
  "configurations": [
    "Debug",
    "Release",
  ],
  "localizations": {
    "development": "en",
  },
  "files": [],
  "targets": [
    {
      "name": "MyApp",
      "id": "AAA111",
      "product": "Products/MyApp.app",
      "product-type": "application",
      "build-settings": {
        "MARKETING_VERSION": "1.2.0",
        "CURRENT_PROJECT_VERSION": "120",
        "PRODUCT_BUNDLE_IDENTIFIER": "com.example.MyApp",
      },
    },
    {
      "name": "MyAppTests",
      "id": "BBB222",
      "product-type": "bundle.unit-test",
      "build-settings": {
        /* Test bundle keeps its own default version */
        "MARKETING_VERSION": "1.0",
      },
    },
  ],
  "build-settings": {
    "SWIFT_VERSION": "6.0",
  },
  "last-upgrade": "27.2",
}
`

describe('Xcode JSON project.xcproj support', () => {
  it('parses JSON5 (trailing commas + comments) and picks the application target version', () => {
    const resolved = resolveVersion(parse(XCPROJ_PROJECT, 'xcproj'), { format: 'xcproj' })
    expect(resolved.version).toBe('1.2.0')
    expect(resolved.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION')
    expect(resolved.alternatives).toEqual([{ version: '1.0', path: 'targets.MyAppTests.build-settings.MARKETING_VERSION' }])
  })

  it('prefers application target over project-level build-settings (and supports full-product-type)', () => {
    const project = `{
      "default-configuration": "Release",
      "build-settings": {
        "MARKETING_VERSION": "1.0.0",
      },
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "full-product-type": "com.apple.product-type.application",
          "build-settings": {
            "MARKETING_VERSION": "2.0.0",
          },
        },
      ],
    }`
    const resolved = resolveVersion(parse(project, 'xcproj'), { format: 'xcproj' })
    expect(resolved.version).toBe('2.0.0')
    expect(resolved.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION')
    expect(resolved.alternatives).toEqual([{ version: '1.0.0', path: 'build-settings.MARKETING_VERSION' }])
  })

  it('prefers project-level build-settings over unit-test targets, and frameworks over unit-test targets', () => {
    const withProject = `{
      "build-settings": {
        "MARKETING_VERSION": "1.5.0",
      },
      "targets": [
        {
          "name": "MyAppTests",
          "id": "1",
          "product-type": "bundle.unit-test",
          "build-settings": {
            "MARKETING_VERSION": "1.0",
          },
        },
      ],
    }`
    const resolvedProject = resolveVersion(parse(withProject, 'xcproj'), { format: 'xcproj' })
    expect(resolvedProject.version).toBe('1.5.0')
    expect(resolvedProject.path).toBe('build-settings.MARKETING_VERSION')

    const frameworkOnly = `{
      "targets": [
        {
          "name": "MyKitTests",
          "id": "1",
          "product-type": "bundle.unit-test",
          "build-settings": {
            "MARKETING_VERSION": "1.0",
          },
        },
        {
          "name": "MyKit",
          "id": "2",
          "product-type": "framework",
          "build-settings": {
            "MARKETING_VERSION": "2.3.0",
          },
        },
      ],
    }`
    const resolvedFramework = resolveVersion(parse(frameworkOnly, 'xcproj'), { format: 'xcproj' })
    expect(resolvedFramework.version).toBe('2.3.0')
    expect(resolvedFramework.path).toBe('targets.MyKit.build-settings.MARKETING_VERSION')
  })

  it('ranks conditional build settings properly (Release > unconditional > Debug)', () => {
    const splitConfigs = `{
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "product-type": "application",
          "build-settings": {
            "MARKETING_VERSION[config=Debug]": "1.2.0-dev",
            "MARKETING_VERSION[config=Release]": "1.2.0",
          },
        },
      ],
    }`
    const resolvedSplit = resolveVersion(parse(splitConfigs, 'xcproj'), { format: 'xcproj' })
    expect(resolvedSplit.version).toBe('1.2.0')
    expect(resolvedSplit.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION[config=Release]')
    expect(resolvedSplit.alternatives).toEqual([
      { version: '1.2.0-dev', path: 'targets.MyApp.build-settings.MARKETING_VERSION[config=Debug]' },
    ])

    const debugOverride = `{
      "build-settings": {
        "MARKETING_VERSION": "1.2.0",
      },
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "product-type": "application",
          "build-settings": {
            "MARKETING_VERSION[config=Debug]": "1.2.0-dev",
          },
        },
      ],
    }`
    const resolvedDebugOverride = resolveVersion(parse(debugOverride, 'xcproj'), { format: 'xcproj' })
    expect(resolvedDebugOverride.version).toBe('1.2.0')
    expect(resolvedDebugOverride.path).toBe('build-settings.MARKETING_VERSION')

    const releaseOverride = `{
      "build-settings": {
        "MARKETING_VERSION": "1.0.0",
      },
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "product-type": "application",
          "build-settings": {
            "MARKETING_VERSION[config=Release]": "2.0.0",
          },
        },
      ],
    }`
    const resolvedReleaseOverride = resolveVersion(parse(releaseOverride, 'xcproj'), { format: 'xcproj' })
    expect(resolvedReleaseOverride.version).toBe('2.0.0')
    expect(resolvedReleaseOverride.path).toBe('targets.MyApp.build-settings.MARKETING_VERSION[config=Release]')
  })

  it('supports INFOPLIST_KEY_CFBundleShortVersionString, ${SETTING}, and $(inherited) fallthrough', () => {
    const inherited = `{
      "build-settings": {
        "APP_VERSION": "3.4.5",
        "MARKETING_VERSION": "\${APP_VERSION}",
      },
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "product-type": "application",
          "build-settings": {
            "MARKETING_VERSION": "$(inherited)",
          },
        },
      ],
    }`
    const resolvedInherited = resolveVersion(parse(inherited, 'xcproj'), { format: 'xcproj' })
    expect(resolvedInherited.version).toBe('3.4.5')
    expect(resolvedInherited.path).toBe('build-settings.MARKETING_VERSION')

    const infoPlistKey = `{
      "targets": [
        {
          "name": "MyApp",
          "id": "1",
          "product-type": "application",
          "build-settings": {
            "INFOPLIST_KEY_CFBundleShortVersionString": "4.0.0",
          },
        },
      ],
    }`
    const resolvedInfoPlistKey = resolveVersion(parse(infoPlistKey, 'xcproj'), { format: 'xcproj' })
    expect(resolvedInfoPlistKey.version).toBe('4.0.0')
    expect(resolvedInfoPlistKey.path).toBe('targets.MyApp.build-settings.INFOPLIST_KEY_CFBundleShortVersionString')
  })

  it('supports explicit queries by target name, index, wildcard, and dotted conditional keys', () => {
    const data = parse(XCPROJ_PROJECT, 'xcproj')
    expect(resolveVersion(data, { format: 'xcproj', query: 'targets.MyApp.build-settings.MARKETING_VERSION' }).version).toBe(
      '1.2.0',
    )
    expect(resolveVersion(data, { format: 'xcproj', query: 'targets.1.build-settings.MARKETING_VERSION' }).version).toBe(
      '1.0',
    )
    expect(resolveVersion(data, { format: 'xcproj', query: 'targets.*.build-settings.MARKETING_VERSION' }).version).toBe(
      '1.2.0',
    )

    const dottedCondition = parse(
      `{
        "build-settings": {
          "MARKETING_VERSION[sdk=iphoneos18.0]": "5.1.0",
        },
      }`,
      'xcproj',
    )
    expect(
      resolveVersion(dottedCondition, { format: 'xcproj', query: 'build-settings.MARKETING_VERSION[sdk=iphoneos18.0]' })
        .version,
    ).toBe('5.1.0')
    expect(resolveVersion(dottedCondition, { format: 'xcproj' }).version).toBe('5.1.0')
  })

  it('explains how to fix a missing version in project.xcproj', () => {
    expect(() => resolveVersion(parse('{ "targets": [], }', 'xcproj'), { format: 'xcproj' })).toThrow(
      'build-settings.MARKETING_VERSION',
    )
  })
})
