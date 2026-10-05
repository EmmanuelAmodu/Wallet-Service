# Exchange infrastructure architecture

Updated: 5 October 2026. This deployment serves one exchange owner. Customer identity, custody balances, and customer liabilities are separate concerns.

## Services and database ownership

| Application      | Owns                                                                                                                                                         | Communication                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| User             | Identity, email/password registration/login, password hashes, access-token issuance                                                                          | Public registration/login HTTP; secret-free `user.registered.v1` to Wallet                                     |
| Wallet           | User/customer mapping, custody registry, deposit-address assignments/readiness, deposit history, customer APIs, internal operations, withdrawal coordination | Public JWT-authenticated HTTP; registry/action queues to workers; authenticated Ledger balance reads           |
| ActivityListener | Provider watch/backfill registry, RPC verification, transfer identity/finality, deposit observations and custody exceptions                                  | QuickNode gateway and Pub/Sub; verified deposit/incident events to Ledger; history to Wallet                   |
| Ledger           | Customer pending/available/reserved/frozen liabilities, custody accounts, immutable balanced journals, holds, compensation, accounting results               | Deposit results and custody incidents independently delivered to Wallet and Sweep                              |
| Sweep            | Customer/hot registry projection, credited-deposit eligibility, coalesced source/asset work, recovery and review gates; future sweep/funding execution state | Consumes committed Ledger events and registry commands; Phase 4 will request signing/submission through queues |
| Signer           | Seed access, key derivation, ephemeral private keys, transaction signing                                                                                     | Authenticated queue commands/results; no database                                                              |
| Broadcast        | Immutable signed bytes, submission, retries, confirmation/expiry/reconciliation                                                                              | RPC and authenticated queues; operation status to its coordinator                                              |

Every database-owning service has its own Prisma schema, generated client, migration history, database credentials, inbox/outbox where needed, and lifecycle hooks. No application imports another application's implementation or queries its database. Database ownership is enforced in application import lint rules. Redis/BullMQ carries durable action queues with competing workers; it is not Redis Pub/Sub transport. Provider discovery enters through Google Cloud Pub/Sub.

```mermaid
flowchart LR
  Customer -->|register / login| User
  User -->|signed access token| Customer
  Customer -->|Bearer JWT| Wallet
  User --> UserDB[(User DB)]
  UserDB -->|registration outbox| Queue[(Redis / BullMQ)]
  Queue --> Wallet
  Backend[Private exchange backend] -->|service credentials / internal paths| Wallet
  Wallet --> WalletDB[(Wallet DB)]
  WalletDB -->|registry / commands| Queue
  Wallet -->|authenticated balance query| Ledger
  Provider[QuickNode gateway / Bitcoin Core gateway] -->|discovery / backfill| Activity[ActivityListener]
  Activity --> ActivityDB[(Activity DB)]
  Activity -->|canonical transfer / finality checks| RPC[Chain RPC]
  ActivityDB -->|verified observations| Queue
  Queue --> Ledger
  Ledger --> LedgerDB[(Ledger DB)]
  LedgerDB -->|committed credit / reversal / incident| Queue
  Queue --> Sweep
  Sweep --> SweepDB[(Sweep DB)]
  SweepDB -.->|Phase 4 authorized execution| Queue
  Queue --> Signer
  Signer --> Seed[Read-only seed]
  Signer -->|signed result| Queue
  Queue --> Broadcast
  Broadcast --> BroadcastDB[(Broadcast DB)]
  Broadcast --> RPC
```

## Registration and the single owner

`POST /v1/users/register` on User accepts only email and password. It normalizes email by trimming and lowercasing, enforces unique email, and stores an async scrypt hash with a random salt. Passwords retain their exact Unicode bytes, with 15–128 Unicode code points and no trimming/truncation. Responses expose only `userId`, normalized email, and creation time; queue events contain only `userId`, never email, password, or hash. User has no wallet, balance, deposit, or blockchain API.

The user row and `user.registered.v1` delivery commit together. Wallet consumes the authenticated event with durable receipt/content checks and creates `customerId = userId`, `externalId = userId`. Wallet's customer projection, inbox receipt, and Ledger registration command commit in one transaction. Ledger acknowledges identity before balances or addresses become ready. Lost queue acknowledgments and replay cannot change identity or clear a freeze. Wallet's former backend `POST /v1/customers` registration route is removed; registration originates in User. The internal non-UUID fixture/import helper does not claim User UUID identities.

