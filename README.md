# Version Check

A GitHub Action to check version changes in any file format (JSON, YAML, TOML, etc.)

## Features

- **Multi-format support**: JSON, YAML, TOML
- **Automatic version comparison**: Detects changes by comparing with the previous commit
- **Flexible query paths**: Use dot notation to access nested version fields
- **Semantic versioning**: Automatic detection of version change types (major/minor/patch)
- **Zero configuration**: Works out of the box on all GitHub-hosted runners
- **TypeScript powered**: Type-safe and well-tested

## Usage

### Basic Example

```yaml
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
- uses: rxliuli/version-check@v1
  with:
    file: ./package.json
```

#### config.yml (YAML)

```yaml
- uses: rxliuli/version-check@v1
  with:
    file: ./build/config.yml
    query: info.version
```

#### Cargo.toml (Rust)

```yaml
- uses: rxliuli/version-check@v1
  with:
    file: ./Cargo.toml
    query: package.version
```

#### pyproject.toml (Python)

```yaml
- uses: rxliuli/version-check@v1
  with:
    file: ./pyproject.toml
    query: project.version
```

## Inputs

| Input   | Description                                                                 | Required | Default   |
| ------- | --------------------------------------------------------------------------- | -------- | --------- |
| `file`  | Path to the file to check (e.g., `./package.json`, `./Cargo.toml`)          | Yes      | -         |
| `query` | Dot-notation path to the version field (e.g., `version`, `package.version`) | No       | `version` |

## Outputs

| Output             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `changed`          | Whether the version changed (`true`/`false`)                  |
| `version`          | Current version number                                        |
| `previous_version` | Previous version number                                       |
| `type`             | Type of version change (`major`/`minor`/`patch`/`prerelease`) |

## Workflow Examples

### Simple Single-Job Workflow

```yaml
name: Release on Version Change

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Check version
        id: version
        uses: rxliuli/version-check@v1
        with:
          file: ./package.json

      - name: Build
        if: steps.version.outputs.changed == 'true'
        run: |
          npm install
          npm run build

      - name: Create Release
        if: steps.version.outputs.changed == 'true'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.version.outputs.version }}
          name: Release v${{ steps.version.outputs.version }}
          files: |
            dist/*
```

### Multi-Job Workflow (Chrome Extension Release)

For complex workflows with multiple steps, using separate jobs with `needs` is cleaner than repeating `if` conditions:

```yaml
name: Release Chrome Extension

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
          file: ./package.json

  release:
    needs: version
    if: needs.version.outputs.changed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 'latest'
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install
      - name: Build extension
        run: pnpm run build
      - name: Package extension
        run: |
          pnpm run zip
          pnpm run zip:firefox

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ needs.version.outputs.version }}
          name: v${{ needs.version.outputs.version }}
          files: |
            dist/extension-${{ needs.version.outputs.version }}-chrome.zip
            dist/extension-${{ needs.version.outputs.version }}-firefox.zip

      - name: Publish to Chrome Web Store
        uses: mnao305/chrome-extension-upload@v5
        with:
          file-path: dist/extension-${{ needs.version.outputs.version }}-chrome.zip
          extension-id: ${{ secrets.CHROME_EXTENSION_ID }}
          client-id: ${{ secrets.CHROME_CLIENT_ID }}
          client-secret: ${{ secrets.CHROME_CLIENT_SECRET }}
          refresh-token: ${{ secrets.CHROME_REFRESH_TOKEN }}
```

## How It Works

1. **Parse file format**: Automatically detects JSON, YAML, or TOML based on file extension
2. **Extract version**: Uses dot notation to navigate nested objects (e.g., `info.version`)
3. **Compare with previous**: Automatically compares with the previous Git commit
4. **Determine change type**: Uses semantic versioning rules to classify the change

## Supported File Formats

| Format | Extensions      | Example Query               |
| ------ | --------------- | --------------------------- |
| JSON   | `.json`         | `version` or `info.version` |
| YAML   | `.yml`, `.yaml` | `info.version`              |
| TOML   | `.toml`         | `package.version`           |

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
