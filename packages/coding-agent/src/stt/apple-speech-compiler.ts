import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

/** Darwin architecture accepted by the SpeechAnalyzer sidecar toolchain. */
export type AppleSpeechArchitecture = "arm64" | "x64";

/** Inputs for the shared build-time and runtime sidecar compiler. */
export interface AppleSpeechCompileOptions {
	architecture: AppleSpeechArchitecture;
	outputPath: string;
	sourcePath: string;
}

/** Compile and ad-hoc sign the native SpeechAnalyzer helper for one Darwin architecture. */
export async function compileAppleSpeechSidecar(options: AppleSpeechCompileOptions): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error("Apple SpeechAnalyzer sidecars can only be built on macOS.");
	}
	const swiftc = $which("swiftc");
	if (!swiftc) throw new Error("Swift compiler not found; Xcode 26 or newer is required.");
	await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
	const targetArchitecture = options.architecture === "x64" ? "x86_64" : options.architecture;
	const proc = Bun.spawn(
		[
			swiftc,
			"-parse-as-library",
			"-O",
			"-target",
			`${targetArchitecture}-apple-macos26.0`,
			"-framework",
			"Speech",
			"-framework",
			"AVFAudio",
			"-framework",
			"CoreMedia",
			"-o",
			options.outputPath,
			options.sourcePath,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, , stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`SpeechAnalyzer sidecar build failed: ${stderr.trim() || `swiftc exited ${exitCode}`}`);
	}
	await fs.chmod(options.outputPath, 0o755);

	const codesign = $which("codesign");
	if (!codesign) return;
	const sign = Bun.spawn([codesign, "--force", "--sign", "-", options.outputPath], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [signExitCode, , signStderr] = await Promise.all([
		sign.exited,
		new Response(sign.stdout as ReadableStream<Uint8Array>).text(),
		new Response(sign.stderr as ReadableStream<Uint8Array>).text(),
	]);
	if (signExitCode !== 0) {
		throw new Error(
			`SpeechAnalyzer sidecar signing failed: ${signStderr.trim() || `codesign exited ${signExitCode}`}`,
		);
	}
}
