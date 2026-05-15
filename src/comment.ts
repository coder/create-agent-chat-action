import * as core from "@actions/core";
import type { getOctokit } from "@actions/github";
import {
	type ChatErrorKind,
	type ChatStatus,
	CoderAPIError,
} from "./coder-client";
import { sanitizeLabelKey } from "./sanitize-label-key";
import type { ActionInputs } from "./schemas";
import { normalizeBaseUrl } from "./url";

// Re-export so `action.ts` and tests keep their existing import sites.
export { normalizeBaseUrl } from "./url";

type Octokit = ReturnType<typeof getOctokit>;

// Shared regex for GitHub issue and PR URLs. Used by `deriveCommentKey` and
// `parseGithubURL` so adding another path (e.g. `/discussions/`) is one edit.
// Anchored at the tail so URLs with extra path segments after the number
// (e.g. `.../issues/123/files`) are rejected rather than silently truncated.
// The `(?:[?#].*)?` group keeps the anchor tolerant of query strings and
// fragments that real-world `github-url` inputs can carry (e.g. a URL copied
// while viewing a specific comment).
export const GITHUB_URL_REGEX =
	/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/;

// Discriminated union so spend-exceeded fields are only representable on the
// spend-exceeded variant; the body builder reads them directly without a
// `?? 0` fallback.
export type FailureDetail =
	| {
			kind: "spend_exceeded";
			message: string;
			spentMicros: number;
			limitMicros: number;
			resetsAt: string;
	  }
	| {
			kind:
				| "user_not_found"
				| "user_ambiguous"
				| "org_not_found"
				| "api_error"
				| "timeout";
			message: string;
	  };

// chat-error-kind enum surfaced as the action's `chat-error-kind` output.
// Re-exported from `coder-client.ts`; this re-export keeps the name local
// to `comment.ts` callers and `index.ts` for backward source compatibility.
export type { ChatErrorKind } from "./coder-client";

const COMMENT_MARKER_PREFIX = "<!-- coder-agents-chat-action:";
const COMMENT_MARKER_SUFFIX = " -->";

// Build the per-comment marker. See `deriveCommentKey` for how the `key`
// is derived from `idempotency-key`, `github-url`, and `GITHUB_WORKFLOW`.
export function buildCommentMarker(key: string): string {
	return `${COMMENT_MARKER_PREFIX}${key}${COMMENT_MARKER_SUFFIX}`;
}

// Derive the marker key. Same value is used by the failure-comment helper
// and by the success-comment helper so they agree per target.
//
// Without a workflow suffix, two workflows targeting the same issue/PR
// would collide on the same key and overwrite each other's comment.
// Callers pass `workflow` (typically `process.env.GITHUB_WORKFLOW`) so
// each workflow gets its own marker. `idempotencyKey` still wins
// when set so users can intentionally collapse comments across
// workflows.
export function deriveCommentKey(
	inputs: Pick<ActionInputs, "githubURL"> & {
		idempotencyKey?: string;
		workflow?: string;
	},
): string {
	if (inputs.idempotencyKey) {
		return sanitizeLabelKey(inputs.idempotencyKey);
	}
	const match = inputs.githubURL.match(GITHUB_URL_REGEX);
	let base: string;
	if (!match) {
		// The action validates githubURL upstream; if we get here the input is
		// malformed and the failure-path comment cannot find a stable target.
		// Fall back to the URL itself so re-runs at least collapse on identical
		// URLs, even if the marker is uglier.
		base = inputs.githubURL;
	} else {
		base = `${match[1]}/${match[2]}#${match[3]}`;
	}
	if (inputs.workflow) {
		return `${base}:${inputs.workflow}`;
	}
	return base;
}

// Map a thrown error to a FailureDetail.
//
// Classification keys on explicit signals so a message reword cannot demote
// a kind to `api_error`:
//   - `kind` on CoderAPIError (set by the client) marks user-lookup
//     failures.
//   - 409 with the spend-exceeded body shape (`spent_micros`, `limit_micros`,
//     `resets_at`) becomes `spend_exceeded`.
//   - Anything else becomes `api_error`. The message is the body's `message`
//     field when present (e.g. `workspace_id: must be a valid UUID`) and
//     falls back to `err.message` only when the body is empty.
export function classifyError(err: unknown): FailureDetail {
	if (err instanceof CoderAPIError) {
		// Check the explicit error-code discriminator first so a client error
		// can never be misclassified by an unrelated 409 body shape.
		const code = mapErrorCodeToKind(err.kind);
		if (code) {
			return { kind: code, message: err.message };
		}
		const spend = parseSpendExceededBody(err.response);
		if (err.statusCode === 409 && spend) {
			return {
				kind: "spend_exceeded",
				message: spend.message,
				spentMicros: spend.spentMicros,
				limitMicros: spend.limitMicros,
				resetsAt: spend.resetsAt,
			};
		}
		return {
			kind: "api_error",
			message: parseAPIErrorMessage(err.response) ?? err.message,
		};
	}
	if (err instanceof Error) {
		return { kind: "api_error", message: err.message };
	}
	return { kind: "api_error", message: String(err) };
}

