// MOBILE-001: the app reuses the web's dependency-free validation and messages from ../src/lib (docs/42 §1.1).
// Only the files re-exported by src/shared.ts are imported from there; tests/shared.test.ts checks they import nothing.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../src/lib")];

module.exports = config;
