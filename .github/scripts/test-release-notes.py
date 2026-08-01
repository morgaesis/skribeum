"""Exercise release-note generation, validation, judging, and fallback."""

import contextlib
import http.server
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest


SCRIPT = pathlib.Path(__file__).parent / "release-notes.py"
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "release-notes-v0.0.6.md"
REPOSITORY_ROOT = pathlib.Path(__file__).parents[2]

SPEC = importlib.util.spec_from_file_location("release_notes", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load release-notes.py")
RELEASE_NOTES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE_NOTES)


def completion(content: str) -> bytes:
    return json.dumps(
        {"choices": [{"message": {"content": content}}]}
    ).encode("utf-8")


PASSING_JUDGE = json.dumps(
    {
        "traceable": True,
        "fabrications": [],
        "voice": "good",
        "verdict": "pass",
    }
)
FAILING_JUDGE = json.dumps(
    {
        "traceable": False,
        "fabrications": ["Android synchronization is absent from the changelog."],
        "voice": "good",
        "verdict": "fail",
    }
)


class StubHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers["Content-Length"])
        payload = json.loads(self.rfile.read(length))
        self.server.requests.append(payload)
        response = self.server.responses.pop(0)
        if isinstance(response, tuple):
            delay, response = response
            time.sleep(delay)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        try:
            self.wfile.write(response)
        except BrokenPipeError:
            pass

    def log_message(self, format_string: str, *arguments: object) -> None:
        del format_string, arguments


class StubServer(http.server.ThreadingHTTPServer):
    def __init__(self, responses: list[bytes | tuple[float, bytes]]) -> None:
        super().__init__(("127.0.0.1", 0), StubHandler)
        self.responses = list(responses)
        self.requests: list[dict[str, object]] = []

    @property
    def url(self) -> str:
        host, port = self.server_address
        return f"http://{host}:{port}/api/v1/chat/completions"


@contextlib.contextmanager
def stub_server(responses: list[bytes | tuple[float, bytes]]):
    server = StubServer(responses)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def candidate(section: str, fabricated: bool = False) -> str:
    if fabricated:
        bullets = (
            "- 📱 **Tables sync to Android.** Every table follows you to an "
            "Android device."
        )
    else:
        bullets = "\n".join(
            [
                "- 📖 **Reading column styles behave.** Prose keeps its bounded "
                "measure and responsive gutters.",
                "- 📱 **Touch controls meet their target.** The mobile controls "
                "stay reachable without hover.",
                "- 🧮 **Tables share one grid.** Header and body rows agree on their columns.",
            ]
        )
    intro = (
        "**TL;DR: reading, touch controls, and tables behave like they mean it.** 📖\n\n"
        "## What you'll actually feel\n\n"
        f"{bullets}"
    )
    return (
        f"{intro}\n\n"
        f"{RELEASE_NOTES.required_suffix(section, 'morgaesis/skribeum', 'v0.0.6')}"
    )