function mapErrorCodeToKind(
	code: ChatErrorKind | undefined,
): "user_not_found" | "user_ambiguous" | undefined {
	switch (code) {
		case "user_not_found":
		case "user_ambiguous":
			return code;
		default:
			return undefined;
	}
}

interface SpendExceededFields {
	message: string;
	spentMicros: number;
	limitMicros: number;
	resetsAt: string;
}

// Parse a 409 body for the spend-exceeded shape. We guard on the numeric
// fields the comment renders so a malformed input cannot produce a `$0.00`
// body.
function parseSpendExceededBody(response: unknown): SpendExceededFields | null {
	const obj = parseJSONObject(response);
	if (!obj) {
		return null;
	}
	if (
		typeof obj.spent_micros === "number" &&
		typeof obj.limit_micros === "number"
	) {
		return {
			message:
				typeof obj.message === "string" && obj.message
					? obj.message
					: "Chat usage limit exceeded.",
			spentMicros: obj.spent_micros,
			limitMicros: obj.limit_micros,
			resetsAt: typeof obj.resets_at === "string" ? obj.resets_at : "",
		};
	}
	return null;
}

// Pull the diagnostic `message` field from a Coder API error body so the
// comment can show e.g. `workspace_id: must be a valid UUID` instead of the
// generic HTTP status text.
function parseAPIErrorMessage(response: unknown): string | undefined {
	const obj = parseJSONObject(response);
	if (!obj) {
		return undefined;
	}
	if (typeof obj.message === "string" && obj.message) {
		return obj.message;
	}
	return undefined;
}

