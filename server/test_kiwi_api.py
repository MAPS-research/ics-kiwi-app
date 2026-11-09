"""Official Kiwi JWT/JWKS + contextual-chat contract checks using a local HTTP fixture.

This is protocol validation, not a claim that a real Kiwi deployment or model was tested.
"""
from __future__ import annotations

import json
import os
import threading
import time
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from server import testsupport, ai, auth, kiwi_api, grading, governance
from server.contracts import AiError


class OfficialApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.key.public_key())),
                   "kid": "test-key", "use": "sig", "alg": "RS256"}
        owner = cls

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                owner.paths.append(self.path)
                if self.path.startswith("/api/kiwi-apps/"):
                    owner.caller_headers.append(dict(self.headers))
                    self.send_response(owner.caller_status)
                    if owner.caller_status == 302:
                        self.send_header("Location", owner.host + "/must-not-follow")
                    self.end_headers()
                    self.wfile.write(owner.caller_reply)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"keys": owner.keys}).encode())

            def do_POST(self):
                owner.paths.append(self.path)
                owner.sent.append((dict(self.headers), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(owner.status)
                if owner.status == 302:
                    self.send_header("Location", owner.host + "/must-not-follow")
                self.end_headers()
                self.wfile.write(owner.reply)

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.host = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)

    def setUp(self):
        type(self).keys = [self.jwk]
        type(self).paths, type(self).sent = [], []
        type(self).status = 200
        type(self).reply = json.dumps({"output": "Try inspecting is.na(x).", "promptId": "lab-tutor",
                                     "contextIncluded": ["relevant_materials"], "contextOmitted": []}).encode()
        type(self).caller_headers, type(self).caller_status = [], 200
        type(self).caller_reply = self.caller()
        kiwi_api._clients.clear()
        kiwi_api._callers.clear()
        self.addCleanup(kiwi_api._callers.clear)
        env = patch.dict(os.environ, {"KIWI_API_ORIGIN": self.host, "KIWI_CONTEXT_PROMPT_ID": "lab-tutor",
                                     "KIWI_STAFF_BINDINGS": "{}", "KIWI_JWT_ISSUER": ""})
        env.start()
        self.addCleanup(env.stop)
        reset = kiwi_api.current_identity.set(None)
        self.addCleanup(kiwi_api.current_identity.reset, reset)
        self.addCleanup(kiwi_api._clients.clear)

    def claims(self, **changes):
        return {"sub": "opaque-user", "type": "app_token", "appSlug": "ics-r-lab", "classId": "course-1",
                "tokenScope": "class", "scopes": ["context:student_learning:read", "llm:prompt:lab-tutor"],
                "iat": int(time.time()) - 1, "exp": int(time.time()) + 60, **changes}

    def token(self, *, kid=True, key=None, **changes):
        return jwt.encode(self.claims(**changes), key or self.key, algorithm="RS256",
                          headers={"kid": "test-key"} if kid else {})

    def caller_token(self, **changes):
        return self.token(scopes=["class:info:read", "context:student_learning:read", "llm:prompt:lab-tutor"], **changes)

    @staticmethod
    def caller(role="professor", manage=True, view=True, **changes):
        """A GET /api/kiwi-apps/ics-r-lab/me reply for the default token."""
        return json.dumps({"userId": "opaque-user", "classId": "course-1", "appSlug": "ics-r-lab", "role": role,
                           "permissions": {"canManageMaterials": manage, "canViewAnalytics": view},
                           "scopes": ["class:info:read", "context:student_learning:read"], **changes}).encode()

    def activate(self, **changes):
        token = self.token(**changes)
        context = kiwi_api.authenticate("Bearer " + token, "course-1")
        ident = replace(auth.student_identity("course-1", "opaque-user", kind="kiwi", linked=True),
                        token=token, kiwi_context=context)
        kiwi_api.current_identity.set(ident)
        return ident

    def invoke(self, text="Why NA?", meta=None):
        return ai.invoke({"model": "ignored-model", "max_output_tokens": 9876,
                          "input": [{"role": "system", "content": "Protected assignment rules"},
                                    {"role": "user", "content": text}]}, "course-1", "opaque-user", meta)

    def test_signed_tokens_with_and_without_kid(self):
        for kid in (True, False):
            with self.subTest(kid=kid):
                context = kiwi_api.authenticate("Bearer " + self.token(kid=kid), "course-1")
                self.assertEqual(context["userId"], "opaque-user")
                self.assertFalse(context["canTeach"])
        self.assertEqual(self.paths, ["/.well-known/jwks.json"])

    def test_signature_expiry_algorithm_and_required_claims(self):
        invalid = [self.token(key=self.wrong_key), self.token(exp=int(time.time()) - 1),
                   self.token(iat=int(time.time()) + 600), jwt.encode(self.claims(), "x" * 32, algorithm="HS256"),
                   "not-a-jwt", jwt.encode({"sub": "opaque-user"}, self.key, algorithm="RS256")]
        for token in invalid:
            with self.subTest(token_type=token[:10]), self.assertRaises(kiwi_api.KiwiError) as caught:
                kiwi_api.authenticate("Bearer " + token, "course-1")
            self.assertEqual(caught.exception.status, 401)

    def test_token_boundaries_reject_wrong_app_class_type_scope(self):
        for changes in ({"appSlug": "other"}, {"classId": "other"}, {"type": "access"},
                        {"tokenScope": "admin"}, {"scopes": "*"}, {"scopes": [123]}):
            with self.subTest(changes=changes), self.assertRaises(kiwi_api.KiwiError) as caught:
                kiwi_api.authenticate("Bearer " + self.token(**changes), "course-1")
            self.assertEqual(caught.exception.status, 403)

    def test_ambiguous_no_kid_keys_fail_closed(self):
        type(self).keys = [self.jwk, {**self.jwk, "kid": "second-key"}]
        with self.assertRaises(kiwi_api.KiwiError) as caught:
            kiwi_api.authenticate("Bearer " + self.token(kid=False), "course-1")
        self.assertEqual(caught.exception.status, 401)

    def test_claimed_roles_and_identity_fields_are_ignored(self):
        token = self.token(role="instructor", name="Real Name", email="secret@example.edu", canTeach=True)
        context = kiwi_api.authenticate("Bearer " + token, "course-1")
        self.assertFalse(context["canTeach"])
        self.assertNotIn("Real Name", json.dumps(context))
        self.assertNotIn("secret@example.edu", json.dumps(context))
        with patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": json.dumps({"course-1": {"opaque-user": "instructor"}})}):
            self.assertEqual(kiwi_api.authenticate("Bearer " + token, "course-1")["labRole"], "instructor")

    def test_kiwi_reports_the_callers_course_role(self):
        token = self.caller_token()
        cases = ((("professor", True, True), (True, True, True)), (("ta", False, True), (True, False, True)),
                 (("admin", True, True), (True, True, True)), (("student", False, False), (False, False, False)))
        for (role, manage, view), (teach, can_manage, can_view) in cases:
            kiwi_api._callers.clear()
            type(self).caller_reply = self.caller(role, manage, view)
            with self.subTest(role=role):
                context = kiwi_api.authenticate("Bearer " + token, "course-1")
                self.assertEqual((context["userRole"], context["labRole"]), (role, None))
                self.assertEqual((context["canTeach"], context["canManageCourse"], context["canViewAnalytics"]),
                                 (teach, can_manage, can_view))
                self.assertEqual(context["scopes"], ["class:info:read", "context:student_learning:read"])
        self.assertEqual(self.paths.count("/api/kiwi-apps/ics-r-lab/me"), len(cases))
        self.assertEqual(self.caller_headers[0]["Authorization"], "Bearer " + token)

    def test_kiwi_is_asked_only_when_the_course_granted_class_info(self):
        kiwi_api.authenticate("Bearer " + self.token(), "course-1")
        kiwi_api.authenticate("Bearer " + self.token(scopes=["class:*"]), "course-1")
        self.assertEqual(self.paths.count("/api/kiwi-apps/ics-r-lab/me"), 1)

    def test_caller_answer_is_reused_only_briefly(self):
        token = self.caller_token()
        kiwi_api.authenticate("Bearer " + token, "course-1")
        kiwi_api.authenticate("Bearer " + token, "course-1")
        self.assertEqual(len(self.caller_headers), 1)
        later = time.time() + kiwi_api.CALLER_CACHE_SECONDS + 1
        with patch.object(kiwi_api, "_now", return_value=later):
            kiwi_api.authenticate("Bearer " + token, "course-1")
        self.assertEqual(len(self.caller_headers), 2)

    def test_revoked_access_and_host_errors_fail_closed(self):
        for http, expected in ((401, 401), (403, 403), (500, 503), (302, 503)):
            kiwi_api._callers.clear()
            type(self).caller_status = http
            with self.subTest(http=http), self.assertRaises(kiwi_api.KiwiError) as caught:
                kiwi_api.authenticate("Bearer " + self.caller_token(), "course-1")
            self.assertEqual(caught.exception.status, expected)
        self.assertNotIn("/must-not-follow", self.paths)

    def test_host_without_the_endpoint_keeps_only_bindings(self):
        type(self).caller_status = 404
        token = self.caller_token()
        context = kiwi_api.authenticate("Bearer " + token, "course-1")
        self.assertEqual((context["userRole"], context["canTeach"]), ("student", False))
        kiwi_api._callers.clear()
        with patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": json.dumps({"course-1": {"opaque-user": "ta"}})}):
            context = kiwi_api.authenticate("Bearer " + token, "course-1")
        self.assertEqual((context["labRole"], context["canTeach"]), ("ta", True))

    def test_unexpected_caller_replies_are_rejected(self):
        bad = (self.caller(userId="someone-else"), self.caller(classId="other"), self.caller(appSlug="other"),
               self.caller(role=None), self.caller(permissions={"canManageMaterials": "yes"}),
               self.caller(scopes="class:info:read"), b"[]", b"<html>oops</html>")
        for reply in bad:
            kiwi_api._callers.clear()
            type(self).caller_reply = reply
            with self.subTest(reply=reply[:40]), self.assertRaises(kiwi_api.KiwiError) as caught:
                kiwi_api.authenticate("Bearer " + self.caller_token(), "course-1")
            self.assertEqual(caught.exception.status, 503)

    def test_only_approved_prompt_and_scopes_enable_ai(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "must-never-be-used"}):
            self.assertFalse(ai.available())
            with self.assertRaises(AiError):
                self.invoke()
        for scopes in ([], ["llm:prompt:lab-tutor"], ["context:student_learning:read"],
                       ["context:student_learning:read", "llm:prompt:other"]):
            self.activate(scopes=scopes)
            self.assertFalse(ai.available())
        self.activate()
        self.assertTrue(ai.available())
        with patch.dict(os.environ, {"KIWI_CONTEXT_PROMPT_ID": ""}):
            self.assertFalse(ai.available())
        self.assertFalse(self.sent)

    def test_official_request_shape_and_response_provenance(self):
        ident = self.activate()
        meta = {}
        self.assertEqual(self.invoke(meta=meta), "Try inspecting is.na(x).")
        headers, body = self.sent[0]
        self.assertEqual(headers["Authorization"], "Bearer " + ident.token)
        self.assertEqual(set(body), {"promptId", "userMessage", "contextRequest"})
        self.assertEqual(body["contextRequest"]["scope"], "current_user_current_class")
        self.assertEqual(body["contextRequest"]["include"], ["relevant_materials"])
        task = json.loads(body["userMessage"])
        self.assertEqual(task["instructions"], ["Protected assignment rules"])
        self.assertEqual(task["conversation"], [{"role": "user", "content": "Why NA?"}])
        self.assertEqual((meta["provider"], meta["model"], meta["prompt_id"]), ("kiwi", "kiwi-managed", "lab-tutor"))
        self.assertIsInstance(meta["latency_ms"], int)
        self.assertNotIn("input_tokens", meta)  # Kiwi does not expose provider usage.
        self.assertEqual(self.paths[-1], "/api/kiwi-apps/ics-r-lab/contextual-chat")

    def test_ai_refuses_other_caller_and_oversized_utf16_context(self):
        self.activate()
        for course, user in (("other", "opaque-user"), ("course-1", "other")):
            with self.assertRaises(AiError) as caught:
                ai.invoke({}, course, user)
            self.assertEqual(caught.exception.status, 403)
        with self.assertRaises(AiError) as caught:
            self.invoke("😀" * 4000)
        self.assertEqual((caught.exception.status, caught.exception.code), (422, "ai_context_too_large"))
        self.assertFalse(self.sent)

    def test_teacher_preview_uses_only_the_current_teachers_context(self):
        ident = self.activate()
        kiwi_api.current_identity.set(replace(ident, is_staff=True, is_student=False, staff_role="instructor", student_id=None))
        ai.invoke({"input": []}, "course-1", "preview-opaque-user")
        with self.assertRaises(AiError) as caught:
            ai.invoke({"input": []}, "course-1", "preview-other-teacher")
        self.assertEqual(caught.exception.status, 403)
        kiwi_api.current_identity.set(ident)
        with self.assertRaises(AiError):
            ai.invoke({"input": []}, "course-1", "preview-opaque-user")

    def test_http_failures_never_fall_back_to_a_provider(self):
        self.activate()
        for http, expected in ((401, 401), (403, 403), (429, 429), (404, 503), (500, 502), (302, 502)):
            type(self).status = http
            with self.subTest(http=http), self.assertRaises(AiError) as caught:
                self.invoke()
            self.assertEqual(caught.exception.status, expected)
        self.assertEqual(len(self.sent), 6)
        self.assertNotIn("/must-not-follow", self.paths)

    def test_unreadable_and_empty_outputs_are_errors(self):
        self.activate()
        for body in (b"<html>oops</html>", b"\xff", b"[]", b"{}", b'{"output":"  "}', b'{"output":123}'):
            type(self).reply = body
            with self.subTest(body=body), self.assertRaises(AiError) as caught:
                self.invoke()
            self.assertEqual(caught.exception.status, 502)


