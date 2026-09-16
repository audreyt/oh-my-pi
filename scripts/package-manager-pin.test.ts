import { describe, expect, test } from "bun:test";

// Root `packageManager` must stay an exact `bun@x.y.z` pin: the field
// follows the corepack contract (`name@version`, exact version only).
// Spec-strict resolvers (corepack, vp shims) reject anything else, and on
// machines where `node` is such a shim that breaks every
// `#!/usr/bin/env node` bin in the repo (tsgo, oxlint, oxfmt), which in
// turn breaks `bun run check:ts` and `omp update`.
const EXACT_BUN_PIN = /^bun@\d+\.\d+\.\d+$/;

describe("root packageManager pin", () => {
	test("is an exact bun x.y.z pin", async () => {
		const manifest = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
			packageManager?: string;
		};
		expect(manifest.packageManager).toMatch(EXACT_BUN_PIN);
	});

	test("rejects range pins", () => {
		// `bun@>=1.4` broke node-shimmed bins repo-wide (tsgo, oxlint,
		// oxfmt): the shim refuses to run with an unparsable pin.
		expect("bun@>=1.4").not.toMatch(EXACT_BUN_PIN);
		expect("bun@^1.4.2").not.toMatch(EXACT_BUN_PIN);
		expect("bun@latest").not.toMatch(EXACT_BUN_PIN);
	});
});
