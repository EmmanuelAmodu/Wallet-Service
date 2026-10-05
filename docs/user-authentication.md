# User authentication and Wallet access

Implemented: 5 October 2026.

User owns identity, password verification, and access-token issuance. Wallet owns customer/custody APIs. No password, password hash, email, or token enters the financial queues. The registration outbox sends only the User UUID so Wallet can provision its financial identity asynchronously.

## Public API

| Application | Endpoint                                     | Authentication and result                                                                                                                                                                              |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User        | `POST /v1/users/register`                    | Public, strict email/password body; 201 with `userId`, normalized `email`, and `createdAt`.                                                                                                            |
| User        | `POST /v1/users/login`                       | Public, strict email/password body; 200 with `accessToken`, `tokenType: "Bearer"`, and `expiresIn` seconds. Wrong credentials return the same generic 401.                                             |
| Wallet      | `GET /v1/me`                                 | Bearer access token; customer identity/state, or 202 `awaiting_customer_registration` while the registration event is pending.                                                                         |
| Wallet      | `POST /v1/me/deposit-addresses`              | Bearer access token; strict `{ "chain": "ethereum", "network": "11155111" }` or configured Solana identity. Only the configured Ethereum/Solana networks are accepted; Bitcoin awaits custody support. |
| Wallet      | `GET /v1/me/deposit-addresses/:assignmentId` | Bearer access token; owner-scoped assignment/readiness. An address is returned only after custody, Ledger, and listener coverage gates pass.                                                           |
| Wallet      | `GET /v1/me/balances`                        | Bearer access token; 202 while Ledger registration is pending, then customer liabilities from authenticated internal Ledger reads.                                                                     |
| Wallet      | `GET /v1/me/deposits?limit=50&cursor=UUID`   | Bearer access token; owner-scoped deposit history.                                                                                                                                                     |

Wallet obtains the customer UUID from the verified token subject. These APIs do not accept customer IDs in the body/query. An access token does not grant service credentials or access to another customer's assignment. Login works independently of Wallet provisioning; a new user can log in while financial registration is pending.

Registration passwords contain 15–128 Unicode code points. Login accepts existing passwords up to 128 code points without applying the new-registration minimum; passwords are never trimmed or normalized. Email is trimmed/lowercased. Registration and login share the bounded asynchronous scrypt pool, with independent per-process IP/global request limits. A missing account still performs the same scrypt work as an incorrect password. Login responses carry `Cache-Control: no-store` and `Pragma: no-cache`.

Save credentials in a local request file, then call login and pass its `accessToken` as the bearer value:

```sh
curl http://127.0.0.1:3001/v1/users/login \
  -H 'Content-Type: application/json' --data-binary @login.json
curl http://127.0.0.1:3000/v1/me/balances \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Token keys and configuration

Tokens use RS256 through `jose`'s [SignJWT](https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md) and [jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md). User receives an RSA private key in PKCS8 PEM format; Wallet receives only the corresponding SPKI public key. Minimum RSA size is 2048 bits; local setup generates 3072 bits. Token keys are separate from the custody mnemonic and all queue/service keys.

| Setting                                                   | Application            | Default/constraint                                                      |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `AUTH_TOKEN_PRIVATE_KEY_FILE` or `AUTH_TOKEN_PRIVATE_KEY` | User only              | Private PKCS8 PEM; configure exactly one source.                        |
| `AUTH_TOKEN_PUBLIC_KEY_FILE` or `AUTH_TOKEN_PUBLIC_KEY`   | Wallet only            | Public SPKI PEM; configure exactly one source. Private PEM is rejected. |
| `AUTH_TOKEN_ISSUER`                                       | Both                   | `exchange-user`; must match.                                            |
| `AUTH_TOKEN_AUDIENCE`                                     | Both                   | `exchange-wallet`; must match.                                          |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                           | User                   | 900; permitted 60–3600.                                                 |
| `RESET_EPOCH`                                             | Both and queue workers | Shared current epoch; tokens from a prior reset are rejected.           |
| `USER_LOGIN_WINDOW_MS`                                    | User                   | 60000.                                                                  |
| `USER_LOGIN_IP_LIMIT` / `USER_LOGIN_GLOBAL_LIMIT`         | User                   | 10 / 60 attempts per window.                                            |

`npm run setup:local` creates `secrets/user-token-private.pem` and `secrets/user-token-public.pem` with owner-only permissions, alongside a separate custody seed. It refuses to overwrite an existing environment or secret. An existing installation must configure a new token key pair before using login; the change does not modify an existing `.env` or deployment secrets. To create a pair for an existing development environment, use new filenames that do not already exist:

```sh
umask 077
mkdir -p secrets
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out secrets/user-token-private.pem
openssl pkey -in secrets/user-token-private.pem -pubout \
  -out secrets/user-token-public.pem
```

Set the matching `_FILE` variables in each application's environment. Do not send the private token key to Wallet or the custody seed to User. In production, missing required keys fail startup; a supplied malformed key fails startup in every environment. In development, absent keys leave login and customer Wallet APIs returning 503. Wallet verifies locally with fixed algorithm/type, issuer/audience, UUID subject, required claims, expiry, bounded token age/lifetime, and the current reset epoch.

## Internal service boundary

Only User and Wallet are public application servers. Route public ingress to User's `/v1/users/*`, Wallet's `/v1/me/*`, and optional `/docs`/`/docs-json`. Deny Wallet `/internal/*` on public ingress.

| Internal interface                                          | Access                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet `/internal/wallets/*` and `/internal/transactions/*` | `WALLET_API_KEY`; operational compatibility routes.                                                                                      |
| Wallet `/internal/customers/*`                              | `EXCHANGE_API_KEY`; private administrative reads/assignments. Direct customer creation remains removed.                                  |
| Ledger `/internal/*`                                        | Private network and `LEDGER_API_KEY`; Wallet uses balance reads. Private event/reconciliation operator compatibility routes also remain. |
| Signer, Broadcast, ActivityListener, Sweep                  | No HTTP server; HMAC-authenticated action/result queues. ActivityListener also consumes provider Pub/Sub.                                |

Normal inter-service actions and financial writes use transactional outbox/inbox queues; the private Ledger event/reconciliation HTTP actions are operator compatibility interfaces. Balance reads no longer create Ledger registration records over HTTP. User, Wallet, Ledger, Broadcast, ActivityListener, and Sweep each receive their own database credentials. Customer JWTs and service bearer keys are separate authentication paths; neither substitutes for the other.

The development overlay publishes only User 3001 and Wallet 3000 and mounts each key only into its owner. After the base infrastructure, Pub/Sub, and migrations are ready, start applications with your host UID/GID so owner-only secret mounts are readable:

```sh
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) \
  docker compose -f compose.yaml -f compose.apps.yaml up --build
```

This is a development stack with local database credentials. Configure public ingress, private networks, secret management, and shared authentication throttling for a deployed environment. The overlay configuration was validated; its application image/startup was not exercised as part of this change.

## Remaining gates

Refresh tokens, logout/session revocation, password reset, verified email, and MFA are not implemented. Current tokens expire naturally; coordinated reset invalidates all tokens from the old epoch. Deploy shared edge/distributed rate limits before running multiple public authentication replicas. Key rotation presently requires coordinated issuer/verifier configuration.

JWT access does not make deposit addresses ready or enable withdrawals. Phase 1 custody/bootstrap, external QuickNode certification, and Phase 4/5 execution controls remain prerequisites in [the exchange checklist](exchange-wallet-todo.md).
