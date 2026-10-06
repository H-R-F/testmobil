# Architecture Proposal — "Testmobil" On-Demand Designated Driver Platform

**Status:** Phase 1 deliverable (inspection + proposal). No application code implemented yet.
**Date:** 2026-10-06
**Repo state at inspection:** Empty greenfield project (`README.md` only, single commit `3d7b05d`, branch `qwen-code-…` off `main`).
**Toolchain verified in environment:** Node v20.20.2, npm 10.8.2 (registry reachable), Python 3.12.10, Go 1.19.8. Docker CLI not confirmed; Postgres client not installed locally.

---

## 1. Product Summary (what we are building)

Not a taxi app. The defining service is:

> DRIVER → CUSTOMER'S CAR → CUSTOMER + CAR → HOME
> "Don't drive. We'll drive you and your car home."

Three roles: **Customer**, **Verified Driver**, **Admin/Ops**. The critical differentiators vs. ride-hailing are (a) the **vehicle handover protocol** with documented condition evidence, and (b) the driver travels *to the car* by any means (walk/bike/scooter/transit), so matching must optimize for reachability to the pickup, not driving distance in a cab fleet.

---

## 2. Recommended High-Level Architecture

**Modular monolith backend + web/mobile frontends + real-time gateway.**
For an MVP, microservices add cost without benefit. We enforce module boundaries in code (domain packages) so services can be extracted later if scale demands.

```
                        ┌──────────────────────────────┐
 Customer App (PWA) ────│                              │
 Driver App (PWA)   ────│   API Gateway (REST /api/v1) │──── Postgres (primary DB)
 Admin SPA        ──────│   Fastify + TypeScript       │──── Redis (cache, presence,
                        │                              │          rate-limit, pub/sub)
        WebSocket ◄─────│   + WS real-time module      │──── S3-compatible object store
                        └──────────┬───────────────────┘          (handover photos, docs)
                                   │
                     Service adapters (interfaces):
                     MapsProvider · PaymentProvider · NotifyProvider · StorageProvider
```

Principles mapped to architecture:
- Business rules (state machine, pricing, matching eligibility, permissions) live **only** in the backend. Frontends never enforce anything the server doesn't re-check ("never trust frontend permissions").
- Every external dependency (maps, payments, push, storage) sits behind a **provider interface** with a local/dev adapter, so no provider SDK leaks into domain logic and no secrets reach the client.
- Every important trip action writes an immutable, timestamped record (`trip_status_history`, `audit_log`).

---

## 3. Technology Choices (and why)

| Concern | Choice | Rationale |
|---|---|---|
| Backend | **Node.js 20 + TypeScript + Fastify** | Single language across stack, strong typing for domain/state machine, Fastify for speed + schema-based validation (AJV) + plugin isolation. Verified available in this environment. |
| Database | **PostgreSQL 15+ (with PostGIS)** | Relational fits normalized model (users/trips/payments/handovers); PostGIS gives true geospatial queries (`ST_DWithin`, KNN distance ordering) for driver matching and service zones. |
| ORM/Migrations | **Drizzle ORM + drizzle-kit migrations** | Typed schema-as-code, SQL-transparent, reviewable migrations. (Alternative: Prisma.) |
| Cache/Realtime bus | **Redis** | Driver presence set, request-offer TTLs, token denylist, rate limiting, pub/sub fan-out for WebSocket nodes. |
| Real-time | **WebSocket (fastify-websocket) + Redis pub/sub** | Event-driven pushes (status changes, offers, location updates). Not GPS polling loops — see §8. |
| Auth | **JWT access (15 min) + refresh rotation (httpOnly Secure SameSite=Strict cookies)** | Web/PWA friendly, revocable via Redis denylist; argon2id password hashing. RBAC claims server-side checked per route. |
| Frontend | **React 18 + TypeScript + Vite + React Router** | Three apps sharing one workspace package of UI components + API client: public site, customer PWA, driver PWA (+ admin SPA). Mobile-first CSS (Tailwind). Install verified feasible (npm registry reachable). |
| Mobile strategy | **PWA first; native wrapper (Capacitor) later** | Fastest path to installable, camera/GPS/push-capable apps; QR-code venue acquisition works instantly in mobile browsers without app-store friction. |
| Object storage | **S3-compatible (AWS S3 / Cloudflare R2 / MinIO for dev)** | Driver documents & handover photos via **presigned PUT uploads** (files never transit the API server; secrets stay server-side). |
| Payments | **Stripe via adapter layer** | Auth→capture→refund split matches trip lifecycle; platform commission via **Stripe Connect** to driver payouts. Abstracted behind `PaymentProvider` interface. |
| Maps | **`MapsProvider` interface; Google Maps adapter (dev default), Mapbox adapter** | Geocoding, routing/distance matrix, ETA. Provider logic isolated in `src/modules/maps/providers/*`. See §8. |
| Monorepo | **npm workspaces** | Zero extra tooling required; shared `packages/shared` (types, DTOs, state-machine definition) consumed by backend and all frontends. |

