import { execSync } from 'child_process'
import * as core from '@actions/core'

export async function getPreviousFileContent(filePath: string): Promise<string | null> {
  try {
    // Check if file was changed in the last commit
    const changedFiles = execSync('git diff --name-only HEAD~1..HEAD', {
      encoding: 'utf-8',
    }).trim()

    if (!changedFiles.includes(filePath)) {
      core.info(`File ${filePath} was not changed in the last commit`)
      return null
    }

    // Get file content from previous commit
    const previousContent = execSync(`git show HEAD~1:${filePath}`, {
      encoding: 'utf-8',
    })

    return previousContent
  } catch (error) {
    // File might not exist in previous commit
    core.debug(`Could not get previous file content: ${error}`)
    return null
  }
}