module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The glob patterns Jest uses to detect test files
  testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  // Transform ES modules in node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(p-queue|eventemitter3)/)',
  ],
};
