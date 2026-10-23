"""Event-type registry (spec §11.3; FOUNDATION, frozen).

Consumed by event validation (TELEMETRY), backfill B5 (category), and the research
codebook (PEOPLE). Each field entry is ``(type, description, free_text)``; ``type`` is one of
``string``, ``integer``, ``number``, ``boolean``, ``array``, ``object``, ``any``.
"""

from __future__ import annotations

import os
from typing import Literal

SCHEMA_VERSION = 2
# Default handling of client-sent server-owned event types (§11.2 step 3).
# INTEGRATION cut-over (v0.6.0, INTEGRATION-05): "enforce" — v2 client copies of server-owned types and v1 copies other
# than answer_submitted answer 422 server_owned_event; v1 answer_submitted is stored as checked_by='client'.
# Env KIWI_SERVER_OWNED_EVENTS=accept|enforce overrides.
SERVER_OWNED_MODE: Literal["accept", "enforce"] = "enforce"

Field = tuple[str, str, bool]


def _f(kind: str, description: str, free_text: bool = False) -> Field:
    return (kind, description, free_text)


_CONTEXT = {
    "unitId": _f("string", "Chapter id the activity belongs to"),
    "assignmentId": _f("string", "Assignment id (teacher-authored work)"),
    "itemId": _f("string", "Generated practice item id ('gi-…')"),
}

