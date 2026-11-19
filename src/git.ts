import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import * as path from 'path'
import * as core from '@actions/core'

export interface ResolveBaseRefOptions {
  base?: string
  eventName?: string
  eventPath?: string
}

export interface GetPreviousFileContentOptions extends ResolveBaseRefOptions {
  cwd?: string
}

function isNonZeroSha(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/^0+$/.test(value.trim())
}

export function resolveBaseRef(options?: ResolveBaseRefOptions): { ref: string; source: string } {
  const explicitBase = options?.base?.trim()
  if (explicitBase) {
    return { ref: explicitBase, source: 'input' }
  }

  const eventPath = options?.eventPath ?? process.env.GITHUB_EVENT_PATH
  const eventName = options?.eventName ?? process.env.GITHUB_EVENT_NAME

  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf-8')) as {
        before?: unknown
        pull_request?: { base?: { sha?: unknown } }
      }
      if ((eventName === 'push' || (!eventName && !event.pull_request)) && isNonZeroSha(event.before)) {
        return { ref: event.before.trim(), source: 'push event before' }
      }
      if (
        (eventName === 'pull_request' || eventName === 'pull_request_target' || !eventName) &&
        isNonZeroSha(event.pull_request?.base?.sha)
      ) {
        return { ref: event.pull_request.base.sha.trim(), source: 'pull_request base' }
      }
    } catch (error) {
      core.debug(`Could not read GitHub event payload from ${eventPath}: ${error}`)
    }
  }

  return { ref: 'HEAD~1', source: 'HEAD~1' }
}

function hasCommit(ref: string, cwd?: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export async function getPreviousFileContent(
  filePath: string,
  options?: GetPreviousFileContentOptions,
): Promise<string | null> {
  try {
    const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\.\//, '')
    const { ref: baseRef, source } = resolveBaseRef(options)
    const cwd = options?.cwd

    core.info(`Comparing against base ref: ${baseRef} (${source})`)

    if (!hasCommit(baseRef, cwd)) {
      if (baseRef === 'HEAD~1') {
        core.warning(
          'Cannot access previous commit (HEAD~1). ' +
            'Make sure to use "fetch-depth: 2" or higher with actions/checkout. ' +
            'See: https://github.com/rxliuli/version-check#important-setup',
        )
        return null
      }

      core.info(`Base commit ${baseRef} not found locally; fetching it from origin...`)
      try {
        execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseRef], { cwd, stdio: 'pipe' })
      } catch (error) {
        core.debug(`Could not fetch base commit ${baseRef} from origin: ${error}`)
      }

      if (!hasCommit(baseRef, cwd)) {
        core.warning(
          `Cannot access base commit (${baseRef}). ` +
            'Make sure to use "fetch-depth: 0" with actions/checkout or ensure the base commit is reachable on origin.',
        )
        return null
      }
    }

    const changedFiles = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', baseRef, 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (
      !changedFiles ||
      !changedFiles.split(/\r?\n/).some((f) => f === normalizedPath || f === filePath)
    ) {
      core.info(`File ${filePath} was not changed since ${baseRef}`)
      return null
    }

    const previousContent = execFileSync('git', ['show', `${baseRef}:${normalizedPath}`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return previousContent
  } catch (error) {
    // File might not exist in base commit (e.g. newly added)
    core.debug(`Could not get previous file content: ${error}`)
    return null
  }
}
