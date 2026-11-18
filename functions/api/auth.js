// Decap CMS GitHub OAuth - step 1: send the popup to GitHub's authorize page.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response(
      'OAuth not configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Cloudflare Pages -> Settings -> Environment variables (Production), then create a new deployment.',
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', url.origin + '/api/auth/callback');
  authorize.searchParams.set('scope', url.searchParams.get('scope') || 'repo');
  authorize.searchParams.set('state', crypto.randomUUID());
  return Response.redirect(authorize.toString(), 302);
}
