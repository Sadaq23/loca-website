#!/usr/bin/env bash
# ============================================================
# LOCA WEBSITE REBUILD - PHASE 9: CMS LOGIN SERVER (OAUTH)
# Run from your project root (the folder containing src/),
# AFTER phase 8. Safe to run more than once.
#
# WHY THIS PHASE EXISTS
#   The admin panel at /admin (Decap CMS) could never log in.
#   Decap's GitHub login always needs a tiny SERVER that holds
#   the GitHub client secret - the browser CMS talks to that
#   server during login. Your config already points at it
#   (base_url + auth_endpoint: api/auth) and the credentials
#   are already in Cloudflare (GITHUB_CLIENT_ID /
#   GITHUB_CLIENT_SECRET) - but the server itself was never
#   deployed. So Cloudflare served the homepage at /api/auth,
#   the login popup showed your website, and login never
#   finished. (Verified against decap-cms-lib-auth 3.x source.)
#
# WHAT THIS PHASE DOES
#   1. Creates functions/api/auth/[[route]].js - the missing
#      login server as a Cloudflare Pages Function. It speaks
#      the exact postMessage handshake Decap CMS expects.
#   2. Fixes public/admin/config.yml:
#        - site_url / display_url point to the site root again
#          (not /admin/ - they are only "view site" links)
#        - removes leftovers of the old PKCE attempt
#          (Decap only supports PKCE for GitLab, not GitHub)
#   3. Adds a friendly public/404.html (if you have none) so
#      unknown paths show "not found" instead of silently
#      rendering the homepage and hiding bugs like this one.
#   4. Runs a verification build.
#
# WHAT YOU STILL DO BY HAND (the script prints reminders)
#   - GitHub OAuth App callback URL:
#       github.com/settings/developers -> your OAuth App ->
#       Authorization callback URL =
#       <SITE_URL>/api/auth/callback     (exact, including https)
#   - Cloudflare env vars GITHUB_CLIENT_ID and
#     GITHUB_CLIENT_SECRET must exist for the PRODUCTION env
#     (Workers & Pages -> loca-website -> Settings ->
#      Environment variables -> Production)
#   - commit + push  ->  Cloudflare rebuilds automatically
#
# Options:
#   --site-url URL    final site URL (default: auto-detected
#                     from public/admin/config.yml base_url)
#   --skip-build      do not run the verification build
# ============================================================
set -e
echo "--- PHASE 9: CMS LOGIN SERVER (fixes /admin login) ---"

SKIP_BUILD=0
SITE_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --site-url)   SITE_URL="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -f package.json ]; then
  echo "ERROR: run this from your project root (the folder with package.json)."
  exit 1
fi
if [ ! -f public/admin/config.yml ]; then
  echo "ERROR: public/admin/config.yml not found. Run phase 8 first."
  exit 1
fi

# ------------------------------------------------------------
# STEP 0: determine the site URL (from --site-url, or the
#         base_url already stored in the CMS config).
#         base_url is indented under backend:, so the grep
#         must allow leading spaces. Any accidental /admin
#         suffix is stripped - the site URL is always the root.
# ------------------------------------------------------------
if [ -z "$SITE_URL" ]; then
  SITE_URL="$(grep -m1 -E '^[[:space:]]*base_url:' public/admin/config.yml | sed 's/^[[:space:]]*base_url:[[:space:]]*//' | sed "s/[\"']//g" | sed 's:/*$::' | sed 's:/admin$::')"
fi
if [ -z "$SITE_URL" ]; then
  SITE_URL="$(grep -m1 -E '^[[:space:]]*site_url:' public/admin/config.yml | sed 's/^[[:space:]]*site_url:[[:space:]]*//' | sed "s/[\"']//g" | sed 's:/*$::' | sed 's:/admin$::')"
fi
if [ -z "$SITE_URL" ]; then
  echo "Could not auto-detect the site URL."
  read -r -p "Enter the final site URL (e.g. https://www.localliance.org): " SITE_URL
fi
case "$SITE_URL" in
  https://*|http://*) : ;;
  *) echo "  [ERROR]  '$SITE_URL' does not look like a URL (expected e.g. https://www.localliance.org)"; exit 1 ;;
esac
case "$SITE_URL" in
  */admin) echo "  [ERROR]  site URL must be the site ROOT, not the admin panel path. Got: $SITE_URL"; exit 1 ;;
