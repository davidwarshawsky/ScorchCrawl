import { createDefaultEsmPreset, type JestConfigWithTsJest } from "ts-jest";

const config: JestConfigWithTsJest = {
  ...createDefaultEsmPreset(),
  verbose: true,
  testPathIgnorePatterns: ["<rootDir>/dist/"],
  forceExit: true,
  detectOpenHandles: true,
  openHandlesTimeout: 120000,
  watchAll: false,
};

export default config;
