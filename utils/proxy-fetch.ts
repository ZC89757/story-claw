import {ProxyAgent} from "undici";

const nativeFetch = globalThis.fetch.bind(globalThis);
const proxyUrl = String(
  process.env.STORY_CLAW_PROXY_URL ||
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy ||
  "",
).trim();

let proxyDispatcher: ProxyAgent | null = null;
if (/^https?:\/\//i.test(proxyUrl)) {
  try { proxyDispatcher = new ProxyAgent(proxyUrl); } catch { proxyDispatcher = null; }
}

const noProxyRules = String(process.env.NO_PROXY || process.env.no_proxy || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

export const requestHostname = (input: any): string => {
  try {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export const isPrivateHost = (host: string): boolean => host === "localhost" || host === "::1" ||
  host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") ||
  /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);

const matchesNoProxy = (host: string): boolean => noProxyRules.some((rawRule) => {
  if (rawRule === "*") return true;
  const rule = rawRule.replace(/^https?:\/\//, "").split(":")[0].replace(/^\./, "");
  return Boolean(rule) && (host === rule || host.endsWith(`.${rule}`));
});

export const fetchDirect = nativeFetch as typeof fetch;

/** Node fetch that honors HTTP(S)_PROXY while always bypassing local/private endpoints. */
export const fetchWithEnvironmentProxy = ((input: any, init: any = {}) => {
  const host = requestHostname(input);
  const useProxy = proxyDispatcher && host && !isPrivateHost(host) && !matchesNoProxy(host);
  return nativeFetch(input, useProxy ? {...init, dispatcher: proxyDispatcher} as any : init);
}) as typeof fetch;
