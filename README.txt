DE.25 by Harshali — Website Demo (Cakes, Savouries, Sips)
==========================================================

This is a working demo of the DE.25 website: real menu, real photos, a
server-authoritative cart/checkout, automatic courier booking through
Borzo's Business API (demo by default, Borzo's sandbox with a free test
token, real riders once Borzo onboarding is done), a constrained
"Food Guide" assistant that only ever answers from DE.25's own menu data,
a live owner-facing orders dashboard, and an order-notification system
(WhatsApp to the owner and the customer) that stays in a safe demo mode
until real credentials are added. The product catalog, order storage, and
admin login are all built the same way: a zero-setup default (a JSON file
and a shared token) with a real backend (Google Sheets, Supabase Postgres,
Supabase Auth) ready to switch on when you want it — see PRODUCT CATALOG,
ORDER STORAGE and ADMIN LOGIN below.

The customer-facing site and the owner dashboard are the same Express app
and always live on one domain: /admin/ is just another path this same
server serves, right alongside / and /api/*. Deploying this project
anywhere (a VPS, Render, Railway, Fly.io, etc.) and pointing your domain
at it automatically gives you https://yourdomain.com for customers and
https://yourdomain.com/admin/ for the owner — there's nothing extra to
configure for that, and nothing to keep in sync between "two sites"
because there's only ever the one server.

The full menu lives on the homepage (public/index.html, filterable by
category), and every category also gets its own dedicated landing page:
public/cakes.html, public/pastries.html, public/savouries.html and
public/sips.html — each linked directly from the main nav (Cakes /
Pastries / Savouries / Sips) and the homepage's category cards. They all
reuse the exact same header, footer, cart, checkout and product-detail
code as the homepage — menu.js just locks the grid to one or more
categories via a `data-category-lock` attribute on <body>:
  - cakes.html    -> data-category-lock="cakes"     (Blueberry Cheesecake,
                     Dark Chocolate Cake, Fruit Cake)
  - pastries.html -> data-category-lock="pastries"  (Classic & Nutella
                     Cheesecake, Tiramisu, Chocolate Truffle Loaf,
                     Chocolate Crunch Mousse Cake, and all three brownies)
  - savouries.html -> data-category-lock="savouries" (Korean Bun, Loaded
                     Nachos)
  - sips.html      -> data-category-lock="sips"      (Hot Chocolate,
                     Chocolate Milkshake)
There's nothing extra to keep in sync when a product's price, photo,
category or availability changes in data/products.json (or the Sheet,
once that's enabled) — moving a product between Cakes and Pastries, for
example, is just editing its "category" field. If another category (or
combination — data-category-lock accepts a comma-separated list) ever
wants its own page the same way, copy one of the four pages above, change
the title/hero copy/hero photo, and set data-category-lock to the
category id(s) you want.

All five pages (home + the four category pages) also share a small mobile
navigation module (public/js/nav.js): below 760px the header's link row
collapses behind a hamburger button (#nav-toggle) that opens #main-nav as
a dropdown, rather than the links disappearing with no way to reach them.
And the fixed "Food Guide" button (public/js/animations.js,
initAiGuideFooterDock()) lifts itself clear of the footer as the page
scrolls to the bottom, and caps its own chat panel's height so the panel
never opens with its top edge pushed off a short phone screen.

MY ORDERS (header button, all five pages)
------------------------------------------
There are no customer accounts in this demo, so returning customers look
up their own order history the same way the existing single-order status
tracker already worked: by a value they already have, not a login. The
"My Orders" button in the header (public/js/myOrders.js) opens a small
drawer where a customer types the WhatsApp number they checked out with,
receives a 6-digit code on WhatsApp, types it back, and then sees every
order placed with that number, newest first, with its live status. The
phone number alone is not enough — without the code, anyone could read
anyone else's orders by typing their number.

WHATSAPP VERIFICATION CODES (My Orders + checkout)
--------------------------------------------------
server/lib/phoneVerification.js + server/routes/verify.js. A code is 6
digits, expires in 5 minutes, allows 5 wrong tries, can't be re-sent for
30 seconds, and each number can request at most 6 codes an hour. Typing
it back gives a 30-minute "verified" token that My Orders and checkout
both require (verifying once at checkout also unlocks My Orders for that
visit).

Checkout requires a verified number, and the customer's WhatsApp receipt
is only ever sent to that verified number — so nobody can make DE.25
message a stranger's phone. The owner's new-order alert is unaffected.

To go live you need, in Meta Business Manager -> WhatsApp Manager ->
Message Templates, an approved AUTHENTICATION template with a "Copy code"
button; put its name in WHATSAPP_OTP_TEMPLATE_NAME (see .env.example).

Without a WhatsApp account connected:
  - Local / demo (NODE_ENV not "production"): the code is printed in the
    server log AND shown on screen as "Demo mode … your code is 123456",
    so the whole flow can be tried end to end.
  - Production (NODE_ENV=production): codes can't be sent and are never
    shown. Checkout still works but no receipt is sent to the customer,
    and My Orders stays locked until WhatsApp is connected.
Always set NODE_ENV=production on the live server.

HOW TO RUN IT
--------------
Requires Node.js 18 or newer (check with: node -v).

  1. cd into this folder
  2. npm install
  3. cp .env.example .env
  4. npm start
  5. open http://localhost:3000

The site works completely out of the box with .env left at its defaults —
there is no external API key required to demo the full flow (menu, cart,
checkout, demo delivery estimate, order status, Food Guide, custom-cake
enquiry, owner dashboard, order notifications). The only things .env
controls today are: which delivery mode is active — demo, Borzo sandbox
or Borzo production (see DELIVERY below), whether the admin API + owner dashboard are enabled (see
OWNER DASHBOARD below), and whether WhatsApp notifications actually send
instead of just logging (see ORDER NOTIFICATIONS below).

To try the owner dashboard right away: set ADMIN_TOKEN to any value in
.env (e.g. ADMIN_TOKEN=letmein), restart the server, place a test order on
the site, then open http://localhost:3000/admin/ and enter that same
token.

WHAT'S REAL vs WHAT'S A DEMO PLACEHOLDER
-------------------------------------------
Real, and taken directly from DE.25's own printed menu/flyer:
  - All product names, prices, and categories in data/products.json
  - The 16 product photos DE.25 provided (public/images/), each with an
    auto-generated WebP sibling for faster loading — including real photos
    for Blueberry Cheesecake, Ragi Jaggery Brownie, Dark Chocolate Cake and
    Fruit Cake supplied directly by the owner, which replaced the earlier
    illustrated placeholders described below
  - The hero photo (chocolate crunch mousse cake)

Explicitly flagged as NOT yet confirmed by DE.25 (never invented, always
labelled honestly wherever they're shown, including inside the Food
Guide's answers):
  - Allergen information — every product currently shows "We don't
    currently have confirmed allergen information for this item" until
    DE.25 supplies real allergen data. Set the "allergens" field on a
    product in data/products.json (array of strings) once confirmed.
  - Nutrition figures — shown as "Nutrition information coming soon"
    until real values are supplied. Fill in the "nutrition" object
    (calories/protein/carbohydrates/fat/sugar) per product once DE.25
    confirms them; the Food Guide will then compute per-serving
    estimates automatically and always caveats them as estimates.
  - Ingredient lists were read off the product photos/descriptions and
    are marked "ingredientsConfirmed: false" until DE.25 double-checks
    them — this matters because the Food Guide repeats them verbatim.
  - Three items (Loaded Nachos, Chocolate Truffle Loaf, Chocolate Crunch
    Mousse Cake) aren't on the current printed flyer, so their prices are
    marked "menuConfirmed: false" with a note on the product page. Confirm
    or correct these in data/products.json before going live.
  - The "Hot Chocolate" product photo shows an iced drink — flagged with
    a priceNote asking DE.25 to confirm whether to relabel it as an iced
    variant or swap in a hot-serve photo.
  - Two more cakes (Dark Chocolate Cake, Fruit Cake) were added at the
    owner's request. They originally used an illustrated concept SVG
    because no real DE.25 photo existed yet; the owner has since supplied
    real photos for both (and for Ragi Jaggery Brownie and a refreshed
    Blueberry Cheesecake shot), so photoConfirmed is now true and the
    "Concept image" badge no longer shows on any of them. Their name/price
    are still marked menuConfirmed:false, though — a real photo doesn't by
    itself confirm those are on DE.25's printed menu at that price; confirm
    that separately in data/products.json before treating them as final.
    The "Design your dream cake" section no longer shows illustrated
    custom-cake inspiration images (the owner felt they read as AI-
    generated) — it's now text + a "Start a custom order" button only, on
    every page that has the section.
  - No business address/phone/hours are published anywhere (footer,
    structured data, etc.) because none were confirmed — add them to the
    JSON-LD block in public/index.html and the footer once DE.25 provides
    them.
  - The site's canonical/OG/sitemap URLs use https://example.com as a
    placeholder domain — replace every occurrence once DE.25's real
    domain is live (public/index.html, public/sitemap.xml).

PRODUCT CATALOG: JSON FILE NOW, GOOGLE SHEETS READY LATER
--------------------------------------------------------------
The menu lives in data/products.json by default — no setup needed, and
every server/lib/pricing.js, server/ai/foodGuide.js and admin-API call
reads it exactly the same way regardless of which backend is actually
active underneath (see server/products/index.js).

Set GOOGLE_SHEETS_PRODUCTS_ENABLED=true to let the owner edit the menu in
a Google Sheet instead — no code changes or redeploy needed to fix a
price or mark something sold out:

  1. Create a Google Cloud service account and enable the Sheets API for
     its project (console.cloud.google.com -> IAM & Admin -> Service
     Accounts -> Create, then APIs & Services -> Library -> "Google
     Sheets API" -> Enable). Generate a JSON key for it.
  2. Create a new Google Sheet with two tabs, "Products" and "Categories".
     Import data/products-sheet-template.csv as the Products tab and
     data/categories-sheet-template.csv as the Categories tab (File ->
     Import -> Upload, "Replace current sheet" or "Insert new sheet") —
     both are pre-filled with DE.25's current menu, including the two
     illustrated-concept cakes, so you're editing real data from the start
     rather than a blank template.
  3. Share the Sheet with the service account's email (the "client_email"
     field in the JSON key you downloaded) — Editor access if the admin
     dashboard's product-edit API should be able to write back to the
     sheet, Viewer if it should only ever be read from Sheets and edited
     by hand there.
  4. Put GOOGLE_SHEETS_ID (the long value in the Sheet's URL between /d/
     and /edit), GOOGLE_SERVICE_ACCOUNT_EMAIL and
     GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (from that JSON key) into .env.
  5. Set GOOGLE_SHEETS_PRODUCTS_ENABLED=true and restart the server.

The sheet is read at boot and re-fetched automatically every 5 minutes
(GOOGLE_SHEETS_REFRESH_MS) — or immediately via the admin API's
POST /api/admin/products/refresh (a "Refresh menu" action belongs on the
dashboard's product-editing UI once one is built; the API is ready today).
Columns can be in any order — they're matched by header name, not
position — so reorganizing the sheet later won't break anything.

A misconfigured or unreachable Sheet at boot falls back to the JSON file
catalog for that run (logged loudly) rather than starting with an empty
menu — fix the sheet/credentials and restart to retry. See
server/products/GoogleSheetsProductsProvider.js for the full column
reference and this design's other tradeoffs.

PAYMENTS: RAZORPAY (UPI QR FIRST), DEMO
---------------------------------------
Checkout no longer confirms an order by itself. Every order is saved as
"Awaiting Payment", and only a paid order reaches the kitchen, the courier
and the notifications. Unpaid orders are cancelled after
PAYMENT_WINDOW_MINUTES (default 30). One of two methods is active,
resolved in server/payments/paymentConfig.js and shown on the owner
dashboard's Payments panel:

  Demo (default)   No payment set up. The payment screen shows a labelled
                   "Simulate payment (no money moves)" button, and every
                   such order is tagged as simulated on the dashboard.
                   Refused when NODE_ENV=production.
  Razorpay         RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET. Razorpay's own
                   checkout window opens on the site as soon as the order is
                   placed, on the UPI QR first (scan with GPay, PhonePe,
                   Paytm…), with cards, netbanking and wallets below. Test
                   keys move no real money, and the whole UI says "test
                   mode".

Nobody confirms a payment by hand. A paid order confirms itself through
whichever of these reaches the server first:

  1. Checkout callback  the browser hands over Razorpay's signed result;
                        the server checks the HMAC with the key secret.
  2. Webhook            RAZORPAY_WEBHOOK_SECRET + a webhook to
                        /api/payments/razorpay/webhook (needs a public
                        https URL) — instant, even if the tab was closed.
  3. Reconciler         every 15 s the server asks Razorpay about each order
                        still awaiting payment — catches a QR paid on a phone
                        while the callback never came, and works on localhost.

The customer's screen and the owner dashboard both refresh every 5 s, so the
order flips to "Payment confirmed" (and the dashboard chimes) on its own.

The amount always comes from the server's own price calculation, never from
the browser. A Razorpay payment is only accepted when its signature, gateway
order id and amount all match. If a payment arrives after the window closed,
it's honoured, never lost: Razorpay is asked once more before an order is
cancelled, and a late payment still confirms it.

Going live with Razorpay: account activation (KYC, a bank account, and
refund/cancellation, terms, privacy and contact pages on the site), then
swap the rzp_test_ keys for rzp_live_ keys and add the webhook. No code
changes are needed.

DELIVERY: DEMO, BORZO SANDBOX, BORZO PRODUCTION
-------------------------------------------------
Every paid order is handed to a courier automatically. The checkout flow
never talks to a courier directly: it goes through server/lib/placeOrder.js
and server/delivery/index.js, which picks one of three modes from .env
(all resolved in server/delivery/borzoConfig.js):

  Demo (default)   DemoDeliveryProvider — a deterministic placeholder,
                   labelled "Demo Delivery Estimate" everywhere. Nothing is
                   sent to Borzo.
  Borzo sandbox    BORZO_DELIVERY_ENABLED=true + BORZO_AUTH_TOKEN +
                   PICKUP_ADDRESS + PICKUP_PHONE (BORZO_ENV defaults to
                   test). Real Borzo API at robotapitest-in.borzodelivery.com:
                   real price quotes, real Borzo order ids and tracking
                   pages — but Borzo never dispatches a rider and never
                   charges. Labelled "Borzo sandbox" in the UI.
  Borzo production Everything above + BORZO_ENV=production +
                   BORZO_LIVE_CONFIRM=yes-dispatch-real-couriers. Real
                   riders, real wallet charges (needs Borzo KYC and a funded
                   wallet). One switch without the other stays on demo.

What happens per order (Borzo modes):
  1. Checkout asks Borzo for a price (calculate-order). If Borzo rejects
     the address, the customer is told before anything is charged.
  2. The order is saved, then create-order books the courier. create-order
     is never retried automatically: Borzo has no idempotency key, so a
     blind retry could book two couriers. A failed booking is shown on the
     dashboard as "Courier booking failed" so the owner can arrange it.
  3. A background sync (one batched GET /orders every BORZO_SYNC_MS,
     default 20s) keeps the courier status, rider name and tracking link
     current, and moves the kitchen status forward only: picked up ->
     Out for Delivery, delivered -> Delivered. Polling, not Borzo's
     callback, because a callback needs a public HTTPS URL.

Getting a sandbox token (free, self-serve, no KYC):
  1. Register at https://apitest.borzodelivery.com/in/ (needs a phone
     number and an SMS code — do this yourself).
  2. Copy the API token from the sandbox dashboard's API settings into
     BORZO_AUTH_TOKEN in .env. A sandbox token only works on the sandbox.
  3. Set BORZO_DELIVERY_ENABLED=true and PICKUP_PHONE, then restart.
The token is only ever read by the server: it is sent to Borzo in the
X-DV-Auth-Token header and nowhere else — never to the browser, never
into the activity log.

THE BORZO PANEL (top of the owner dashboard)
  - Setup: which mode is active and exactly which .env value is missing.
  - Live API log: every HTTPS exchange with Borzo — endpoint, HTTP status,
    latency, Borzo's own error codes, and the full request/response
    (phone numbers masked, token never stored). Kept in
    data/borzo-activity.json (gitignored), newest 300 calls.
  - Run live connection check: a real price request to BOTH Borzo hosts
    right now. With no token Borzo answers HTTP 400 required_auth_token —
    that is Borzo's own server proving it is reachable and enforcing auth.
    With a token, the configured environment returns a real quote. The
    token is only ever sent to the environment it belongs to. Also on the
    command line: npm run borzo:check
  - Create sample orders: 1-5 illustrative orders from five Navi Mumbai
    localities, run through the real checkout path. In sandbox mode each
    becomes a real Borzo test booking with its own id and tracking page.
    Samples are tagged "Sample" everywhere, use the shop's own phone as
    the drop-off contact, switch Borzo's SMS off, never send a customer
    receipt, and are refused outright on production.

OWNER DASHBOARD (http://localhost:3000/admin/)
------------------------------------------------
A live orders dashboard for whoever is running the kitchen — this is what
answers "how will I know an order came in?". It's disabled by default:

  1. Set ADMIN_TOKEN in .env to a long random value.
  2. Restart the server.
  3. Open http://localhost:3000/admin/ and enter that same token.

While ADMIN_TOKEN is blank, /admin/ shows a plain "isn't enabled yet"
message instead of a login screen — nothing is silently half-working.

Once unlocked, the dashboard:
  - Lists every order (newest first), auto-refreshing every 5 seconds —
    no page reload needed.
  - Plays a short sound and shows a banner + highlight the moment a
    genuinely new order arrives (not on the first load of orders already
    in the system). The sound can be muted with the header toggle; the
    setting is remembered per browser.
  - Lets the owner advance an order's status (Preparing -> Ready for
    Delivery -> Out for Delivery -> Delivered, etc.) with one tap, since
    there's no real courier system yet to do this automatically.
  - Shows a Notifications panel listing every WhatsApp alert that has
    gone out (or would go out, in demo mode) — see ORDER NOTIFICATIONS
    below.
  - "Lock" clears the session and returns to the token screen; the token
    is otherwise remembered in the browser so it isn't re-entered on
    every visit.

Orders now persist to data/orders.json (gitignored — it holds customer
names, phone numbers, and addresses, so it must never be committed or
shared) so order history survives a server restart. One limitation to
know about: the automatic demo status-progression timer only runs for
orders placed in the current server process — after a restart, older
orders stay at whatever status they were last at until the owner advances
them manually from the dashboard.

ADMIN LOGIN: SHARED TOKEN NOW, SUPABASE ACCOUNTS READY LATER
--------------------------------------------------------------------
ADMIN_TOKEN (above) is one shared secret everyone with dashboard access
uses — fine for one person, awkward once more than one person needs their
own login (you can't revoke just one person's access, there's no "who did
this" trail, and rotating it locks everyone out at once).

Set ADMIN_AUTH_PROVIDER=supabase to switch the dashboard to real
email/password accounts via Supabase Auth instead:

  1. Create a free project at supabase.com.
  2. In Authentication -> Users, add an account for each person who should
     have dashboard access. Then turn OFF "Allow new users to sign up" in
     Authentication -> Providers -> Email — new projects allow public
     sign-up by default, and the anon key is public by design.
  3. Copy Project Settings -> API's Project URL and "anon public" key into
     SUPABASE_URL and SUPABASE_ANON_KEY, and Project Settings -> API ->
     JWT Settings' JWT Secret into SUPABASE_JWT_SECRET.
  4. List the same people's emails in ADMIN_EMAILS (comma-separated). The
     server only admits accounts on this list, so even if sign-up is left
     on by mistake, a stranger's new account can't open the dashboard.
     An empty list admits nobody.
  5. Set ADMIN_AUTH_PROVIDER=supabase and restart the server.

If the site runs behind a reverse proxy or a host's router (nginx, Render,
Railway, Cloudflare), set TRUST_PROXY to the number of proxy hops (usually
1) so rate limits see each visitor's real IP. Leave it empty otherwise —
trusting X-Forwarded-For with no proxy lets anyone bypass the limits.

The dashboard's login screen automatically switches from a token field to
an email/password form (GET /api/admin/auth-config tells it which to
show), sessions refresh themselves silently in the background, and
"Lock" signs the session out properly instead of just forgetting a token
locally. If ADMIN_AUTH_PROVIDER=supabase is set but any of the three
SUPABASE_* values above is missing, this falls back to ADMIN_TOKEN with a
warning in the server log rather than locking everyone out — check the
log if the login screen looks wrong after enabling this.

The same Supabase project can also store orders (next section) — you only
need to create it once, whichever you turn on first.

ORDER STORAGE: JSON FILE NOW, SUPABASE POSTGRES READY LATER
--------------------------------------------------------------------
Orders live in data/orders.json by default (see OWNER DASHBOARD above).
That's fine for a single server with a persistent disk, but two situations
call for a real database instead: order volume growing past what one JSON
file comfortably handles, or deploying somewhere that doesn't keep a
persistent local disk between deploys (many "serverless"-style hosts
wipe the filesystem on every deploy, which would silently erase order
history).

Set SUPABASE_ORDERS_ENABLED=true to store orders in Supabase's Postgres
database instead:

  1. Create (or reuse) a Supabase project — see ADMIN LOGIN above if you
     haven't already.
  2. Open the SQL Editor in your Supabase project, paste in the contents
     of supabase/schema.sql, and run it once. This creates the `orders`
     table with Row Level Security turned on and NO policies defined —
     deliberately: this app only ever talks to it with the service_role
     key (which bypasses RLS by design), so the anon key and any Supabase
     Auth user get zero direct access to order data from the browser.
  3. Copy Project Settings -> API's Project URL and "service_role secret"
     key into SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. NEVER put the
     service_role key anywhere a browser can see it (it's server-only,
     read from .env by server/lib/supabaseRest.js).
  4. Set SUPABASE_ORDERS_ENABLED=true and restart the server.

No frontend, checkout, or dashboard code needs to change — same pattern as
every other provider in this project (server/orders/index.js picks the
backend once at boot; a misconfigured Supabase setup falls back to the
JSON file store for that run, logged loudly, rather than silently losing
orders).

ORDER NOTIFICATIONS: DEMO NOW, WHATSAPP-READY LATER
----------------------------------------------------
Every order now triggers two notifications, built the same demo-first,
architected-for-real-credentials way as Borzo delivery:
  - An alert to the owner ("New order ...") with the customer's name,
    phone, items, delivery address, and payment method.
  - An order-slip message to the customer confirming their order, with
    the shop's contact number and an honest note about delivery — either
    "DE.25 is preparing and delivering this order directly for now" (the
    current reality) or, once Borzo is actually live for that order, a
    line saying delivery-partner details will be shared once assigned.
    This deliberately never invents a courier name, phone number, or
    tracking link — there is no real courier to name yet, and the day
    Borzo actually goes live, this project can wire in that provider's
    real assignment details, never fabricated ones.

Both notifications are "fire-and-forget": they're triggered right after
an order is created but never block or can never fail the customer's
checkout, even if WhatsApp is down or misconfigured.

While WHATSAPP_NOTIFICATIONS_ENABLED is false (the default), nothing is
actually sent anywhere. Instead, every notification is logged to the
server console and appended to data/notifications.json (also gitignored —
it contains customer phone numbers), and shown in the dashboard's
Notifications panel labelled "Demo mode". This means the entire order ->
alert -> slip flow can be demoed end-to-end today with zero external
accounts.

To go live with real WhatsApp messages:
  1. Set up a WhatsApp Business Platform account via Meta (or a reseller
     such as Interakt/AiSensy/Gupshup — see the comments at the top of
     server/notifications/WhatsAppCloudProvider.js for how to adapt it).
  2. Get an access token and phone number ID, and get a message template
     approved (WhatsApp requires a pre-approved template for messages a
     business sends first — free-form text only works if the customer
     messaged first within the last 24 hours). This is a real, easy-to-
     miss requirement — read the file's comments before flipping this on.
  3. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
     WHATSAPP_TEMPLATE_NAME (and OWNER_WHATSAPP_NUMBER, SHOP_CONTACT_PHONE)
     in .env.
  4. Set WHATSAPP_NOTIFICATIONS_ENABLED=true and restart the server.
No frontend or checkout code needs to change — same pattern as Borzo.

Delivery tracking links to Borzo's own tracking page (only ever an https
borzodelivery.com URL that Borzo returned for that order) and shows the
rider's name once Borzo assigns one. There is deliberately no home-made
moving map: a map is only as true as the GPS behind it, and Borzo's page
already shows the real one. Sandbox bookings are labelled as such — they
get a real Borzo tracking page, but no rider is ever dispatched.

THE FOOD GUIDE (bottom-right "Food Guide" button)
------------------------------------------------------
This intentionally does NOT call ChatGPT/Grok/any general-purpose AI
model. It's a small deterministic engine (server/ai/foodGuide.js) that
only ever composes answers from the fields already in
data/products.json — it is structurally incapable of inventing an
ingredient, allergen, or nutrition figure, which matters because a wrong
"no nuts" answer is a real safety issue, not a demo nitpick. If DE.25
later wants more conversational phrasing, the safe way to add that is a
phrasing-only LLM pass fed exactly the facts object retrieveFacts()
already returns — never a model with open-ended access to make things up.

SECURITY (audited as part of this build)
--------------------------------------------
- Every order total is calculated server-side from data/products.json —
  the frontend cart is for display only; a manipulated price, quantity,
  or delivery fee in the request is never trusted (server/lib/pricing.js).
- Every user-controlled field (name, phone, email, address, pincode,
  quantities, product IDs, enquiry text) is validated server-side with
  zod before anything touches it (server/lib/validation.js).
- Security headers + a locked-down Content-Security-Policy via helmet,
  same-origin CSRF protection, and tiered rate limiting on write/AI
  endpoints (server/middleware/).
- Order IDs are unguessable UUIDs, and the public order-status endpoint
  never returns customer name/phone/address — only order/line/status data.
- The optional admin API and owner dashboard (server/routes/admin.js,
  public/admin/) are completely disabled (every /api/admin/* route 404s,
  dashboard shows a plain "not enabled" message) unless you set either
  ADMIN_TOKEN or the Supabase Auth vars in .env (see ADMIN LOGIN above).
  A fixed allowlist of product fields can be edited through it —
  productId can never be overwritten. The dashboard page is served with
  the same site-wide Content-Security-Policy as everywhere else (extended
  with Supabase's own domain in connect-src only when Supabase login is
  active) and is marked noindex/nofollow.
- data/orders.json and data/notifications.json contain customer names,
  phone numbers, and addresses — both are gitignored and must never be
  committed or shared outside the team running this server.
- No secrets are ever sent to the browser; Borzo, WhatsApp, Google Sheets
  and Supabase credentials only ever live in server-side env vars — the
  one deliberate exception is Supabase's "anon" key (SUPABASE_ANON_KEY),
  which is safe by Supabase's own design (Row Level Security protects
  data, not this key's secrecy) and is what the dashboard's Supabase-mode
  login page uses to call Supabase's Auth API directly from the browser.
- If Supabase order storage is enabled, the `orders` table has Row Level
  Security on with zero policies — only this server's service_role key
  (never exposed to a browser) can read or write it; see supabase/schema.sql.
- npm audit currently reports 0 known vulnerabilities in the dependency
  tree (dotenv, express, express-rate-limit, helmet, jsonwebtoken, zod).

ACCESSIBILITY & PERFORMANCE
--------------------------------
- Verified with an axe-core pass (0 violations, WCAG 2 A/AA rules) across
  all five pages (home, cakes, pastries, savouries, sips) at desktop
  (1280px) and mobile (390px, 320px) widths, plus a manual keyboard-only
  pass (skip link, full keyboard operability, focus trap + focus restore
  on every modal including the My Orders drawer, background content
  marked inert while a modal is open).
- Respects prefers-reduced-motion (all animations become instant reveals).
- No image is served without a generated WebP sibling; total home-page
  weight is roughly 200KB with a sub-400ms load in local testing.
- No horizontal overflow at 320/390/430/768/1024/1440px, on any of the
  five pages, verified after the mobile-nav and My Orders header changes.

PROJECT LAYOUT
-------------------
  server/            Express backend (see server/index.js for the route map)
    lib/             pricing, validation, asyncHandler, datastore.js/orders.js
                      (thin delegators — see products/ and orders/ below),
                      googleServiceAccountAuth.js, supabaseRest.js,
                      supabaseAuth.js, adminAuthConfig.js
    products/        product-catalog backend (JSON file + Google Sheets)
    orders/          order-storage backend (JSON file + Supabase Postgres)
    delivery/        DeliveryProvider abstraction (Demo + Borzo v1.8), Borzo
                      config, API activity log, connection check, status sync
    notifications/   NotificationProvider abstraction (Demo + WhatsApp stub)
    ai/              the deterministic Food Guide engine
    middleware/      security headers, rate limiting, admin auth, errors
    routes/          one thin router per resource
  public/            everything served to the browser
    js/              plain ES modules, no bundler, no framework
    css/styles.css   the whole design system (CSS custom properties)
    images/          DE.25's real product photos + generated WebP + hero set.
                      The four custom-cake-*.svg "inspiration" illustrations
                      are no longer referenced anywhere (removed from the
                      Design Your Dream Cake section — see WHAT'S REAL
                      above) and can be deleted; kept for now in case any
                      external link still points at one directly.
    admin/           the owner-facing live orders dashboard (see OWNER
                      DASHBOARD above) — token- or Supabase-gated, polls
                      every 5s
  supabase/schema.sql the `orders` table DDL for Supabase order storage
  data/products.json the structured product database (see the _notes field
                      inside it for the "never invent" conventions this
                      whole build follows)
  data/products-sheet-template.csv    Google Sheets import template (Products tab)
  data/categories-sheet-template.csv  Google Sheets import template (Categories tab)
  data/orders.json          order history (gitignored — contains customer PII)
  data/notifications.json   demo notification log (gitignored — contains PII)
  data/borzo-activity.json  Borzo API call log (gitignored — masked phones, no token)

NEXT STEPS TOWARD GOING LIVE
---------------------------------
  - Have DE.25 confirm: allergen info, nutrition figures, ingredient
    lists, the unconfirmed menu items (including the two new illustrated-
    concept cakes), the Hot Chocolate photo, and a real business
    address/phone for the footer and structured data.
  - Get real photos for Dark Chocolate Cake and Fruit Cake and swap out
    their illustrated placeholders (see WHAT'S REAL above).
  - Get the real domain and swap out every example.com reference.
  - Add a Borzo sandbox token and PICKUP_PHONE and run sample orders
    through Borzo's sandbox (see DELIVERY above). For real riders: Borzo
    business KYC + a funded wallet, then BORZO_ENV=production and
    BORZO_LIVE_CONFIRM — no other code changes.
  - Set up WhatsApp Business + get a message template approved, then flip
    WHATSAPP_NOTIFICATIONS_ENABLED (see ORDER NOTIFICATIONS above) — no
    other code changes.
  - Once Borzo production is live, register a Borzo callback URL on the
    deployed domain so status changes arrive instantly instead of on the
    20-second sync (see DELIVERY above).
  - Payments (see PAYMENTS above): Razorpay test keys are free and work
    today; live Razorpay needs account activation, then the rzp_live_ keys
    and the webhook.
  - Move the menu to Google Sheets (see PRODUCT CATALOG above) if DE.25
    wants to edit prices/availability without a developer.
  - Move order storage to Supabase Postgres (see ORDER STORAGE above)
    once order volume grows, or before deploying anywhere without a
    persistent local disk.
  - Switch admin login to Supabase Auth (see ADMIN LOGIN above) once more
    than one person needs their own dashboard access.
