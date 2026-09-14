import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "zai-org/GLM-5.3",
		name: "GLM-5.3",
		api: "openai-responses",
		provider: "doubleword",
		baseUrl: "https://api.doubleword.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
		...overrides,
	} as ModelSpec<"openai-responses">);
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "doubleword",
		model: "zai-org/GLM-5.3",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

function makeEventStream(): { stream: AssistantMessageEventStreamLike; emitted: Array<{ type?: string }> } {
	const emitted: Array<{ type?: string }> = [];
	return {
		emitted,
		stream: {
			push: (e: { type?: string }) => emitted.push(e),
			end: () => {},
		} as AssistantMessageEventStreamLike,
	};
}

type AssistantMessageEventStreamLike = {
	push: (e: { type?: string }) => void;
	end: () => void;
};

const USAGE = { input_tokens: 17, output_tokens: 261, total_tokens: 278, input_tokens_details: { cached_tokens: 0 } };

describe("processResponsesStream terminal-event output materialization", () => {
	it("materializes response.output[] when the host streams only created + completed (Doubleword flex)", async () => {
		const output = makeOutput();
		const { stream } = makeEventStream();
		const doneItems: unknown[] = [];
		let completed = false;

		await processResponsesStream(
			makeStream([
				{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						service_tier: "flex",
						usage: USAGE,
						output: [
							{
								type: "reasoning",
								id: "rs_1",
								summary: [{ type: "summary_text", text: "thinking about it" }],
							},
							{
								type: "message",
								id: "msg_1",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "ok" }],
							},
							{
								type: "function_call",
								id: "fc_1",
								call_id: "call_1",
								name: "read_file",
								arguments: '{"path":"README.md"}',
								status: "completed",
							},
						],
					},
				},
			]),
			output,
			stream as never,
			makeModel(),
			{
				onOutputItemDone: item => doneItems.push(item),
				onCompleted: () => {
					completed = true;
				},
			},
		);

		expect(completed).toBe(true);
		// The turn ends on a pending tool call, so the stop promotes to toolUse.
		expect(output.stopReason).toBe("toolUse");
		expect(output.usage.output).toBe(261);
		expect(output.content.map(b => b.type)).toEqual(["thinking", "text", "toolCall"]);
		const thinking = output.content[0] as ThinkingContent;
		expect(thinking.thinking).toBe("thinking about it");
		expect(thinking.thinkingSignature).toBeTruthy();
		const text = output.content[1] as TextContent;
		expect(text.text).toBe("ok");
		const toolCall = output.content[2] as ToolCall;
		expect(toolCall.name).toBe("read_file");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect(doneItems).toHaveLength(3);
	});

	it("does not duplicate items already finalized by a streamed output_item.done", async () => {
		const output = makeOutput();
		const { stream } = makeEventStream();
		const messageItem = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "hello" }],
		};

		await processResponsesStream(
			makeStream([
				{ type: "response.output_item.added", output_index: 0, item: { ...messageItem, content: [] } },
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "hello" },
				{ type: "response.output_item.done", output_index: 0, item: messageItem },
				{
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: USAGE, output: [messageItem] },
				},
			]),
			output,
			stream as never,
			makeModel(),
		);

		expect(output.content).toHaveLength(1);
		expect((output.content[0] as TextContent).text).toBe("hello");
	});

	it("finalizes an open item whose done event never streamed when the terminal output repeats it", async () => {
		const output = makeOutput();
		const { stream } = makeEventStream();
		const messageItem = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "final text" }],
		};

		await processResponsesStream(
			makeStream([
				{ type: "response.output_item.added", output_index: 0, item: { ...messageItem, content: [] } },
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "final " },
				// No output_item.done — the terminal event's output[] is authoritative.
				{
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: USAGE, output: [messageItem] },
				},
			]),
			output,
			stream as never,
			makeModel(),
		);

		expect(output.content).toHaveLength(1);
		expect((output.content[0] as TextContent).text).toBe("final text");
	});

	it.each(["in_progress", "queued"])(
		"throws incomplete-stream when a terminal event reports status %s",
		async status => {
			const output = makeOutput();
			const { stream } = makeEventStream();

			const error = await processResponsesStream(
				makeStream([
					{
						type: "response.completed",
						response: { id: "resp_1", status, usage: USAGE, output: [] },
					},
				]),
				output,
				stream as never,
				makeModel(),
			).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(`non-terminal status "${status}"`);
		},
	);
});

describe("streamOpenAIResponses async service tier watchdogs", () => {
	// The desk env pins PI_*_STREAM_*_TIMEOUT_MS; scrub them so the flex
	// relaxation and the realtime default are both observable deterministically.
	const TIMEOUT_ENV_KEYS = [
		"PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS",
		"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
		"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
		"PI_STREAM_IDLE_TIMEOUT_MS",
	] as const;
	let savedEnv: Array<readonly [string, string | undefined]> = [];
	beforeEach(() => {
		savedEnv = TIMEOUT_ENV_KEYS.map(key => [key, process.env[key]] as const);
		for (const key of TIMEOUT_ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	function sseResponse(): Response {
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } })}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					service_tier: "flex",
					usage: USAGE,
					output: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok" }],
						},
					],
				},
			})}`,
		].join("\n\n")}\n\n`;
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	function baseContext(): Context {
		return { messages: [{ role: "user", content: "Say ok", timestamp: Date.now() }] };
	}

	async function captureRequest(serviceTier: "flex" | "priority") {
		let capturedBody: Record<string, unknown> | undefined;
		let capturedHeaders: Headers | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			capturedHeaders = new Headers(init?.headers);
			return sseResponse();
		});
		const stream = streamOpenAIResponses(makeModel(), baseContext(), {
			apiKey: "sk-test",
			serviceTier,
			fetch: fetchMock,
		});
		const result = await stream.result();
		return { result, capturedBody, capturedHeaders };
	}

	it("sends service_tier and omits the first-event watchdog header for flex", async () => {
		const { result, capturedBody, capturedHeaders } = await captureRequest("flex");
		expect(capturedBody?.service_tier).toBe("flex");
		expect(capturedHeaders?.get("X-Stainless-Timeout")).toBeNull();
		expect(result.stopReason).toBe("stop");
		expect((result.content[0] as TextContent).text).toBe("ok");
	});

	it("keeps the first-event watchdog for realtime tiers", async () => {
		const { capturedBody, capturedHeaders } = await captureRequest("priority");
		expect(capturedBody?.service_tier).toBe("priority");
		expect(Number(capturedHeaders?.get("X-Stainless-Timeout"))).toBeGreaterThan(0);
	});
});