`POST /v1/users/login` verifies email/password and returns an RS256 access token with a User UUID subject, issuer, audience, issue/expiry times, unique token ID, and reset epoch. The default lifetime is 15 minutes. User holds the private token key; Wallet holds only its public verification key and verifies tokens locally without querying User's database or HTTP API. Public Wallet `/v1/me` routes derive ownership from the verified subject and reject caller-supplied customer identities. Registration provisioning is asynchronous: `GET /v1/me` returns HTTP 202 while Wallet awaits the identity event. See [authentication setup and API contract](user-authentication.md).

There is no tenant field, request tenant context, key map, or tenant-scoped identity. Legacy operations moved to `/internal/wallets` and `/internal/transactions` with `WALLET_API_KEY`; administrative customer routes moved to `/internal/customers` with `EXCHANGE_API_KEY`. Ledger's `/internal` read API requires `LEDGER_API_KEY` and a private network. These service credentials remain distinct from `QUEUE_AUTH_KEY`; customer access tokens cannot authorize operational routes, and service keys cannot authorize `/v1/me`. A technical `EXCHANGE_DOMAIN_ID` binds custody seed/network configuration, operation ownership, and reset safety; it represents custody configuration rather than another owner.

User has an 8 KiB request limit, independent registration/login IP/global throttles, and one bounded hashing pool for both operations. Login uses the same scrypt work for missing accounts and incorrect passwords, returns a generic 401, and sets token responses to `no-store`. Socket peer addresses are used without trusting caller-supplied forwarding headers. Default hashing concurrency is two; overload returns HTTP 429. The scrypt parameters follow the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt). Shared edge/distributed limits are required before scaling public authentication across replicas. Refresh tokens, session revocation/logout, email verification, MFA, and password reset remain later identity work.

Only User and Wallet publish application HTTP ports in [the development application overlay](../compose.apps.yaml). Signer, Broadcast, ActivityListener, and Sweep run Nest application contexts without HTTP listeners; Ledger provides authenticated private reads plus operator event/reconciliation compatibility routes. Normal inter-service actions, registration, registry updates, and financial state changes use authenticated BullMQ queues with transactional outboxes; Ledger's operator compatibility actions remain private and service authenticated. Wallet-to-Ledger HTTP remains a read-only exception and no longer registers wallets during balance reads. Public ingress must route User's `/v1/users/*`, Wallet's `/v1/me/*`, and optional public Wallet documentation only; deny Wallet `/internal/*` at the edge and keep Ledger off public ingress.

## Deposits and Sweep boundary

ActivityListener installs watches only for customer deposit addresses in the native rollout. It retains hot/management registry projections for classification, without installing customer-style watches on those accounts. Provider notifications supply lookup hints; RPC verification determines canonical transfers, base units, and finality. Initial historical backfill and watch acknowledgment are prerequisites for exposing an address. QuickNode is selected for Ethereum/Solana; its external gateway deployment/certification remains a rollout gate.

ActivityListener does not schedule sweeps or sign/broadcast. It observes both directions at customer addresses: outflows must remain visible to detect unauthorized movement, attribute failed fees, and compensate reorgs. Registered funding, sweep receipts, refunds, and change never mint a customer credit. Unexpected or incomplete customer spends produce incidents/review gates. This auditing is part of verified observation, not execution orchestration.

Ledger credits a finalized eligible deposit once and emits `deposit.credited.v1` from the same transaction as the journal. Separate outbox records deliver the identical accounting result to Wallet and Sweep, each with independent retries/inbox retention. Pending deposit discovery does not schedule a sweep. Reversals, deficits, and custody incidents also reach Sweep so delayed/reordered events cannot bypass review.

ActivityListener retains finalized inclusion evidence separately from a replacement pending observation. A proven orphan compensates prior credit/loss before replacement finality; RPC uncertainty preserves the prior evidence and credit. Registry recovery filters eligible networks before applying batch limits, so disabled rows cannot starve certified networks. Ledger persists reversal-first settlement fences independently of an operation: stale settlement cannot consume a withdrawal hold, release remains blocked under uncertainty, and compensation is posted only when an original journal exists. Settlement fee-cap, custody-shortfall, and reorg incidents fan out atomically to Wallet and Sweep.

Sweep owns source/asset work and its registry projection. It coalesces credited deposits without treating credited amounts as current on-chain spendable balance. Missing customer/hot registrations retain blocked work and recover on registry delivery. Reversal-first tombstones absorb late credit; customer/domain review gates remain sticky. Unsupported assets defer. The current worker persists scheduling intent with `blocked_execution_not_implemented` once registry prerequisites are present. It emits no signing/submission commands. Phase 4 must add canonical resource reads, durable input/nonce reservations, economics, fee funding, signing authorization, attempts, settlement correlation, and repair before executing funds.

