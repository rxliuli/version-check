import { describe, expect, it } from 'vitest'
import { compareVersions, determineVersionChangeType } from './version'

describe('compareVersions', () => {
  it('compares semantic versions accurately', () => {
    expect(compareVersions('0.0.5', '0.0.4')).toBe(1)
    expect(compareVersions('0.0.4', '0.0.5')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.1')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })

  it('compares non-semver numeric dot-separated versions numerically', () => {
    expect(compareVersions('1.10', '1.9')).toBe(1)
    expect(compareVersions('1.9', '1.10')).toBe(-1)
    expect(compareVersions('2.0', '1.10')).toBe(1)
    expect(compareVersions('1.0.0', '1.0')).toBe(0)
  })
})

describe('determineVersionChangeType', () => {
  it('classifies major, minor, patch, and prerelease upgrades', () => {
    expect(determineVersionChangeType('1.2.3', '2.0.0')).toBe('major')
    expect(determineVersionChangeType('0.0.4', '0.1.1')).toBe('minor')
    expect(determineVersionChangeType('0.0.4', '0.0.6')).toBe('patch')
    expect(determineVersionChangeType('1.0.0', '1.0.1-beta.1')).toBe('prepatch')
  })
})