REGISTRY: dict[str, dict] = {
    "page_view": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "The student opened a page or tab of the Lab.",
        "fields": {
            "route": _f("string", "Path without query string"),
            "fromRoute": _f("string", "Previous path without query string"),
            "tool": _f("string", "Tool tab shown (answer, code, kiwi, similar…)"),
            "questionId": _f("string", "Question shown, if any"),
        },
    },
    "visibility": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "The browser tab became visible or hidden.",
        "fields": {"state": _f("string", "visible | hidden"), "idleMs": _f("integer", "Milliseconds since last input")},
    },
    "idle": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "No pointer or keyboard input for a while.",
        "fields": {"state": _f("string", "idle | active"), "idleMs": _f("integer", "Milliseconds since last input")},
    },
    "study_heartbeat": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "30-second activity heartbeat while the page is visible and recently used.",
        "fields": {
            "seconds": _f("number", "Client-reported seconds (ignored; the server counts 30 s per bucket)"),
            "route": _f("string", "Path without query string"),
            **_CONTEXT,
            "questionId": _f("string", "Question in view"),
            "tool": _f("string", "Tool tab in view"),
            "signals": _f("array", "Input kinds seen in the last 60 s"),
        },
    },
    "question_viewed": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "ASSESS, AIRUN",
        "description": "A question or generated item was shown to the student.",
        "fields": {**_CONTEXT, "questionTitle": _f("string", "Title shown", True)},
    },
    "code_edited": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "Debounced snapshot of code typed in the R workspace.",
        "fields": {"code": _f("string", "Code snapshot", True), **_CONTEXT, "envKey": _f("string", "R environment key"),
                   "title": _f("string", "Page title", True), "questionTitle": _f("string", "Question shown", True)},
        "limits": {"code": 60000},
    },
    "code_run": {
        "version": 2, "category": "action", "emitter": "client", "owner": "TELEMETRY",
        "description": "The student ran R code in the browser (webR).",
        "fields": {
            "code": _f("string", "Code that was run", True),
            "ok": _f("boolean", "True when the run finished without an R error"),
            "stdout": _f("string", "Printed output", True),
            "output": _f("string", "Combined output shown", True),
            "error": _f("string", "R error message", True),
            "warnings": _f("array", "R warnings", True),
            "warningCount": _f("integer", "Number of warnings"),
            "plots": _f("integer", "Number of plots produced"),
            "plotHashes": _f("array", "SHA-256 of each plot image"),
            "durationMs": _f("integer", "Run time in milliseconds"),
            "envKey": _f("string", "R environment key"),
            "runSeq": _f("integer", "Run counter within the environment"),
            "objectNames": _f("array", "Objects in the environment after the run"),
            "packagesLoaded": _f("array", "Packages attached after the run"),
            "attribution": _f("object", "Client attribution context"),
            "plotsUnavailable": _f("boolean", "Plots could not be captured on this device"),
            "title": _f("string", "Page title", True),
            "questionTitle": _f("string", "Question shown", True),
            **_CONTEXT,
        },
        "limits": {"code": 60000, "output": 40000, "stdout": 40000},
    },
    "r_package_install": {
        "version": 2, "category": "action", "emitter": "client", "owner": "TELEMETRY",
        "description": "An allowlisted R package was installed in webR.",
        "fields": {"package": _f("string", "Package name"), "ok": _f("boolean", "Install succeeded"),
                   "error": _f("string", "Install error", True), "durationMs": _f("integer", "Install time in milliseconds"),
                   "preinstall": _f("boolean", "Installed because the chapter lists it")},
    },
    "data_file_loaded": {
        "version": 2, "category": "action", "emitter": "client", "owner": "TELEMETRY",
        "description": "A data file was mounted into the R workspace.",
        "fields": {"name": _f("string", "File name"), "size": _f("integer", "Bytes"), "sha256": _f("string", "File hash"),
                   "source": _f("string", "upload | assignment | chapter"), "title": _f("string", "Page title", True)},
    },
    "hint_shown": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY, ASSESS",
        "description": "A hint was displayed (R error rule or teacher hint).",
        "fields": {"hintKind": _f("string", "r_error_rule | teacher_hint"), "ruleId": _f("string", "Error-hint rule id"),
                   "hintIndex": _f("integer", "Teacher hint index (0-based)"), "errorExcerpt": _f("string", "R error excerpt", True),
                   **_CONTEXT, "title": _f("string", "Page title", True)},
    },
    "explanation_shown": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "ASSESS, AIRUN",
        "description": "A question explanation was displayed to the student.",
        "fields": {"questionId": _f("string", "Question id"), "itemId": _f("string", "Generated item id"),
                   "context": _f("string", "Where the explanation appeared")},
    },
    "feedback_viewed": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "ASSESS",
        "description": "The student opened released grading feedback.",
        "fields": {"submissionId": _f("string", "Submission id"), "assignmentId": _f("string", "Assignment id")},
    },
    "paste": {
        "version": 2, "category": "telemetry", "emitter": "client", "owner": "TELEMETRY",
        "description": "Text was pasted into code, an answer or the chat (no clipboard text is stored).",
        "fields": {"target": _f("string", "code | answer | chat"), "length": _f("integer", "Pasted characters"),
                   "matchesAiReply": _f("boolean", "Pasted text matches a recent AI reply"),
                   "chatTurnId": _f("integer", "Matching chat turn")},
    },
    "practice_settings_changed": {
        "version": 2, "category": "action", "emitter": "client", "owner": "AIRUN",
        "description": "The student changed free-practice settings.",
        "fields": {"field": _f("string", "unit | type | difficulty | focusNote"), "from": _f("any", "Previous value", True),
                   "to": _f("any", "New value", True)},
    },
    "question_skipped": {
        "version": 2, "category": "action", "emitter": "client", "owner": "AIRUN",
        "description": "The student moved on from a generated item.",
        "fields": {"itemId": _f("string", "Generated item id"), "attempted": _f("boolean", "At least one check was made")},
    },
    "work_answer_saved": {
        "version": 2, "category": "action", "emitter": "client", "owner": "ASSESS",
        "description": "An assignment answer was saved locally by the client.",
        "fields": {"questionId": _f("string", "Question id"), "length": _f("integer", "Answer length"),
                   "codeHash": _f("string", "Hash of answer code"), "code": _f("string", "Answer code", True),
                   **_CONTEXT},
    },
    "telemetry_gap": {
        "version": 2, "category": "system", "emitter": "client", "owner": "TELEMETRY",
        "description": "The client outbox dropped events (overflow, no storage, or rejected).",
        "fields": {"droppedCount": _f("integer", "Events dropped"), "droppedTypes": _f("object", "Dropped counts per type"),
                   "reason": _f("string", "overflow | no_storage | rejected"),
                   "fromTs": _f("integer", "Client time of the oldest dropped event (ms)"),
                   "toTs": _f("integer", "Client time of the newest dropped event (ms)")},
    },
    "ai_request_unreached": {
        "version": 2, "category": "system", "emitter": "client", "owner": "AIRUN",
        "description": "An AI request never reached the server (network, timeout or HTTP error).",
        "fields": {"action": _f("string", "chat | question | similar"), "surface": _f("string", "Surface"),
                   "reason": _f("string", "network | timeout | http_error"), "httpStatus": _f("integer", "HTTP status"),
                   **_CONTEXT, "questionId": _f("string", "Question id")},
    },
    "answer_submitted": {
        "version": 2, "category": "action", "emitter": "server", "owner": "ASSESS, AIRUN", "server_owned": True,
        "description": "An answer attempt (homework submit, in-class check, or generated-item check).",
        "fields": {**_CONTEXT, "answer": _f("string", "Student answer", True), "correct": _f("boolean", "Correctness (null when not auto-checkable)"),
                   "checkedBy": _f("string", "server | legacy_server | client"), "basis": _f("string", "answer_text | client_run_output"),
                   "attemptIndex": _f("integer", "Attempt number on this question"), "timeOnItemMs": _f("integer", "Milliseconds on the item"),
                   "submissionId": _f("string", "Submission id (homework)"), "attempt": _f("integer", "Submission attempt"),
                   "assignmentVersion": _f("integer", "Assignment version at the attempt"),
                   "reason": _f("string", "judging reason: exact | accepted | numeric_tolerance | choice | output_match | "
                                          "case_mismatch | mismatch | not_gradable | no_reference"),
                   "origin": _f("string", "Generated item origin: free | similar"),
                   "relatedAssignmentId": _f("string", "Parent homework of a similar item"),
                   "feedback": _f("string", "AI feedback on an explain item", True),
                   "feedbackCallId": _f("integer", "ai_calls id of the feedback call"),
                   "runOutput": _f("string", "Client run output used for the check", True)},
    },
    "answer_draft": {
        "version": 2, "category": "action", "emitter": "server", "owner": "ASSESS", "server_owned": True,
        "description": "A server-saved answer draft changed (throttled per question).",
        "fields": {"assignmentId": _f("string", "Assignment id"), "unitId": _f("string", "Chapter id"),
                   "questionId": _f("string", "Question id"),
                   "length": _f("integer", "Draft length"), "valueHash": _f("string", "Hash of the draft"),
                   "choice": _f("string", "Selected choice (choice questions)", True)},
    },
    "work_submitted": {
        "version": 2, "category": "action", "emitter": "server", "owner": "ASSESS", "server_owned": True,
        "description": "A homework submission was stored (never written for a replayed requestId).",
        "fields": {"assignmentId": _f("string", "Assignment id"), "unitId": _f("string", "Chapter id"),
                   "submissionId": _f("string", "Submission id"),
                   "attempt": _f("integer", "Attempt number"), "late": _f("boolean", "Submitted after the due date"),
                   "lateSeconds": _f("integer", "Seconds after the due date"), "overTime": _f("boolean", "Over the time limit"),
                   "timeUsedSeconds": _f("integer", "Seconds used (timed homework)")},
    },
    "attempt_started": {
        "version": 2, "category": "action", "emitter": "server", "owner": "ASSESS", "server_owned": True,
        "description": "A timed homework attempt was started.",
        "fields": {"assignmentId": _f("string", "Assignment id"), "attempt": _f("integer", "Attempt number"),
                   "startedAt": _f("string", "Start time"), "endsAt": _f("string", "End time")},
    },
    "grade_released": {
        "version": 2, "category": "system", "emitter": "server", "owner": "GRADE", "server_owned": True,
        "description": ("A grade was released to the student. Stored on the student's row with the releasing staff member's "
                        "role as actor_role, so it is not the student's activity and leaves the student population."),
        "fields": {"submissionId": _f("string", "Submission id"), "assignmentId": _f("string", "Assignment id"),
                   "total": _f("number", "Total points"), "maxPoints": _f("number", "Maximum points"),
                   "releasedBy": _f("string", "Actor label of the releasing staff member")},
    },
    "ai_question": {
        "version": 2, "category": "action", "emitter": "server", "owner": "AIRUN; native TELEMETRY", "server_owned": True,
        "description": "A question to an AI tutor and its reply (Lab AI tutor or Kiwi lecture AI).",
        "fields": {"chatTurnId": _f("integer", "chat_turns id"), "aiCallId": _f("integer", "ai_calls id"), **_CONTEXT,
                   "threadId": _f("string", "Thread id"), "surface": _f("string", "Surface"),
                   "prompt": _f("string", "Student prompt", True), "response": _f("string", "AI reply", True),
                   "aiProvider": _f("string", "openai | local | kiwi-native"), "model": _f("string", "Model"),
                   "policyVersionId": _f("integer", "Policy version applied"), "guardStatus": _f("string", "Final-answer guard status"),
                   "effectiveAccess": _f("string", "Chapter access at the time: open | review | locked | hidden"),
                   "ok": _f("boolean", "Legacy: request succeeded")},
        "limits": {"prompt": 20000, "response": 100000},
    },
    "ai_request_failed": {
        "version": 2, "category": "system", "emitter": "server", "owner": "AIRUN", "server_owned": True,
        "description": "An AI request reached the server but failed or was turned away.",
        "fields": {"aiCallId": _f("integer", "ai_calls id"), "action": _f("string", "chat | question | similar"),
                   "status": _f("string", "ai_calls.status"), "surface": _f("string", "Surface"),
                   "code": _f("string", "API error code returned to the student"), **_CONTEXT},
    },
    "question_generated": {
        "version": 2, "category": "action", "emitter": "server", "owner": "AIRUN", "server_owned": True,
        "description": "A practice item was generated (free or similar practice).",
        "fields": {"itemId": _f("string", "Generated item id"), "origin": _f("string", "free | similar"),
                   "unitId": _f("string", "Chapter id"), "type": _f("string", "Question type"), "difficulty": _f("integer", "Difficulty 1-5"),
                   "requestedType": _f("string", "Requested type"), "requestedDifficulty": _f("integer", "Requested difficulty"),
                   "focusNote": _f("string", "Student focus note", True), "title": _f("string", "Item title", True),
                   "prompt": _f("string", "Item prompt", True), "choices": _f("array", "Choices", True),
                   "source": _f("string", "ai | local_template | teacher_bank"), "policyVersionId": _f("integer", "Policy version"),
                   "model": _f("string", "Model"), "relatedAssignmentId": _f("string", "Parent homework"),
                   "relatedQuestionId": _f("string", "Parent question"),
                   "choiceOrder": _f("array", "Display order of the stored choices (seeded shuffle)"),
                   "aiCallId": _f("integer", "ai_calls id"), "effectiveAccess": _f("string", "Chapter access at the time"),
                   "guardStatus": _f("string", "Final-answer guard status of the item"),
                   "homeworkMatchAssignmentId": _f("string", "Homework matched by the focus note")},
    },
    "similar_requested": {
        "version": 2, "category": "action", "emitter": "server", "owner": "AIRUN", "server_owned": True,
        "description": "The student asked for a similar exercise to an assignment question.",
        "fields": {"sourceAssignmentId": _f("string", "Assignment id"), "sourceQuestionId": _f("string", "Question id"),
                   "itemId": _f("string", "Generated item id"), "unitId": _f("string", "Chapter id"),
                   "relatedAssignmentId": _f("string", "Parent homework")},
    },
    "answer_revealed": {
        "version": 2, "category": "action", "emitter": "server", "owner": "AIRUN", "server_owned": True,
        "description": "The answer of a generated item was revealed to the student.",
        "fields": {"itemId": _f("string", "Generated item id"), "attemptIndex": _f("integer", "Attempts before reveal"),
                   "unitId": _f("string", "Chapter id")},
    },
    "material_viewed": {
        "version": 2, "category": "action", "emitter": "native", "owner": "TELEMETRY",
        "description": "Kiwi lecture material page viewed (imported from Kiwi).",
        "fields": {"materialId": _f("string", "Kiwi material id"), "page": _f("integer", "1-based page"), "threadId": _f("string", "Thread")},
    },
    "code_shared": {
        "version": 2, "category": "action", "emitter": "native", "owner": "TELEMETRY",
        "description": "Kiwi scratchpad code activity (imported from Kiwi).",
        "fields": {"code": _f("string", "Code", True), "output": _f("string", "Output", True)},
    },
    "kiwi_check_answer": {
        "version": 2, "category": "action", "emitter": "native", "owner": "TELEMETRY",
        "description": "Kiwi scratchpad check-answer action (imported from Kiwi).",
        "fields": {"code": _f("string", "Code", True), "output": _f("string", "Output", True)},
    },
    "kiwi_file_action": {
        "version": 2, "category": "action", "emitter": "native", "owner": "TELEMETRY",
        "description": "Kiwi scratchpad file action (upload, switch tab, save, add).",
        "fields": {"action": _f("string", "upload | switchtab | save | add"), "fileName": _f("string", "File name")},
    },
    "ai_feedback": {
        "version": 2, "category": "action", "emitter": "native", "owner": "TELEMETRY",
        "description": "Thumbs or flag feedback on a Kiwi lecture AI reply (imported from Kiwi). Join key: (conversationId, "
                       "targetMessageIndex) = the k-th assistant reply of that conversation (ai_responses by time; approximate).",
        "fields": {"conversationId": _f("string", "Kiwi conversation id"), "targetMessageIndex": _f("integer", "Message index in the conversation"),
                   "value": _f("number", "Thumbs value"), "reply": _f("string", "Flag reply text", True)},
        "limits": {"reply": 4000},
    },
}

