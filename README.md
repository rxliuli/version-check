# Version Check

A GitHub Action to check version changes in any file format (JSON, YAML, TOML, plist, XcodeGen `project.yml`)

## Features

- **Multi-format support**: JSON, YAML, TOML, plist and XcodeGen `project.yml`
- **Apple project aware**: Finds `MARKETING_VERSION` in an XcodeGen spec (project or target level,
  following `$(SETTING)` references) without hand-writing the dot path
- **Version-preserving parsing**: `MARKETING_VERSION: 1.0` is read as `1.0`, not the YAML number `1`
- **Automatic version comparison**: Detects changes by comparing with the previous commit
- **Flexible query paths**: Use dot notation to access nested version fields, `*` matches any key
- **Semantic versioning**: Automatic detection of version change types (major/minor/patch)
- **Zero configuration**: Works out of the box on all GitHub-hosted runners
- **TypeScript powered**: Type-safe and well-tested

## Usage

### Basic Example

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2 # Required to access previous commit

- uses: rxliuli/version-check@v1
  id: version
  with:
    file: ./package.json

- name: Create Release
  if: steps.version.outputs.changed == 'true'
  run: |
    echo "Version changed to ${{ steps.version.outputs.version }}"
```

### Examples for Different File Formats

#### package.json (JavaScript/TypeScript)

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2
- uses: rxliuli/version-check@v1
  with:
    file: ./package.json
```

#### config.yml (YAML)

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2
- uses: rxliuli/version-check@v1
  with:
    file: ./build/config.yml
    query: info.version
```

#### Cargo.toml (Rust)

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2
- uses: rxliuli/version-check@v1
  with:
    file: ./Cargo.toml
    query: package.version
```

#### pyproject.toml (Python)

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2
- uses: rxliuli/version-check@v1
  with:
    file: ./pyproject.toml
    query: project.version
```

#### project.yml (XcodeGen, Swift / Objective-C)

`project.yml` is recognised by its file name, and `MARKETING_VERSION` is located automatically, so
no `query` is needed:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2
- uses: rxliuli/version-check@v1
  id: version
  with:
    file: ./project.yml

- name: Tag the release
  if: steps.version.outputs.changed == 'true'
  run: git tag "v${{ steps.version.outputs.version }}"
```

The setting may live at the project level or per target, and `$(SETTING)` references are followed:

```yaml
settings:
  base:
    MARKETING_VERSION: "0.6.0" # <-- used by default

targets:
  MyApp:
    type: application
    settings:
      base:
        MARKETING_VERSION: "0.6.0" # <-- wins over the project level one
  MyAppTests:
    type: bundle.unit-test
    info:
      properties:
        CFBundleShortVersionString: "$(MARKETING_VERSION)" # <-- resolved through the reference
```

When several targets declare different versions, the application target wins and a warning is logged
with the other values. A different location can always be pinned explicitly:

```yaml
- uses: rxliuli/version-check@v1
  with:
    file: ./project.yml
    query: targets.MyApp.settings.base.MARKETING_VERSION
```

## Important Setup

