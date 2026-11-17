// LOCA website - contact form endpoint (Cloudflare Pages Function)
// POST /api/partner
//
// Saves every Contact / "Partner With Us" message into the LOCA D1
// database so it appears in the control panel inbox at /panel.
// Optionally also emails a copy through Resend.com when BOTH secrets
// are set: RESEND_API_KEY and NOTIFY_EMAIL.
//
// REQUIRED BINDING (dashboard -> Workers & Pages -> <project> ->
//   Settings -> Bindings -> Add -> D1):
//   DB = your D1 database (e.g. loca-inbox)
//
// OPTIONAL SECRETS (Settings -> Variables and Secrets):
//   RESEND_API_KEY   API key from a free resend.com account
//                    (verify the localliance.org domain there first)
//   NOTIFY_EMAIL     inbox that receives the copy (the client Gmail)

const json = (data, status) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch([
        db.prepare(
          "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TEXT NOT NULL, read_at INTEGER)"
        ),
        db.prepare(
          'CREATE TABLE IF NOT EXISTS panel_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
        ),
        db.prepare(
          'CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL)'
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id DESC)'),
      ])
      .then(function () { return true; })
      .catch(function (err) { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function notifyEmail(env, subject, text, replyTo) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return; // optional feature
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'LOCA Website <updates@localliance.org>',
        to: [String(env.NOTIFY_EMAIL).trim()],
        reply_to: replyTo,
        subject: subject,
        text: text,
      }),
    });
    if (!resp.ok) console.error('Notification email failed: ' + resp.status);
  } catch (err) {
    // never fail the form because of the notification copy
    console.error('Notification email error: ' + (err && err.message));
  }
}

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  // Honeypot: the "botcheck" checkbox is invisible to humans, bots
  // tick everything. Answer "success" so bots do not retry.
  if (data.botcheck) return json({ ok: true });

  // Time trap: humans need at least ~3 seconds to fill the form.
  const elapsed = parseInt(data.elapsed_ms, 10);
  if (!Number.isNaN(elapsed) && elapsed < 3000) return json({ ok: true });

  const name = String(data.name || '').trim().slice(0, 120);
  const email = String(data.email || '').trim().slice(0, 200);
  const subject = String(data.subject || 'Partnership Enquiry').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
  const message = String(data.message || '').trim().slice(0, 8000);

  if (name.length < 2) return json({ ok: false, error: 'Please enter your name.' }, 422);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ ok: false, error: 'Please enter a valid email address.' }, 422);
  if (message.length < 10)
    return json({ ok: false, error: 'Please write a slightly longer message.' }, 422);

  // Optional Turnstile human verification (only when the secret is set)
  if (env.TURNSTILE_SECRET) {
    try {
      const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET,
          response: String(data['cf-turnstile-response'] || ''),
        }).toString(),
      });
      const verdict = await verify.json();
      if (!verdict.success)
        return json({ ok: false, error: 'Spam check failed. Please try again.' }, 422);
    } catch (e) {
      return json({ ok: false, error: 'Spam check failed. Please try again.' }, 422);
    }
  }

  if (!env.DB) {
    return json(
      { ok: false, error: 'Our message inbox is being set up. Please email info@localliance.org directly.' },
      503
    );
  }

  try {
    await ensureSchema(env.DB);
    await env.DB.prepare(
      'INSERT INTO messages (name, email, subject, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(name, email, subject, message, new Date().toISOString())
      .run();
  } catch (err) {
    console.error('Inbox save failed: ' + (err && err.message));
    return json(
      { ok: false, error: 'Sorry, the message could not be delivered right now. Please email info@localliance.org.' },
      500
    );
  }

  const text = [
    'NEW MESSAGE FROM THE LOCA WEBSITE',
    '=================================',
    '',
    'Name:     ' + name,
    'Email:    ' + email,
    'Subject:  ' + subject,
    'Sent:     ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    '',
    '----------------------------------------',
    message,
    '----------------------------------------',
    '',
    'A copy is waiting in the control panel: localliance.org/panel',
  ].join('\r\n');

  await notifyEmail(env, 'LOCA website message: ' + subject, text, email);

  return json({ ok: true });
}
