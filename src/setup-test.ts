// Suppress @actions/core write helpers during tests.
//
// The real implementations emit GitHub workflow commands
// (`::error::...`, `::warning::...`) and free-form lines to stdout, which
// flood test output and obscure real failures. Replace the entire module
// with no-ops; tests that need to observe calls (`spyOn(core, "warning")`)
// still work because `spyOn` wraps the property on the mocked module.
import { mock } from "bun:test";

mock.module("@actions/core", () => ({
	info: () => {},
	debug: () => {},
	warning: () => {},
	error: () => {},
	notice: () => {},
	setFailed: () => {},
	setOutput: () => {},
	getInput: () => "",
	getBooleanInput: () => false,
}));
