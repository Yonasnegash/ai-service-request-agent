import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/integration/**/*.integration.test.ts'],
        environment: 'node',
        clearMocks: true,
        restoreMocks: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
    },
})
