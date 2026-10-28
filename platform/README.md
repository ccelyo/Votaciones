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
`GATEWAY_URL` to the API Gateway (`gateway/`, default `http://localhost:8088`).
`GATEWAY_URL` is read by the server at runtime; the browser never sees it.

### SSR sub-architecture

The app has the two sub-components of the P2 C&C view:

- **SSR server** (Server Components and `app/api/[...path]/route.ts`): renders
  pages with data fetched from the Gateway (`lib/server/gateway.ts`) and proxies
  every browser call under `/api/*` to the Gateway's `/api/*` routes.
- **Browser client**: hydrates the UI, blinds the token and encrypts the vote
  (`lib/m4`). It only talks to its own origin (`lib/api.ts`).

The session lives in an `httpOnly`, `SameSite=Strict` cookie (`espivota_session`):
on `POST /api/auth/login/mfa` the SSR server stores the Gateway's bearer token in
the cookie and returns only `token_type` and `expires_in`; on later requests it
sends the token to the Gateway as `Authorization: Bearer`. `POST /api/auth/logout`
and any `401` clear the cookie. Non-GET requests from another origin get `403`.

`POST /api/ballots` and `GET /api/ballots/...` are the anonymous voting route:
the browser sends them with `credentials: "omit"` and the SSR server forwards no
cookie, bearer token, `X-Forwarded-For`, `User-Agent` or `Referer`.

`/`, `/admin` and the admin election pages are rendered on the server with the
current user and their data; admin pages redirect on the server when the user is
not an administrator. In mock mode the data lives in the browser, so those
components fall back to loading it on the client.

Registration is unavailable against the current API; the registration page and
links are only shown in mock mode.

The home page reads active elections from the public `GET /api/elections/open`.
It returns an array with `id`, `name`, `starts_at`, `ends_at`, and `created_at`,
limited to elections with status `open` whose current UTC time is within the
election's `[starts_at, ends_at)` window.
The API should return a non-2xx status when a request fails; the frontend reads
FastAPI `detail` messages and the `error.message` format used by the identity
service and the Gateway.

Administrators can create an election at `/admin/elections/new`. The form posts
`name`, `options`, `encryption_public_key` (base64url without padding), `opens_at`,
and `closes_at` (UTC epoch seconds) to `POST /api/elections`; the Gateway and the
Election service enforce the administrator role as well.
The shared application sidebar is hidden on login and registration pages, and only
shows the “Crear votación” link when the current user's role is `admin`.
Authenticated users open this sidebar from the header menu icon and can end their
session through `POST /api/auth/logout`, which revokes the session and clears the cookie.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
