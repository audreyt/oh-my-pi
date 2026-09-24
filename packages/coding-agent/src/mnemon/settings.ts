/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Native Mnemon CLI backend. Talks to the existing ~/.mnemon store.
// Never point mnemopi.dbPath at that database — schemas differ.
export const cfgMnemonCliPath = register({
	id: "mnemon.cliPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemon",
		label: "Mnemon CLI Path",
		description: "Optional absolute path to mnemon. Defaults to PATH, then ~/.local/bin, then Homebrew.",
		condition: "mnemonActive",
	},
});

export const cfgMnemonAutoRecall = register({
	id: "mnemon.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemon",
		label: "Mnemon Auto Recall",
		description: "Inject high-score native recall into the first turn of each session",
		condition: "mnemonActive",
	},
});

export const cfgMnemonRecallLimit = register({ id: "mnemon.recallLimit", type: "number", default: 3 });

export const cfgMnemonAutoRetain = register({
	id: "mnemon.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemon",
		label: "Mnemon Auto Retain",
		description: "Retain completed conversation turns into ~/.mnemon after agent turns",
		condition: "mnemonActive",
	},
});

export const cfgMnemonRetainEveryNTurns = register({ id: "mnemon.retainEveryNTurns", type: "number", default: 4 });
