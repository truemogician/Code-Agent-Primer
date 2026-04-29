import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface LoopbackResult {
	code: string;
	state: string | null;
	rawUrl: string;
}

/**
 * Spin up a one-shot HTTP server on the given port, wait for a single OAuth
 * redirect, return the parsed `code` (and `state` if present), then close.
 */
export function awaitLoopbackCode(opts: {
	port: number;
	pathPrefix: string;
	successHtml?: string;
	timeoutMs?: number;
}): Promise<LoopbackResult> {
	const { port, pathPrefix, timeoutMs = 5 * 60_000 } = opts;
	const successHtml =
		opts.successHtml ??
		"<!doctype html><meta charset=utf-8><title>Authorized</title><body style='font-family:system-ui;padding:2rem'><h1>Authorization received.</h1><p>You can close this tab and return to the terminal.</p>";

	return new Promise((resolve, reject) => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			try {
				const url = new URL(req.url ?? "/", `http://localhost:${port}`);
				if (!url.pathname.startsWith(pathPrefix)) {
					res.statusCode = 404;
					res.end("not found");
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				if (error) {
					res.statusCode = 400;
					res.end(`OAuth error: ${error}`);
					cleanup();
					reject(new Error(`OAuth error: ${error}`));
					return;
				}
				if (!code) {
					res.statusCode = 400;
					res.end("missing code");
					return;
				}
				res.statusCode = 200;
				res.setHeader("content-type", "text/html; charset=utf-8");
				res.end(successHtml);
				cleanup();
				resolve({ code, state, rawUrl: url.toString() });
			}
			catch (err) {
				cleanup();
				reject(err);
			}
		});

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			server.close();
		}

		server.on("error", (err) => {
			cleanup();
			reject(err);
		});
		server.listen(port, "127.0.0.1");
	});
}