class IdentityApiTests(testsupport.ApiTestCase):
    def test_linked_teaching_exports_hide_historical_identity(self):
        self.create_course("course-1")
        with self.db() as db:
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES ('course-1', 'Review course')")
            testsupport.add_roster(db, "course-1", "opaque-user", source="kiwi")
            # Seed an old v0.6 database, bypassing today's identity-free writer.
            db.execute("UPDATE roster SET display_name='Bobby Tables', kiwi_email='bobby@realmail.edu', student_name='Bobby Tables' WHERE class_id='course-1'")
            testsupport.publish_work(db, "course-1", title="Review export for Bobby Tables")
            for export in (grading.grades_csv(db, "course-1"), grading.grades_csv(db, "course-1", layout="long"),
                           grading.status_csv(db, "course-1")):
                self.assertNotIn(b"Bobby Tables", export)
                self.assertNotIn(b"bobby@realmail.edu", export)
            auth._upsert_staff_seen(db, "course-1", "staff-opaque", "old.staff@realmail.edu", "instructor", True, True)
            listing = governance.staff_listing(db, "course-1")
            self.assertNotIn("old.staff@realmail.edu", json.dumps(listing))
            # The role Kiwi reported at the last visit; requests re-ask Kiwi.
            self.assertEqual(listing["kiwiStaff"][0]["effectiveRole"], "instructor")
            with patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": '{"course-1":{"staff-opaque":"ta"}}'}):
                self.assertEqual(governance.staff_listing(db, "course-1")["kiwiStaff"][0]["effectiveRole"], "ta")

    def test_real_adapter_ignores_browser_identity_and_grants_only_configured_staff(self):
        claims = {"sub": "opaque-user", "classId": "course-1", "scopes": []}
        with patch.object(kiwi_api, "verify_token", return_value=claims), patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": "{}"}):
            status, me = self.request("/api/me?classId=course-1&role=instructor", token="signed-token")
            self.assertEqual((status, me["role"]), (200, "student"))
            self.assertFalse(me["isStaff"])
            with patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": '{"course-1":{"opaque-user":"ta"}}'}):
                status, me = self.request("/api/me?classId=course-1", token="signed-token")
                self.assertEqual((status, me["role"]), (200, "ta"))
                self.assertNotIn("manageCourse", me["permissions"])
        with self.db() as db:
            row = db.execute("SELECT display_name, kiwi_email FROM roster WHERE student_id='opaque-user'").fetchone()
            self.assertEqual(tuple(row), ("", ""))

    def test_kiwi_course_role_grants_lab_staff_without_bindings(self):
        claims = {"sub": "opaque-user", "classId": "course-1", "scopes": ["class:info:read"]}

        def reported(role, manage, view):
            return {"userId": "opaque-user", "classId": "course-1", "appSlug": "ics-r-lab", "role": role,
                    "permissions": {"canManageMaterials": manage, "canViewAnalytics": view},
                    "scopes": ["class:info:read"]}

        # A professor without material or analytics permission is Kiwi staff with no Lab role yet:
        # an instructor can give one on Staff & roles.
        cases = ((reported("professor", True, True), "instructor", True), (reported("ta", False, True), "ta", True),
                 (reported("professor", False, False), None, True), (reported("student", False, False), "student", False))
        with patch.object(kiwi_api, "verify_token", return_value=claims), patch.dict(os.environ, {"KIWI_STAFF_BINDINGS": "{}"}):
            for caller, lab_role, is_staff in cases:
                with self.subTest(caller=caller["role"], manage=caller["permissions"]["canManageMaterials"]), \
                        patch.object(kiwi_api, "kiwi_caller", return_value=caller):
                    status, me = self.request("/api/me?classId=course-1", token="signed-token")
                    self.assertEqual(status, 200)
                    self.assertEqual((me["role"], me["isStaff"]), (lab_role, is_staff))
        with self.db() as db:
            listing = governance.staff_listing(db, "course-1")["kiwiStaff"]
            self.assertEqual([(r["kiwiRole"], r["effectiveRole"]) for r in listing], [("professor", None)])
