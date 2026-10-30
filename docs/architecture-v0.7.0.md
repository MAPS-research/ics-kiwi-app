# v0.7.0 — official Kiwi App integration

Date: 2026-10-29. Branch: `codex/kiwi-sdk-v0.7.0`. This document describes that branch, not `main` or `codex/css-lab-v0.6.0`. It supersedes v0.6's patched-host integration, including the exception recorded in §14.6 and decision D5.

## Upstream evidence

Read against these upstream development commits:

- Kiwi backend: [`e31b21f2429330dab8b2a3b0897511c9c83d242c`](https://github.com/NYUSH-ML/kiwi/tree/e31b21f2429330dab8b2a3b0897511c9c83d242c). Relevant contracts: `CLAUDE.md` (“Apps never get identity”), `docs/jwt-configuration.md`, App token guard, registration and contextual-chat DTOs/controllers/services.
- Kiwi UI: [`fbc29beab4c6063c07fcf273d89e7237fad850b7`](https://github.com/NYUSH-ML/kiwi-ui/tree/fbc29beab4c6063c07fcf273d89e7237fad850b7). Relevant contracts: [`KIWI-APPS.md`](https://github.com/NYUSH-ML/kiwi-ui/blob/fbc29beab4c6063c07fcf273d89e7237fad850b7/KIWI-APPS.md), SDK host handler, course placements, and `public/sdk/v1/kiwi-app-sdk.js`.
- Bundled official SDK reports version **0.2.0**. Its Git blob SHA is `8c776b5786d52a8a444b84a0d20f05ee11b0cc12`, identical to the file at the UI commit above. It is not a Lab fork. The `v1` URL is the protocol distribution path, not the npm version.

No theme refresh was made in this version. The existing Montserrat/purple theme remains; future theme syncs must compare upstream `src/Theme.ts` and the public token stylesheet and record the commit.

## Feedback reconciliation

| Feedback about v0.6 | v0.7 implementation | Boundary / consequence |
| --- | --- | --- |
| Injected `lab-bridge.controller.ts`, raw SQL, class roster and emails | Removed the host bridge and every tracked `scripts/local-kiwi/` patch/install script; backend authenticates via public JWKS | No host database access, roster lookup or raw native activity export |
| `kiwi:setChatAvailability` | Removed invented postMessage requests; use SDK `updateContext` only | Lab's “Ask Kiwi off” applies inside Lab; current SDK cannot disable host chat |
| `returnTo` login patch | Removed | Host login behavior belongs upstream |
| `CssLabLaunch` / `CssLabTeacherEntry` | Removed; manifest uses generic `class-tab` / `class-admin-panel` | Standalone entry links to the configured Kiwi home and tells users to open their course's Apps panel |
| Replace native WebR / copy runtime into kiwi-ui | Removed | Lab runs its own browser webR only |
| Host listen/SMTP/token TTL/health/reasoning/logging patches | Removed | A real deployment uses the official host configuration; potential host bugs require separate upstream work |
| Lab key directly calls OpenAI while UI says Ask Kiwi | Replaced by official Kiwi `contextual-chat` with caller's App token and approved prompt | No direct provider URL/key/fallback; model, provider usage and billing belong to Kiwi |

The old .local checkouts, containers, data and running services are not reset by this migration. Merely checking out this version does not clean an already-patched host. See the [upgrade notes](../README.md#upgrade-from-v06).

The [SDK developer feedback record](handoff/v0.7.0-sdk-feedback.md) separates proposed SDK/API capabilities, host bugs, AI extensions and withdrawn boundary violations. It includes pinned source evidence and proposed acceptance checks; these are pending upstream discussion, not approved changes or live-host test results.

## Request and authorization path

1. Official iframe SDK performs its handshake and supplies context. Standalone simulator/demo context grants no Kiwi privileges.
2. The frontend explicitly calls SDK `getToken()` and sends the App token to its own Lab backend. This is the documented direct REST architecture, not the host-proxied `client.contextualChat()` path.
3. The Lab accepts RS256 only, fetches keys from the configured `KIWI_API_ORIGIN`'s `/.well-known/jwks.json`, verifies signature, expiry and issuance time, and checks `type=app_token`, `appSlug=ics-r-lab`, class binding, subject and class token scope. Admin-scoped tokens do not become class credentials. Optional `KIWI_JWT_ISSUER` enables issuer validation for deployments that issue it. No shared host signing secret is accepted.
4. Upstream currently signs tokens without a `kid`. A token without `kid` is accepted only when JWKS has exactly one RS256 RSA signing key. Ambiguous key sets fail closed. JWKS is cached for five minutes; token expiry/signature are checked on each request.
5. The signed token supplies an opaque caller UUID, not a teacher role. `KIWI_STAFF_BINDINGS` provides explicit course/user UUID grants (`instructor`, `ta`, `viewer`, `researcher`); existing active Lab staff grants can override them. Removing a UI override restores the server grant; revoking that grant also requires removing its server binding. The staff list resolves current grants rather than reusing a historical host role. Other verified callers are students. Browser context, query parameters and name/email/role claims do not confer staff access.
6. Student writes remain bound to the authenticated caller. Staff use explicit student preview; preview data stays excluded from real student analytics.

A verified student visit creates an App-owned population entry with an opaque ID and an anonymous label. This counts users observed in Lab, not the host's complete enrollment. The operator must obtain IDs through an authorized administrative process; the app adds no user lookup. Standalone demo identities and access keys remain separate from Kiwi-linked course authentication.

Linked-course labels suppress previously imported names/emails. JSON responses and exports scrub known historical roster terms; teaching CSVs suppress email columns and use anonymous labels. This is not a guarantee that arbitrary names typed into free text can be detected. Existing private databases/backups retain historical data for the operator's retention process; no destructive data migration is performed.

## AI contract

The administrator registers the manifest, approves `lab-tutor`, and enables its course scopes. The required scopes are `context:student_learning:read` and `llm:prompt:lab-tutor`. Registration preview is read-only; explicit `--register` needs the whitelist registration secret and uses the official registration endpoint. It never self-approves a prompt or edits Kiwi tables.

For an AI request, the Lab applies access, assignment-help, rate and capacity rules, then POSTs to `/api/kiwi-apps/ics-r-lab/contextual-chat`. It sends:

```json
{
  "promptId": "lab-tutor",
  "userMessage": "{\"instructions\":[\"…\"],\"conversation\":[{\"role\":\"user\",\"content\":\"…\"}]}",
  "contextRequest": {
    "kind": "student_learning_context",
    "scope": "current_user_current_class",
    "include": ["relevant_materials"],
    "timeWindowDays": 14
  }
}
```

Kiwi assembles its private context internally. Lab receives `output` and context inclusion metadata, not raw student histories. It requests course material context only. Both class and user must match the current verified request identity. App tokens do not follow HTTP redirects.

Lab rules are task data inside `userMessage`. They do not become separate provider system/developer messages. The approved Kiwi prompt controls model instructions; Lab independently enforces access, validates exercise output and guards protected final answers. Existing `developer_text`/prompt-log database columns retain Lab's assembled task instructions for audit compatibility, not evidence of provider-level precedence.

The upstream DTO caps `userMessage` at **8,000 UTF-16 code units**, including the JSON wrapper and rules. Oversized assembled requests return 422 `ai_context_too_large`. Existing bounded input/history selection still applies; the adapter does not silently truncate a request to fit this limit. Users may need shorter code, reference text or conversation history.

No model, reasoning effort or provider output-token setting is sent by Lab. Old policy fields remain readable for history but no longer control the model; the teacher editor hides those controls. New call records use `kiwi-managed`, leave unreported usage/limits empty, and record available latency. New chat turns use `source=kiwi-ai`, exports `ai_provider=kiwi`. Historical `lab-ai`/OpenAI rows retain their source. Local guidance/templates remain explicitly local. Aggregate tutor-request counts include local hints and are not provider-call counts.

Missing app session, approval configuration or scope leaves explicitly labeled local guidance/templates available. Once an actual Kiwi request fails (authorization, rate limit, network or invalid response), Lab reports the failure; it does not switch to OpenAI or silently replace the result. A token can expire during a long/retried request; reopening the app refreshes the host session.

## Historical activity and review

Native activity sync returns 410 and the UI marks the feed unavailable. Existing projections and material mappings remain for historical records. “Kiwi history (legacy)” is a history filter, not a current feed. Lab still records its own R runs, question attempts, drafts, submissions, grades and tutor requests.

[`server/test_kiwi_api.py`](../server/test_kiwi_api.py) uses real RSA signatures and a local JWKS/contextual-chat HTTP fixture to exercise token validation, role boundaries, request shape, redirect refusal and failure behavior. It is not a live Kiwi deployment or real AI test. Regression suites cover existing Lab data/workflows; [`scripts/sdk-contract.test.mjs`](../scripts/sdk-contract.test.mjs) verifies generic registration and the absence of the old database registration route.

The independent [browser review](reviews/2026-10-29-v0.7.0.md) records observed student/teacher workflows, desktop/narrow screenshots, corrections and untested work. Real unmodified-host launch, prompt approval and provider-backed AI must still be verified against an operator-provided deployment before classroom rollout. The old patched local host cannot establish that result.

### Recorded validation

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed; Vite retains the large-chunk and mixed static/dynamic R runtime import warnings |
| Frontend regression | 51 files, 1,302 tests passed |
| Backend regression | 534 tests, OK with 1 unavailable-snapshot check skipped |
| Final staff-grant and official API checks | 35 tests passed after the final grant-listing change |
| Registration contract | 3 tests passed |
| Independent browser review | Standalone student/teacher workflow passed; three P2 findings fixed and retested; seven page screenshots |

The remaining P3 item is narrow-screen student navigation discoverability: the tabs work by horizontal scrolling, but the affordance is weak. Carry this into the next version. These results do not establish live Kiwi integration, online AI success or preservation of a production database; see the browser report's explicit limitations.
