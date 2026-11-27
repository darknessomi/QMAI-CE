import path from "path"
import { readFileSync } from "fs"
import { configDefaults, defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { sentryVitePlugin } from "@sentry/vite-plugin"

const host = process.env.TAURI_DEV_HOST

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf-8"))
const sentryRelease = `qmai@${pkgJson.version}`
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const uploadSentrySourcemaps = Boolean(sentryAuthToken)

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Last plugin. No token → no maps, no upload (local / CI check).
    sentryVitePlugin({
      disable: !uploadSentrySourcemaps,
      org: process.env.SENTRY_ORG || "qmai-c5",
      project: process.env.SENTRY_PROJECT || "qmai",
      authToken: sentryAuthToken,
      telemetry: false,
      release: { name: sentryRelease },
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"],
      },
    }),
  ],

  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  build: {
    // Hidden maps only when uploading; never ship *.map in the Tauri bundle.
    sourcemap: uploadSentrySourcemaps ? "hidden" : false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("js-yaml")) {
              return "yaml-vendor"
            }
            if (id.includes("react") || id.includes("scheduler")) {
              return "react-vendor"
            }
            if (id.includes("@milkdown")) {
              return "milkdown-vendor"
            }
          }
          return undefined
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/node_modules/**",
        "**/samples/plugins/**",
        "**/dist/**",
        "**/.vite/**",
        "**/.qmai/**",
        "**/chapters/**",
        "**/wiki/**",
        "**/target/**",
        "**/*.snapshot.*",
        "**/*.json",
        "**/*.store",
      ],
    },
  },

  test: {
    environment: "node",
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
    // SDK 和样例插件由 test:mocks 通过 node:test 单独运行。
    include: ["{src,src-tauri/migration,scripts,tests}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      ...configDefaults.exclude,
      "**/{dist,.worktrees,.claude,.codex-temp}/**",
    ],
  },
})
