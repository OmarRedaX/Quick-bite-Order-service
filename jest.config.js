module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests/unit'],
    testMatch: ['**/*.test.ts'],
    setupFiles: ['<rootDir>/tests/setup-env.ts'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
    },
    // uuid@13 is ESM-only; see tests/helpers/uuid-cjs-shim.js for why.
    moduleNameMapper: {
        '^uuid$': '<rootDir>/tests/helpers/uuid-cjs-shim.js'
    },
    collectCoverageFrom: ['src/**/*.ts', '!src/migrations/**', '!src/server.ts', '!src/worker.ts'],
    coverageDirectory: '<rootDir>/coverage-unit'
}
