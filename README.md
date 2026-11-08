# BunkFy Web

This is the operational frontend for BunkFy, an open-source hostel property management system.

The app is a Vite-powered React client for staff. It connects directly to the public BunkFy API and keeps product workflows grouped around the property currently being operated.

## Current Scope

- Tenant-aware staff login and registration with password confirmation and race-safe browser sessions.
- Optional external-provider sign-in/linking plus self-service password, email-verification, and session controls.
- Property, room, and bed topology management.
- Room/bed sales-mode setup, availability checks, and manual inventory blocks.
- Full reservation lifecycle with grouped availability, Guest Record linking, editable booking details and history, check-in, no-show, checkout, and cancellation.
- Property-scoped guest profiles with search, editing, archival, and stay history.
- Staff profiles with lifecycle management, account links, and property assignment history.
- Property integration operations covering connections, credentials, review proposals, runs, receipts, raw payloads, and reprocessing audit.
- Live personal notifications and workspace announcements with durable read state, plus account-wide session revocation.
- A property-level operations overview for arrivals, guests, inventory, and upcoming stays.
- React, TanStack Query, React Router, Tailwind CSS, and daisyUI.

## Validation

```powershell
pnpm install
pnpm verify
```

Public API types are generated from the backend OpenAPI document. Check drift with `pnpm contracts:check`; after an intentional backend contract change, run `pnpm contracts:generate` from this repository's root-superproject checkout. Do not edit `src/api/contracts.generated.ts` manually.

Run the app directly:

```powershell
pnpm dev
```

The default API address is `http://localhost:5194`. Override it with `VITE_BUNKFY_API_BASE_URL` (`/` selects the same origin), or run the root Aspire AppHost to inject the API endpoint automatically. Email verification controls use the runtime `/api/product-capabilities` response and fail closed when the composed backend delivery path is unavailable.

Browser refresh state is stored only in path-scoped `HttpOnly`, `SameSite=Strict` cookies. The access token remains in memory, concurrent unauthorized requests share one refresh operation, and supported browsers serialize cookie rotation across tabs with Web Locks; no bearer or refresh token is persisted in browser storage.

Mounted OpenID Connect providers are discovered from the API. Their browser challenge uses a short-lived HttpOnly handoff before returning to `/auth/complete`; provider codes and one-time exchange codes never carry access or refresh tokens in URLs. Email-verification delivery additionally requires a configured backend email sender.

## Documentation

Start with [docs/README.md](docs/README.md).

## Hosting under a URL prefix

The default public path is `/`. To build for a path such as `/example/`, set
`VITE_PUBLIC_BASE_PATH=/example/`. Configure `VITE_BUNKFY_API_BASE_URL` for the API's
public address; `/example/` works when the reverse proxy exposes the API at that
same prefix. The Docker build accepts both values as build arguments.

Client navigation, invitation links, station handoffs and external-auth return
URLs retain the configured public prefix. Configure the reverse proxy to strip
the prefix before forwarding to the frontend container, and keep backend proxy
routing, refresh-cookie paths and external-auth return configuration consistent
with the chosen public URLs. Colocated applications need distinct refresh-cookie
paths.
