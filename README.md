# Roberts Renovations, website

A one-page website for Roberts Renovations, a renovation company at 4483 Ontario St, Beamsville,
ON L3J 0A9, phone (905) 869-6353.

## Stack

Plain HTML, CSS and vanilla JavaScript. No framework, no build step, no npm, no vendored libraries.
Everything in this folder is deployed exactly as it is written; there is no compile or bundle step
between this repository and the live site.

## Running it locally

Any static file server works, for example from this folder:

```
npx serve .
```

or, with Python installed:

```
python -m http.server 8080
```

Opening `index.html` directly from the file system (double-clicking it, or `file://` in the browser
address bar) also works for most of the page. The contact form's live send and the `/api/contact`
health check both need a real server, since Cloudflare Pages Functions only run once the site is
deployed (or under `wrangler pages dev`, which is optional and not required for day to day editing).

## Folder layout

| Path | Purpose |
| --- | --- |
| `index.html` | The page itself |
| `styles.css` | All styling, design tokens at the top |
| `script.js` | All behaviour: the build film, the contact form, the lightbox, and so on |
| `assets/` | Photos of finished work, and `assets/film/` for the animated build sequence |
| `fonts/` | Self-hosted font files (woff2) |
| `frames/` | Frame-by-frame stills for the scroll-scrubbed build film |
| `functions/api/contact.js` | The contact form backend, see below |
| `_headers` | Security headers and cache rules |
| `_redirects` | URL redirects |
| `robots.txt`, `sitemap.xml` | Search engine crawling and indexing rules |
| `404.html` | The not-found page |
| `favicon.svg`, `site.webmanifest` | Icon and home-screen install metadata |

## Deploying

This site is built for Cloudflare Pages. A Pages project connected to this repository's `main`
branch rebuilds automatically on every push, with an empty build command and the repository root
as the output directory, because there is nothing to build. Every other branch gets its own preview
URL at `<branch>.<project>.pages.dev`.

Pushing to `main` is the entire deploy process. There is no separate release step.

## Cache-busting with `?v=N`

`index.html` loads `styles.css` and `script.js` with a version query string, for example
`styles.css?v=2`. Cloudflare Pages caches HTML pages with revalidation, but caches CSS and
JavaScript files in the visitor's browser for a few hours by default. If a change to either file
ships without bumping its `?v=N`, visitors who already have the page open, or who visit again
within that window, keep the old file. **Bump the number on every change to `styles.css` or
`script.js`.** Images, fonts and the film frames are on a long, immutable cache instead (see
`_headers`) because those files get a new filename whenever their content changes, so they never
need a version query string.

## The contact form

The form posts to `/api/contact`, a Cloudflare Pages Function at `functions/api/contact.js`. It
needs four environment variables to actually send mail. Without them it answers `501` and the page
falls back to opening the visitor's own mail app with the message pre-filled, so the form is never
a dead end either way.

Set the variables on the **Pages project itself, not on the custom domain** (a domain can move
between projects; the variables do not travel with it):

Cloudflare dashboard path: **Workers & Pages > (the Pages project) > Settings > Variables and
secrets > Production**

| Variable | Type | Value |
| --- | --- | --- |
| `CONTACT_TO` | Text | The inbox that should receive enquiries. Must be a verified destination address under Email Routing on the same Cloudflare account. |
| `CONTACT_FROM` | Text | The address the mail is sent from, on the site's own domain, for example `form@example.com`. Nothing needs to actually receive mail at this address; it only needs to exist as a sender. |
| `CF_ACCOUNT_ID` | Text | The account ID, found on the Workers & Pages overview page. |
| `CF_EMAIL_TOKEN` | **Secret** | An API token with the "Email Sending: Edit" permission. |

After saving variables, **redeploy**. Variables only take effect on a deployment made after they
were saved: go to Deployments, open the latest one, and choose Retry deployment. Saving the
variables alone is not enough; this is the single most common reason the form reports itself as
not configured after setup.

### Verifying it is wired up

```
curl -s https://DOMAIN/api/contact
```

Replace `DOMAIN` with the live domain or the `*.pages.dev` preview URL. This should return
`{"configured":true}` once all four variables are set and a fresh deployment has gone out.
`{"configured":false}` means at least one variable is missing, misspelled, or the site has not
redeployed since it was added.

Sending mail to a verified address on the same Cloudflare account is free on every plan and does
not use a sending quota, so there is no billing step involved in getting the form working.
