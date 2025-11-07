# Universal Version Check

A universal GitHub Action to check version changes in any file format (JSON, YAML, TOML, etc.)

## Features

✅ **Multi-format support**: JSON, YAML, TOML  
✅ **Flexible query paths**: Use dot notation to access nested version fields  
✅ **Semantic versioning**: Automatic detection of version change types (major/minor/patch)  
✅ **Zero configuration**: Works out of the box on all GitHub-hosted runners  
✅ **TypeScript powered**: Type-safe and well-tested

## Usage

### Basic Example

```yaml
- uses: rxliuli/universal-version-check@v1
  id: version
  with:
    file-name: ./package.json#version
    diff-search: true

- name: Create Release
  if: steps.version.outputs.changed == 'true'
  run: |
    echo "Version changed to ${{ steps.version.outputs.version }}"
```

### Examples for Different File Formats

#### package.json (JavaScript/TypeScript)
```yaml
- uses: rxliuli/universal-version-check@v1
  with:
    file-name: ./package.json#version
    diff-search: true
```

#### config.yml (YAML)
```yaml
- uses: rxliuli/universal-version-check@v1
  with:
    file-name: ./build/config.yml#info.version
    diff-search: true
```

#### Cargo.toml (Rust)
```yaml
- uses: rxliuli/universal-version-check@v1
  with:
    file-name: ./Cargo.toml#package.version
    diff-search: true
```

#### pyproject.toml (Python)
```yaml
- uses: rxliuli/universal-version-check@v1
  with:
    file-name: ./pyproject.toml#project.version
    diff-search: true
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `file-name` | File path with optional query (e.g., `config.yml#info.version`) | Yes | - |
| `diff-search` | Compare with previous commit to detect changes | No | `false` |

## Outputs

| Output | Description |
|--------|-------------|
| `changed` | Whether the version changed (`true`/`false`) |
| `version` | Current version number |
| `previous_version` | Previous version number (only if `diff-search` is `true`) |
| `type` | Type of version change (`major`/`minor`/`patch`/`prerelease`) |

## Complete Workflow Example

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
          fetch-depth: 2  # Need previous commit for comparison

      - name: Check version
        id: version
        uses: rxliuli/universal-version-check@v1
        with:
          file-name: ./package.json#version
          diff-search: true

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

## How It Works

1. **Parse file format**: Automatically detects JSON, YAML, or TOML based on file extension
2. **Extract version**: Uses dot notation to navigate nested objects (e.g., `info.version`)
3. **Compare with previous**: If `diff-search` is enabled, compares with the previous Git commit
4. **Determine change type**: Uses semantic versioning rules to classify the change

## Supported File Formats

| Format | Extensions | Example Query |
|--------|-----------|---------------|
| JSON | `.json` | `version` or `info.version` |
| YAML | `.yml`, `.yaml` | `info.version` |
| TOML | `.toml` | `package.version` |

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
