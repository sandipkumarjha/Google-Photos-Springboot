# Pixora – web client

Pixora is a cloud photo library. This is the Next.js frontend; it talks to the Spring Boot API in `../backend`, which stores files in ImageKit and metadata in PostgreSQL.

## Stack

- Next.js 16 (App Router, Turbopack) with React 19 and TypeScript
- Tailwind CSS 4 with shadcn/ui (Base UI primitives) and lucide icons
- TanStack Query for server state, Zustand for auth, selection and upload queue state
- next-themes for light / dark / system theme
- sonner for toasts, react-hook-form + zod for forms

## Running locally

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

The API base URL defaults to the deployed backend,
`https://google-photos-springboot.onrender.com/api`. Point it at a local backend with:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080 pnpm dev
```

The value may be the backend origin or include `/api`; the client appends `/api` once.
`NEXT_PUBLIC_*` variables are inlined at build time, so set it before `pnpm build`.

Other scripts: `pnpm lint`, `pnpm build`, `pnpm start`.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Public landing page (features, how it works, workspace preview) |
| `/login`, `/register` | Authentication; signed-in users are redirected to the workspace |
| `/dashboard` | Overview: recently added photos, albums, real library usage, quick actions |
| `/photos` | Main library with drag-and-drop upload, server-side search and sorting, selection and bulk actions |
| `/photos/[id]` | Full-screen viewer with prev/next, details, version lineage, download and quick AI edits |
| `/photos/[id]/edit` | Editor: crop, aspect ratio, resize, rotate, flip, effects, AI steps, format/quality, before/after compare, undo/redo |
| `/albums`, `/albums/[id]` | Album list and detail with rename, cover, add/remove photos, delete, PIN lock |
| `/archive`, `/trash` | Archived and trashed photos with restore / permanent delete |

Protected routes are guarded on the client (`components/auth/auth-guard.tsx`). Unauthenticated visitors are sent to `/login?next=…` and return to the page they asked for after signing in.

## Project layout

```
app/              routes (route groups: (auth), (app))
components/
  brand/          Pixora mark and wordmark
  landing/        public landing page sections
  layout/         app shell, sidebar, account menu, page header
  photos/         grid, tiles, viewer, upload queue, drop zone, bulk toolbar, versions
  editor/         editing workspace: canvas, compare slider, crop overlay, step list, tools
  albums/         album grid, dialogs, photo picker
  dashboard/      overview widgets
  library/        storage summary, ImageKit import
  ui/             shadcn/ui primitives plus small shared pieces
hooks/            TanStack Query hooks and UI hooks
lib/              API client (with token refresh), ImageKit URL helpers, edit step catalog, formatting
stores/           Zustand stores: auth (persisted), selection, upload queue, viewer, editor pipeline
```

## Sessions

Access tokens are short-lived; `lib/api.ts` decodes the `exp` claim and refreshes via `POST /auth/refresh` shortly before expiry, or once after an unauthenticated response. Refresh calls are single-flight and tolerate another tab having rotated the token first.

## Images

Thumbnails and album covers are requested from ImageKit with a square smart-crop URL transformation (`lib/imagekit.ts`). Full-size images in the viewer use the original URL. No ImageKit credentials live in the client; uploads go through the backend.

## Editor

The editor builds an ordered pipeline of steps (`lib/edit-steps.ts`) and sends it to `POST /photos/{id}/edits/preview`, which validates every step and returns an ImageKit URL for the chained transformation. Non-AI pipelines preview automatically; pipelines with AI steps wait for an explicit "Generate preview" because each render spends ImageKit AI credits. `POST /photos/{id}/edits/apply` downloads the rendition and stores it as a new photo with `parentPhotoId` and `editChain` set, so the source is never modified. `GET /photos/{id}/versions` lists a photo's parent and derived copies. Downloads use ImageKit's `ik-attachment=true` flag.

A manual crop always runs first and is expressed in original-image pixels, which is what lets the on-canvas crop overlay stay exact; every other step can be reordered.

## Private albums

An album can be locked with a 4 to 6 digit PIN from its options menu. While locked, the album's cover is withheld and its photos leave the library, search, dashboard and the photo viewer (opening one redirects to the album's PIN screen). Entering the PIN returns a short-lived album token that the client keeps in memory only and sends in the `X-Album-Token` header; it expires after ten minutes, on reload, and on sign-out. Five wrong PINs in a row pause PIN entry for five minutes. The PIN is stored hashed on the backend; a forgotten PIN is removed with the account password. Edited copies of a private photo join the same locked album so they stay private.
