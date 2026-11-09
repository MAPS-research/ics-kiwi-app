# Kiwi App development workflow

## Review after each version

The user requires an independent review agent after every app version update.

- After implementation, have an agent other than the implementation agents use the running app through a real browser as both a student and a teacher.
- Student tasks include answering and continuing generated questions, R execution and debugging, assignment answer persistence and submission, and Kiwi questions.
- Teacher tasks include creating and publishing a test assignment, grading its submission, and checking the student Data Hub and activity history.
- Check the role entry pages and key cards at desktop and narrow viewport sizes. Inspect screenshots for text containment, spacing, legibility, and navigation; passing a build does not establish visual correctness.
- Use clearly named Review test work. Preserve existing user assignments and grades.
- Record the tested version, actual steps, observed results, difficulties, severity, screenshots, and untested limitations in `docs/reviews/`. Immediately send actionable findings to the implementation agent, then retest fixes to blocking issues.
- Include a concise review summary and report link in the delivery to the user. Carry remaining issues into the next version's work; never describe untested tasks as passed.

## Theme source

Match the active `NYUSH-ML/kiwi-ui` theme and font definitions. Record the upstream commit when syncing. Its public app token stylesheet can lag `src/Theme.ts`; check both before changing colors. Keep semantic success/error colors separate from the purple interaction theme.

## Kiwi SDK boundary (2026-10-29 feedback; supersedes v0.6 demo exceptions)

- Read the current upstream Kiwi `CLAUDE.md`, Kiwi UI `KIWI-APPS.md`, SDK bundle, App API DTOs and JWT documentation before changing integration. Record the commits used.
- Do not patch or inject files into a Kiwi or kiwi-ui checkout. Do not read or write the host database. Register through the official API; administrators whitelist, approve prompts and enable apps in Kiwi.
- External Apps receive opaque user IDs. Never add a roster, user lookup, email/name mapping, or native-activity export endpoint. Use App-local labels. Existing user work and grades must be preserved.
- Use the official SDK for iframe handshake/context/navigation and its explicit app token API when authenticating the Lab backend. Verify RS256 against the configured host's public JWKS, then validate type, app slug, class and expiry. Do not share host secrets or trust browser role claims.
- App tokens currently contain no course role. Teacher access is a Lab-owned, explicit course/user UUID grant; absence of a grant is not teacher access.
- AI calls go through Kiwi's approved contextual-chat API, with the caller's app token and enabled scopes. Never call an LLM provider directly or use a Lab OpenAI key. Never silently fall back to another provider.
- Use generic `class-tab` and `class-admin-panel` placements. No app-specific host UI, native IDE replacement, token-lifetime patch, login patch, or invented postMessage methods.
- The current SDK cannot disable the host chat. Show that limitation accurately. General host enhancements belong in separate upstream proposals, not in this app's installer.
- Standalone mode uses explicitly labeled local guidance/templates. Real Kiwi/AI integration and simulator/fixture checks must be reported separately.
