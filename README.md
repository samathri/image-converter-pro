# Image Converter Pro (Web)

Convert, compress and download images in the browser: AVIF, WEBP, JPEG and PNG, compressed to a target size. Built with React (Vite) and an Express API, ready to deploy on **Vercel**.

A university portfolio project: free tier with limits, user accounts, a Pro plan paid by card (PayHere sandbox) or bank transfer, and an admin dashboard to review payments.

## Features

- Upload images (drag & drop) or paste image URLs, pick formats and a target size, and download the results (one file, or a zip).
- **Free:** 3 conversions in total, up to 5 images each, then locked. Counted per browser, account and IP address, so clearing cookies or making a new account doesn't reset it.
- **Pro:** unlimited conversions, up to 50 images per batch. Needs an account.
  - **Card via PayHere:** Pro unlocks automatically when PayHere confirms the payment.
  - **Bank transfer:** the user uploads the receipt and an admin approves or rejects it.
- **Admin dashboard** (`/admin`): review payments and receipts, manage users' Pro access, set the price and bank details.

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
   | `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET` | Optional, from sandbox.payhere.lk |
   | `PAYHERE_SANDBOX` | `true` |

   To make a random string, run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables are used.
6. Open `https://your-project.vercel.app/admin`, sign in with your admin email and password, and fill in **Settings**.

The tables are created automatically on first use. The admin account always follows `ADMIN_EMAIL` and `ADMIN_PASSWORD`: change them and redeploy to change the admin login.

### PayHere (sandbox)

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
