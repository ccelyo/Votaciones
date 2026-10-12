This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Authentication API

To explore the frontend without a running backend, copy `env.example` to
`.env.local` and start the development server. Mock mode persists demo users and
elections in this browser's local storage. Use `admin@votaciones.test` to test
administrator options or `voter@votaciones.test` to test a regular account; in
mock mode, any non-empty password works. New registrations are regular users.
The mock includes sample election options and stores one test vote per user and
election in the browser. This mode is only a UI mock: it does not validate
credentials or submit real votes.

To connect to the real backend, set `NEXT_PUBLIC_API_MODE=api` and
`NEXT_PUBLIC_API_URL` to the API base URL. The frontend sends JSON
requests to `POST /login` (`email`, `password`) and `POST /register`
(`full_name`, `email`, `password`). The home page reads open
elections from `GET /elections?status=open`, which should return an array of
elections matching the `Election` type in `lib/types/election.ts`.
The API should return a non-2xx status when a request fails; the frontend reads
FastAPI `detail` messages and the identity service's `error.message` format.
Requests include credentials so the API can establish or use a session cookie.

Administrators can create an election at `/admin/elections/new`. The form posts
`name`, `options`, `encryption_public_key` (base64url without padding), `opens_at`,
and `closes_at` (UTC epoch seconds) to `POST /elections`; the identity API enforces
the administrator role as well.
The shared application sidebar is hidden on login and registration pages, and only
shows the “Crear votación” link when the current user's role is `admin`.
Authenticated users open this sidebar from the header menu icon and can end their
session through `POST /logout`; the API must invalidate the session cookie.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