Broadcast continues to own same-byte submission retries. Sweep owns business retry decisions: when another sweep is eligible, when funding is needed, or when an uncertain prior attempt forbids a replacement. These are separate state machines. Ledger exclusively posts sweep/funding principal and actual fees; a sweep does not reduce the customer's liability. Wallet remains the registry/API and future withdrawal coordinator. Reusable preparation/chain helpers belong in shared packages rather than application imports.

## Nest modules and transport adapters

Each application has a small `main.ts` and root `AppModule`. Feature modules export only providers needed by that application. Controllers/processors validate input and delegate to injectable services. `@nestjs/config` factories validate settings and inject typed configuration; application services do not read `process.env` directly.

- User: `users/`, `users/dto/`, `auth/`, shared password hashing/throttle providers, `prisma/`, and registration outbox relay.
- Wallet: `auth/`, `wallets/`, `transactions/`, `customers/`, `exchange-messaging/`, `messaging/`, `ledger/`, and `prisma/`; custody bootstrap/withdrawal modules remain planned.
- Sweep: `sweep/` processor/application service, registry/deposit/work projections, `prisma/`, and shared outbox infrastructure.
- ActivityListener: `registry/`, `provider/`, `exchange/`, Pub/Sub transport, legacy activity workflow, and `prisma/`.
- Ledger: `accounts/`, `journal/`, `deposits/`, `reservations/`, `settlements/`, `incidents/`, `exchange/`, and `prisma/`.
- Signer and Broadcast retain their `signing/` and `broadcast/` feature boundaries.

Strict Zod schemas are the runtime contract for HTTP and queue payloads. `ZodValidationPipe`, UUID pipes, and `SafeErrorsFilter` provide validated/safe HTTP boundaries. Wallet Swagger documents public customer routes with bearer JWT and excludes internal paths. Customer guards validate signature, fixed algorithm, issuer/audience, bounded lifetime, UUID subject, and reset epoch; service guards protect internal APIs. Workers authenticate HMAC envelopes and reject stale `RESET_EPOCH` before financial transitions. `ActionRejectedError` means a permanent invalid action; missing registry/state dependencies remain retryable and never consume a durable inbox receipt prematurely.

## Durability, lifecycle, and development setup

State changes that schedule actions use the owning Prisma transaction for outbox writes. Independent consumer deliveries share the event identity/payload but have separate delivery records. Consumers retain durable event IDs and content digests after queue retention. Aggregate revision guards and database locks protect transitions. Queue HMAC is transport authentication; independent signing/role/destination authorization remains Phase 4 work.

Prisma providers connect/disconnect through Nest lifecycle hooks. Worker shutdown drains consumers; outbox relays stop timers and complete an active flush. ActivityListener retains its verification/registry recovery scans. Sweep does not currently have an execution loop because execution is blocked. User is a producer-only HTTP service with an outbox relay.

`nest-cli.json` declares seven applications. Build generates all six Prisma clients, builds every app, and compiles tests/tools. `dev:*`, `build:*`, and `start:*` include User and Sweep. Default local database ports are Wallet 5432, Broadcast 5433, Ledger 5434, ActivityListener 5435, Sweep 5436, and User 5437; default HTTP ports are Wallet 3000, User 3001, and Ledger 3010. Compose and CI use separate databases for all six owners. `migrate:user` and `migrate:sweep` apply only those schemas.

Wallet/Ledger tenant removal and the settlement/inclusion fixes use additive migrations; historical SQL remains unchanged. Conflicting global development external identities cause migration failure rather than an implicit merge. Development resets include all six databases and epoch-specific queues, require stopped workers/publisher and retired provider watches, and remain guarded by durable reset markers/locks. No deployment reset or application migration is performed as part of this code change. Existing environments must replace `WALLET_API_KEYS` with one `WALLET_API_KEY`, add User/Sweep URLs/settings, and configure separate token keys before starting the revised services. `setup:local` generates a distinct RSA token key pair for fresh environments. Production User/Wallet startup requires the appropriate key; development login/customer routes return 503 if absent.

Real PostgreSQL/Redis tests verify financial/outbox/inbox behavior; compiled Nest tests verify controllers, guards, DI metadata, and registration limits. RPC/provider fixtures remain deterministic and no test sends live funds. Full execution rollout still requires custody bootstrap, external provider certification, and the Phase 4/5 gates in the [exchange checklist](exchange-wallet-todo.md).