esac
CALLBACK_URL="$SITE_URL/api/auth/callback"
echo "  [OK]     Site URL detected : $SITE_URL"
echo "  [OK]     OAuth callback URL: $CALLBACK_URL"
echo "           -> this EXACT value must be set in your GitHub OAuth App"
echo "              (github.com/settings/developers -> Authorization callback URL)"

# ------------------------------------------------------------
# STEP 1: fix public/admin/config.yml
#         - site_url / display_url back to the site root
#         - drop PKCE leftovers (auth_type / app_id)
#         - make sure base_url + auth_endpoint: api/auth exist
# ------------------------------------------------------------
CFG=public/admin/config.yml

sed -i 's|^site_url:.*|site_url: '"$SITE_URL"'|' "$CFG"
sed -i 's|^display_url:.*|display_url: '"$SITE_URL"'|' "$CFG"
sed -i '/^[[:space:]]*auth_type:/d' "$CFG"
sed -i '/^[[:space:]]*app_id:/d' "$CFG"

if grep -q '^  base_url:' "$CFG"; then
  sed -i 's|^  base_url:.*|  base_url: '"$SITE_URL"'|' "$CFG"
else
  sed -i '/^  branch:/a\  base_url: '"$SITE_URL" "$CFG"
  echo "  [DONE]   added base_url to backend config"
fi
if ! grep -q '^  auth_endpoint:' "$CFG"; then
  sed -i '/^  base_url:/a\  auth_endpoint: api/auth' "$CFG"
  echo "  [DONE]   added auth_endpoint: api/auth"
fi

if grep -q "^site_url: $SITE_URL\$" "$CFG" && grep -q '^  auth_endpoint: api/auth' "$CFG" \
   && ! grep -qE '^site_url:.*/admin' "$CFG" && ! grep -qE '^  base_url:.*/admin' "$CFG"; then
  echo "  [OK]     config.yml fixed (site_url = root, auth_endpoint = api/auth)"
else
  echo "  [ERROR]  config.yml verification failed - inspect $CFG"
  exit 1
fi

# ------------------------------------------------------------
# STEP 2: the login server itself
#         Cloudflare Pages Function: functions/api/auth/[[route]].js
#         Handles:
#           GET /api/auth            -> start GitHub login (popup)
#           GET /api/auth/callback   -> GitHub returns here; the
#                                       page exchanges code+secret
#                                       for a token and hands it
#                                       back to the CMS window
# ------------------------------------------------------------
mkdir -p functions/api/auth
cat << 'LOCA_FUNC_EOF' > 'functions/api/auth/[[route]].js'
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

var DEFAULT_SITE_URL = '__SITE_URL__';

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
LOCA_FUNC_EOF
sed -i "s|__SITE_URL__|$SITE_URL|g" 'functions/api/auth/[[route]].js'
echo "  [OK]     functions/api/auth/[[route]].js created (the missing login server)"

# ------------------------------------------------------------
# STEP 3: friendly 404 page (only if the project has none).
#         Without it, Cloudflare serves the HOMEPAGE for any
#         unknown path (SPA fallback), which is exactly what
#         made the broken login look so confusing.
# ------------------------------------------------------------
if ls src/pages/404.* >/dev/null 2>&1; then
  echo "  [SKIP]   you already have a 404 page in src/pages"
elif [ -f public/404.html ]; then
  echo "  [SKIP]   public/404.html already exists"
