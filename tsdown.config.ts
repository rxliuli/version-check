import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: false,
  clean: true,
  fixedExtension: false,
  deps: {
    alwaysBundle: (id) => !isBuiltin(id),
    onlyBundle: false,
  },
})
