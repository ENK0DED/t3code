import { next, rewrite } from "@vercel/functions";

export type HostedWebChannel = "latest" | "nightly";

export const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";

const DEFAULT_ROUTER_HOST = "app.t3.codes";
const DEFAULT_CHANNEL_ORIGINS = {
  latest: "https://latest.app.t3.codes",
  nightly: "https://nightly.app.t3.codes",
} as const satisfies Record<HostedWebChannel, string>;

export interface ChannelRouterConfig {
  readonly routerHost: string;
  readonly channelOrigins: Record<HostedWebChannel, string>;
}

export interface ChannelSelection {
  readonly channel: HostedWebChannel;
  readonly setCookie: boolean;
  readonly nextPath: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readChannelRouterConfig(): ChannelRouterConfig {
  return {
    routerHost: envValue("T3CODE_WEB_ROUTER_HOST") ?? DEFAULT_ROUTER_HOST,
    channelOrigins: {
      latest: envValue("T3CODE_WEB_LATEST_ORIGIN") ?? DEFAULT_CHANNEL_ORIGINS.latest,
      nightly: envValue("T3CODE_WEB_NIGHTLY_ORIGIN") ?? DEFAULT_CHANNEL_ORIGINS.nightly,
    },
  };
}

export function normalizeChannel(value: string | null | undefined): HostedWebChannel | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "latest") return "latest";
  if (normalized === "nightly") return "nightly";
  return null;
}

export function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;

  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (rawKey?.trim() !== name) continue;
    return rawValue.join("=").trim() || null;
  }

  return null;
}

function normalizeHost(value: string | null): string | null {
  const host = value?.split(":")[0]?.trim().toLowerCase();
  return host ? host : null;
}

export function isRouterHost(hostHeader: string | null, routerHost: string): boolean {
  const host = normalizeHost(hostHeader);
  const router = normalizeHost(routerHost);
  return host !== null && host === router;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeNextPath(value: string | null): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes(":") ||
    hasControlCharacter(value)
  ) {
    return "/";
  }

  return value;
}

export function selectChannel(request: Request): ChannelSelection {
  const url = new URL(request.url);

  if (url.pathname === "/__t3code/channel") {
    return {
      channel: normalizeChannel(url.searchParams.get("channel")) ?? "latest",
      setCookie: true,
      nextPath: safeNextPath(url.searchParams.get("next")),
    };
  }

  return {
    channel:
      normalizeChannel(
        parseCookieValue(request.headers.get("cookie"), HOSTED_WEB_CHANNEL_COOKIE),
      ) ?? "latest",
    setCookie: false,
    nextPath: `${url.pathname}${url.search}`,
  };
}

function channelCookie(channel: HostedWebChannel): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function buildRewriteUrl(request: Request, origin: string): URL {
  const requestUrl = new URL(request.url);
  const target = new URL(origin);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  target.hash = "";
  return target;
}

export const config = {
  matcher: "/:path*",
};

export default function middleware(request: Request): Response {
  const routerConfig = readChannelRouterConfig();
  if (!isRouterHost(request.headers.get("host"), routerConfig.routerHost)) {
    return next();
  }

  const selection = selectChannel(request);

  if (selection.setCookie) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: selection.nextPath,
        "Set-Cookie": channelCookie(selection.channel),
      },
    });
  }

  return rewrite(buildRewriteUrl(request, routerConfig.channelOrigins[selection.channel]));
}
