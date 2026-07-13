import { handleRequest } from "./app.mjs";

function shouldTryAsset(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const { pathname } = new URL(request.url);
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

export default {
  async fetch(request, env, ctx) {
    if (env.ASSETS && shouldTryAsset(request)) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }
    return handleRequest(request, env, ctx);
  },
};
