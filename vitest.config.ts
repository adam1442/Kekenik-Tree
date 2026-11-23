import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Test-only settings; the build configuration stays in vite.config.ts.
// The default 5 s per-test budget is too tight for shared CI runners (2 vCPU) that evaluate the full default project.
export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      testTimeout: 30_000,
      hookTimeout: 30_000,
      setupFiles: ['./tests/setup/noWebGL.ts'],
      // Fewer parallel workers on CI so the heavy DOM/engine files do not starve each other.
      ...(process.env.CI ? { maxWorkers: 2 } : {}),
    },
  }),
);
