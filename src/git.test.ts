import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { getPreviousFileContent, resolveBaseRef } from './git'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function parseOutputs(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf-8')
  const result: Record<string, string> = {}
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx !== -1) {
      result[line.slice(0, eqIdx)] = line.slice(eqIdx + 1)
      continue
    }
    const delimIdx = line.indexOf('<<')
    if (delimIdx !== -1) {
      const key = line.slice(0, delimIdx)
      const delim = line.slice(delimIdx + 2)
      const valueLines: string[] = []
      while (i + 1 < lines.length && lines[i + 1] !== delim) {
        valueLines.push(lines[++i])
      }
      i++
      result[key] = valueLines.join('\n')
    }
  }
  return result
}

function createOriginRepo(): string {
  const origin = makeTempDir('vc-origin-')
  git(origin, 'init', '-b', 'main')
  git(origin, 'config', 'user.name', 'Test User')
  git(origin, 'config', 'user.email', 'test@example.com')
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  return origin
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveBaseRef', () => {
  it('prefers an explicit base input', () => {
    const dir = makeTempDir('vc-event-')
    const eventPath = path.join(dir, 'event.json')
    writeJson(eventPath, { before: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

    expect(resolveBaseRef({ base: 'v1.0.0', eventName: 'push', eventPath })).toEqual({
      ref: 'v1.0.0',
      source: 'input',
    })
  })

  it('uses github.event.before for push events with non-zero SHA', () => {
    const dir = makeTempDir('vc-event-')
    const eventPath = path.join(dir, 'event.json')
    const beforeSha = '1111111111111111111111111111111111111111'
    writeJson(eventPath, { before: beforeSha })

    expect(resolveBaseRef({ eventName: 'push', eventPath })).toEqual({
      ref: beforeSha,
      source: 'push event before',
    })
  })

  it('falls back to HEAD~1 on push with all-zero before SHA (new branch)', () => {
    const dir = makeTempDir('vc-event-')
    const eventPath = path.join(dir, 'event.json')
    writeJson(eventPath, { before: '0000000000000000000000000000000000000000' })

    expect(resolveBaseRef({ eventName: 'push', eventPath })).toEqual({
      ref: 'HEAD~1',
      source: 'HEAD~1',
    })
  })

  it('uses pull_request.base.sha on pull_request events', () => {
    const dir = makeTempDir('vc-event-')
    const eventPath = path.join(dir, 'event.json')
    const baseSha = '2222222222222222222222222222222222222222'
    writeJson(eventPath, { pull_request: { base: { sha: baseSha } } })

    expect(resolveBaseRef({ eventName: 'pull_request', eventPath })).toEqual({
      ref: baseSha,
      source: 'pull_request base',
    })
  })

  it('falls back to HEAD~1 on workflow_dispatch or missing/invalid event file', () => {
    const dir = makeTempDir('vc-event-')
    const invalidPath = path.join(dir, 'bad.json')
    writeFileSync(invalidPath, '{not-json', 'utf-8')

    expect(resolveBaseRef({ eventName: 'workflow_dispatch', eventPath: invalidPath })).toEqual({
      ref: 'HEAD~1',
      source: 'HEAD~1',
    })
    expect(resolveBaseRef({ eventName: 'push', eventPath: path.join(dir, 'missing.json') })).toEqual({
      ref: 'HEAD~1',
      source: 'HEAD~1',
    })
  })
})

describe('getPreviousFileContent with shallow clones', () => {
  it('auto-fetches before commit and detects bumps across multiple modules in one push', async () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'packages/pkg-a/package.json'), { name: 'pkg-a', version: '0.0.1' })
    writeJson(path.join(origin, 'packages/pkg-b/package.json'), { name: 'pkg-b', version: '0.0.10' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'initial')
    const beforeSha = git(origin, 'rev-parse', 'HEAD')

    writeJson(path.join(origin, 'packages/pkg-a/package.json'), { name: 'pkg-a', version: '0.0.2' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump pkg-a')

    writeJson(path.join(origin, 'packages/pkg-b/package.json'), { name: 'pkg-b', version: '0.0.11' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump pkg-b')

    writeFileSync(path.join(origin, 'README.md'), '# hello\n', 'utf-8')
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'docs follow-up')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    // Confirm beforeSha is initially outside depth=2
    expect(() => git(clone, 'cat-file', '-e', `${beforeSha}^{commit}`)).toThrow()

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: beforeSha })

    const prevA = await getPreviousFileContent('./packages/pkg-a/package.json', {
      cwd: clone,
      eventName: 'push',
      eventPath,
    })
    const prevB = await getPreviousFileContent('./packages/pkg-b/package.json', {
      cwd: clone,
      eventName: 'push',
      eventPath,
    })

    expect(JSON.parse(prevA!).version).toBe('0.0.1')
    expect(JSON.parse(prevB!).version).toBe('0.0.10')
  })

  it('returns the pre-push base version when the same module is bumped twice in one push', async () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'initial')
    const beforeSha = git(origin, 'rev-parse', 'HEAD')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.5' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump 0.0.5')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.6' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump 0.0.6')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: beforeSha })

    const prev = await getPreviousFileContent('./package.json', {
      cwd: clone,
      eventName: 'push',
      eventPath,
    })
    expect(JSON.parse(prev!).version).toBe('0.0.4')
  })

  it('returns null when a module is bumped then reverted back in the same push', async () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'initial')
    const beforeSha = git(origin, 'rev-parse', 'HEAD')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.5' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump 0.0.5')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'revert 0.0.4')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: beforeSha })

    const prev = await getPreviousFileContent('./package.json', {
      cwd: clone,
      eventName: 'push',
      eventPath,
    })
    expect(prev).toBeNull()
  })
})