else
  cat << 'LOCA_404_EOF' > public/404.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page not found - LOCA</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f3;color:#1c2b22;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{max-width:480px;background:#fff;border-radius:14px;padding:40px;text-align:center;box-shadow:0 2px 14px rgba(0,0,0,.09)}
    h1{font-size:22px;margin:0 0 10px}p{font-size:15px;line-height:1.6;color:#4a5a50;margin:8px 0}
    a{color:#2e7d4f;font-weight:bold;text-decoration:none}a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="card">
    <h1>404 - page not found</h1>
    <p>The page you are looking for does not exist or has moved.</p>
    <p><a href="/">Back to the homepage</a></p>
  </div>
</body>
</html>
LOCA_404_EOF
  echo "  [DONE]   public/404.html created (unknown paths no longer show the homepage)"
fi

# ------------------------------------------------------------
# STEP 4: verification build
# ------------------------------------------------------------
if [ "$SKIP_BUILD" != "1" ]; then
  echo ""
  echo "Running the verification build..."
  npm run build
  if [ ! -f dist/admin/config.yml ]; then
    echo "  [ERROR]  dist/admin/config.yml missing after build."
    exit 1
  fi
  if grep -q "^site_url: $SITE_URL\$" dist/admin/config.yml; then
    echo "  [OK]     built admin config has site_url = $SITE_URL"
  else
    echo "  [ERROR]  dist/admin/config.yml still has a wrong site_url - check $CFG"
    exit 1
  fi
  if [ -f dist/404.html ]; then
    echo "  [OK]     dist/404.html present"
  else
    echo "  [WARN]   dist/404.html missing - unknown paths will show the homepage again"
  fi
  echo "  [OK]     functions/api/auth/[[route]].js in place (Cloudflare bundles it on deploy)"
fi

# ------------------------------------------------------------
# Summary + the manual steps that remain
# ------------------------------------------------------------
cat << LOCA_SUM_EOF

================ PHASE 9 DONE - CMS LOGIN SERVER ===============
  What this fixes  : /admin could not log in because the OAuth
                     login server (which holds the GitHub secret)
                     was never deployed. It now exists as a
                     Cloudflare Pages Function at /api/auth.
  OAuth callback   : $CALLBACK_URL
                     Set this EXACT value in the GitHub OAuth App:
                     github.com/settings/developers
  Env vars         : GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET must
                     exist in Cloudflare under the PRODUCTION env.

  DO THIS NOW (in order):
  1) GitHub OAuth App: set the callback URL above, Save.
  2) git add functions public
     git commit -m "Phase 9: CMS login server + CMS config fixes"
     git push
  3) Wait for the Cloudflare deploy to go "Ready".
  4) Test A: open $SITE_URL/api/auth?provider=github
       - lands on github.com authorize page = correct
       - shows your homepage   = function not deployed
       - "redirect_uri mismatch" = step 1 callback URL wrong
       - "Login server not configured" = env vars missing
  5) Test B: open $SITE_URL/admin -> "Log in with GitHub"
       -> authorize -> collections appear (News, Programs, ...).
  6) Invite the client's GitHub account: repo Settings ->
     Collaborators -> add. They log in at /admin the same way.

  Full notes: CMS-LOGIN-SETUP.txt (written next to this file)
================================================================

LOCA_SUM_EOF

# ------------------------------------------------------------
# Notes file for later reference / client handover
# ------------------------------------------------------------
cat << LOCA_NOTES_EOF > CMS-LOGIN-SETUP.txt
LOCA WEBSITE - HOW THE CLIENT LOGS INTO THE ADMIN PANEL (/admin)
=================================================================

HOW IT WORKS (one paragraph)
  /admin is a friendly editor for the website content. Every
  "Publish" saves a new version into the GitHub repo
  (Sadaq23/loca-website), and Cloudflare automatically rebuilds
  the live site about a minute later. Logging in goes through a
  small login server on the website itself (/api/auth), which
  safely holds the GitHub secret; editors never see it.

ONE-TIME SETTINGS (developer, already done in phase 9)
  1. GitHub OAuth App (github.com/settings/developers):
       Homepage URL:               $SITE_URL
       Authorization callback URL: $CALLBACK_URL
  2. Cloudflare (Workers & Pages -> loca-website -> Settings ->
     Environment variables -> Production):
       GITHUB_CLIENT_ID     = the OAuth App Client ID
       GITHUB_CLIENT_SECRET = the OAuth App Client Secret
  3. Invite editors: GitHub repo -> Settings -> Collaborators.

DAILY USE (client)
  1. Open  $SITE_URL/admin
  2. Click "Log in with GitHub", sign in with your GitHub
     account, click "Authorize".
  3. Edit News, Program pages, Resources PDFs, Site Settings.
  4. Click "Publish". The live site updates in about 1-2 minutes.
  5. Every change is saved in GitHub history - nothing is ever
     lost, and any change can be undone.

IF LOGIN EVER FAILS
  - "redirect_uri mismatch" on github.com:
      the OAuth App callback URL is not exactly
      $CALLBACK_URL
  - popup shows the website homepage:
      the login server is not deployed - redeploy the repo
  - "Login server not configured":
      GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing in
      Cloudflare Production environment variables
  - "Your account does not have access to this site":
      your GitHub account has not been added as a collaborator
      on the repo yet.
LOCA_NOTES_EOF
echo "  [OK]     CMS-LOGIN-SETUP.txt written (keep for client handover)"

if [ -t 0 ]; then
  echo ""
  read -r -p "Press Enter to close this window..." _
fi
