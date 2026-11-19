import * as core from '@actions/core'
import { detectFormat, extractVersion, parseFile, resolveVersion, type ResolvedVersion } from './parsers'
import { getPreviousFileContent } from './git'
import { compareVersions, determineVersionChangeType } from './version'

function reportAlternatives(filePath: string, resolved: ResolvedVersion): void {
  if (resolved.alternatives.length === 0) return
  const others = resolved.alternatives.map((item) => `${item.version} (${item.path})`).join(', ')
  core.warning(`Other versions found in ${filePath}, make sure they are intended to differ: ${others}`)
}

async function run(): Promise<void> {
  try {
    const filePath = core.getInput('file', { required: true })
    const query = core.getInput('query').trim()
    const format = detectFormat(filePath, core.getInput('format'))
    const base = core.getInput('base').trim()

    core.info(`Checking version in file: ${filePath}`)
    core.info(`Format: ${format}`)
    if (query) core.info(`Query path: ${query}`)

    // Get current version
    const current = await extractVersion(filePath, { query, format })
    core.setOutput('version', current.version)
    core.setOutput('path', current.path)
    core.info(`Current version: ${current.version} (from ${current.path})`)
    reportAlternatives(filePath, current)

    try {
      // Get previous file content
      const previousContent = await getPreviousFileContent(filePath, { base: base || undefined })

      if (!previousContent) {
        // No previous version found - cannot determine if changed
        core.setOutput('changed', 'false')
        core.info('No previous version found - cannot determine version change')
        return
      }

      // Parse previous version with the same query so both sides stay comparable
      const previous = resolveVersion(parseFile(previousContent, format), { query, format })
      core.setOutput('previous_version', previous.version)
      core.info(`Previous version: ${previous.version} (from ${previous.path})`)

      if (previous.version === current.version) {
        core.setOutput('changed', 'false')
        core.info('Version unchanged')
        return
      }

      if (compareVersions(current.version, previous.version) < 0) {
        core.setOutput('changed', 'false')
        core.setOutput('type', 'downgrade')
        core.warning(
          `Version downgraded (${previous.version} → ${current.version}) in ${filePath}: skipping release. Rollbacks must be handled manually on each publishing platform.`,
        )
        if (process.env.GITHUB_STEP_SUMMARY) {
          await core.summary
            .addHeading('Version Downgrade Detected', 3)
            .addRaw(
              `Skipped release for \`${filePath}\`: version downgraded from \`${previous.version}\` to \`${current.version}\`. ` +
                `Platform rollbacks (e.g. Chrome Web Store, App Store Connect, npm) must be handled manually.`,
              true,
            )
            .write()
        }
        return
      }

      core.setOutput('changed', 'true')
      const changeType = determineVersionChangeType(previous.version, current.version)
      core.setOutput('type', changeType)
      core.info(`Version changed: ${previous.version} → ${current.version} (${changeType})`)

      if (previous.path !== current.path) {
        core.warning(
          `The version was read from a different place than in the previous commit ` +
            `(${previous.path} → ${current.path}), make sure that is intended`,
        )
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

run()
