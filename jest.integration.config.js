module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests/integration'],
    testMatch: ['**/*integration.test.ts'],
    setupFiles: ['<rootDir>/tests/setup-env.ts'],
    globalSetup: '<rootDir>/tests/integration/global-setup.ts',
    globalTeardown: '<rootDir>/tests/integration/teardown.ts',
    maxWorkers: 1,
    forceExit: true,
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
    },
    // uuid@13 is ESM-only; see tests/helpers/uuid-cjs-shim.js for why.
    moduleNameMapper: {
        '^uuid$': '<rootDir>/tests/helpers/uuid-cjs-shim.js'
    },
    collectCoverageFrom: ['src/**/*.ts', '!src/migrations/**', '!src/server.ts', '!src/worker.ts'],
    coverageDirectory: '<rootDir>/coverage-integration'
}
