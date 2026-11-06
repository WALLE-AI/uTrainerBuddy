import { readFileSync } from 'fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import UnoCSS from 'unocss/vite';
import unoConfig from './uno.config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

const rendererRoot = resolve(__dirname, 'src/renderer');

// Icon Park transform plugin — ported verbatim from packages/desktop/electron.vite.config.ts.
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
    root: rendererRoot,
    base: './',
    publicDir: resolve(__dirname, 'public'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@renderer': rendererRoot,
        // Force ESM version of streamdown
        streamdown: resolve(__dirname, 'node_modules/streamdown/dist/index.js'),
      },
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.css'],
      // See electron.vite.config.ts comment: dedupe CodeMirror singleton packages
      // to avoid duplicate module-level state breaking markdown source highlighting.
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
    plugins: [react(), UnoCSS(unoConfig), iconParkPlugin()],
    build: {
      target: 'es2022',
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      sourcemap: isDevelopment,
      minify: !isDevelopment,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 1500,
      cssCodeSplit: true,
      rollupOptions: {
        external: ['node:crypto', 'crypto'],
        onwarn(warning, warn) {
          if (warning.code === 'EVAL') return;
          warn(warning);
        },
        output: {
          // Keep React and every vendor tightly coupled to it in ONE chunk — see
          // electron.vite.config.ts for the full rationale (avoids a chunk cycle
          // that left React's exports uninitialized at vendor-arco eval time).
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
      'process.env.AIONUI_MULTI_INSTANCE': JSON.stringify(''),
      __APP_VERSION__: JSON.stringify(pkg.version),
      __IS_DISCONTINUED_BUILD__: JSON.stringify(false),
      global: 'globalThis',
    },
    server: {
      port: 5173,
    },
    optimizeDeps: {
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
  };
});
