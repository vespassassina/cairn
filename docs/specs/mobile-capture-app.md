# Spec: the mobile capture app

The owner's direction of 2026-09-24: a simple mobile-first web app to add notes, images and files. Chosen shape: a progressive web app served by the same container under `/m`. ADR to write on agreement: ADR-080, amending ADR-009 for one service worker.

## Goal

On a phone, Cairn is an icon; tapping it opens a capture box in under a second; sharing a photo or a link from any app sends it to the Inbox; a note written without signal arrives when the signal returns.

## Success test

Install on an Android phone and an iPhone from the browser's "Add to Home Screen". Open it in airplane mode, type a note, send: it says "Queued". Turn the radio on: within a minute it says "Sent" and the note is under Inbox. On Android, share a photo from the gallery to Cairn: it lands in the Inbox with the photo. On iPhone, run the documented Shortcut from the share sheet: same.

## Scope

1. Routes under `/m`: capture, today, recent, search, read a page and append to it, sign in.
2. A manifest with `start_url: /m`, `display: standalone`, and a Web Share Target.
3. One service worker: caches the shell, queues failed drop posts, retries.
4. The person's guide: install steps for both platforms and the iOS Shortcut recipe.

## Non-goals

1. No editing of existing page bodies beyond appending. Editing stays in the console.
2. No offline reading of the wiki. The cache holds the app shell and the queue, not pages.
3. No native app, no push notifications, no framework, no build step (ADR-006, ADR-009).
4. No separate authentication. The same session cookie and OAuth flow as the console.

## Constraints

ADR-009 rule 3 (no client-side application: this spec asks for one exception, one service worker, and every screen still works with JavaScript off, minus the offline queue). ADR-056 (phone layout). ADR-017 (auth on a non-loopback bind). Hard rule 13 (web-standard handlers). The dropbox spec: `/m` posts to `createDrop`, nothing else.

## Design

### Screens

1. `/m`: the capture form. A textarea with focus on load, a file input with `accept="image/*,application/pdf,*/*"` and `capture="environment"` on a second camera button, a tags field folded under "More", a Send button. On success, a one-line confirmation with a link to the drop and the form cleared. Under 30 KB including CSS.
2. `/m/today`: today's daily note (ADR-075) rendered, with an append box at the bottom that posts `update_page` in append mode. "Start today's note" button when none exists. Previous and next day links.
3. `/m/recent`: the last 20 pages changed, one line each.
4. `/m/search`: the same `searchPages`, results as a plain list.
5. `/m/p/:id`: the page rendered read-only with an append box. A link "Open in console".
6. `/m/login`: the console's sign-in, styled for a phone.

A bottom bar with four items: Capture, Today, Recent, Search. All server-rendered with the existing layout components and artifactkit tokens; a `/m` layout variant with no side columns.

### Manifest

`/m/manifest.webmanifest`: `name`, `short_name: "Cairn"`, `start_url: "/m"`, `display: "standalone"`, icons from the existing set, and:

```json
"share_target": {
  "action": "/m/share",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": { "title": "title", "text": "text", "url": "url", "files": [{ "name": "files", "accept": ["image/*", "application/pdf"] }] }
}
```

`POST /m/share` calls `createDrop` and redirects to the drop. iOS has no share target; the guide gives a Shortcut: "Get Contents of URL", POST multipart to `/api/v1/drops` with a drop token, shown in the share sheet. The console's drop-token screen prints the Shortcut's three fields ready to copy.

### Service worker

`/m/sw.js`, plain JavaScript, no dependencies, served with `Service-Worker-Allowed: /m/`. It:

1. Pre-caches `/m`, the CSS and the icons; network first for everything else.
2. Intercepts `POST /m` and `POST /m/share`. On network failure, stores the form data in IndexedDB and answers a small "Queued" page. Registers a Background Sync tag where supported; otherwise retries on the next `fetch` event or page open.
3. Never caches a response to an authenticated GET beyond the shell.

Without the worker (JavaScript off, or a browser without it) every form still posts and the page simply shows the server's answer or the network error.

### Security

Same-origin check on every POST as the console does. The share target posts from the browser's own origin. The worker holds the queue in the app's own storage; a signed-out device clears it on sign-out.

## Acceptance criteria

1. `GET /m` returns the capture screen in under 30 KB, works signed in on localhost without sign-in (ADR-010) and redirects to `/m/login` elsewhere.
2. `POST /m` with text creates a drop and shows the confirmation; with a file, attaches it; with attachments off and a file, shows the `attachments_off` message and keeps the text in the form.
3. `POST /m/share` from a multipart body shaped like Chrome's share target creates a drop with the shared title, text, url (as a source) and file.
4. `/m/today` renders the daily note, appends through the append form, and the previous/next links land on the neighbouring dates.
5. `/m/manifest.webmanifest` validates in Chrome's application panel: installable, share target listed. Lighthouse PWA audit passes installability.
6. With the worker registered and the network blocked, a capture is queued in IndexedDB; unblocking the network delivers it within a minute; the drop's revision time is the delivery time and the body carries the capture time as its first line.
7. Every `/m` screen renders and posts with JavaScript disabled.
8. Screenshots at 375 px and 430 px width for each screen, light and dark, in the changelog entry or the PR.
9. Guide sections for Android install and share, iPhone install and Shortcut, in the person's guide and `docs/AGENT-OPERATE.md`.

## Risks and open questions

1. iOS installs PWAs from Safari only, and clears their storage after inactivity in some versions; the queue is a convenience, not a guarantee. The screen says "Queued, keep the app until it says Sent".
2. Background Sync is Chromium-only. The fallback retry runs when the app opens, which on a phone is often enough.
3. The service worker is the first client-side component in Cairn. ADR-080 must state its boundary: one file, one job, no page rendering, no data cache beyond the shell and the queue.