Rejected for MVP: microservices, Kafka (Redis pub/sub suffices), native Swift/Kotlin apps (time-to-market), MongoDB (relational integrity matters for money + trips).

---

## 4. Proposed Folder Structure

```
/workspace
├── package.json                  # npm workspaces root
├── docker-compose.yml            # postgres+postgis, redis, minio, mailhog (dev)
├── .env.example                  # ALL secrets documented, never committed
├── docs/                         # this proposal, ADRs, runbooks
├── packages/
│   └── shared/                   # pure TS: no runtime deps
│       ├── src/trip-state-machine.ts     # states, allowed transitions, guards
│       ├── src/roles.ts                  # CUSTOMER | DRIVER | ADMIN
│       ├── src/dto/                      # request/response contracts
│       ├── src/errors.ts                 # canonical error codes
│       └── src/pricing.ts                # price breakdown types (not values)
├── apps/
│   ├── api/                      # Fastify modular monolith
│   │   └── src/
│   │       ├── server.ts, app.ts
│   │       ├── modules/          # one folder per bounded context
│   │       │   ├── auth/         ├── users/        ├── customers/
│   │       │   ├── drivers/      ├── verification/ ├── vehicles/
│   │       │   ├── trips/        ├── matching/     ├── handover/
│   │       │   ├── locations/    ├── realtime/     ├── payments/
│   │       │   ├── payouts/      ├── ratings/      ├── notifications/
│   │       │   ├── incidents/    ├── support/      ├── pricing/
│   │       │   ├── zones/        ├── promotions/   ├── admin/
│   │       │   └── audit/
│   │       ├── plugins/          # jwt, rbac, rate-limit, db, redis, ws
│   │       ├── providers/        # maps/, payments/, notify/, storage/ (adapters)
│   │       └── jobs/             # cron: offer expiry, no-show detection, payout batching
│   ├── web-public/               # landing, how-it-works, safety, FAQ, legal (SSR later)
│   ├── web-customer/             # customer PWA (booking, tracking, SOS, history)
│   ├── web-driver/               # driver PWA (online toggle, offers, handover, earnings)
│   ├── web-admin/                # ops dashboard SPA
│   └── ui/                       # shared React component library + API client hooks
└── infra/                        # IaC, GitHub Actions pipelines, Terraform
```

Module convention inside `apps/api/src/modules/<name>/`:
`routes.ts` (HTTP wiring + schemas) → `service.ts` (use-cases/business rules) → `repository.ts` (SQL) → `index.ts`. Cross-module calls go through services, never another module's repository.

---

## 5. Required Dependencies (initial set)

