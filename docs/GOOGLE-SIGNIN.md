# Sign in with Google

Potion has two sign-in doors: **Continue with Google**, and the one-time
email link that has always been there. Google is off until two values exist
in the environment; until then the button is simply not drawn, and the email
link is unchanged.

This document is written for whoever holds the Google account. It is about
fifteen minutes of clicking, once.

---

## What you are creating, and what you are NOT

You are creating an **OAuth client** — a client ID and secret that let
withpotion.com ask Google "who is this person?" and get back a verified
email address.

You are **not** asking for anyone's Gmail, Drive, Calendar or Contacts.
Potion requests exactly three scopes: `openid`, `email`, `profile`. Google
calls these *non-sensitive*, and they are the category that does **not**
require the security assessment that reading someone's mailbox does. That is
the whole reason this can ship in an afternoon while a Gmail integration
cannot.

(If Google ever asks for anything, expect *brand* verification — proving you
own withpotion.com and that the logo is yours. That is a short form, not the
multi-week review.)

---

## The steps

### 1. Consent screen

<https://console.cloud.google.com/auth/overview>

Create a project if there is none (name it `Potion`). Then fill the branding
form:

| Field                | Value                            |
|----------------------|----------------------------------|
| App name             | `Potion`                         |
| User support email   | your email                       |
| Audience             | **External**                     |
| Authorized domain    | `withpotion.com`                 |
| Developer contact    | your email                       |

### 2. Scopes

Add exactly these three, and nothing else:

```
openid
.../auth/userinfo.email
.../auth/userinfo.profile
```

If a scope you did not choose appears in the list, remove it. Every extra
scope is a reason for Google to ask questions, and Potion uses none of them.

### 3. Publish

On the consent screen, set publishing status to **In production**.

This matters: in *Testing* mode only accounts you list by hand can sign in
(capped at 100), so anyone else clicking the button gets an error page. With
only non-sensitive scopes, publishing does not require review.

### 4. The client

<https://console.cloud.google.com/auth/clients> → **Create client**

| Field                     | Value                                              |
|---------------------------|----------------------------------------------------|
| Application type          | **Web application**                                |
| Name                      | `Potion dashboard`                                 |
| Authorized redirect URI   | `https://withpotion.com/api/auth/google/callback`  |

The redirect URI must match **exactly** — no trailing slash, `https` not
`http`, apex not `www`. A mismatch is the single most common failure, and
Google's error names it plainly (`redirect_uri_mismatch`).

Copy the **Client ID** and **Client secret** off the screen that appears.
The secret is shown once.

### 5. Turn it on

On the production host, in `/opt/potion/.env.prod`:

```
POTION_GOOGLE_CLIENT_ID=<the client id>
POTION_GOOGLE_CLIENT_SECRET=<the secret>
```

Then restart the server container. Within seconds:

- `GET /auth/providers` starts reporting `google: true`
- the button appears on `/login`
- the boot log prints `sign in with Google: on — the button is drawn`

If you paste one value and miss the other, the boot log says so
(`half-configured: … the button will not appear`) rather than leaving you to
wonder why nothing changed. That warning exists because a scaffolded-empty
env var once turned sign-in off in production silently — see
`apps/server/src/boot-report.ts`.

---

## What happens to existing accounts

Nothing breaks, and nothing duplicates. Accounts are keyed by **email
address**, so somebody who signed up with an email link and later clicks
Continue with Google lands in the same account, with the same workspace and
the same data. Both doors prove the same fact — control of that address —
so treating them as the same person is correct rather than convenient.

An account whose Google address Google has **not** verified is refused
(403). A valid signature on an unverified address is not proof of the
address, and accepting one would be a way to walk into someone else's
workspace.

---

## How it is built (for whoever reads the code next)

The flow is split across the two origins, which is not decoration:

- The browser half lives on the **dashboard** (`app/api/auth/google/start`
  and `.../callback`). It has to: the session cookie must land on
  withpotion.com, and the API server answers on api.withpotion.com, so a
  cookie set there would be unreadable here.
- The credential half lives on the **API server**
  (`apps/server/src/routes/google-auth.ts`): the code exchange, the id_token
  verification, provisioning and session minting — everything that needs the
  client secret, the JWKS, or the database.

It is the same split the magic link already uses, and it reuses the OIDC
machinery in `apps/server/src/oidc.ts` rather than being a second
implementation: discovery, JWKS, RS256 verification, PKCE S256, state and
nonce are all shared with the enterprise SSO path (`docs/ENTERPRISE.md`).

Google adds exactly one rule of its own: **`email_verified` must be true**.
The enterprise path trusts its IdP's email claim because the customer runs
that IdP; Google is a public issuer, so the claim is checked.

Tests: `apps/server/test/google-auth.test.ts` (full flow against a local
mock IdP minting real RS256 tokens),
`apps/dashboard/test/google-signin-routes.test.ts` (the cookie handling and
every refusal path), `apps/dashboard/test/google-signin-button.test.tsx`.
