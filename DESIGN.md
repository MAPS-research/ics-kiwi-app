# CSS Kiwi Lab interaction decisions

## v0.7.1 — embedded tools, 2026-11-02

The primary surface is Kiwi's course iframe on desktop, with pointer and keyboard input. It must also remain usable in a narrow phone viewport. Keep the existing Montserrat typography, purple interaction theme, spacing and semantic result colors. The theme source remains Kiwi UI `fbc29beab4c6063c07fcf273d89e7237fad850b7`; this revision changes navigation and wording, not palette or typography.

Kiwi owns general chat and Scratchpad. Embedded Lab navigation has three destinations: Assigned work, Practice exercises and Course outline. A question has an R editor because the draft, run and submitted answer belong to that question. The practice editor appears only after a question exists. This keeps general exploration in Kiwi and assessed work in Lab.

On phones the three destinations are equal-width, wrapping labels with at least 58px height, all visible without horizontal scrolling. The inner duplicate wordmark is omitted at this size because the host already supplies the Kiwi brand. Desktop navigation retains the existing sidebar.

Old chat bookmarks display the corresponding assignment/question or assignment list. Old workspace bookmarks show preserved code as read-only recovery, with an acknowledged SDK navigation action to Scratchpad and an error state. Course outline offers recovery only when the current user's original scratch key exists. No draft is deleted, rewritten or automatically transferred to the host.

The floating chat receives only the currently visible problem and the current student's work through official `updateContext`. It receives no answer keys, rubrics, grading records or teacher comments. Teacher help controls state the actual limitation: their guidance cannot disable or enforce a help level in Kiwi's chat. Lab analytics continue to cover Lab activity, not host chats or Scratchpad runs.

Standalone mode keeps its local guidance and scratch editor. This distinction is tied to the SDK's live mode, including teacher student-preview, rather than browser role claims. Existing route and storage identifiers remain compatible.

Validation is recorded in [the independent review](docs/reviews/2026-11-02-v0.7.1.md), including actual desktop/narrow screenshots and untested limits.
