import * as semver from 'semver'

export function compareVersions(v1: string, v2: string): number {
  // Try semantic versioning first
  const sv1 = semver.valid(v1)
  const sv2 = semver.valid(v2)

  if (sv1 && sv2) {
    return semver.compare(sv1, sv2)
  }

  if (v1 === v2) return 0

  // Fallback: numeric dot-separated comparison so e.g. "1.10" > "1.9"
  const p1 = v1.split('.')
  const p2 = v2.split('.')
  const len = Math.max(p1.length, p2.length)
  for (let i = 0; i < len; i++) {
    const s1 = p1[i] ?? '0'
    const s2 = p2[i] ?? '0'
    if (/^\d+$/.test(s1) && /^\d+$/.test(s2)) {
      const n1 = Number(s1)
      const n2 = Number(s2)
      if (n1 !== n2) return n1 > n2 ? 1 : -1
    } else if (s1 !== s2) {
      return s1 > s2 ? 1 : -1
    }
  }
  return 0
}

export function determineVersionChangeType(
  previousVersion: string,
  currentVersion: string
): string {
  // Try semantic versioning
  const prev = semver.valid(previousVersion)
  const curr = semver.valid(currentVersion)
  
  if (prev && curr) {
    const diff = semver.diff(prev, curr)
    return diff || 'unknown'
  }
  
  // Fallback to simple comparison
  const prevParts = previousVersion.split('.')
  const currParts = currentVersion.split('.')
  
  for (let i = 0; i < Math.max(prevParts.length, currParts.length); i++) {
    const prevPart = parseInt(prevParts[i] || '0', 10)
    const currPart = parseInt(currParts[i] || '0', 10)
    
    if (currPart > prevPart) {
      if (i === 0) return 'major'
      if (i === 1) return 'minor'
      if (i === 2) return 'patch'
    }
  }
  
  return 'prerelease'
}