- **API:** fastify, @fastify/websocket, @fastify/static, ajv validators, drizzle-orm, pg, ioredis, jsonwebtoken/jose, argon2, zod (boundary validation), ulidx (sortable IDs), @aws-sdk/client-s3 (storage), stripe, googleapis-geocoding/mapbox-sdk (behind adapters), pino (logging).
- **Shared:** typescript, vitest.
- **Frontends:** react, react-dom, react-router-dom, vite, tailwindcss, zustand (light state), @tanstack/react-query (server cache), leaflet or maplibre-gl (UI-side map rendering via adapter tokens).
- **Dev/test:** docker compose, supertest/vitest, playwright (E2E), eslint+prettier.

---

## 6. Data Model (Phase 3 blueprint — relationships before DDL)

Lifecycle spine: **User → (CustomerProfile | DriverProfile) → Trip → everything else hangs off Trip.**

Key entities & relationships (normalized):

- `users` (id, role enum, email, phone, password_hash, status: ACTIVE|SUSPENDED|DELETED, timestamps)
- `customer_profiles` (1—1 user) · `emergency_contacts` (1—N customer)
- `driver_profiles` (1—1 user; availability ONLINE|OFFLINE|BUSY, current_location, caps: manual_transmission, vehicle_types_accepted)
- `driver_verifications` (1—N driver; type IDENTITY|LICENSE|BACKGROUND, status PENDING|VERIFIED|REJECTED, expires_at)
- `driver_documents` (1—N verification; storage_key, mime, uploaded_at) — **private bucket, presigned GET only, access audited**
- `vehicles` (owned_by customer, plate, make/model, transmission)
- `trips` (id, customer, driver?, vehicle?, origin/dest points, scheduled_at?, status, quote_snapshot jsonb, totals)
- `trip_status_history` (append-only: trip_id, from_state, to_state, actor, lat/lng, ts) ← enforces §8 state machine
- `vehicle_handovers` (trip_id, phase BEFORE|AFTER, odometer, fuel_level, damage_notes jsonb, photo keys, driver_confirmed_at, customer_confirmed_at, gps, ts)
- `locations` (trip_id, role PICKUP|DROP|DRIVER_PING, point, ts) — high-volume table, time-partitioned
- `pricing_rules` (key, value, currency, zone?, valid_from/to) — **DB-configured, never hardcoded**
- `quotes` (trip draft, breakdown jsonb, expires_at)
- `payments` (trip, provider, intent_id, amount, status AUTHORIZED|CAPTURED|FAILED|REFUNDED) · `refunds` · `driver_payouts` (commission_split snapshot) · `receipts`
- `ratings` (trip, direction CUST→DRV|DRV→CUST, score, comment)
- `notifications` + `device_tokens` · `incidents` (trip?, reporter, type, severity, status) · `support_tickets`
- `service_zones` (PostGIS polygon, active) · `promotions` (code, discount rule, validity)
- `audit_logs` (actor, action, entity, before/after, ip, ts) — append-only

No blind DDL: each table gets a migration only when its producing module is built (Phases 4–12), reviewed against this map.

---

## 7. API Architecture

REST under `/api/v1`, resource-oriented, grouped exactly as the domain list in §23 of the brief (`/auth, /drivers, /trips, /matching, /payments, …`). Conventions:

- **Validation:** JSON-Schema on every route (Fastify/AJV) + zod at service boundary; reject unknown fields.
- **Errors:** canonical envelope `{code, message, details?, requestId}` with stable codes (`TRIP_INVALID_TRANSITION`, `NO_DRIVERS_AVAILABLE`, `VERIFICATION_REQUIRED`…).
- **Pagination/filtering:** cursor-based (`?cursor=&limit=`), consistent across list endpoints.
- **AuthZ:** route-level scope guard (`requireRole('DRIVER')`) **plus** row-level ownership checks in services (e.g., driver may act only on their assigned trip). Admin actions write audit logs.
- **Idempotency:** `Idempotency-Key` header honored on POST /trips, payment capture, SOS.
- **Rate limiting:** Redis sliding window per user/IP; stricter on auth + SOS-abuse protection (but SOS endpoint itself is never throttled into silence — it degrades to "log + alert ops" even under retry).

