import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModels } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { getTinyLocalModelSpec, isFoundationModelsSpec } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { TinyTitleClient } from "../src/tiny/title-client";
import {
	AFM_CORE_SIDECAR_ENV,
	completeAfmCore,
	foundationModelsUnavailableReason,
	isAfmRequestScopedFailure,
	probeAfmCore,
	resolveBundledSidecarPath,
} from "../src/tiny/apple-fm";

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
	it("registers a foundation-models engine the ONNX backend always refuses", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		expect(isFoundationModelsSpec(spec)).toBe(true);
		expect(spec?.repo).toBe("apple.SystemLanguageModel");
		expect(spec?.onnxUnsupportedReason).toBe("Apple Foundation Models uses the SystemLanguageModel engine, not ONNX");
	});

	it("gates availability on Darwin unless OMP_APPLE_FM_SIDECAR is set", () => {
		delete process.env[AFM_CORE_SIDECAR_ENV];
		if (process.platform !== "darwin") {
			expect(foundationModelsUnavailableReason()).toBe("Apple Foundation Models is macOS-only");
		} else {
			expect(foundationModelsUnavailableReason()).toBeUndefined();
		}
		process.env[AFM_CORE_SIDECAR_ENV] = "/tmp/does-not-need-to-exist-for-this-check";
		expect(foundationModelsUnavailableReason()).toBeUndefined();
	});

	it("keeps afm-core out of download all even when Darwin-ready", () => {
		expect(resolveModels("all")).not.toContain("afm-core");
		expect(resolveModels("afm-core")).toEqual(["afm-core"]);
	});

	it("resolves a Bun file-loader emit against the module dir, not cwd", () => {
		expect(resolveBundledSidecarPath("./omp-apple-fm-py3pdx4g.", "/pkg/dist")).toBe(
			path.join("/pkg/dist", "omp-apple-fm-py3pdx4g."),
		);
	});

	it("treats generation failures as request-scoped and availability faults as terminal", () => {
		expect(isAfmRequestScopedFailure(new Error("apple_fm_failed: modelNotReady"))).toBe(true);
		expect(isAfmRequestScopedFailure(new Error("apple_fm_failed: Generation was refused"))).toBe(true);
		expect(isAfmRequestScopedFailure(new Error("Apple Foundation Models sidecar returned empty text"))).toBe(true);
		expect(isAfmRequestScopedFailure(new Error("apple_fm_failed: deviceNotEligible"))).toBe(false);
		expect(isAfmRequestScopedFailure(new Error("failed to compile Apple Foundation Models sidecar"))).toBe(false);
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
process.stdout.write(JSON.stringify({ text: req.maxTokens ? String(req.maxTokens) : "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).resolves.toEqual({ available: true, reason: undefined, contextSize: 8192 });
			await expect(completeAfmCore({ instructions: "title", prompt: "fix the login button" })).resolves.toBe(
				"<title>Fix login button</title>",
			);
			await expect(completeAfmCore({ prompt: "classify", maxTokens: 16 })).resolves.toBe("16");
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

describe("afm-core client titles", () => {
	it("generates a title without spawning a worker", async () => {
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
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "the login button is broken on mobile")).resolves.toBe(
				"Fix login button",
			);
			expect(events).toContain("initiate");
			expect(events).toContain("ready");
			expect(events).not.toContain("error");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats download as a readiness probe", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			await expect(client.downloadModel("afm-core")).resolves.toEqual({ ok: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no title on modelNotReady and recovers when ready later", async () => {
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
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).toContain("error");
			fs.writeFileSync(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps prompt-specific AFM failures request-scoped", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "Generation was refused" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).not.toContain("error");
			fs.writeFileSync(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("disables AFM after a terminal failure", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "deviceNotEligible" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			fs.writeFileSync(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
