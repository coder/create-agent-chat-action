// Stub @actions/core during tests.
//
// The real write helpers (`info`, `warning`, `error`, etc.) emit GitHub
// workflow commands (`::error::...`, `::warning::...`) and free-form
// lines to stdout, which flood test output and obscure real failures.
// Replace the used exports: write helpers become no-ops, and read helpers
// return safe defaults so any test path that calls them stays
// well-behaved. Tests that need to observe calls
// (`spyOn(core, "warning")`) still work because `spyOn` wraps the
// property on the mocked module.
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
