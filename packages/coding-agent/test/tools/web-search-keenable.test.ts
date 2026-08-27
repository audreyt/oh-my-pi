import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { KEENABLE_SEARCH_PUBLIC_URL, KEENABLE_SEARCH_URL } from "@oh-my-pi/pi-coding-agent/web/keenable";
import { buildRequestBody, searchKeenable } from "@oh-my-pi/pi-coding-agent/web/search/providers/keenable";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { APP_NAME } from "@oh-my-pi/pi-utils";

describe("Keenable web search provider", () => {
	beforeEach(() => {
		process.env.KEENABLE_API_KEY = "test-keenable-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KEENABLE_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.KEENABLE_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.KEENABLE_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.KEENABLE_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Keenable test prompt",
		} as const;
	}

	it("maps Keenable hits into SearchResponse and forwards recency as published_after", async () => {
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | null = null;

		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					query: "latest ai news",
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							description: "Short blurb",
							snippet: "Longer excerpt",
							published_at: "2026-03-01T00:00:00Z",
						},
						{
							url: "https://example.com/two",
							description: "Second blurb",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchKeenable({
			...makeParams("latest ai news"),
			numSearchResults: 2,
			recency: "week",
			fetch: fetchMock,
		});

		expect(requestUrl).toBe(KEENABLE_SEARCH_URL);
		expect(requestHeaders?.get("x-api-key")).toBe("test-keenable-key");
		expect(requestBody).toMatchObject({
			query: "latest ai news",
			max_results: 2,
			published_after: "7d",
		});
		expect(response).toMatchObject({
			provider: "keenable",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "Longer excerpt",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Second blurb",
				},
			],
		});
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("maps a single site: directive to site and strips it from the query", async () => {
		let requestBody: Record<string, unknown> | null = null;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchKeenable({
			...makeParams("typescript site:github.com"),
			fetch: fetchMock,
		});

		expect(requestBody).toMatchObject({
			query: "typescript",
			site: "github.com",
		});
	});

	it("maps after:/before: to published_after/published_before instead of recency", async () => {
		expect(
			buildRequestBody({
				query: "rust",
				recency: "week",
				published_after: "2026-01-01",
				published_before: "2026-02-01",
			}),
		).toEqual({
			query: "rust",
			max_results: 10,
			published_after: "2026-01-01",
			published_before: "2026-02-01",
		});
	});

	it("retries recency-filtered empty responses without published_after", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestBodies.push(JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>);
			if (requestBodies.length === 1) {
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					results: [{ title: "Untimed", url: "https://example.com/untimed" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchKeenable({
			...makeParams("ai chips"),
			recency: "day",
			fetch: fetchMock,
		});

		expect(requestBodies).toEqual([
			{ query: "ai chips", max_results: 10, published_after: "1d" },
			{ query: "ai chips", max_results: 10 },
		]);
		expect(response.sources).toEqual([
			{
				title: "Untimed",
				url: "https://example.com/untimed",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("uses the public search endpoint when no credential is configured", async () => {
		delete process.env.KEENABLE_API_KEY;
		let requestUrl = "";
		let requestHeaders: Headers | undefined;
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requestHeaders = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [{ title: "Public", url: "https://example.com/public" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchKeenable({
			...makeParams("public search"),
			fetch: fetchMock,
		});

		expect(requestUrl).toBe(KEENABLE_SEARCH_PUBLIC_URL);
		expect(requestHeaders?.get("x-api-key")).toBeNull();
		expect(requestHeaders?.get("x-keenable-title")).toBe(APP_NAME);
		expect(response.authMode).toBe("keyless");
	});

	it("surfaces classified 402 credit exhaustion", async () => {
		const fetchMock = async (): Promise<Response> => new Response("no credits available", { status: 402 });

		await expect(searchKeenable({ ...makeParams("quota"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "keenable",
				status: 402,
				message: "keenable: 402 credits exhausted",
			}) satisfies Partial<SearchProviderError>,
		);
	});
});
