import { readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import UnoCSS from 'unocss/vite';
import unoConfig from './uno.config';

// This config is additive to vite.config.ts (the plain no-Electron web build,
// left untouched) — it adds the Electron main/preload/renderer build on top,
// ported from AionUi/packages/desktop/electron.vite.config.ts with the
// aioncore-specific bits (Sentry sourcemaps, MCP server esbuild step,
// @aionui/web-host externalization) removed.

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

const srcRoot = resolve(__dirname, 'src');
const rendererRoot = resolve(__dirname, 'src/renderer');

const sharedAliases = {
  '@': srcRoot,
  '@common': resolve(__dirname, 'src/common'),
};

// Icon Park transform plugin — same as vite.config.ts / AionUi's electron.vite.config.ts.
function iconParkPlugin() {
  return {
    name: 'vite-plugin-icon-park',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (!id.endsWith('.tsx') || id.includes('node_modules')) return null;
      if (!source.includes('@icon-park/react')) return null;
      const transformedSource = source.replace(
        /import\s+\{\s+([a-zA-Z, ]*)\s+\}\s+from\s+['"]@icon-park\/react['"](;?)/g,
        function (str, match) {
          if (!match) return str;
          const components = match.split(',');
          const importComponent = str.replace(
            match,
            components.map((key: string) => `${key} as _${key.trim()}`).join(', ')
          );
          const hoc = `import IconParkHOC from '@renderer/components/IconParkHOC';
          ${components.map((key: string) => `const ${key.trim()} = IconParkHOC(_${key.trim()})`).join(';\n')}`;
          return importComponent + ';' + hoc;
        }
      );
      if (transformedSource !== source) return { code: transformedSource, map: null } as { code: string; map: null };
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDevelopment = mode === 'development';

  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: ['fix-path'] })],
      resolve: {
        alias: { ...sharedAliases, '@process': resolve(__dirname, 'src/process'), '@renderer': rendererRoot },
        extensions: ['.ts', '.tsx', '.js', '.json'],
      },
      build: {
        sourcemap: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: { index: resolve(srcRoot, 'index.ts') },
          // Force CJS + .cjs extension regardless of this package's own
          // "type": "module" (needed for the plain Vite/renderer build).
          // Node picks module format from file extension first, ahead of
          // the nearest package.json "type" field — without this, main.js
          // gets loaded as ESM, and CJS deps like electron-updater that do
          // extensionless internal requires (e.g. `require('./providers/Provider')`)
          // fail Node's stricter ESM resolver ("Cannot find module ... Did
          // you mean to import '....js'").
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            chunkFileNames: 'chunks/[name]-[hash].cjs',
          },
          onwarn(warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
          },
        },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
      },
    },

    preload: {
      plugins: [externalizeDepsPlugin({})],
      resolve: {
        alias: sharedAliases,
        extensions: ['.ts', '.tsx', '.js', '.json'],
      },
      build: {
        sourcemap: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: {
            main: resolve(srcRoot, 'preload/main.ts'),
            petPreload: resolve(srcRoot, 'preload/petPreload.ts'),
            petHitPreload: resolve(srcRoot, 'preload/petHitPreload.ts'),
            petConfirmPreload: resolve(srcRoot, 'preload/petConfirmPreload.ts'),
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            chunkFileNames: 'chunks/[name]-[hash].cjs',
          },
        },
      },
    },

    renderer: {
      root: rendererRoot,
      base: './',
      publicDir: resolve(__dirname, 'public'),
      appType: 'mpa',
      server: {
        port: 5174,
        hmr: { host: 'localhost' },
        // Electron's navigation request for the initial document can hang forever
        // ("Pending" in DevTools Network) when Vite answers with a 304 Not Modified
        // for the main-frame request — the renderer never gets a body/completion
        // event, so the page stays blank and webContents eventually fires
        // 'unresponsive'. Forcing no-store sidesteps conditional-GET/304 entirely.
        headers: { 'Cache-Control': 'no-store' },
      },
      resolve: {
        alias: {
          ...sharedAliases,
          '@renderer': rendererRoot,
          '@process': resolve(__dirname, 'src/process'),
          streamdown: resolve(__dirname, 'node_modules/streamdown/dist/index.js'),
        },
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.css'],
        dedupe: [
          'react',
          'react-dom',
          'react-router-dom',
          '@codemirror/state',
          '@codemirror/view',
          '@codemirror/language',
          '@lezer/highlight',
        ],
      },
      plugins: [UnoCSS(unoConfig), iconParkPlugin()],
      build: {
        target: 'es2022',
        sourcemap: isDevelopment,
        minify: !isDevelopment,
        reportCompressedSize: false,
        chunkSizeWarningLimit: 1500,
        cssCodeSplit: true,
        rollupOptions: {
          input: {
            index: resolve(rendererRoot, 'index.html'),
            pet: resolve(rendererRoot, 'pet/pet.html'),
            'pet-hit': resolve(rendererRoot, 'pet/pet-hit.html'),
            'pet-confirm': resolve(rendererRoot, 'pet/pet-confirm.html'),
          },
          external: ['node:crypto', 'crypto'],
          onwarn(warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
          },
          output: {
            manualChunks(id: string) {
              if (!id.includes('node_modules')) return undefined;
              if (
                id.includes('/react-dom/') ||
                id.includes('/react/') ||
                id.includes('/@arco-design/') ||
                id.includes('/react-markdown/') ||
                id.includes('/remark-') ||
                id.includes('/rehype-') ||
                id.includes('/unified/') ||
                id.includes('/mdast-') ||
                id.includes('/hast-') ||
                id.includes('/micromark') ||
                id.includes('/react-syntax-highlighter/') ||
                id.includes('/refractor/') ||
                id.includes('/highlight.js/') ||
                id.includes('/monaco-editor/') ||
                id.includes('/@monaco-editor/') ||
                id.includes('/codemirror/') ||
                id.includes('/@codemirror/') ||
                id.includes('/katex/') ||
                id.includes('/wavedrom/')
              )
                return 'vendor';
              if (id.includes('/@icon-park/')) return 'vendor-icons';
              if (id.includes('/diff2html/')) return 'vendor-diff';
              return undefined;
            },
          },
        },
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        'process.env.AIONUI_MULTI_INSTANCE': JSON.stringify(process.env.AIONUI_MULTI_INSTANCE ?? ''),
        __APP_VERSION__: JSON.stringify(pkg.version),
        __IS_DISCONTINUED_BUILD__: JSON.stringify(false),
        global: 'globalThis',
      },
      optimizeDeps: {
        exclude: ['electron'],
        include: [
          'react',
          'react-dom',
          'react-router-dom',
          'react-i18next',
          'i18next',
          '@arco-design/web-react',
          '@icon-park/react',
          'react-markdown',
          'react-syntax-highlighter',
          'react-virtuoso',
          'classnames',
          'swr',
          'eventemitter3',
          'katex',
          'diff2html',
          'remark-gfm',
          'remark-math',
          'remark-breaks',
          'rehype-raw',
          'rehype-katex',
          'wavedrom',
          '@uiw/react-codemirror',
          '@codemirror/lang-markdown',
          '@codemirror/language',
        ],
      },
    },
  };
});
