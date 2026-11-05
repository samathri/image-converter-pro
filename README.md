# Image Converter Pro (Web)

Convert, compress and download images in the browser: AVIF, WEBP, JPEG and PNG, compressed to a target size. Built with React (Vite) and an Express API, ready to deploy on **Vercel**.

A university portfolio project: free tier with limits, user accounts, a Pro plan paid with PayPal (sandbox) or by bank transfer, and an admin dashboard to review payments.

## Features

- Upload images (drag & drop) or paste image URLs, pick formats and a target size, and download the results (one file, or a zip).
- **Free:** 3 conversions in total, up to 5 images each, then locked. Counted per browser, account and IP address, so clearing cookies or making a new account doesn't reset it.
- **Pro:** unlimited conversions, up to 50 images per batch. Needs an account.
  - **PayPal (sandbox):** the buyer pays on PayPal (PayPal balance or card); when they return, the server captures the payment and Pro unlocks immediately.
  - **PayHere (optional):** supported too, but PayHere only approves root domains, so it needs your own domain rather than `*.vercel.app`.
  - **Bank transfer:** the user uploads the receipt and an admin approves or rejects it.
- **Create images (Pro), at `/create`:** describe an image or type keywords (with one-click keyword chips), pick a style (photo, illustration, 3D, watercolor, anime, flat vector, sketch), a shape and 1–4 images. Each result can be downloaded, sent to the converter, or sent to Names & alt text Click an image to zoom (fit or 100%). **Edit** asks what should change (with ideas such as "make it night time") and redraws it with the same seed, so the scene stays close; "new version" makes a fresh one. Made with [Pollinations.ai](https://pollinations.ai).
- **Remove background (Pro), at `/remove-background`:** AI cuts out the subject and removes the background, entirely in the browser (photos are never uploaded). Before/after slider, zoom, transparent PNG or a solid colour (JPG), download one or all (.zip), or send them to the converter. Uses BRIA's RMBG-1.4 model via transformers.js; the model (~45 MB) downloads once and is cached. RMBG-1.4 is free for non-commercial use: for a commercial launch, use an MIT-licensed model such as `onnx-community/BiRefNet_lite-ONNX` in `src/bgWorker.js` instead (a bigger download, and a small code change: it works with transformers.js' ready-made `background-removal` pipeline).
- **Names & alt text (Pro), on its own page (`/names`):** Google Gemini looks at each photo and writes an SEO-friendly file name, alt text, or both. Everyone can open the page; generating needs Pro. Results can be edited, copied or exported as CSV, then either downloaded as the **original images renamed** (a zip, no conversion) or **sent to the converter** to convert and compress under the new names (that zip includes `alt-text.csv`). The converter's "Name with AI" button goes the other way.
- **Accounts:** sign-in by [Clerk](https://clerk.com): email with a verification code, Google, and "Forgot password", all in Clerk's sign-in window. Users also manage their profile there (Account settings).
- **Offers:** longer-plan discounts (% off 3, 6 and 12-month plans, shown as "Save X%"; other discounts apply on top), timed sale campaigns (with a banner), promo codes (% or amount off, expiry, usage limits; 100% codes give Pro free) and a referral programme (users who have bought Pro get an invite link; every 5 friends who join give them 5% off their next payment, both numbers set by the admin).
- **Pro expiry:** users see a banner and an amber badge in the last 7 days and after it ends, and get reminder emails 7 days before, 1 day before and on the day it ends (once each per Pro period; renewing resets them). Admins see each user's expiry date and days left, and an "ending this week" list on the Overview.
- **Admin dashboard** (`/admin`): review payments and receipts, manage users (grant or revoke Pro, make admin, delete), run promotions, set the price and bank details. Admins always have unlimited access; the owner account (`ADMIN_EMAIL`) can't be demoted or deleted.

## Architecture

| Part | Production (Vercel) | Local development |
|---|---|---|
| Frontend | React + Vite, served by Vercel's CDN | Vite dev server or `npm start` |
| API | Express app as one Vercel Function (`api/index.js`) | Same app on port 3001 (`server/index.js`) |
| Database | Postgres (Neon) via `DATABASE_URL` | Built-in PGlite in `data/pglite`, no setup |
| Files | Private Vercel Blob store | `data/blobs` |

Vercel Functions accept at most 4.5 MB per request, so images and receipts are uploaded from the browser **straight to Blob storage**. The API then converts them and returns a short-lived signed download link. A daily job (Vercel Cron, 03:00 UTC) deletes temporary uploads and results older than an hour and emails Pro expiry reminders.

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
```

Copy `.env.example` to `.env` and set the Clerk keys (see [Sign-in](#sign-in-clerk)), `ADMIN_EMAIL` and, for the AI feature, `GEMINI_API_KEY`. Leave the database and Blob settings empty. Then:

```bash
npm run dev
```

Open http://localhost:5173 and sign in with the `ADMIN_EMAIL` address: that account becomes the admin. Open http://localhost:5173/admin and fill in **Settings** (price, currency, bank details).

To run the built version instead, use `npm run build` and then `npm start`, and open http://localhost:3001.

> The local database can only be opened by one program at a time. If you use `npm run db`, stop the app first.

## Deploy to Vercel

1. **Push the project to GitHub**, then in Vercel choose **Add New → Project** and import the repository. The settings in `vercel.json` are picked up automatically.
2. **Add a database:** in the project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL`.
3. **Add file storage:** **Storage → Create → Blob**, choose **Private** access, and connect it to the project. This adds `BLOB_STORE_ID`; the app then uses Vercel's automatic credentials, so no token needs to be copied. (A `BLOB_READ_WRITE_TOKEN` also works if you have one.)
4. **Add environment variables** in **Settings → Environment Variables**:

   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | A long random string (required) |
   | `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From the Clerk dashboard (see below) |
   | `ADMIN_EMAIL` | The email you'll sign in with as the owner/admin |
   | `GEMINI_API_KEY` | From Google AI Studio (see below) |
   | `CRON_SECRET` | A long random string (required for the daily job: cleanup and expiry reminders) |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From developer.paypal.com (see below) |
   | `PAYPAL_SANDBOX` | `true` |

   To make a random string, run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables are used.
6. Open `https://your-project.vercel.app/admin`, sign in with your `ADMIN_EMAIL` address, and fill in **Settings**.

The tables are created automatically on first use. Whoever signs in with `ADMIN_EMAIL` is always an admin.

### Sign-in (Clerk)

1. Create a free account at [clerk.com](https://clerk.com) and an application. Turn on **Email** and **Google** as sign-in options.
2. Open **Configure → API keys** and copy the **Publishable key** into `VITE_CLERK_PUBLISHABLE_KEY` and the **Secret key** into `CLERK_SECRET_KEY` (mark it **Sensitive** in Vercel). Redeploy: the publishable key is built into the frontend.
3. Clerk's development keys work on localhost and on `*.vercel.app`, with Clerk's shared Google login (no Google Cloud setup). For a production instance with your own domain, Clerk walks you through DNS records and your own Google credentials.

Accounts from before Clerk are kept: signing in with the same email links to the old account, with its plan, payments and referrals. Deleting a user in the admin dashboard also deletes their Clerk login.

### AI names and alt text (Gemini)

1. Open [aistudio.google.com](https://aistudio.google.com), sign in, and choose **Get API key → Create API key**.
2. Add it as `GEMINI_API_KEY` (mark it **Sensitive**) and redeploy.

The free tier has per-minute and per-day limits, so each user can describe up to 200 images a day (`AI_DAILY_LIMIT`). Only a small preview (768 px JPEG) is sent, and nothing is stored. On the free tier Google may use the data to improve its models.

### Create images (Pollinations)

Nothing to set up: without a key the app uses Pollinations' free tier, which allows **one image every 45 seconds per IP address** and adds a small watermark. On Vercel each user's browser fetches its own image, so every user gets their own allowance (the page counts down between images). Locally the server fetches the images, because Pollinations only accepts browser requests from a real website.

For no waiting and no watermark, create a key at [enter.pollinations.ai](https://enter.pollinations.ai) and add it as `POLLINATIONS_API_KEY` (mark it **Sensitive**); the server then fetches every image. Each user can create up to 50 images a day (`IMAGE_DAILY_LIMIT`). `POLLINATIONS_MODE` (`direct` or `server`) overrides where images are fetched.

### Email (Pro expiry reminders)

1. Turn on **2-Step Verification** for the Gmail account that will send the emails.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create an App Password (name it e.g. "Image Converter"), and copy the 16-character password.
3. Add `SMTP_USER` (the Gmail address) and `SMTP_PASS` (the App Password) to the environment variables (mark `SMTP_PASS` **Sensitive**) and redeploy.

Gmail allows around 500 emails a day. Locally, without these settings, the emails are printed in the terminal where the app runs.

### PayPal (sandbox)

1. Sign in at [developer.paypal.com](https://developer.paypal.com) with a PayPal account (a free personal account works).
2. Open **Apps & Credentials**, make sure **Sandbox** is selected, and click **Create App** (type: Merchant).
3. Copy the app's **Client ID** and **Secret** into Vercel as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (mark the secret **Sensitive**), set `PAYPAL_SANDBOX=true`, and redeploy.
4. In **admin → Settings**, use a PayPal currency such as **USD** (PayPal doesn't accept LKR). The PayPal box should say **Ready · sandbox**.
5. To test, open **Testing Tools → Sandbox Accounts** on developer.paypal.com: there's a **Personal** (buyer) test account with fake money. Upgrade to Pro in the app, choose PayPal, and log in on PayPal's page with that buyer account's email and password.

Pro is only granted when PayPal reports the capture as **COMPLETED** and the amount and currency match the order. Capturing twice can't add time twice, and users can only capture their own orders. No webhook is needed, so it works on any domain, including localhost.

### PayHere (optional, needs your own domain)

PayHere rejects subdomains such as `your-project.vercel.app`, so connect your own domain to Vercel first and register that root domain.

1. Create a free account at [sandbox.payhere.lk](https://sandbox.payhere.lk).
2. Under **Settings → Domains & Credentials**, add your Vercel domain (e.g. `your-project.vercel.app`) and copy the Merchant ID and Merchant Secret.
3. Add them to Vercel's environment variables and redeploy. **Admin → Settings** shows whether PayHere is ready. The currency must be LKR or USD.
4. Pay with PayHere's sandbox test cards. Pro unlocks automatically when PayHere notifies `/api/payhere/notify`.

Pro is only granted when the notification's signature is valid **and** the amount, currency and merchant match the order. Duplicate notifications are ignored, and chargebacks remove the Pro time.

## Security notes

- Free limits and Pro access are checked on the server; changing anything in the browser can't get around them.
- Passwords, verification codes and sessions are handled by Clerk; the API checks the Clerk session token on every request.
- Uploads are authorized per visitor or user and limited by type and size. Each visitor can only use files in their own folder.
- Receipts are private; only admins can view them, through short-lived signed links. File types are checked by content, not by name.
- Requests from other websites are rejected, and image URLs that point to private networks are blocked.

## Limits

- 25 MB per image, 50 images per batch (Pro), 5 in total on the free plan.
- Receipts: JPG, PNG, WEBP or PDF, up to 5 MB.
- A conversion must finish within 5 minutes (Vercel Hobby). Very large AVIF batches can be slow, so convert them in smaller groups.
