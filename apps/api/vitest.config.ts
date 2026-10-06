import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { NODE_ENV: 'test' }, testTimeout: 20000, hookTimeout: 20000 } });