def run_script(
    output: pathlib.Path,
    summary: pathlib.Path,
    api_url: str | None,
    *,
    key: bool = True,
    tag: str = "v0.0.6",
    changelog: pathlib.Path | None = None,
    section_file: pathlib.Path | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = {
        name: os.environ[name]
        for name in ("LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "TMPDIR")
        if name in os.environ
    }
    environment["GITHUB_STEP_SUMMARY"] = str(summary)
    if key:
        environment["OPENROUTER_RELEASE_NOTES_KEY"] = "stub-key"
    if api_url:
        environment["RELEASE_NOTES_API_URL"] = api_url
    command = [
        sys.executable,
        str(SCRIPT),
        "--changelog",
        str(changelog or REPOSITORY_ROOT / "CHANGELOG.md"),
        "--tag",
        tag,
        "--repository",
        "morgaesis/skribeum",
        "--output",
        str(output),
    ]
    if section_file:
        command.extend(["--section-file", str(section_file)])
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )


class ValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.section = FIXTURE.read_text(encoding="utf-8").strip()
        cls.body = candidate(cls.section)

    def assert_invalid(self, body: str, expected: str) -> None:
        errors = RELEASE_NOTES.validate_generated_body(
            body, self.section, "morgaesis/skribeum", "v0.0.6"
        )
        self.assertTrue(any(expected in error for error in errors), errors)

    def test_fixture_is_real_release_section(self) -> None:
        extracted = RELEASE_NOTES.changelog_section(
            REPOSITORY_ROOT / "CHANGELOG.md", "v0.0.6"
        )
        self.assertEqual(self.section, extracted)

    def test_happy_candidate_passes(self) -> None:
        self.assertEqual(
            [],
            RELEASE_NOTES.validate_generated_body(
                self.body, self.section, "morgaesis/skribeum", "v0.0.6"
            ),
        )

    def test_extra_details_block_is_rejected(self) -> None:
        body = self.body.replace(
            "## What you'll actually feel",
            "<details><summary>Extra</summary></details>\n\n"
            "## What you'll actually feel",
        )
        self.assert_invalid(body, "unexpected details block")

    def test_missing_details_block_is_rejected(self) -> None:
        body = self.body.replace(RELEASE_NOTES.changelog_details(self.section), "")
        self.assert_invalid(body, "changelog details block")

    def test_mutated_changelog_is_rejected(self) -> None:
        body = self.body.replace(
            "Release pages use the matching version section",
            "Release pages use a matching version section",
        )
        self.assert_invalid(body, "missing or changed")

    def test_em_dash_is_rejected(self) -> None:
        body = self.body.replace("Reading column", f"Reading{chr(0x2014)}column", 1)
        self.assert_invalid(body, "em dash")

    def test_tldr_requires_sentence_punctuation_and_an_emoji(self) -> None:
        body = self.body.replace(
            "**TL;DR: reading, touch controls, and tables behave like they mean it.** 📖",
            "**TL;DR: reading, touch controls, and tables behave**",
        )
        self.assert_invalid(body, "bold TL;DR")

    def test_invented_markdown_link_is_rejected(self) -> None:
        body = self.body.replace(
            "## What you'll actually feel",
            "[Surprise](https://example.invalid)\n\n## What you'll actually feel",
        )
        self.assert_invalid(body, "link or URL")

    def test_invented_bare_url_is_rejected(self) -> None:
        body = self.body.replace(
            "## What you'll actually feel",
            "https://example.invalid\n\n## What you'll actually feel",
        )
        self.assert_invalid(body, "link or URL")

    def test_unstructured_bullet_is_rejected(self) -> None:
        body = self.body.replace(
            "- 📖 **Reading column styles behave.**",
            "- Reading column styles behave.",
        )
        self.assert_invalid(body, "every introduction bullet")

    def test_non_ascii_letter_does_not_count_as_a_bullet_emoji(self) -> None:
        body = self.body.replace("- 📖 **Reading", "- é **Reading")
        self.assert_invalid(body, "every introduction bullet")

    def test_ungrounded_bold_lead_is_rejected(self) -> None:
        body = self.body.replace(
            "**Reading column styles behave.**",
            "**Satellites predict tomorrow.**",
        )
        self.assert_invalid(body, "not traceable")


class PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.section = FIXTURE.read_text(encoding="utf-8").strip()
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary_directory.name)
        self.output = self.root / "release.md"
        self.summary = self.root / "summary.md"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_happy_path_assembles_expected_structure(self) -> None:
        expected = candidate(self.section)
        with stub_server(
            [completion(expected), completion(PASSING_JUDGE)]
        ) as server:
            result = run_script(self.output, self.summary, server.url)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(f"{expected}\n", self.output.read_text(encoding="utf-8"))
        body = self.output.read_text(encoding="utf-8")
        self.assertTrue(body.startswith("**TL;DR:"))
        self.assertIn(RELEASE_NOTES.changelog_details(self.section), body)
        self.assertIn("<summary>🔐 Verifying your download</summary>", body)
        self.assertTrue(body.rstrip().endswith(RELEASE_NOTES.DEMO_LINK))
        self.assertEqual(2, len(server.requests))
        for request in server.requests:
            self.assertEqual("anthropic/claude-sonnet-4.5", request["model"])
            self.assertEqual(0.7, request["temperature"])
        self.assertIn("**Path:** generated", self.summary.read_text(encoding="utf-8"))

    def test_judge_failure_regenerates_once_then_falls_back(self) -> None:
        fabricated = candidate(self.section, fabricated=True)
        responses = [
            completion(fabricated),
            completion(FAILING_JUDGE),
            completion(fabricated),
            completion(FAILING_JUDGE),
        ]
        with stub_server(responses) as server:
            result = run_script(self.output, self.summary, server.url)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(4, len(server.requests))
        retry_prompt = server.requests[2]["messages"][1]["content"]
        self.assertIn("Android synchronization is absent", retry_prompt)
        self.assertEqual(
            RELEASE_NOTES.fallback_body(
                self.section, "morgaesis/skribeum", "v0.0.6"
            ),
            self.output.read_text(encoding="utf-8"),
        )
        self.assertIn(
            "**Path:** plain changelog fallback",
            self.summary.read_text(encoding="utf-8"),
        )

    def test_deterministic_failure_regenerates_once_and_can_pass(self) -> None:
        expected = candidate(self.section)
        invalid = expected.replace(
            RELEASE_NOTES.changelog_details(self.section), ""
        )
        responses = [
            completion(invalid),
            completion(expected),
            completion(PASSING_JUDGE),
        ]
        with stub_server(responses) as server:
            result = run_script(self.output, self.summary, server.url)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(3, len(server.requests))
        retry_prompt = server.requests[1]["messages"][1]["content"]
        self.assertIn("changelog details block", retry_prompt)
        self.assertEqual(f"{expected}\n", self.output.read_text(encoding="utf-8"))
        self.assertIn(
            "**Path:** generated after critique",
            self.summary.read_text(encoding="utf-8"),
        )

    def test_malformed_api_response_falls_back(self) -> None:
        with stub_server([b"{not-json"]) as server:
            result = run_script(self.output, self.summary, server.url)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(1, len(server.requests))
        self.assertEqual(
            RELEASE_NOTES.fallback_body(
                self.section, "morgaesis/skribeum", "v0.0.6"
            ),
            self.output.read_text(encoding="utf-8"),
        )
        self.assertIn("malformed response", self.summary.read_text(encoding="utf-8"))

    def test_api_call_has_a_total_deadline(self) -> None:
        original_timeout = RELEASE_NOTES.REQUEST_TIMEOUT_SECONDS
        RELEASE_NOTES.REQUEST_TIMEOUT_SECONDS = 0.05
        try:
            with stub_server([(0.2, completion("too late"))]) as server:
                with self.assertRaisesRegex(
                    RELEASE_NOTES.ReleaseNotesError, "timed out"
                ):
                    RELEASE_NOTES.chat_completion(
                        server.url,
                        "stub-key",
                        RELEASE_NOTES.DEFAULT_MODEL,
                        [{"role": "user", "content": "test"}],
                    )
        finally:
            RELEASE_NOTES.REQUEST_TIMEOUT_SECONDS = original_timeout

    def test_missing_key_falls_back_without_an_api_call(self) -> None:
        result = run_script(self.output, self.summary, None, key=False)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(
            RELEASE_NOTES.fallback_body(
                self.section, "morgaesis/skribeum", "v0.0.6"
            ),
            self.output.read_text(encoding="utf-8"),
        )
        self.assertIn(
            "OPENROUTER_RELEASE_NOTES_KEY is unavailable",
            self.summary.read_text(encoding="utf-8"),
        )

    def test_raw_section_file_supports_quality_dry_runs(self) -> None:
        result = run_script(
            self.output,
            self.summary,
            None,
            key=False,
            tag="vNEXT",
            section_file=FIXTURE,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(
            self.output.read_text(encoding="utf-8").startswith(self.section)
        )

    def test_missing_changelog_section_still_stops_publication(self) -> None:
        result = run_script(
            self.output, self.summary, None, key=False, tag="v9.9.9"
        )
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(self.output.exists())
        self.assertIn("has no section for v9.9.9", result.stderr)


class JudgeFenceTests(unittest.TestCase):
    def test_parses_judge_json_inside_a_code_fence(self):
        fenced = (
            "```json\n"
            '{"traceable": true, "fabrications": [], "voice": "good", "verdict": "pass"}\n'
            "```"
        )
        result = RELEASE_NOTES.parse_judge(fenced)
        self.assertEqual(result["verdict"], "pass")
        self.assertTrue(RELEASE_NOTES.judge_passed(result))

    def test_rejects_a_fence_with_no_object(self):
        with self.assertRaises(RELEASE_NOTES.ReleaseNotesError):
            RELEASE_NOTES.parse_judge("```json\nnot an object\n```")


if __name__ == "__main__":
    unittest.main()
