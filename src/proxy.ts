import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Bun replaces the bare "undici" fetch with a native implementation that ignores dispatchers.
import { Agent, ProxyAgent, fetch as originalFetch, type Dispatcher, type RequestInit, type Response } from "undici/index.js";
import { loadConfig, type Config } from "./storage/config.js";

const exec = promisify(execFile);
const dispatchers = new Map<string, Dispatcher>();
const systemProxies = new Map<string, Promise<string>>();
let config: Promise<Config> | undefined;

export function bypassesProxy(url: URL, rules: string): boolean {
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	for (const rule of rules.toLowerCase().split(/[\s,;]+/).filter(Boolean)) {
		if (rule === "*")
			return true;
		if (rule === "<local>" && !url.hostname.includes("."))
			return true;
		const match = rule.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
		if (!match || (match[2] && match[2] !== port))
			continue;
		const host = match[1];
		const pattern = host.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		if (new RegExp(`^${host.startsWith(".") ? ".*" : ""}${pattern}$`, "i").test(url.hostname))
			return true;
	}
	return false;
}

async function resolveOsProxy(url: URL): Promise<string> {
	if (process.platform === "win32") {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"$target = [Uri]$env:PRIMER_PROXY_TARGET",
			"$proxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($target)",
			"if ($null -eq $proxy) { throw 'System proxy resolution failed' }",
			"if ($proxy.AbsoluteUri -ne $target.AbsoluteUri) { [Console]::Out.Write($proxy.AbsoluteUri) }",
		].join("; ");
		try {
			const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				windowsHide: true,
				timeout: 15_000,
				env: { ...process.env, PRIMER_PROXY_TARGET: url.href },
			});
			return stdout.trim();
		}
		catch {
			throw new Error("Could not resolve Windows system proxy settings. Configure an explicit proxy or use config proxy false.");
		}
	}
	if (process.platform === "darwin") {
		const { stdout } = await exec("/usr/sbin/scutil", ["--proxy"], { timeout: 5_000 });
		const values = new Map([...stdout.matchAll(/^\s+(\w+)\s+:\s+([^\r\n]+)$/gm)].map(m => [m[1], m[2].trim()]));
		const exceptions = [...(stdout.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/)?.[1] ?? "").matchAll(/\d+\s*:\s*(\S+)/g)].map(m => m[1]);
		if (values.get("ExcludeSimpleHostnames") === "1")
			exceptions.push("<local>");
		if (bypassesProxy(url, exceptions.join(",")))
			return "";
		if (values.get("ProxyAutoConfigEnable") === "1" || values.get("ProxyAutoDiscoveryEnable") === "1")
			throw new Error("macOS automatic proxy configuration requires an explicit proxy URL. Use config proxy <url>.");
		const prefix = url.protocol === "https:" ? "HTTPS" : "HTTP";
		if (values.get(`${prefix}Enable`) !== "1") {
			if (values.get("SOCKSEnable") === "1")
				throw new Error("SOCKS proxies are not supported. Use config proxy <url> with an HTTP(S) proxy.");
			return "";
		}
		const host = values.get(`${prefix}Proxy`);
		const port = values.get(`${prefix}Port`);
		if (!host || !port)
			throw new Error("System proxy settings are missing a host or port.");
		return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
	}
	return "";
}

export async function fetch(input: string | URL, init?: RequestInit): Promise<Response> {
	const { proxy: settings } = await (config ??= loadConfig());
	const url = new URL(input);
	let proxy = "";
	if (settings.mode === "custom")
		proxy = settings.url;
	else if (settings.mode === "system") {
		const env = process.env;
		if (!bypassesProxy(url, env.no_proxy || env.NO_PROXY || "")) {
			proxy = (url.protocol === "https:" ? env.https_proxy || env.HTTPS_PROXY : undefined)
				|| env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY || "";
			if (!proxy) {
				let resolved = systemProxies.get(url.href);
				if (!resolved) {
					resolved = resolveOsProxy(url).catch(err => {
						systemProxies.delete(url.href);
						throw err;
					});
					systemProxies.set(url.href, resolved);
				}
				proxy = await resolved;
			}
		}
	}
	if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol))
		throw new Error("Only HTTP(S) proxies are supported. Configure config proxy <url> or config proxy false.");
	let dispatcher = dispatchers.get(proxy);
	if (!dispatcher) {
		dispatcher = proxy ? new ProxyAgent(proxy) : new Agent();
		dispatchers.set(proxy, dispatcher);
	}
	return originalFetch(input, { ...init, dispatcher });
}
