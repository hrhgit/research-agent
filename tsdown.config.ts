import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/dsh/plugin.ts', agent: 'src/dsh/agent.ts', core: 'src/index.ts' },
    outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024',
    fixedExtension: false, dts: true, clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/dsh/client/index.tsx' },
    outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
    dts: false, clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-research-agent", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
