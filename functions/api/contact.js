/*
 * POST /api/contact  -  contact form backend for the Roberts Renovations site
 * on Cloudflare Pages.
 *
 * Cloudflare Pages turns every file under functions/ into a route, so this
 * file answers /api/contact. There is no build step, no npm, and no wrangler
 * config. Push the repo and the endpoint exists.
 *
 * Configure it with environment variables in the Cloudflare dashboard, under
 * Workers and Pages > the Pages project > Settings > Variables and secrets:
 *
 *   CONTACT_TO      Inbox that receives the messages. Must be a verified
 *                   destination address under Email Routing on the account.
 *   CONTACT_FROM    Address the mail is sent from, on the site's own domain,
 *                   for example form@example.com. Nothing has to receive mail
 *                   there, it only has to exist as a sender.
 *   CF_ACCOUNT_ID   Account ID from the Workers and Pages overview page.
 *   CF_EMAIL_TOKEN  API token with the "Email Sending: Edit" permission.
 *                   Add this one as a secret, not a plain text variable.
 *
 * Sending to a verified destination address on the same account is free on
 * every Cloudflare plan, including the free one, and does not count against
 * any sending quota.
 *
 * With any of the four missing, the endpoint answers 501 and the front end
 * falls back to opening the visitor's mail app, so the form is never a dead
 * end.
 *
 * No secrets live in this file. Every value above comes from context.env at
 * request time.
 */

const LIMITS = { name: 120, contact: 200, message: 6000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_SUBMIT_MS = 2000;

/* The three fields plus JSON overhead never come close to this in a real
   submission. A request bigger than this is rejected before its body is
   read, so nobody can hand the function a multi-megabyte payload and make it
   buffer that much into memory just to find out the message field is too
   long. */
const MAX_BODY_BYTES = 40000;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  /* _headers does not run for Function responses, so this route sets its own
     policy rather than inherit the site's. Narrow on purpose: no script, no
     external style, nothing but this response's own text and the one fixed,
     hard-coded inline style attribute the no-JS confirmation page uses (never
     built from visitor input, so 'unsafe-inline' here is not a way in). */
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
};

const withSecurityHeaders = function (headers) {
  const out = Object.assign({}, SECURITY_HEADERS, headers || {});
  return out;
};

const jsonResponse = function (data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: withSecurityHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    })
  });
};

/* A submit with JavaScript switched off lands here too, so answer that one
   with something a browser can render instead of raw JSON. */
const pageResponse = function (data, status) {
  const line = data.ok
    ? "Message sent. Thanks, we will get back to you."
    : "That message did not send. Please call or email us instead.";
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    "<title>Contact</title></head>" +
    '<body style="font:16px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem">' +
    "<p>" + line + '</p><p><a href="/">Back to the site</a></p></body></html>';
  return new Response(body, {
    status: status || 200,
    headers: withSecurityHeaders({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    })
  });
};

/* Escapes text before it goes anywhere near the HTML mail body. A message is
   whatever a stranger typed into a form on the open internet, so it is
   treated as text in every direction and never as markup. */
