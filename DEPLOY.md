# Deploying Viomocoin

The three deployment blockers are handled in code — you just have to set the env
and give it a persistent disk.

## 1. Node version

The app uses `node:sqlite`, which needs **Node ≥ 22.5** and runs flagless on **Node 24**
(the recommended version — see `.nvmrc` and the `engines` field). The `Dockerfile`
pins `node:24-alpine`. If you deploy without Docker, make sure the host runs Node 24.

## 2. Secrets (required)

The server **refuses to boot** with `NODE_ENV=production` unless you set a strong
`JWT_SECRET`. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Minimum required env in production:

| Var | Purpose |
|-----|---------|
| `NODE_ENV=production` | enables the production guards |
| `JWT_SECRET` | **required** — signs auth tokens; boot fails without it |
| `PORT` | port to listen on (default 5178) |

Optional (features stay simulated until set): `STRIPE_*`, `RAZORPAY_*`, `SMTP_*`,
`ADSENSE_*`, `OWNER_EMAIL`, `GOOGLE_*`, `AWS_*` / `S3_BUCKET`. See `.env.example`.

## 3. Persistence (required)

The SQLite DB and uploaded media must live on a **persistent volume**, or they are
wiped on every redeploy. Point these at a mounted disk:

| Var | Default (dev) | Production |
|-----|---------------|-----------|
| `VIOMOCOIN_DB` | `./viomocoin.db` | `/data/viomocoin.db` |
| `VIOMOCOIN_UPLOAD_DIR` | `./uploads` | `/data/uploads` |

Alternatively, set S3 credentials (`S3_BUCKET`, `AWS_*`) to store uploads in object
storage instead of on disk — the DB still needs a durable path.

The server prints a loud warning at startup if it detects production-on-local-disk
with no volume configured.

## Deploy with Docker (works on any host)

```bash
docker build -t viomocoin .
docker run -d -p 5178:5178 \
  -e JWT_SECRET="<your-generated-secret>" \
  -v viomocoin-data:/data \
  viomocoin
```

The `Dockerfile` already sets `NODE_ENV=production`, `VIOMOCOIN_DB=/data/viomocoin.db`,
and `VIOMOCOIN_UPLOAD_DIR=/data/uploads`, and declares `/data` as a volume.

## Platform notes

- **Fly.io / Railway / Render:** use the Dockerfile and attach a volume mounted at `/data`.
  Set `JWT_SECRET` (and any provider keys) as secrets.
- **VPS (bare Node):** install Node 24, `npm install --omit=dev`, set the env vars above
  (a `/data` dir on the box works fine), and run `npm start` behind a reverse proxy
  (nginx/Caddy) that terminates HTTPS. `trust proxy` is already enabled.

## Before taking real money

These are **your accounts and keys** — the code activates each integration the moment
its env vars are present (otherwise it runs simulated). You must supply:

| Provider | Env | What it enables |
|----------|-----|-----------------|
| PayPal Payouts | `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_ENV`, `PAYPAL_WEBHOOK_ID` | real worldwide creator payouts ($) — most accessible from India |
| Stripe Connect | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | bank payouts (platform must be in a supported country) |
| Razorpay / RazorpayX | `RAZORPAY_KEY_ID/SECRET/ACCOUNT_NUMBER`, `RAZORPAY_WEBHOOK_SECRET` | UPI payouts for India (₹) |
| SMTP | `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | real verification / password-reset email |
| Google AdSense | `ADSENSE_CLIENT`, `ADSENSE_SLOT` | real ad units (needs an approved account + live domain) |
| KYC | see below | identity verification before payouts |

**KYC:** no provider SDK is bundled. In production the app **stops auto-approving** —
submissions become `pending` and the platform owner approves them in **Moderation → KYC**.
To automate, integrate Onfido / Persona / Stripe Identity / Razorpay and mark users
verified via the provider's callback, or set `KYC_AUTO_APPROVE=true` to keep auto-approval.

The code is already hardened for real money: `/api/payouts/cashout` atomically claims the
balance before contacting the provider (no double-spend from concurrent requests) and
refunds coins if the transfer fails; payout webhooks verify signatures and reverse coins on
failed/reversed transfers. Set the webhook secrets above so those callbacks are trusted.
