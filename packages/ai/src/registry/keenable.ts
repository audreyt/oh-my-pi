import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://app.keenable.ai/console";

/**
 * Login to Keenable.
 *
 * Opens the console and prompts the user to paste their API key.
 * Returns the API key directly (not OAuth credentials).
 */
export const loginKeenable = createApiKeyLogin({
	providerLabel: "Keenable",
	authUrl: AUTH_URL,
	instructions: "Copy your Keenable API key from the console.",
	promptMessage: "Paste your Keenable API key",
	placeholder: "keen_...",
	validation: null,
});

export const keenableProvider = {
	id: "keenable",
	name: "Keenable",
	envKeys: "KEENABLE_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginKeenable(cb),
} as const satisfies ProviderDefinition;