const escapeHtml = function (value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

/* Collapses whitespace and strips line breaks, which also stops anyone from
   smuggling extra mail headers in through the name or contact field. */
const oneLine = function (value, max) {
  return String(value == null ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
};

/* Digits and a leading + only, for building a tel: link out of whatever a
   visitor typed (spaces, dashes, brackets all get dropped). */
const phoneDigits = function (value) {
  const stripped = String(value == null ? "" : value).replace(/[^\d+]/g, "");
  const plus = stripped.charAt(0) === "+" ? "+" : "";
  return plus + stripped.replace(/\+/g, "");
};

const isEmailValue = function (value) {
  return EMAIL_RE.test(value);
};

/* Loose on purpose: this only decides whether the "contact" field is a phone
   number worth a tel: link, not whether it is a deliverable number. */
const isPhoneValue = function (value) {
  const digits = phoneDigits(value).replace(/^\+/, "");
  return digits.length >= 7 && digits.length <= 15;
};

const LABEL =
  "font:600 11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;" +
  "letter-spacing:.12em;text-transform:uppercase;color:#6E6C64";
const BODY =
  "font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#15140F";

/* A real looking email instead of a wall of unstyled text. Tables and inline
   styles, because that is still what mail clients understand: no flexbox, no
   grid, no external stylesheet, no remote images. The site's own "Site plan"
   colours (concrete grey, ink, one marking-paint orange) on a light card. */
const htmlBody = function (mail) {
  const rows = mail.facts
    .map(function (fact) {
      const value = fact.href
        ? '<a href="' + escapeHtml(fact.href) + '" style="color:#C7430C">' + escapeHtml(fact.value) + "</a>"
        : escapeHtml(fact.value);
      return (
        '<tr><td style="' + LABEL + ';padding:0 14px 10px 0;width:84px;vertical-align:top">' +
        escapeHtml(fact.label) +
        '</td><td style="' + BODY + ';padding:0 0 10px">' + value + "</td></tr>"
      );
    })
    .join("");

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + escapeHtml(mail.subject) + "</title></head>",
    '<body style="margin:0;padding:0;background:#ECEBE6">',
    /* Sits in the inbox preview line instead of the first words of the message. */
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + escapeHtml(mail.preview) + "</div>",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ECEBE6;padding:24px 12px">',
    "<tr><td align=\"center\">",
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid #DFDED7">',

    '<tr><td style="background:#15140F;padding:22px 28px">',
    "<div style=\"font:700 17px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#ECEBE6\">Roberts Renovations</div>",
    '<div style="' + LABEL + ';color:#F25C1A;padding-top:6px">New enquiry</div>',
    "</td></tr>",
    '<tr><td style="height:3px;background:#F25C1A;font-size:0;line-height:0">&nbsp;</td></tr>',

    '<tr><td style="padding:26px 28px 6px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + "</table>",
    "</td></tr>",

    '<tr><td style="padding:10px 28px 4px">',
    '<div style="' + LABEL + ';padding-bottom:8px">Message</div>',
    '<div style="border-left:3px solid #C7430C;background:#F7F6F2;padding:16px 18px;' + BODY + '">',
    mail.messageHtml,
    "</div></td></tr>",

    '<tr><td style="padding:22px 28px 28px">',
    '<a href="' + escapeHtml(mail.ctaHref) + '" ',
    'style="display:inline-block;background:#F25C1A;color:#15140F;text-decoration:none;',
    "font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:14px 22px\">",
    escapeHtml(mail.ctaLabel) + "</a>",
    "</td></tr>",

    '<tr><td style="border-top:1px solid #DFDED7;padding:16px 28px;',
    "font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#6E6C64\">",
    "Sent from the contact form on " + escapeHtml(mail.site) + ".",
    "</td></tr>",

    "</table></td></tr></table></body></html>"
  ].join("");
};

/* True only when every variable the send path needs is present. */
const configured = function (env) {
  return Boolean(env.CONTACT_TO && env.CONTACT_FROM && env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN);
};

const readFields = async function (request) {
  const type = request.headers.get("content-type") || "";
  if (type.indexOf("application/json") !== -1) {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  }
  const form = await request.formData();
  const out = {};
  form.forEach(function (value, key) { out[key] = value; });
  return out;
};

const sendMail = async function (env, mail) {
  const url =
    "https://api.cloudflare.com/client/v4/accounts/" +
    env.CF_ACCOUNT_ID +
    "/email/sending/send";
  const headers = {
    authorization: "Bearer " + env.CF_EMAIL_TOKEN,
    "content-type": "application/json"
  };
  const payload = {
    from: mail.from,
    to: env.CONTACT_TO,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  };
  if (mail.replyTo) payload.reply_to = mail.replyTo;

  let res = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(payload) });
  /* Shed the optional parts one at a time rather than lose the message. Some
     accounts reject reply_to, and an older sending API may not know html. The
     plain text body is the last thing standing, so the mail still arrives. */
  if (res.status === 400 && payload.reply_to) {
    delete payload.reply_to;
    res = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(payload) });
  }
  if (res.status === 400) {
    delete payload.html;
    res = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(payload) });
  }
  return res;
};

/* GET /api/contact reports whether the mail path is wired up. Handy on
   handover day: curl it and you know in one second whether the form will
   deliver. */
