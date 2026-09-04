// uuid@13 ships ESM-only (no CJS build at all — see its package.json
// "exports"), and Jest's CommonJS module system can't require() an ESM
// package without a much larger jest.config ESM migration (extensionsToTreatAsEsm,
// --experimental-vm-modules, etc.) that the rest of this ts-jest/CommonJS setup
// doesn't use. src/lib/correlation/correlationId.ts is the only production
// call site and only needs `v4` (a fresh random UUID) — Node's built-in
// crypto.randomUUID() produces the same RFC4122 v4 format, so mapping the
// "uuid" specifier to this shim in jest's moduleNameMapper (test-only, zero
// production code change) is a faithful substitute.
const {randomUUID} = require("crypto");

module.exports = {v4: randomUUID};