for _legacy in ("hint_requested", "difficulty_changed", "topic_changed", "profile_updated", "work_opened"):
    REGISTRY[_legacy] = {
        "version": 1, "category": "action", "emitter": "client (deprecated)", "owner": "legacy",
        "description": "Deprecated since 0.6.0; legacy rows only, accepted from v1 clients.",
        "fields": {}, "deprecated_since": "0.6.0",
    }

# Event types that v0.5.1 clients send (schema version 1 bodies).
LEGACY_V1_TYPES = frozenset({
    "question_generated", "question_viewed", "answer_submitted", "code_run", "code_edited", "hint_requested",
    "question_skipped", "difficulty_changed", "topic_changed", "profile_updated", "ai_question", "similar_requested",
    "study_heartbeat", "work_opened", "work_answer_saved", "work_submitted",
})
SERVER_OWNED_TYPES = frozenset(t for t, spec in REGISTRY.items() if spec.get("server_owned"))
TELEMETRY_TYPES = frozenset(t for t, spec in REGISTRY.items() if spec["category"] == "telemetry")
DEFAULT_LIMITS = {"string": 20000, "array": 200, "max_keys": 64, "max_depth": 4, "payload_chars": 250000}


def is_known(event_type: object) -> bool:
    return isinstance(event_type, str) and event_type in REGISTRY


def category(event_type: str) -> str:
    spec = REGISTRY.get(event_type)
    return spec["category"] if spec else ""


def is_server_owned(event_type: str) -> bool:
    return event_type in SERVER_OWNED_TYPES


def server_owned_mode() -> str:
    """Effective mode: env ``KIWI_SERVER_OWNED_EVENTS`` (accept|enforce) overrides the code default."""
    value = os.environ.get("KIWI_SERVER_OWNED_EVENTS", "").strip().lower()
    return value if value in ("accept", "enforce") else SERVER_OWNED_MODE


def fields(event_type: str) -> dict[str, Field]:
    spec = REGISTRY.get(event_type)
    return dict(spec["fields"]) if spec else {}


def category_case_sql(column: str = "event_type") -> str:
    """SQL CASE expression mapping event types to their category (used by backfill B5)."""
    parts = [f"WHEN '{t}' THEN '{spec['category']}'" for t, spec in sorted(REGISTRY.items())]
    return f"CASE {column} {' '.join(parts)} ELSE '' END"
