/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
    testEnvironment: 'node',
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json',
            diagnostics: { ignoreCodes: [2322, 2339, 2554, 2769, 7006] },
        }],
    },
    setupFiles: ['<rootDir>/test/unit/_person.ts'],
    testTimeout: 600000,
    clearMocks: true,
    forceExit: true,
};
