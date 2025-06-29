import { loadConfig } from './core/config';
import { Router } from './core/router';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
export * as t from 'zod'; 
export * from './core/trpc-adapter';
export * from './core/context/api';
export * from './core/context/ws';
export * from './core/context/tcp';
export * from './core/middleware';
export * from './core/docs';
export { cors } from './core/cors';
export { syncLayer } from './core/syncLayer';
export { syncLayerSqlite } from './adapters/syncLayerSqlite';
export { syncLayerRedis } from './adapters/syncLayerRedis';
export * from './core/cron';

/**
 * Plugin API: Plugins receive a context object with deep integration points.
 * Example plugin signature:
 *   (ctx: PluginContext) => void | Promise<void>
 *
 * PluginContext includes:
 *   - router: the main Router instance
 *   - config: loaded config
 *   - app: the app instance (for hooks, etc.)
 *   - registerRoute: (method, path, handler) => void (optional convenience)
 *   - registerPluginRoute: (method, path, handler) => void (registers before user routes)
 *   - ...future extension points
 *
 * ctx type: Strongly typed context for plugin handlers (e.g., DiscordPluginContext)
 */
export type PluginContext<Ctx = any> = {
  router: Router;
  config: any;
  app: any;
  registerRoute?: (method: string, path: string, handler: Function) => void;
  registerPluginRoute?: (method: string, path: string, handler: Function) => void;
  ctxType?: Ctx;
};

/**
 * Context type for manual .all()/.get()/.post() handlers
 */
export type ManualRouteContext = {
  request: Request;
  req: Request;
  url: URL;
  method: string;
  error: (status?: number, message?: string) => Response;
};

async function loadUserConfig() {
  const root = process.cwd();
  const configPath = resolve(root, '.breeze/config.ts');
  if (existsSync(configPath)) {
    try {
      const config = await import(configPath);
      return config.default || config;
    } catch (e) {
      console.warn(`[Breeze] Failed to import .breeze/config.ts:`, e);
    }
  }
  return {};
}

export async function createApp(options = {}) {
  const config = await loadConfig(options);
  const router = new Router(config.apiDir, config.tcpDir, {
    debug: config.debug,
    enableTcp: config.enableTcp,
    cors: config.cors,
    cache: config.cache,
    compression: config.compression,
  });
  const port = config.port;
  const tcpPort = config.tcpPort;

  // Internal: Store plugin routes to register before user routes
  const pluginRoutes: Array<{ method: string, path: string, handler: Function }> = [];

  // Internal: Register plugin route (before user routes)
  function _registerPluginRoute(method: string, path: string, handler: Function) {
    pluginRoutes.push({ method, path, handler });
  }

  // Plugin context object
  const app = {
    async start() {
      // Register plugin routes before user routes
      for (const { method, path, handler } of pluginRoutes) {
        if (typeof router[method.toLowerCase()] === 'function') {
          router[method.toLowerCase()](path, handler);
        }
      }
      // HTTP & WebSocket
      (globalThis as any).Bun.serve({
        port,
        fetch: async (req: Request, server: any) => {
          if (server.upgrade(req)) return undefined;
          return await router.handleHttp(req);
        },
        websocket: {
          open(ws: any) {},
          message(ws: any, message: string) {},
          close(ws: any, code: number, reason: string) {},
          drain(ws: any) {},
          async upgrade(req: Request, ws: any) {
            await router.handleWebSocket(req, ws);
          },
        },
      });

      // TCP (only if enabled)
      if (config.enableTcp) {
        (globalThis as any).Bun.listen({
          hostname: '0.0.0.0',
          port: tcpPort,
          socket: {
            open(socket: any) {
              router.handleTcp(socket);
            },
            data(socket: any, data: Uint8Array) {},
            close(socket: any) {},
            error(socket: any, error: Error) {},
          },
        });
        console.log(`HTTP/WebSocket on :${port}, TCP on :${tcpPort}`);
      } else {
        console.log(`HTTP/WebSocket on :${port}`);
      }
    },
    router,
    config,
    /**
     * Register a plugin with deep integration.
     * The plugin receives a PluginContext object.
     */
    async registerPlugin(plugin: (ctx: PluginContext) => void | Promise<void>) {
      await plugin({
        router,
        config,
        app,
        registerRoute: (method: string, path: string, handler: Function) => {
          if (typeof router[method.toLowerCase()] === 'function') {
            router[method.toLowerCase()](path, handler);
          }
        },
        registerPluginRoute: _registerPluginRoute,
      });
    },
    // Expose for plugins
    _registerPluginRoute,
    /**
     * Register a prioritized manual route (any method, wildcard supported).
     * Handler receives { request, ... } context for compatibility.
     */
    all: (path: string, handler: Function) => {
      router.all(path, handler);
    },
  };
  return app;
}

/**
 * Registers a GET and POST handler for a given path, forwarding requests to a fetch-compatible handler.
 * Usage: registerFetchHandler(router, '/api/auth/*', handler)
 *
 * @param router - The Router instance
 * @param path - The wildcard route path (e.g. '/api/auth/*')
 * @param handler - A function that takes a Fetch API Request and returns a Response
 */
export function registerFetchHandler(router: Router, path: string, handler: (req: Request) => Promise<Response> | Response) {
  if (typeof router.get === 'function') {
    router.get(path, async (req: Request) => {
      return await handler(req);
    });
  }
  if (typeof router.post === 'function') {
    router.post(path, async (req: Request) => {
      return await handler(req);
    });
  }
} 

