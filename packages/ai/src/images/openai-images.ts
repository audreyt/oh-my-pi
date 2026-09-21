import type { Model } from "@oh-my-pi/pi-catalog/types";
import { NO_AUTH_SENTINEL, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { setHeaderIfAbsent } from "../providers/inference-headers";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import {
	decodeImageResponse,
	imageBaseUrl,
	modelHeaders,
	postJson,
	postMultipart,
	resolveOpenAIImageSize,
	toDataUrl,
} from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

export const XAI_MAX_EDIT_IMAGES = 3;

export function resolveXAIResolution(imageSize?: string): "1k" | "2k" {
	return !imageSize || imageSize === "1024x1024" ? "1k" : "2k";
}

export async function generateOpenAIImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const size = resolveOpenAIImageSize(request.aspectRatio, request.imageSize);
	const count = request.count ?? 1;
	const isXAI = model.provider === "xai" || model.provider === "xai-oauth";
	const isMeta = model.provider === "meta";
	const generationBody = isXAI
		? {
				model: model.requestModelId ?? model.id,
				prompt: request.prompt,
				aspect_ratio: request.aspectRatio ?? "1:1",
				resolution: resolveXAIResolution(request.imageSize),
				n: count,
				response_format: "b64_json",
			}
		: {
				model: model.requestModelId ?? model.id,
				prompt: request.prompt,
				n: count,
				response_format: "b64_json",
				...(size ? { size } : {}),
			};
	const references = (request.inputImages ?? []).map(image => ({ type: "image_url", url: toDataUrl(image) }));
	if (isXAI && references.length > XAI_MAX_EDIT_IMAGES) {
		throw new AIError.ValidationError(
			`${model.provider} image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${references.length}`,
		);
	}
	const [firstReference, ...remainingReferences] = references;
	const body = isMeta
		? { ...generationBody, images: references.map(image => ({ image_url: image.url })) }
		: isXAI
			? remainingReferences.length === 0
				? { ...generationBody, image: firstReference }
				: { ...generationBody, images: references }
			: { ...generationBody, input_references: references };
	const baseUrl = isMeta ? resolveMetaImageBaseUrl(model) : imageBaseUrl(model);
	let response: unknown;
	if (references.length === 0) {
		response = isMeta
			? await postMetaImage({
					model,
					url: `${baseUrl}/images/generations`,
					body: generationBody,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				})
			: await postJson({
					model,
					url: `${baseUrl}/images/generations`,
					body: generationBody,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
	} else {
		try {
			if (model.provider === "openai") {
				const form = new FormData();
				form.set("model", model.requestModelId ?? model.id);
				form.set("prompt", request.prompt);
				form.set("n", String(count));
				form.set("response_format", "b64_json");
				if (size) form.set("size", size);
				for (const image of request.inputImages ?? []) {
					form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
				}
				response = await postMultipart({
					model,
					url: `${baseUrl}/images/edits`,
					body: form,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			} else if (isMeta) {
				response = await postMetaImage({
					model,
					url: `${baseUrl}/images/edits`,
					body,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			} else {
				response = await postJson({
					model,
					url: `${baseUrl}/images/edits`,
					body,
					apiKey: options.apiKey,
					fetch: fetchImpl,
					signal: options.signal,
				});
			}
		} catch (error) {
			if (!(error instanceof AIError.ProviderHttpError) || error.status !== 404) throw error;
			response = await (isMeta ? postMetaImage : postJson)({
				model,
				url: `${baseUrl}/images/generations`,
				body,
				apiKey: options.apiKey,
				fetch: fetchImpl,
				signal: options.signal,
			});
		}
	}
	return decodeImageResponse(response, fetchImpl, options.signal);
}

/** Prefer `META_BASE_URL` only when the model is still on the bundled Meta host. */
function resolveMetaImageBaseUrl(model: Model): string {
	const base = imageBaseUrl(model).replace(/\/+$/, "");
	if (base !== META_MODEL_API_BASE_URL) return base;
	return (Bun.env.META_BASE_URL || META_MODEL_API_BASE_URL).replace(/\/+$/, "");
}

/**
 * Meta image proxies authenticate with caller headers. A configured
 * `Authorization` / `User-Agent` / `Content-Type` under any casing wins, and
 * the keyless `N/A` sentinel does not invent a bearer token.
 */
async function postMetaImage(options: {
	model: Model;
	url: string;
	body: unknown;
	apiKey: ImageGenerationOptions["apiKey"];
	fetch: NonNullable<ImageGenerationOptions["fetch"]>;
	signal?: AbortSignal;
}): Promise<unknown> {
	return withAuth(
		options.apiKey,
		async key => {
			const headers: Record<string, string> = { ...(await modelHeaders(options.model, options.signal)) };
			if (key !== NO_AUTH_SENTINEL) setHeaderIfAbsent(headers, "Authorization", `Bearer ${key}`);
			setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
			setHeaderIfAbsent(headers, "Content-Type", "application/json");
			const response = await options.fetch(options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(options.body),
				signal: options.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				let message = text;
				try {
					const parsed = JSON.parse(text) as { detail?: string; error?: { message?: string } };
					message = parsed.detail ?? parsed.error?.message ?? message;
				} catch {
					// Keep the raw body.
				}
				throw new AIError.ProviderHttpError(
					`${options.model.provider}/${options.model.id} image request failed (${response.status}): ${message}`,
					response.status,
					{ headers: response.headers },
				);
			}
			try {
				return JSON.parse(text) as unknown;
			} catch (cause) {
				throw new AIError.ProviderResponseError("Image API returned malformed JSON", {
					provider: options.model.provider,
					kind: "envelope",
					cause,
				});
			}
		},
		{ signal: options.signal },
	);
}