describe('dist/index.js end-to-end execution', () => {
  const distIndexJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

  function runAction(
    cwd: string,
    envExtra: Record<string, string>,
  ): { stdout: string; outputs: Record<string, string>; summary: string } {
    const outDir = makeTempDir('vc-out-')
    const outputFile = path.join(outDir, 'github_output.txt')
    const summaryFile = path.join(outDir, 'github_summary.md')
    writeFileSync(outputFile, '', 'utf-8')
    writeFileSync(summaryFile, '', 'utf-8')

    const stdout = execFileSync('node', [distIndexJs], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...envExtra,
      },
    })

    return {
      stdout,
      outputs: parseOutputs(outputFile),
      summary: readFileSync(summaryFile, 'utf-8'),
    }
  }

  it('reports minor upgrade across multiple commits in a --depth=2 clone', () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'initial')
    const beforeSha = git(origin, 'rev-parse', 'HEAD')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.1.0' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump 0.1.0')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.1.1' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'bump 0.1.1')

    writeFileSync(path.join(origin, 'notes.txt'), 'non-version change\n', 'utf-8')
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'chore: notes')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: beforeSha })

    const { outputs, summary } = runAction(clone, {
      INPUT_FILE: './package.json',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(outputs).toMatchObject({
      changed: 'true',
      previous_version: '0.0.4',
      version: '0.1.1',
      type: 'minor',
    })
    expect(summary).toBe('')
  })

  it('ignores a version downgrade, outputs type=downgrade, warns, and writes Job Summary', () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.5' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'v0.0.5')
    const beforeSha = git(origin, 'rev-parse', 'HEAD')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'revert to 0.0.4')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: beforeSha })

    const { stdout, outputs, summary } = runAction(clone, {
      INPUT_FILE: './package.json',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(outputs).toMatchObject({
      changed: 'false',
      previous_version: '0.0.5',
      version: '0.0.4',
      type: 'downgrade',
    })
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain('Version downgraded (0.0.5 → 0.0.4)')
    expect(summary).toContain('Version Downgrade Detected')
    expect(summary).toContain('0.0.5')
    expect(summary).toContain('0.0.4')
  })

  it('warns and sets changed=false without falling back to HEAD~1 when base SHA is unreachable', () => {
    const origin = createOriginRepo()
    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.4' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'v0.0.4')

    writeJson(path.join(origin, 'package.json'), { name: 'demo', version: '0.0.5' })
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'v0.0.5')

    const cloneParent = makeTempDir('vc-clone-')
    const clone = path.join(cloneParent, 'repo')
    git(cloneParent, 'clone', '--depth=2', `file://${origin}`, 'repo')

    const eventPath = path.join(cloneParent, 'event.json')
    writeJson(eventPath, { before: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })

    const { stdout, outputs } = runAction(clone, {
      INPUT_FILE: './package.json',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
    })

    expect(outputs.changed).toBe('false')
    expect(outputs.previous_version).toBeUndefined()
    expect(stdout).toContain('::warning::Cannot access base commit (deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)')
  })
})
