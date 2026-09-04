import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModels } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { getTinyLocalModelSpec, isFoundationModelsSpec } from "@oh-my-pi/pi-coding-agent/tiny/models";
import type { TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import {
	AFM_CORE_SIDECAR_ENV,
	completeAfmCore,
	foundationModelsUnavailableReason,
	probeAfmCore,
	resolveBundledSidecarPath,
} from "../src/tiny/apple-fm";
import { chatWithFoundationModels, probeFoundationModels } from "../src/tiny/worker";

const previousSidecar = process.env[AFM_CORE_SIDECAR_ENV];

afterEach(() => {
	if (previousSidecar === undefined) delete process.env[AFM_CORE_SIDECAR_ENV];
	else process.env[AFM_CORE_SIDECAR_ENV] = previousSidecar;
});

function writeFakeSidecar(dir: string, script: string): string {
	const sidecar = path.join(dir, "fake-afm");
	fs.writeFileSync(sidecar, script);
	fs.chmodSync(sidecar, 0o755);
	return sidecar;
}

function bunSidecar(body: string): string {
	return `#!/usr/bin/env bun
${body}
`;
}

describe("afm-core title registry", () => {
	it("registers a Darwin-only foundation-models engine", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		expect(isFoundationModelsSpec(spec)).toBe(true);
		expect(spec?.repo).toBe("apple.SystemLanguageModel");
		if (process.platform === "darwin") {
			expect(spec?.unsupportedReason).toBeUndefined();
		} else {
			expect(spec?.unsupportedReason).toBe("Apple Foundation Models is macOS-only");
		}
	});

	it("lets OMP_APPLE_FM_SIDECAR bypass the platform gate", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		if (!spec) return;
		delete process.env[AFM_CORE_SIDECAR_ENV];
		if (process.platform !== "darwin") {
			expect(foundationModelsUnavailableReason(spec)).toBe("Apple Foundation Models is macOS-only");
		}
		process.env[AFM_CORE_SIDECAR_ENV] = "/tmp/does-not-need-to-exist-for-this-check";
		expect(foundationModelsUnavailableReason(spec)).toBeUndefined();
	});

	it("includes afm-core in download all exactly when Darwin-ready", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		if (!spec) return;
		if (foundationModelsUnavailableReason(spec)) {
			expect(resolveModels("all")).not.toContain("afm-core");
		} else {
			expect(resolveModels("all")).toContain("afm-core");
		}
		expect(resolveModels("afm-core")).toEqual(["afm-core"]);
	});

	it("resolves a Bun file-loader emit against the module dir, not cwd", () => {
		expect(resolveBundledSidecarPath("./omp-apple-fm-py3pdx4g.", "/pkg/dist")).toBe(
			path.join("/pkg/dist", "omp-apple-fm-py3pdx4g."),
		);
	});
});

describe("AFM sidecar runner", () => {
	it("probes and completes through an env-overridden sidecar", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
const cmd = process.argv[2];
if (cmd === "status") {
	process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
	process.exit(0);
}
const raw = await Bun.stdin.text();
const req = JSON.parse(raw);
if (!req.prompt) throw new Error("missing prompt");
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).resolves.toEqual({ available: true, reason: undefined, contextSize: 8192 });
			await expect(completeAfmCore({ instructions: "title", prompt: "fix the login button" })).resolves.toBe(
				"<title>Fix login button</title>",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces sidecar error payloads", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).rejects.toThrow("apple_fm_failed: modelNotReady");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("tiny worker AFM chat (message-level protocol)", () => {
	it("chats through the sidecar without loading transformers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const spec = getTinyLocalModelSpec("afm-core");
			expect(spec).toBeDefined();
			if (!spec) return;

			const text = await chatWithFoundationModels("afm-core", spec, {
				type: "chat",
				id: "1",
				messages: [
					{ role: "system", content: "title instructions" },
					{ role: "user", content: "the login button is broken on mobile" },
				],
				maxNewTokens: 20,
			});
			expect(text).toBe("<title>Fix login button</title>");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("honors the chat stop marker", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const spec = getTinyLocalModelSpec("afm-core");
			expect(spec).toBeDefined();
			if (!spec) return;

			const text = await chatWithFoundationModels("afm-core", spec, {
				type: "chat",
				id: "1",
				messages: [{ role: "user", content: "the login button is broken" }],
				stop: "</title>",
				maxNewTokens: 20,
			});
			expect(text).toBe("<title>Fix login button");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats load as a readiness probe", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const spec = getTinyLocalModelSpec("afm-core");
			expect(spec).toBeDefined();
			if (!spec) return;

			const outbound: TinyWorkerResponse[] = [];
			await probeFoundationModels(
				{ send: (message: TinyWorkerResponse) => void outbound.push(message) },
				"2",
				"afm-core",
				spec,
			);
			expect(outbound.some(message => message.type === "progress" && message.event.status === "ready")).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty text on modelNotReady instead of throwing", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const spec = getTinyLocalModelSpec("afm-core");
			expect(spec).toBeDefined();
			if (!spec) return;

			const text = await chatWithFoundationModels("afm-core", spec, {
				type: "chat",
				id: "3",
				messages: [{ role: "user", content: "fix the login button" }],
				maxNewTokens: 20,
			});
			expect(text).toBe("");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("completes through the sidecar without loading transformers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "yes" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const spec = getTinyLocalModelSpec("afm-core");
			expect(spec).toBeDefined();
			if (!spec) return;

			const text = await chatWithFoundationModels("afm-core", spec, {
				type: "chat",
				id: "4",
				messages: [{ role: "user", content: "did the model stop unexpectedly?" }],
				maxNewTokens: 256,
			});
			expect(text).toBe("yes");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