export function onRequestGet(context) {
  return jsonResponse({ configured: configured(context.env) });
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  const wantsJson = (request.headers.get("accept") || "").indexOf("application/json") !== -1;
  const respond = function (data, status) {
    return wantsJson ? jsonResponse(data, status) : pageResponse(data, status);
  };

  /* Reject an oversized body by its declared length before touching it, so a
     huge POST never gets far enough to be parsed into memory. A request
     without a content-length header falls through to readFields as before;
     Cloudflare's own edge still caps the absolute request size ahead of this
     function, this is an extra, cheap line of defence in front of that. */
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return respond({ ok: false, code: "too_large" }, 413);

  let fields;
  try {
    fields = await readFields(request);
  } catch (err) {
    return respond({ ok: false, code: "bad_request" }, 400);
  }

  /* Two cheap spam traps: a hidden field a human never sees, and a form
     filled out faster than anyone can type. Both answer as if the send
     worked, so a bot learns nothing from the response. */
  if (String(fields._gotcha || "").length) return respond({ ok: true }, 200);
  const started = Number(fields._t);
  if (started > 0 && Date.now() - started < MIN_SUBMIT_MS) return respond({ ok: true }, 200);

  const name = oneLine(fields.name, LIMITS.name);
  const contact = oneLine(fields.contact, LIMITS.contact);
  const message = String(fields.message == null ? "" : fields.message).trim().slice(0, LIMITS.message);

  const contactIsEmail = isEmailValue(contact);
  const contactIsPhone = !contactIsEmail && isPhoneValue(contact);

  const bad = [];
  if (!name) bad.push("name");
  if (!contact || (!contactIsEmail && !contactIsPhone)) bad.push("contact");
  if (!message) bad.push("message");
  if (bad.length) return respond({ ok: false, code: "invalid", fields: bad }, 422);

  if (!configured(env)) return respond({ ok: false, code: "not_configured" }, 501);

  const site = new URL(request.url).hostname;
  const sent = new Date().toUTCString();

  /* Reply-to only makes sense when the visitor gave an email address. For a
     phone number the reply path is a phone call, not a mailto:, so the mail
     itself carries a Call button instead and the send omits reply_to. */
  const ctaHref = contactIsEmail ? "mailto:" + contact : "tel:" + phoneDigits(contact);
  const ctaLabel = contactIsEmail ? "Reply to " + name : "Call " + name;

  const mail = {
    /* A display name reads as a business rather than a bare robot address. */
    from: "Roberts Renovations website <" + env.CONTACT_FROM + ">",
    subject: "New enquiry from " + name,
    replyTo: contactIsEmail ? contact : null,
    ctaHref: ctaHref,
    ctaLabel: ctaLabel,
    site: site,
    preview: message.replace(/\s+/g, " ").slice(0, 140),
    facts: [
      { label: "Name", value: name },
      {
        label: "Contact",
        value: contact,
        href: contactIsEmail ? "mailto:" + contact : "tel:" + phoneDigits(contact)
      },
      { label: "Sent", value: sent }
    ],
    messageHtml: escapeHtml(message).replace(/\r?\n/g, "<br>"),
    /* The plain text alternative is not a leftover. Mail carrying both parts
       looks like real mail, where a text-only body is a spam signal on its
       own. */
    text: [
      "New enquiry from " + name,
      "",
      "Name:    " + name,
      "Contact: " + contact,
      "Sent:    " + sent,
      "",
      message,
      "",
      "Sent from the contact form on " + site + "."
    ].join("\n")
  };
  mail.html = htmlBody(mail);

  let res;
  try {
    res = await sendMail(env, mail);
  } catch (err) {
    console.log("contact: send threw", String(err));
    return respond({ ok: false, code: "send_failed" }, 502);
  }

  if (!res.ok) {
    /* Shows up in the dashboard log stream and in wrangler pages deployment
       tail. Reading the body is wrapped too, so a broken response stream
       cannot throw past this and skip the graceful reply below it. */
    let detail = "";
    try {
      detail = await res.text();
    } catch (readErr) {
      detail = "(could not read response body)";
    }
    console.log("contact: cloudflare returned " + res.status, detail);
    return respond({ ok: false, code: "send_failed" }, 502);
  }

  return respond({ ok: true }, 200);
}
