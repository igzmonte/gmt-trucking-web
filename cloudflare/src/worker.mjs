function shouldTryAsset(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const { pathname } = new URL(request.url);
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

function diagnosticError(error) {
  const message = error?.stack || error?.message || String(error);
  return new Response(
    `GMT Cloudflare Worker failed to start.\n\n${message}\n\nIf this mentions a missing table, run the D1 SQL setup scripts. If it mentions a missing module or syntax error, push the latest code and redeploy.`,
    {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (env.ASSETS && shouldTryAsset(request)) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) return assetResponse;
      }
      const { handleRequest } = await import("./app.mjs");
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return diagnosticError(error);
    }
  },
};
