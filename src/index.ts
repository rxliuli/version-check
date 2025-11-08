import * as core from '@actions/core'
import { parseFile, extractVersion } from './parsers'
import { getPreviousFileContent } from './git'
import { determineVersionChangeType } from './version'

async function run(): Promise<void> {
  try {
    const filePath = core.getInput('file', { required: true })
    const query = core.getInput('query') || 'version'

    core.info(`Checking version in file: ${filePath}`)
    core.info(`Query path: ${query}`)

    // Get current version
    const currentVersion = await extractVersion(filePath, query)
    core.setOutput('version', currentVersion)
    core.info(`Current version: ${currentVersion}`)

    try {
      // Get previous file content
      const previousContent = await getPreviousFileContent(filePath)

      if (previousContent) {
        // Parse previous version
        const fileExtension = filePath.split('.').pop() || 'json'
        const previousData = parseFile(previousContent, fileExtension)
        const previousVersion = getValueByPath(previousData, query)

        core.setOutput('previous_version', previousVersion)
        core.info(`Previous version: ${previousVersion}`)

        // Compare versions
        const changed = currentVersion !== previousVersion
        core.setOutput('changed', changed.toString())

        if (changed) {
          // Determine version change type
          const changeType = determineVersionChangeType(
            previousVersion,
            currentVersion,
          )
          core.setOutput('type', changeType)
          core.info(
            `Version changed: ${previousVersion} → ${currentVersion} (${changeType})`,
          )
        } else {
          core.info('Version unchanged')
        }
      } else {
        // No previous version (first commit)
        core.setOutput('changed', 'true')
        core.info('No previous version found (possibly first commit)')
      }
    } catch (error) {
      core.warning(`Could not get previous version: ${error}`)
      core.setOutput('changed', 'false')
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}

function getValueByPath(obj: any, path: string): string {
  const keys = path.split('.')
  let current = obj

  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key]
    } else {
      throw new Error(`Path "${path}" not found in object`)
    }
  }

  return String(current)
}

run()