---

## 8. Maps / Location Architecture

`MapsProvider` interface: `geocode(query)`, `reverse(latlng)`, `route(origin, dest, travelMode)`, `distanceMatrix(centers, origin)`, `snapToZone(point)`. Adapters: Google (default), Mapbox. Provider API keys live **only server-side**; browser map tiles/tokens are short-lived, domain-restricted, issued by the backend.

Location strategy (battery/network conscious, no continuous polling):
1. **Driver online presence:** ping every ~30 s while app foregrounded & ONLINE (Redis key w/ TTL; stale = auto-OFFLINE flag for matching).
2. **During assigned trip:** driver app posts location on movement events + minimum interval (~10 s), batched over one WebSocket; server rebroadcasts to customer/admin via WS — customers never poll REST.
3. **ETA/route:** computed server-side on demand (assignment, arrival, start, completion), cached on the trip row.
4. Matching distances use **PostGIS geodesic distance** (straight-line fallback for ranking, routed distance for display/pricing) to avoid burning Matrix API quota during broadcast search.

---

## 9. Real-Time Architecture

Single WebSocket endpoint `/ws` (JWT-authenticated, role-scoped channels):
- Channels: `trip:{id}`, `driver:{id}`, `admin`, `user:{id}:notifications`.
- Server emits **domain events** (TripAssigned, DriverEnRoute, DriverArrived, HandoverPending, TripStarted, LocationUpdate, OfferExpired, SosTriggered) — clients render from events, never infer state from raw sockets.
- Multi-node ready: API publishes events to Redis pub/sub; each node fans out to its own socket connections.
- Fallback: if WS unavailable, clients fall back to conditional GET on trip status (short intervals, ETag).
- Offers to drivers are also pushed over WS with a server-side TTL job (auto-expire → next candidate or NO_DRIVERS_AVAILABLE terminal handling).

---

## 10. Authentication & Security Architecture

- Registration/login with argon2id; email/phone verification; optional 2FA later.
- Access JWT 15 min (role + driver-verified claims); refresh token rotation, reuse-detection, server-side revoke list in Redis.
- RBAC middleware + per-route ownership checks; driver document access requires admin scope or owning driver, always audited.
- Uploads: MIME/size allowlists, image sanitization, private buckets, presigned URLs (≤5 min) for reads.
- Transport: TLS everywhere, HSTS, secure cookie flags, CSP, CSRF token for cookie-mutating routes, strict CORS per-app origins.
- OWASP top-10 posture: parameterized SQL (no string interpolation), output-safe React, rate limits on auth, dependency audit in CI, secret scanning pre-commit.
- Payments: card data never touches our servers (Stripe Elements → server-side intents); webhooks signature-verified; amounts stored integer-minor units.
- Secrets: `.env` locally, SSM/Secrets Manager in prod; `.gitignore` enforced; nothing secret in any frontend bundle.

---

## 11. Payments & Business Model Wiring

Quote flow: pricing engine reads `pricing_rules` rows → returns itemized estimate **(base + trip distance fee + pickup/reachability component + surcharges − discounts)** shown before confirmation; quote snapshot frozen onto the trip at booking (transparency guarantee).

Settlement flow: `AUTHORIZE at confirm → CAPTURE at TRIP_COMPLETED → payout ledger splits platform commission vs driver share using the snapshot's configurable percentages`. Cancellation applies configurable cancellation fee only past the free-cancel window/state. Refunds/partial refunds recorded against payment rows; every movement produces a receipt. Stripe Connect transfers for drivers on a configurable payout schedule.

---

## 12. Deployment Architecture

- **CI/CD:** GitHub Actions — lint → typecheck → unit/integration tests → build images → staging deploy → smoke E2E → manual-gate prod.
- **Prod topology (start simple):** containerized API behind AWS ECS Fargate (or Fly.io early), managed Postgres+PostGIS (RDS/Neon), managed Redis (ElastiCache/Upstash), S3/R2, CloudFront for static frontends, Sentry + structured log shipping.
- **Static frontends** deployed to CDN; PWA manifests enable Add-to-Home-Screen + Web Push.
- Environments: dev (docker compose) / staging / prod; migrations gated, reversible where possible; blue/green for API.

