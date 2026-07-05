// Equyvo — Cloudflare Pages SPA Fallback Worker
// Serves the React SPA with client-side routing support.
//
// Deployment:
//   1. Build: cd Equyvo && npm run build
//   2. Deploy to Cloudflare Pages:
//      wrangler pages deploy dist --project-name=equyvo
//   3. Add custom domain: equyvo.acronous.com
//
// Or deploy with wrangler.toml:
//   name = "equyvo"
//   compatibility_date = "2026-05-30"
//   main = "_worker.js"
//   assets = { directory = ".", not_found_handling = "single-page-application" }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      const response = await env.ASSETS.fetch(request);
      if (response.status === 404) {
        const indexResponse = await env.ASSETS.fetch(
          new Request(new URL('/index.html', request.url), request)
        );
        return new Response(indexResponse.body, {
          status: 200,
          headers: indexResponse.headers,
        });
      }
      return response;
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  },
};
