import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import { loadConfig } from "../config/config.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { resolveGatewayClientIp } from "./net.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
import type { RateLimiter } from "./rate-limiter.js";
import { getAuditLog } from "../security/audit-log.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
};

const RATE_LIMIT_BODY = Buffer.from(
  JSON.stringify({ error: "Too Many Requests", message: "Rate limit exceeded. Please try again later." }),
);

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Extract client IP address, considering trusted proxies and X-Forwarded-For header
 */
function getClientIp(req: IncomingMessage, trustedProxies: string[]): string {
  if (trustedProxies.length > 0) {
    const forwardedFor = req.headers["x-forwarded-for"];
    if (forwardedFor) {
      const ips = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
        .split(",")
        .map((ip) => ip.trim());
      for (const ip of ips) {
        if (!trustedProxies.includes(ip)) {
          return ip;
        }
      }
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ── Per-response CSP nonce (S2) ────────────────────────────────────────

const responseNonces = new WeakMap<ServerResponse, string>();

function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Retrieve the CSP nonce assigned to a response (for inline <script> tags). */
export function getResponseNonce(res: ServerResponse): string | undefined {
  return responseNonces.get(res);
}

/**
 * Set comprehensive security headers on HTTP responses.
 *
 * S2: Uses per-request nonce instead of 'unsafe-inline' for script-src.
 * S9: Blocks cross-origin requests (no Access-Control-Allow-Origin by default).
 */
function setSecurityHeaders(res: ServerResponse): void {
  const nonce = generateNonce();
  responseNonces.set(res, nonce);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; ` +
    `script-src 'self' 'nonce-${nonce}'; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `frame-ancestors 'none'`,
  );
}

/**
 * Handle CORS preflight and enforce same-origin policy (S9).
 * Returns true if the request was a preflight OPTIONS that was handled.
 */
function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return false;
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Content-Length", "0");
    res.end();
    return true;
  }
  return false;
}

// ── Canvas host authorization (upstream) ───────────────────────────────

function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, clientIp: string): boolean {
  for (const client of clients) {
    if (client.clientIp && client.clientIp === clientIp) {
      return true;
    }
  }
  return false;
}

async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  clients: Set<GatewayWsClient>;
}): Promise<boolean> {
  const { req, auth, trustedProxies, clients } = params;
  if (isLocalDirectRequest(req, trustedProxies)) {
    return true;
  }

  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
    });
    if (authResult.ok) {
      return true;
    }
  }

  const clientIp = resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
  });
  if (!clientIp) {
    return false;
  }
  return hasAuthorizedWsClientForIp(clients, clientIp);
}


export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const expected = hooksConfig.token;
    if (!token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      getAuditLog()?.log("hook_auth_failure", `path=${url.pathname}`, {
        ip: req.socket.remoteAddress ?? "unknown",
      });
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const runId = dispatchAgentHook(normalized.value);
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            wakeMode: mapped.action.wakeMode,
            sessionKey: mapped.action.sessionKey ?? "",
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  resolvedAuth: ResolvedGatewayAuth;
  tlsOptions?: TlsOptions;
  rateLimiter?: RateLimiter | null; // OPTIONAL: Rate limiter instance (disabled if null/undefined)
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      // S9: Handle CORS preflight — blocks cross-origin requests by default
      if (handleCors(req, res)) {
        return;
      }

      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];

      // Rate limiting (enabled by default, see S7)
      if (rateLimiter) {
        const clientIp = getClientIp(req, trustedProxies);
        const allowed = rateLimiter.tryConsume(clientIp);

        if (!allowed) {
          getAuditLog()?.log("rate_limited", `ip=${clientIp}`, { ip: clientIp });
          res.statusCode = 429;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Retry-After", "60");
          res.end(RATE_LIMIT_BODY);
          return;
        }
      }

      // Set comprehensive security headers on all responses
      setSecurityHeaders(res);

      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
        })
      ) {
        return;
      }
      if (await handleSlackHttpRequest(req, res)) {
        return;
      }
      if (handlePluginRequest && (await handlePluginRequest(req, res))) {
        return;
      }
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
          })
        ) {
          return;
        }
      }
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (isCanvasPath(url.pathname)) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
          });
          if (!ok) {
            sendUnauthorized(res);
            return;
          }
        }
        if (await handleA2uiHttpRequest(req, res)) {
          return;
        }
        if (await canvasHost.handleHttpRequest(req, res)) {
          return;
        }
      }
      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
}) {
  const { httpServer, wss, canvasHost, clients, resolvedAuth } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const configSnapshot = loadConfig();
          const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
          });
          if (!ok) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      socket.destroy();
    });
  });
}