---

## 13. Phased Implementation Roadmap (aligned to brief §26/§28)

| Phase | Deliverable | Exit check |
|---|---|---|
| 1 ✅ | Repo inspection, this proposal | done (this doc) |
| 2 | Monorepo scaffold, docker-compose dev env, CI skeleton, shared package | `npm test` green in CI |
| 3 | DB schema migrations (core tables), seed scripts, Trip state machine in `shared` with exhaustive transition tests | state machine rejects illegal transitions 100% |
| 4 | Auth + RBAC + profiles (customer, driver) | e2e register/login/role gates |
| 5–6 | Customer booking flow (quote→confirm) & Driver flows (verify, online/offline) | quote accuracy, verification blocking |
| 7 | Matching engine (eligibility → geo-rank → offer cascade) + full trip lifecycle transitions | simulated dispatch happy path + no-driver path |
| 8 | Vehicle handover (photos, odometer, dual confirmation gate on TRIP_STARTED) | trip cannot start unsigned |
| 9 | WS realtime, presence, live tracking, ETA | customer sees driver move without polling |
| 10 | Payments (authorize/capture/refund) + payouts + receipts | money math property tests |
| 11 | SOS/incidents/emergency contacts/support tickets | SOS creates incident + alerts ops within seconds |
| 12 | Admin dashboard (monitoring, verification queue, pricing editor, zones) | ops can run the whole business |
| 13–16 | Test hardening, security review, perf, production deploy | quality gate §29 checklist signed |

MVP cut-line = Phases 2–10 plus minimal admin (manual driver verification via DB/dashboard). Ratings basic; promotions/zones editable but simple.

---

## 14. Risks & Open Assumptions (need stakeholder/legal input)

1. **Liability & insurance** *(highest risk)*: who insures damage to the customer's car during the handover window? Design assumes platform acts as marketplace and requires driver commercial/"hire-and-reward"-type coverage + per-trip contingent insurance; **must be validated with counsel per market before launch.** Handover photo evidence exists precisely to arbitrate this.
2. **Driver legal status**: employees vs contractors (classification affects payouts, taxes, benefits) — payout ledger designed to support either, but policy undecided.
3. **Alcohol-service venues**: operating where customers are impaired raises consent/capacity questions — handover confirmation UX must be plain-language; consider requiring sober-companion or delaying non-emergency disputes.
4. **Jurisdictional data rules** (GDPR/local): document retention limits for ID/license scans, right-to-deletion vs financial-record retention obligations.
5. **Matching fairness SLA**: what happens after N minutes with no acceptance — currently proposed terminal `NO_DRIVERS_AVAILABLE` + notification; product decision needed on surge/waitlist behavior.
6. **Payment provider availability by country** — Stripe assumption may not hold in target launch market(s).
7. **Map provider cost/quota** at scale (routing matrix per offer round) — mitigated by PostGIS ranking, needs load estimation.
8. **SOS expectations**: button connects to emergency services via device dialer + platform ops alert; marketing must not promise guaranteed physical response (brief explicitly requires this honesty).
9. **Fake/staged requests by verified drivers** (gaming payout) — mitigation planned: velocity checks + admin anomaly view; needs policy thresholds.
10. **Launch city/service zone definition** still unknown — zones are data-driven so this is config, not code.

---

## 15. Decision Requested Before Phase 2

Confirm: (a) TypeScript/Node + Postgres+PostGIS + React PWAs stack, (b) Stripe + Google Maps as *default adapters* (interface keeps them swappable), (c) PWA-first instead of native, (d) monorepo layout above. Then proceed to Phase 2 scaffolding.

**END OF PHASE 1 — stopping here as instructed; awaiting next task.**
