import { createPkcePair, randomState } from "../oauth/pkce.js";
import { awaitLoopbackCode } from "../oauth/loopback.js";
import { createInterface } from "node:readline/promises";

export interface OAuthConfig {
	/** Default OAuth client id. Subclasses can override `resolveClientId` to fetch a live value. */
	readonly clientId: string;
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly redirectUri: string;
	/** Loopback port (ignored when `manualPaste` is true). */
	readonly loopbackPort: number;
	/** Path the loopback server listens on (ignored when `manualPaste` is true). */
	readonly loopbackPath: string;
	readonly scope: string;
	/** Extra query parameters to append to the authorize URL (e.g. `prompt=login`, `code=true`). */
	readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
	/** When true, skip the loopback HTTP server and prompt the user to paste the
	 *  authorization code returned to a hosted callback. The pasted value is
	 *  expected to look like `<code>#<state>` (Anthropic's format). */
	readonly manualPaste?: boolean;
}

export interface LoginOptions {
	open?: (url: string) => void;
}

export interface SendRequestOptions {
	/** The model name to use for the primer call. */
	model?: string;
	/** The primer message text to send. */
	primer?: string;
	/** When true, consume at least one token from the response (used to anchor
	 *  rolling rate-limit windows like Codex's 5h window). When false (default),
	 *  the agent should return as soon as response headers are available without
	 *  draining the body. */
	consume?: boolean;
}

export interface RawPrimerResponse {
	status: number;
	headers: Record<string, string>;
}

/** Unified quota snapshot. Different providers populate different subsets:
 *
 *  - Codex returns rolling-percentage windows (`primary`, `secondary`).
 *  - Claude returns request/token rate buckets and (eventually) a 5h session window.
 *  - Future agents may surface other windows or buckets — extend by id. */
export interface QuotaSnapshot {
	/** All windows keyed by stable id (e.g. `"primary"`, `"secondary"`, `"session-5h"`). */
	windows: Record<string, QuotaWindow>;
	/** All rate buckets keyed by stable id (e.g. `"requests"`, `"tokens"`). */
	buckets: Record<string, RateBucket>;
	/** Top-level retry hint if the server told us to back off. */
	retryAfterSeconds?: number;
	/** The exact subset of headers we kept, lowercased. */
	raw: Record<string, string>;
}

export interface QuotaWindow {
	label?: string;
	usedPercent?: number;
	windowMinutes?: number;
	resetAfterSeconds?: number;
	resetAt?: string;
}

export interface RateBucket {
	label?: string;
	limit?: number;
	remaining?: number;
	resetAt?: string;
}

export interface ExchangeArgs {
	clientId: string;
	code: string;
	verifier: string;
	state: string;
	/** Account id under which to persist the resulting tokens. */
	accountId: string;
}

export abstract class CodeAgent {
	/** Stable machine id, e.g. `"codex"` or `"claude"`. Used as snapshot file name and config key. */
	abstract readonly id: string;
	/** Human-readable name for log lines and CLI help. */
	abstract readonly displayName: string;
	/** Default model used for the primer call. Users may override per-agent in config. */
	abstract readonly defaultModel: string;
	/** Default primer message body sent to the agent. Users may override per-agent in config. */
	abstract readonly defaultPrimer: string;
	/** Id of the rolling "session" window in {@link QuotaSnapshot.windows} that the
	 *  scheduler should chain follow-up primers against (e.g. Codex `"primary"`,
	 *  Claude `"session-5h"`). Leave undefined to disable follow-ups for this agent. */
	readonly followUpWindowId?: string;

	/** Per-agent OAuth endpoints and parameters. */
	protected abstract readonly oauth: OAuthConfig;

	/** Resolve the OAuth client id at login time. Override for live-discovered ids
	 *  (e.g. Claude fetches the public client id from a remote asset). */
	protected async resolveClientId(): Promise<string> {
		return this.oauth.clientId;
	}

	/** Template-method implementation of the full PKCE / loopback / authorize flow.
	 *  Subclasses provide the `exchangeAndPersist` step. The exchanged tokens
	 *  are persisted under `accountId`. */
	async login(accountId: string, opts: LoginOptions = {}): Promise<void> {
		const clientId = await this.resolveClientId();
		const { verifier, challenge } = createPkcePair();
		const state = randomState();
		const url = new URL(this.oauth.authorizeUrl);
		const params = url.searchParams;
		for (const [k, v] of Object.entries(this.oauth.extraAuthorizeParams ?? {}))
			params.set(k, v);
		params.set("client_id", clientId);
		params.set("response_type", "code");
		params.set("redirect_uri", this.oauth.redirectUri);
		params.set("scope", this.oauth.scope);
		params.set("code_challenge", challenge);
		params.set("code_challenge_method", "S256");
		params.set("state", state);

		console.log(`\nOpen this URL in your browser to authorize ${this.displayName}:\n`);
		console.log("  " + url.toString() + "\n");
		opts.open?.(url.toString());

		let code: string;
		if (this.oauth.manualPaste) {
			const pasted = await this.promptForCode();
			const [authCode, returnedState] = pasted.split("#");
			if (!authCode)
				throw new Error(`No authorization code provided for ${this.id}`);
			if (returnedState && returnedState !== state)
				throw new Error(`State mismatch in ${this.id} OAuth callback`);
			code = authCode;
		}
		else {
			const cb = await awaitLoopbackCode({ port: this.oauth.loopbackPort, pathPrefix: this.oauth.loopbackPath });
			if (cb.state !== state)
				throw new Error(`State mismatch in ${this.id} OAuth callback`);
			code = cb.code;
		}

		await this.exchangeAndPersist({ clientId, code, verifier, state, accountId });
	}

	private async promptForCode(): Promise<string> {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await rl.question("Paste the authorization code from the browser: ");
			return answer.trim();
		}
		finally {
			rl.close();
		}
	}

	/** Trade an authorization code for tokens and persist them under `args.accountId`. */
	protected abstract exchangeAndPersist(args: ExchangeArgs): Promise<void>;

	/** Whether stored credentials exist for the given account. */
	abstract isAuthenticated(accountId: string): Promise<boolean>;

	/** Issue the minimal primer HTTP call using credentials for `accountId`.
	 *  Implementations must drain the response body. */
	abstract sendRequest(accountId: string, opts: SendRequestOptions): Promise<RawPrimerResponse>;

	/** Filter the full response headers down to the ones this agent treats as quota-related. */
	abstract selectQuotaHeaders(headers: Record<string, string>): Record<string, string>;

	/** Convert selected headers into the unified `QuotaSnapshot` shape. */
	abstract parseQuota(headers: Record<string, string>): QuotaSnapshot;

	/** One-line summary used for scheduler log output. */
	abstract summarize(snapshot: QuotaSnapshot): string;

	/** Predicate used by the first-run header dump to keep the log focused. */
	abstract isInterestingHeader(name: string): boolean;
}
