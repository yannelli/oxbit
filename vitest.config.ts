import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts','apps/**/*.test.ts','tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000, pool: 'forks', maxWorkers: 2 } });