**⚠️ Required: You must use `fetch-depth: 2` (or higher) with `actions/checkout`**

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 2 # Required to access previous commit for comparison
```

Without this, the action cannot access the previous commit and will always report `changed: true` with no previous version.

## Inputs

| Input    | Description                                                                                                                                                        | Required | Default |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- |
| `file`   | Path to the file to check (e.g., `./package.json`, `./Cargo.toml`, `./project.yml`)                                                                                | Yes      | -       |
| `query`  | Dot-notation path to the version field (e.g., `version`, `package.version`, `settings.base.MARKETING_VERSION`). `*` matches any key. Empty uses the format default | No       | -       |
| `format` | File format: `auto`, `json`, `yaml`, `toml`, `plist` or `xcodegen`. `auto` detects it from the file name (`project.yml`/`project.yaml` means `xcodegen`)           | No       | `auto`  |

With an empty `query`, the action looks for `version` in JSON/YAML/TOML/plist files and for the
`MARKETING_VERSION` build setting in XcodeGen specs (`CFBundleShortVersionString` is used as a
fallback, which also makes a bare `Info.plist` work).

## Outputs

| Output             | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `changed`          | Whether the version changed (`true`/`false`)                              |
| `version`          | Current version number                                                    |
| `previous_version` | Previous version number                                                   |
| `type`             | Type of version change (`major`/`minor`/`patch`/`prerelease`)             |
| `path`             | Where the version was read from (e.g., `settings.base.MARKETING_VERSION`) |

## Workflow Examples

### Release Browser Extension

For complex workflows with multiple steps, using separate jobs with `needs` is cleaner than repeating `if` conditions:

```yaml
env:
  DIRECTORY: .
  PROJECT_NAME: redirector

name: Release

on:
  push:
    branches: [main]
    paths:
      - 'package.json'

jobs:
  version:
    runs-on: ubuntu-latest
    outputs:
      changed: ${{ steps.version.outputs.changed }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - name: Check version change
        id: version
        uses: rxliuli/version-check@v1
        with:
          file: ${{ env.DIRECTORY }}/package.json

  release:
    permissions:
      contents: write
    needs: version
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 'latest'
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install
      - name: Zip extensions
        run: |
          cd ${{ env.DIRECTORY }}
          pnpm zip
          pnpm zip:firefox

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: 'v${{ needs.version.outputs.version }}'
          name: 'v${{ needs.version.outputs.version }}'
          draft: false
          prerelease: false
          files: |
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-chrome.zip
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-firefox.zip
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-sources.zip
```

### Release Browser Extension on Monorepo

```yaml
env:
  DIRECTORY: packages/plugin
  PROJECT_NAME: mass-block-twitter

name: Release

on:
  push:
    branches: [main]
    paths:
      - 'packages/plugin/package.json'

jobs:
  version:
    runs-on: ubuntu-latest
    outputs:
      changed: ${{ steps.version.outputs.changed }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - name: Check version change
        id: version
        uses: rxliuli/version-check@v1
        with:
          file: ${{ env.DIRECTORY }}/package.json

  release:
    permissions:
      contents: write
    needs: version
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 'latest'
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install && pnpm init-all
      - name: Zip extensions
        run: |
          cd ${{ env.DIRECTORY }}
          pnpm zip
          pnpm zip:firefox

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: 'v${{ needs.version.outputs.version }}'
          name: 'v${{ needs.version.outputs.version }}'
          draft: false
          prerelease: false
          files: |
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-chrome.zip
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-firefox.zip
            ${{ env.DIRECTORY }}/.output/${{ env.PROJECT_NAME }}-${{ needs.version.outputs.version }}-sources.zip
```

## How It Works

1. **Parse file format**: Automatically detects JSON, YAML, TOML, plist or an XcodeGen spec based on
   the file name. YAML plain scalars keep their source text, so `1.0` is not reduced to `1`
2. **Extract version**: Uses dot notation to navigate nested objects (e.g., `info.version`), or locates
   `MARKETING_VERSION` in an Apple project (following `$(SETTING)` references)
3. **Compare with previous**: Automatically compares with the previous Git commit
4. **Determine change type**: Uses semantic versioning rules to classify the change

## Supported File Formats

| Format   | Extensions / file name        | Example Query                               |
| -------- | ----------------------------- | ------------------------------------------- |
| JSON     | `.json`                       | `version` or `info.version`                 |
| YAML     | `.yml`, `.yaml`               | `info.version`                              |
| TOML     | `.toml`                       | `package.version`                           |
| plist    | `.plist`                      | `CFBundleShortVersionString`                |
| XcodeGen | `project.yml`, `project.yaml` | `targets.*.settings.base.MARKETING_VERSION` |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Test locally
pnpm dev
```

## License

MIT © rxliuli
