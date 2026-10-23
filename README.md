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
- **Accounts:** sign up with email (a 6-digit code is emailed to verify it), Google or Facebook. Show/hide password, and "Forgot password" with an emailed code.
- **Offers:** timed sale campaigns (with a banner), promo codes (% or amount off, expiry, usage limits; 100% codes give Pro free) and a referral programme (invite links, bonus free conversions and a first-purchase discount for friends, free Pro days for the referrer).
- **Admin dashboard** (`/admin`): review payments and receipts, manage users (grant or revoke Pro, make admin, delete), run promotions, set the price and bank details. Admins always have unlimited access; the owner account (`ADMIN_EMAIL`) can't be demoted or deleted.

## Architecture

| Part | Production (Vercel) | Local development |
|---|---|---|
| Frontend | React + Vite, served by Vercel's CDN | Vite dev server or `npm start` |
| API | Express app as one Vercel Function (`api/index.js`) | Same app on port 3001 (`server/index.js`) |
| Database | Postgres (Neon) via `DATABASE_URL` | Built-in PGlite in `data/pglite`, no setup |
| Files | Private Vercel Blob store | `data/blobs` |

Vercel Functions accept at most 4.5 MB per request, so images and receipts are uploaded from the browser **straight to Blob storage**. The API then converts them and returns a short-lived signed download link. Temporary uploads and results are deleted after an hour by a daily cleanup job.

## Run locally

Needs Node.js 22.13 or newer.

```bash
npm install
```

Copy `.env.example` to `.env` and set `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Leave the database and Blob settings empty. Then:

```bash
npm run dev
```

Open http://localhost:5173. The admin account is created on first start; sign in at http://localhost:5173/admin and fill in **Settings** (price, currency, bank details).

To run the built version instead, use `npm run build` and then `npm start`, and open http://localhost:3001.

> The local database can only be opened by one program at a time. If you use `npm run create-admin`, stop the app first.

## Deploy to Vercel

1. **Push the project to GitHub**, then in Vercel choose **Add New → Project** and import the repository. The settings in `vercel.json` are picked up automatically.
2. **Add a database:** in the project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This adds `DATABASE_URL`.
3. **Add file storage:** **Storage → Create → Blob**, choose **Private** access, and connect it to the project. This adds `BLOB_STORE_ID`; the app then uses Vercel's automatic credentials, so no token needs to be copied. (A `BLOB_READ_WRITE_TOKEN` also works if you have one.)
4. **Add environment variables** in **Settings → Environment Variables**:

   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | A long random string (required) |
   | `ADMIN_EMAIL` | Your admin email |
   | `ADMIN_PASSWORD` | A strong password (8+ characters) |
   | `CRON_SECRET` | A long random string (protects the cleanup job) |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From developer.paypal.com (see below) |
   | `PAYPAL_SANDBOX` | `true` |

   To make a random string, run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables are used.
6. Open `https://your-project.vercel.app/admin`, sign in with your admin email and password, and fill in **Settings**.

The tables are created automatically on first use. The admin account always follows `ADMIN_EMAIL` and `ADMIN_PASSWORD`: change them and redeploy to change the admin login.

### Email (signup codes and password reset)

1. Turn on **2-Step Verification** for the Gmail account that will send the emails.
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create an App Password (name it e.g. "Image Converter"), and copy the 16-character password.
3. Add `SMTP_USER` (the Gmail address) and `SMTP_PASS` (the App Password) to the environment variables (mark `SMTP_PASS` **Sensitive**) and redeploy.

Gmail allows around 500 emails a day. Locally, without these settings, the codes are printed in the terminal where the app runs.

### Google sign-in

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project, then **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email, and add yourself as a test user (or publish the app).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
3. Under **Authorised redirect URIs** add `https://YOUR-DOMAIN/api/auth/oauth/google/callback` (and `http://localhost:3001/api/auth/oauth/google/callback` for local testing).
4. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then redeploy. The "Continue with Google" button appears automatically.

### Facebook sign-in

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create app**, and add the **Facebook Login** product.
2. In **Facebook Login → Settings**, add `https://YOUR-DOMAIN/api/auth/oauth/facebook/callback` to **Valid OAuth Redirect URIs**.
3. In **App settings → Basic**, copy the **App ID** and **App secret** into `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`, add a privacy policy URL, and redeploy.
4. While the app is in **Development** mode only you (and people you add as testers) can sign in; switch it to **Live** for everyone.

Google/Facebook accounts are matched to existing accounts by email. New ones get no password; they can set one with "Forgot password".

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
- Passwords are hashed with scrypt. Sessions are HTTP-only cookies, and login attempts are rate-limited in the database.
- Uploads are authorized per visitor or user and limited by type and size. Each visitor can only use files in their own folder.
- Receipts are private; only admins can view them, through short-lived signed links. File types are checked by content, not by name.
- Requests from other websites are rejected, and image URLs that point to private networks are blocked.

## Limits

- 25 MB per image, 50 images per batch (Pro), 5 in total on the free plan.
- Receipts: JPG, PNG, WEBP or PDF, up to 5 MB.
- A conversion must finish within 5 minutes (Vercel Hobby). Very large AVIF batches can be slow, so convert them in smaller groups.
