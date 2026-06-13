import * as fs from 'fs/promises'
import * as YAML from 'yaml'
import * as TOML from 'toml'

function parsePlist(content: string): Record<string, any> {
  const result: Record<string, any> = {}
  const regex = /<key>(.+?)<\/key>\s*(?:<string>(.+?)<\/string>|<(true|false)\s*\/>)/g
  let match
  while ((match = regex.exec(content)) !== null) {
    result[match[1]] = match[3] !== undefined ? match[3] === 'true' : match[2]
  }
  return result
}

export function parseFile(content: string, extension: string): any {
  switch (extension.toLowerCase()) {
    case 'json':
      return JSON.parse(content)

    case 'yaml':
    case 'yml':
      return YAML.parse(content)

    case 'toml':
      return TOML.parse(content)

    case 'plist':
      return parsePlist(content)

    default:
      throw new Error(`Unsupported file format: ${extension}`)
  }
}

export async function extractVersion(filePath: string, queryPath: string): Promise<string> {
  // Read file
  const content = await fs.readFile(filePath, 'utf-8')
  
  // Determine file type
  const extension = filePath.split('.').pop() || 'json'
  
  // Parse file
  const data = parseFile(content, extension)
  
  // Extract version using query path
  const keys = queryPath.split('.')
  let current = data
  
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key]
    } else {
      throw new Error(`Path "${queryPath}" not found in ${filePath}`)
    }
  }

  return String(current)
}