function parseJSONObject(response: unknown): Record<string, unknown> | null {
	let parsed: unknown = response;
	if (typeof response === "string" && response.length > 0) {
		try {
			parsed = JSON.parse(response);
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	return parsed as Record<string, unknown>;
}

function formatMicrosAsDollars(micros: number): string {
	const dollars = micros / 1_000_000;
	return `$${dollars.toFixed(2)}`;
}

export interface FailureCommentContext {
	agentsUrl: string;
	marker: string;
	// Chat-specific URL when the failure surfaced after the chat existed
	// (timeout, error-state terminal, polling-network blip). Flips the
	// heading to the run-phase "failed".
	chatUrl?: string;
	// Final chat status when the failure carries a chat handle. `"error"`
	// means the chat itself errored; the `api_error` body uses this to hint
	// at `last_error` rather than connectivity.
	chatStatus?: ChatStatus;
}

// Build the failure-comment body. Each variant ends with `ctx.marker` so
// subsequent runs can find and update the prior comment via
// `upsertCommentByMarker`. The exhaustive `default` makes adding a new
// ChatErrorKind a type error here rather than a silent blank body.
//
// Heading branches on creation phase vs run phase: "failed to start" when
// no chat existed yet, "failed" when one did (`isRunPhaseFailure`).
export function buildFailureCommentBody(
	detail: FailureDetail,
	ctx: FailureCommentContext,
): string {
	const runPhase = isRunPhaseFailure(detail.kind, ctx);
	const heading = runPhase
		? "**Coder Agents Chat: failed**"
		: "**Coder Agents Chat: failed to start**";
	const lines: string[] = [heading, ""];
	const linkLine = ctx.chatUrl
		? `View the chat in the Coder deployment: ${ctx.chatUrl}`
		: `View agents in the Coder deployment: ${ctx.agentsUrl}`;
	switch (detail.kind) {
		case "spend_exceeded":
			lines.push(
				"The Coder deployment's chat spend limit was reached, so this " +
					"chat could not be created.",
				"",
				`- chat-error-kind=${detail.kind}`,
				`- Spent: ${formatMicrosAsDollars(detail.spentMicros)}`,
				`- Limit: ${formatMicrosAsDollars(detail.limitMicros)}`,
			);
			if (detail.resetsAt) {
				lines.push(`- Resets at: ${detail.resetsAt}`);
			}
			lines.push("", linkLine);
			break;
		case "user_not_found":
			lines.push(
				"No Coder user could be resolved for this run. Adjust either " +
					"the `acting-github-user-id` input (the GitHub identity is not " +
					"linked to a Coder user) or pass `acting-coder-username` directly.",
				"",
				`- chat-error-kind=${detail.kind}`,
				`- Detail: ${detail.message}`,
				"",
				linkLine,
			);
			break;
		case "user_ambiguous":
			lines.push(
				"Multiple Coder users matched the GitHub identity. Set the " +
					"`acting-coder-username` input to the specific account this " +
					"workflow should use as the acting user (for org pick and the " +
					"per-user reuse label).",
				"",
				`- chat-error-kind=${detail.kind}`,
				`- Detail: ${detail.message}`,
				"",
				linkLine,
			);
			break;
		case "org_not_found":
			lines.push(
				"The resolved Coder user has no matching organization. Set the " +
					"`coder-organization` input or grant the user a membership.",
				"",
				`- chat-error-kind=${detail.kind}`,
				`- Detail: ${detail.message}`,
				"",
				linkLine,
			);
			break;
		case "api_error":
			lines.push(apiErrorPhrase(runPhase, ctx), "");
			lines.push(
				`- chat-error-kind=${detail.kind}`,
				`- Detail: ${detail.message}`,
			);
			if (ctx.chatStatus === "error") {
				lines.push(
					"- Hint: the agent itself failed mid-run; inspect " +
						"`last_error` on the chat (e.g. provider rate limits) " +
						"rather than action connectivity.",
				);
			}
			lines.push("", linkLine);
			break;
		case "timeout":
			// timeout fires only from `waitForTerminal`, which runs after
			// chat creation; always run-phase.
			lines.push(
				"`wait: complete` polling did not reach a terminal status within " +
					"`wait-timeout-seconds`.",
				"",
				`- chat-error-kind=${detail.kind}`,
				`- Detail: ${detail.message}`,
				"",
				linkLine,
			);
			break;
		default: {
			const _exhaustive: never = detail;
			throw new Error(
				`buildFailureCommentBody: unhandled ChatErrorKind ${JSON.stringify(_exhaustive)}`,
			);
		}
	}
	lines.push("", ctx.marker);
	return lines.join("\n");
}

function isRunPhaseFailure(
	kind: ChatErrorKind,
	ctx: FailureCommentContext,
): boolean {
	if (kind === "timeout") {
		return true;
	}
	// `api_error` split: classification cannot tell creation 4xx from
	// polling 5xx by kind alone. `ctx.chatUrl` is the signal: polling
	// always carries it; creation never does.
	if (kind === "api_error" && ctx.chatUrl) {
		return true;
	}
	return false;
}

// Pick the `api_error` lead-in: creation (no chatUrl) blames inputs/
// connectivity; run-phase + chatStatus="error" blames the chat's
// last_error; run-phase, other status, blames polling connectivity.
function apiErrorPhrase(runPhase: boolean, ctx: FailureCommentContext): string {
	if (!runPhase) {
		return "An unexpected error occurred while running the action.";
	}
	if (ctx.chatStatus === "error") {
		return "The chat ran and ended in an error state.";
	}
	return "The Coder API returned an unexpected error while polling the chat.";
}

export interface SuccessCommentContext {
	chatUrl: string;
	// Undefined when the chat object could not be fetched (existing-chat-id
	// + wait=none + getChat failed); body omits the Status line rather than
	// rendering a literal "unknown".
	chatStatus: ChatStatus | undefined;
	marker: string;
	waitMode: "none" | "complete";
	// True when this run created the chat; false on the existing-chat-id
	// follow-up path. Drives the wait=none heading.
	chatCreated: boolean;
	// Diff fields populated only on wait=complete; the at-creation snapshot
	// has no real diff yet.
	pullRequestUrl?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}

// Build the success-path comment body. Shares the marker with the failure
// path so re-runs accumulate in one comment per target.
//
// Heading variants:
//   wait=complete + completed: "Coder Agents Chat: completed".
//   wait=complete + waiting: ambiguous phrasing (`waiting` conflates
//     "done" with "awaiting input").
//   wait=none + chatCreated: "created".
//   wait=none + !chatCreated: "message sent" (follow-up path).
//
// Per-chat spend is omitted; the chats API only exposes per-user spend,
// which is misleading at per-chat granularity.
export function buildSuccessCommentBody(ctx: SuccessCommentContext): string {
	const lines: string[] = [];

	if (ctx.waitMode === "complete" && ctx.chatStatus === "waiting") {
		// `waiting` conflates "done" and "awaiting input"; do not claim
		// completion.
		lines.push("**Coder Agents Chat: agent finished or is awaiting input**");
	} else if (ctx.waitMode === "complete" && ctx.chatStatus !== undefined) {
		lines.push(`**Coder Agents Chat: ${ctx.chatStatus}**`);
	} else if (ctx.waitMode === "complete") {
		// Safety net: waitForTerminal always returns a chat or throws, so
		// this branch should be unreachable today.
		lines.push("**Coder Agents Chat: complete**");
	} else if (ctx.chatCreated) {
		lines.push("**Coder Agents Chat: created**");
	} else {
		lines.push("**Coder Agents Chat: message sent**");
	}

	lines.push("", `Chat: ${ctx.chatUrl}`);
	if (ctx.chatStatus !== undefined) {
		lines.push(`Status: ${ctx.chatStatus}`);
	}

	// Diff fields render only on wait=complete; the at-creation snapshot
	// has no real diff. Each field is gated independently because the
	// chats API may populate some but not others.
	if (ctx.waitMode === "complete") {
		if (ctx.pullRequestUrl) {
			lines.push(`Pull request: ${ctx.pullRequestUrl}`);
		}
		if (
			typeof ctx.additions === "number" ||
			typeof ctx.deletions === "number" ||
			typeof ctx.changedFiles === "number"
		) {
			const parts: string[] = [];
			if (typeof ctx.additions === "number") {
				parts.push(`+${ctx.additions} additions`);
			}
			if (typeof ctx.deletions === "number") {
				parts.push(`-${ctx.deletions} deletions`);
			}
			if (typeof ctx.changedFiles === "number") {
				parts.push(`${ctx.changedFiles} files changed`);
			}
			lines.push(`Diff: ${parts.join(", ")}`);
		}
	}

	lines.push("", ctx.marker);
	return lines.join("\n");
}

// Walk every comment via `octokit.paginate` and return the most recent one
// matching `predicate`. Full pagination is required because the marker
// comment may sit past the default 30-per-page window on busy issues. The
// newest-first scan means re-runs collide with the most recent prior match.
export async function findCommentByPredicate(args: {
	octokit: Octokit;
	owner: string;
	repo: string;
	issueNumber: number;
	predicate: (comment: { body?: string }) => boolean;
}): Promise<{ id: number; body?: string } | undefined> {
	const all = await args.octokit.paginate(
		args.octokit.rest.issues.listComments,
		{
			owner: args.owner,
			repo: args.repo,
			issue_number: args.issueNumber,
			per_page: 100,
		},
	);
	for (let i = all.length - 1; i >= 0; i--) {
		const comment = all[i];
		if (args.predicate(comment)) {
			return comment;
		}
	}
	return undefined;
}

// Find an existing comment matching `predicate` and update it; create a new
// comment otherwise. Errors are logged, not thrown, so the comment helper
// cannot itself fail the action a second time.
//
// Concurrency: GitHub's REST API has no atomic find-or-create for comments,
// so two parallel runs can each miss the other and both create one. The next
// single re-run converges via the newest-first scan; the earlier comment is
// not cleaned up.
export async function upsertComment(args: {
	octokit: Octokit;
	owner: string;
	repo: string;
	issueNumber: number;
	body: string;
	predicate: (comment: { body?: string }) => boolean;
	logLabel?: string;
}): Promise<void> {
	const label = args.logLabel ?? "comment";
	try {
		const existing = await findCommentByPredicate({
			octokit: args.octokit,
			owner: args.owner,
			repo: args.repo,
			issueNumber: args.issueNumber,
			predicate: args.predicate,
		});
		if (existing) {
			await args.octokit.rest.issues.updateComment({
				owner: args.owner,
				repo: args.repo,
				comment_id: existing.id,
				body: args.body,
			});
			return;
		}
		await args.octokit.rest.issues.createComment({
			owner: args.owner,
			repo: args.repo,
			issue_number: args.issueNumber,
			body: args.body,
		});
	} catch (error) {
		core.error(`Failed to post ${label}: ${error}`);
	}
}

// Marker-keyed specialization of `upsertComment`. Callers that only need
// marker-based matching can skip assembling the predicate themselves.
export async function upsertCommentByMarker(args: {
	octokit: Octokit;
	owner: string;
	repo: string;
	issueNumber: number;
	body: string;
	marker: string;
}): Promise<void> {
	await upsertComment({
		octokit: args.octokit,
		owner: args.owner,
		repo: args.repo,
		issueNumber: args.issueNumber,
		body: args.body,
		predicate: (comment) => comment.body?.includes(args.marker) ?? false,
		logLabel: "failure comment",
	});
}

// Deployment-level agents URL for the "view agents" link in the failure body.
// We use the deployment list because a creation failure has no chat ID.
export function buildDeploymentAgentsUrl(coderURL: string): string {
	return `${normalizeBaseUrl(coderURL)}/agents`;
}
