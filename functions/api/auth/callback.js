// Decap CMS <-> GitHub OAuth callback for Cloudflare Pages.
// Exchanges ?code for an access token, then performs the exact
// postMessage handshake Decap expects (decap-cms-lib-auth netlify-auth.js):
//   popup -> CMS:  'authorizing:github'
//   CMS -> popup:  'authorizing:github'   (echo)
//   popup -> CMS:  'authorization:github:success:{"token":"...","provider":"github"}'
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const page = (body, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const errorPage = (msg) => page(
    '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">' +
    '<h2>CMS login error</h2><pre style="white-space:pre-wrap">' + esc(msg) +
    '</pre><p>Copy this page and send it to your developer.</p></body></html>'
  );

  const ghError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (ghError) return errorPage('GitHub said: ' + ghError);

  const code = url.searchParams.get('code');
  if (!code) return errorPage('No ?code in the URL. Open the CMS at /admin/ and press "Login with GitHub".');

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return errorPage('OAuth env vars missing: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Cloudflare Pages (Production), then retry the deployment.');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: code,
      redirect_uri: url.origin + '/api/auth/callback'
    })
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenData.access_token) {
    return errorPage('GitHub token exchange failed: ' + JSON.stringify(tokenData));
  }

  const payload = { token: tokenData.access_token, provider: 'github' };
  const html = '<!DOCTYPE html><html><body>' +
    '<p style="font-family:sans-serif">Login complete - closing...</p>' +
    '<script>\n' +
    '(function () {\n' +
    '  var payload = ' + JSON.stringify(payload) + ';\n' +
    '  function finish(target) {\n' +
    '    if (window.opener) {\n' +
    '      window.opener.postMessage("authorization:github:success:" + JSON.stringify(payload), target || "*");\n' +
    '    }\n' +
    '    setTimeout(function () { window.close(); }, 300);\n' +
    '  }\n' +
    '  window.addEventListener("message", function (e) {\n' +
    '    if (e.data === "authorizing:github") finish(e.origin);\n' +
    '  }, false);\n' +
    '  if (window.opener) { window.opener.postMessage("authorizing:github", "*"); }\n' +
    '  setTimeout(function () { finish("*"); }, 2500);\n' +
    '})();\n' +
    '</script></body></html>';
  return page(html);
}
