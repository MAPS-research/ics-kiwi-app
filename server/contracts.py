"""Dataclasses shared across workstreams (spec §5.6; FOUNDATION, frozen signatures)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from server.router import ApiError


@dataclass(frozen=True)
class ToolPolicy:
    r_workspace: bool
    allow_run_predict: bool
    ask_kiwi: str
    similar_practice: bool

    def as_dict(self) -> dict:
        return {
            "rWorkspace": self.r_workspace,
            "allowRunPredict": self.allow_run_predict,
            "askKiwi": self.ask_kiwi,
            "similarPractice": self.similar_practice,
        }


@dataclass(frozen=True)
class AssignmentRecord:
    """``readers.load_assignment(db, class_id, assignment_id, include_deleted=False)``."""

    id: str
    class_id: str
    kind: str
    title: str
    unit_id: str
    status: str
    due_at: str | None
    open_at: str | None
    close_at: str | None
    late_policy: dict
    max_attempts: int | None
    grades_visibility: str
    solutions_visibility: str
    tool_policy: ToolPolicy
    audience: dict
    archived_at: str | None
    deleted_at: str | None
    version: int
    frozen_at: str | None
    questions: list[dict]          # v2 question dicts, legacy-mapped (§4.5.2)
    time_limit: dict | None
    updated_at: str


@dataclass(frozen=True)
class CheckResult:
    """``judging.check(question, answer, run_output=None, provenance='client')``."""

    correct: bool | None
    score_fraction: float | None
    reason: str     # exact|accepted|numeric_tolerance|choice|output_match|case_mismatch|mismatch|not_gradable|no_reference
    basis: str      # answer_text|client_run_output
    normalized_answer: str

    def as_dict(self) -> dict:
        return {
            "correct": self.correct,
            "scoreFraction": self.score_fraction,
            "reason": self.reason,
            "basis": self.basis,
            "normalizedAnswer": self.normalized_answer,
        }


@dataclass(frozen=True)
class ResolvedPolicy:
    """``ai_policy.resolve(db, class_id, unit_id, student_id=None, group_id=None)``."""

    config: dict                         # full PolicyConfig with defaults (§12.1)
    version_id: int | None
    version: int | None
    source: str                          # unit-group|unit|course-group|course|platform
    scope_label: str                     # e.g. "Ch 03 rules v4" or "Default rules"
    updated_at: str | None
    updated_by: str | None

    def as_dict(self) -> dict:
        return {
            "config": self.config,
            "versionId": self.version_id,
            "version": self.version,
            "source": self.source,
            "scopeLabel": self.scope_label,
            "updatedAt": self.updated_at,
            "updatedBy": self.updated_by,
        }


@dataclass(frozen=True)
class GuardResult:
    """``leak_guard.check_text(text, protected)`` / ``check_item(item, protected)``."""

    leaked: bool
    rules: list[str]
    matches: list[dict]   # {rule, answerKind, excerpt, start, end} (start/end index the ORIGINAL text)


@dataclass(frozen=True)
class HomeworkMatch:
    """``leak_guard.match_homework(db, class_id, student_id, text, now)``."""

    assignment_id: str
    question_id: str
    containment: float
    jaccard: float
    rec: AssignmentRecord
    question: dict


@dataclass(frozen=True)
class AddEventResult:
    id: int | None
    event_id: str
    status: Literal["created", "duplicate", "rejected"]
    code: str
    message: str
    truncated: dict[str, int] = field(default_factory=dict)
    created_at: str | None = None    # FOUNDATION addition: stored occurrence time (v0.5.1 ``createdAt`` response field)

    def as_dict(self) -> dict:
        body: dict[str, object] = {"eventId": self.event_id, "status": self.status}
        if self.id is not None:
            body["id"] = self.id
        if self.created_at:
            body["createdAt"] = self.created_at
        if self.code:
            body["code"] = self.code
        if self.message:
            body["error"] = self.message
        if self.truncated:
            body["truncated"] = dict(self.truncated)
        return body


@dataclass(frozen=True)
class TimeRange:
    """``course_config.time_range(...)`` result (TS ``TimeRange``, §7.2)."""

    preset: str
    effective_preset: str
    from_: str | None
    to: str | None
    compare_from: str | None
    compare_to: str | None
    label: str
    compare_label: str | None
    note: str | None = None

    def as_dict(self) -> dict:
        body: dict[str, object] = {
            "preset": self.preset,
            "effectivePreset": self.effective_preset,
            "from": self.from_,
            "to": self.to,
            "compareFrom": self.compare_from,
            "compareTo": self.compare_to,
            "label": self.label,
            "compareLabel": self.compare_label,
        }
        if self.note:
            body["note"] = self.note
        return body


class AiError(ApiError):
    """Raised by ``ai.invoke``; the router maps status/code (429 rate_limited, 503 ai_busy/ai_unavailable,
    502 ai_provider_error/ai_incomplete/ai_invalid_output)."""

    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(status, code, message, details)
