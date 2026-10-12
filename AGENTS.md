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
