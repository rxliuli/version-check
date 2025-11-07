import * as semver from 'semver'

export function compareVersions(v1: string, v2: string): number {
  // Try semantic versioning first
  const sv1 = semver.valid(v1)
  const sv2 = semver.valid(v2)
  
  if (sv1 && sv2) {
    return semver.compare(sv1, sv2)
  }
  
  // Fallback to string comparison
  if (v1 === v2) return 0
  return v1 > v2 ? 1 : -1
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