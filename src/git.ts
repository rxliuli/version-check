import { execSync } from 'child_process'
import * as core from '@actions/core'

export async function getPreviousFileContent(filePath: string): Promise<string | null> {
  try {
    // Normalize file path (remove leading ./)
    const normalizedPath = filePath.replace(/^\.\//, '')

    // Check if HEAD~1 exists (requires fetch-depth >= 2)
    try {
      execSync('git rev-parse HEAD~1', { encoding: 'utf-8', stdio: 'pipe' })
    } catch {
      core.warning(
        'Cannot access previous commit (HEAD~1). ' +
        'Make sure to use "fetch-depth: 2" or higher with actions/checkout. ' +
        'See: https://github.com/rxliuli/version-check#important-setup'
      )
      return null
    }

    // Check if file was changed in the last commit
    const changedFiles = execSync('git diff --name-only HEAD~1..HEAD', {
      encoding: 'utf-8',
    }).trim()

    if (!changedFiles.split('\n').some(f => f === normalizedPath || f === filePath)) {
      core.info(`File ${filePath} was not changed in the last commit`)
      return null
    }

    // Get file content from previous commit
    const previousContent = execSync(`git show HEAD~1:${normalizedPath}`, {
      encoding: 'utf-8',
    })

    return previousContent
  } catch (error) {
    // File might not exist in previous commit
    core.debug(`Could not get previous file content: ${error}`)
    return null
  }
}