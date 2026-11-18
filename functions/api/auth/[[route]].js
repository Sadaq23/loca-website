// ============================================================
// Decap CMS login server for GitHub (Cloudflare Pages Function)
// Added in PHASE 9. The CMS popup talks to this server during
// login; the GitHub client secret never leaves the server.
//
// Requires environment variables (Cloudflare Pages -> Settings
// -> Environment variables, scope: PRODUCTION):
//   GITHUB_CLIENT_ID      - Client ID of the GitHub OAuth App
//   GITHUB_CLIENT_SECRET  - Client Secret of the same app
// The OAuth App callback URL must be exactly:
//   <site-url>/api/auth/callback
//
// Handshake implemented (matches decap-cms-lib-auth 3.x):
//   1. CMS opens popup at /api/auth?provider=github&scope=repo
//   2. popup announces  postMessage('authorizing:github')  to opener
//   3. CMS replies and starts listening for the result
//   4. popup redirects to github.com to authorize
//   5. GitHub returns to /api/auth/callback?code&state
//   6. this page exchanges the code (server-side secret!) and
//      posts 'authorization:github:success:{token,provider}'
//      back to the CMS window; the CMS closes the popup.
// ============================================================

var DEFAULT_SITE_URL = 'https://www.localliance.org';

function htmlHeaders() {
  var h = new Headers();
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  return h;
}

function getSiteUrl(env) {
  return String(env.CMS_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

// Origins the login result may be delivered to: the canonical
// site origin plus its non-www twin, so login works whether
// the admin panel is browsed on www or the apex domain.
function allowedOrigins(siteUrl) {
  var out = [siteUrl];
  try {
    var u = new URL(siteUrl);
    if (u.hostname.indexOf('www.') === 0) {
      out.push(u.protocol + '//' + u.hostname.slice(4) + (u.port ? ':' + u.port : ''));
    }
  } catch (e) { /* fall back to the primary origin only */ }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, bodyHtml, script) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>' + esc(title) + ' - LOCA CMS</title>' +
    '<style>' +
    'body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f3;color:#1c2b22;' +
    'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}' +
    '.card{max-width:560px;background:#fff;border-radius:14px;padding:36px 40px;' +
    'box-shadow:0 2px 14px rgba(0,0,0,.09)}' +
    'h1{font-size:18px;margin:0 0 14px}p{font-size:14px;line-height:1.65;margin:8px 0}' +
    'code{background:#eef2ec;padding:2px 6px;border-radius:4px;font-size:13px}' +
    '</style></head><body><div class="card"><h1>' + esc(title) + '</h1>' +
    bodyHtml + '</div>' + (script || '') + '</body></html>';
}

function postResultScript(msg, origins) {
  return '<script>(function(){var msg=' + JSON.stringify(msg) + ';' +
    'var targets=' + JSON.stringify(origins) + ';' +
    'for(var i=0;i<targets.length;i++){try{window.opener.postMessage(msg,targets[i]);}catch(e){}}' +
    'setTimeout(function(){try{window.close();}catch(e){}},800);})();</script>';
}

function errorPage(origins, headline, detail) {
  var payload = { error: 'oauth', error_description: detail, message: detail };
  var msg = 'authorization:github:error:' + JSON.stringify(payload);
  var body = '<p><strong>' + esc(detail) + '</strong></p>' +
    '<p>You can close this window, then try again from <code>/admin</code>.</p>';
  return page(headline, body, postResultScript(msg, origins));
}

// GET /api/auth  - Decap CMS opens this in a popup.
function handleStart(context, siteUrl) {
  var env = context.env;
  var url = new URL(context.request.url);
  var origins = allowedOrigins(siteUrl);

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response(errorPage(origins, 'Login server not configured',
      'GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing. Set both in Cloudflare -> ' +
      'Workers & Pages -> loca-website -> Settings -> Environment variables, for the ' +
      'Production environment, then redeploy.'), { headers: htmlHeaders() });
  }

  var provider = url.searchParams.get('provider') || 'github';
  if (provider !== 'github') {
    return new Response(errorPage(origins, 'Unsupported provider',
      'This login server only supports GitHub.'), { headers: htmlHeaders() });
  }
  var rawScope = url.searchParams.get('scope') || 'repo';
  var scope = rawScope === 'public_repo' ? 'public_repo' : 'repo';

  var state = crypto.randomUUID() + crypto.randomUUID();
  var redirectUri = siteUrl + '/api/auth/callback';
  var authorizeUrl = 'https://github.com/login/oauth/authorize' +
    '?client_id=' + encodeURIComponent(env.GITHUB_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&scope=' + encodeURIComponent(scope) +
    '&state=' + encodeURIComponent(state);

  var headers = htmlHeaders();
  headers.append('Set-Cookie',
    'loca_oauth_state=' + state + '; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600');

  // Announce the handshake to the CMS first, then continue to GitHub.
  var script = '<script>(function(){' +
    'try{window.opener.postMessage("authorizing:github","*");}catch(e){}' +
    'window.location.replace(' + JSON.stringify(authorizeUrl) + ');})();</script>';
  var html = page('Signing you in...',
    '<p>Taking you to GitHub to authorize access&hellip;</p>', script);
  return new Response(html, { headers: headers });
}

// GET /api/auth/callback  - GitHub redirects back here.
async function handleCallback(context, siteUrl) {
  var env = context.env;
  var url = new URL(context.request.url);
  var origins = allowedOrigins(siteUrl);

  var code = url.searchParams.get('code') || '';
  var state = url.searchParams.get('state') || '';
  var cookie = context.request.headers.get('cookie') || '';
  var match = cookie.match(/(?:^|;\s*)loca_oauth_state=([^;]+)/);
  var cookieState = match ? match[1] : '';

  if (!code) {
    return new Response(errorPage(origins, 'Login failed',
      'GitHub did not return an authorization code. Close this window and try again ' +
      'from /admin.'), { headers: htmlHeaders() });
  }
  if (!cookieState || cookieState !== state) {
    return new Response(errorPage(origins, 'Login failed',
      'Security check failed (state mismatch) or the login session expired. Close this ' +
      'window and log in again from /admin.'), { headers: htmlHeaders() });
  }

  var data = {};
  try {
    var res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': 'loca-website-cms-login'
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: code,
        redirect_uri: siteUrl + '/api/auth/callback',
        state: state
      })
    });
    data = await res.json();
  } catch (e) {
    data = { error: 'network', error_description: 'Token exchange request failed: ' + e.message };
  }

  if (!data.access_token) {
    return new Response(errorPage(origins, 'Login failed',
      'GitHub did not return an access token: ' +
      (data.error_description || data.error || 'unknown error') +
      '. If the message mentions redirect_uri, the GitHub OAuth App callback URL does not ' +
      'match ' + siteUrl + '/api/auth/callback'), { headers: htmlHeaders() });
  }

  var msg = 'authorization:github:success:' +
    JSON.stringify({ token: data.access_token, provider: 'github' });
  var html = page('Login successful',
    '<p>Access granted. Closing this window&hellip;</p>',
    postResultScript(msg, origins));
  return new Response(html, { headers: htmlHeaders() });
}

export async function onRequestGet(context) {
  var siteUrl = getSiteUrl(context.env);
  var route = (context.params && context.params.route) || '';
  if (route === '') return handleStart(context, siteUrl);
  if (route === 'callback') return await handleCallback(context, siteUrl);
  return new Response(page('Not found', '<p>Unknown login route.</p>'),
    { status: 404, headers: htmlHeaders() });
}
