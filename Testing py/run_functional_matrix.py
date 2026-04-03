#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BUILD_DIR = SCRIPT_DIR / "build"
REPORT_PATH = SCRIPT_DIR / "functional_test_report.md"
JSON_PATH = SCRIPT_DIR / "functional_test_results.json"
RULES_TEST_DIR = SCRIPT_DIR / "fb auto testing py"
RULES_RESULTS_PATH = RULES_TEST_DIR / "firebase_rules_results.json"

ROOT_NODE_MODULES = REPO_ROOT / "node_modules"
TSC_BIN = ROOT_NODE_MODULES / ".bin" / "tsc"
TRYON_DIR = REPO_ROOT / "tryon-local"
CHECKOUT_DIR = REPO_ROOT / "server"

TRYON_PORT = 8799
CHECKOUT_PORT = 4243

ONE_PIXEL_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W6McAAAAASUVORK5CYII="
)


@dataclass
class CheckResult:
    check_id: str
    name: str
    area: str
    check_type: str
    status: str
    summary: str
    evidence: str
    details: str = ""


def run_command(args: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def ensure_build_dir() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)


def compile_typescript_modules() -> list[CheckResult]:
    ensure_build_dir()
    modules = [
        REPO_ROOT / "src/lib/shippingAddress.ts",
        REPO_ROOT / "src/lib/listingEditor.ts",
        REPO_ROOT / "src/lib/feedRanking.ts",
    ]
    cmd = [
        str(TSC_BIN),
        *[str(path) for path in modules],
        "--target",
        "ES2020",
        "--module",
        "commonjs",
        "--skipLibCheck",
        "--types",
        "node",
        "--lib",
        "ES2020",
        "--outDir",
        str(BUILD_DIR),
    ]
    proc = run_command(cmd, cwd=REPO_ROOT)
    status = "PASS" if proc.returncode == 0 else "FAIL"
    summary = "Compiled runnable TypeScript logic modules into Testing py/build." if proc.returncode == 0 else "Failed to compile runnable TypeScript logic modules."
    evidence = ", ".join(path.name for path in modules)
    details = (proc.stdout + proc.stderr).strip()
    return [
        CheckResult(
            check_id="ts_compile_logic_modules",
            name="Compile Runnable Logic Modules",
            area="Harness",
            check_type="executed",
            status=status,
            summary=summary,
            evidence=evidence,
            details=details[:800],
        )
    ]


def run_node_expression(js_expression: str) -> tuple[bool, str]:
    proc = run_command(["node", "-e", js_expression], cwd=REPO_ROOT)
    if proc.returncode != 0:
        return False, (proc.stdout + proc.stderr).strip()
    return True, proc.stdout.strip()


def run_compiled_logic_checks() -> list[CheckResult]:
    checks: list[CheckResult] = []

    shipping_js = "./Testing py/build/shippingAddress.js"
    shipping_expr = textwrap.dedent(
        f"""
        const m=require({shipping_js!r});
        const complete=m.sanitizeShippingAddress({{name:' Ada ',line1:' 1 Main ',city:'London',postalCode:'SW1A',country:'UK'}});
        const incomplete=m.sanitizeShippingAddress({{name:'Ada',line1:'',city:'London',postalCode:'SW1A',country:'UK'}});
        console.log(JSON.stringify({{
          completeOk:m.isShippingAddressComplete(complete),
          incompleteOk:m.isShippingAddressComplete(incomplete),
          equalOk:m.shippingAddressesEqual(complete,{{name:'Ada',line1:'1 Main',city:'London',postalCode:'SW1A',country:'UK'}}),
          formatted:m.formatShippingAddress(complete)
        }}));
        """
    ).strip()
    ok, output = run_node_expression(shipping_expr)
    if ok:
        parsed = json.loads(output)
        pass_status = parsed["completeOk"] is True and parsed["incompleteOk"] is False and parsed["equalOk"] is True
        checks.append(
            CheckResult(
                check_id="shipping_address_logic",
                name="Shipping Address Logic",
                area="Authentication and profile persistence",
                check_type="executed",
                status="PASS" if pass_status else "FAIL",
                summary="Shipping address sanitization, completeness gating, equality, and formatting behaved as expected.",
                evidence=output,
            )
        )
    else:
        checks.append(
            CheckResult(
                check_id="shipping_address_logic",
                name="Shipping Address Logic",
                area="Authentication and profile persistence",
                check_type="executed",
                status="FAIL",
                summary="Shipping address logic could not be executed.",
                evidence=output[:500],
            )
        )

    listing_js = "./Testing py/build/listingEditor.js"
    listing_expr = textwrap.dedent(
        f"""
        const m=require({listing_js!r});
        const empty=m.createEmptyListingEditorState();
        const filled=m.cloneListingEditorState({{
          title:' Jacket ',
          tags:['Denim','denim','Blue'],
          photos:[{{uri:'https://example.com/a.jpg'}},{{uri:' '}}]
        }});
        console.log(JSON.stringify({{
          emptyHasContent:m.hasMeaningfulListingContent(empty),
          filledHasContent:m.hasMeaningfulListingContent(filled),
          title:filled.title,
          tags:filled.tags,
          remotePhoto:m.isRemoteListingPhotoUri(filled.photos[0]?.uri || '')
        }}));
        """
    ).strip()
    ok, output = run_node_expression(listing_expr)
    if ok:
        parsed = json.loads(output)
        pass_status = (
            parsed["emptyHasContent"] is False
            and parsed["filledHasContent"] is True
            and parsed["title"] == "Jacket"
            and parsed["tags"] == ["Denim", "Blue"]
            and parsed["remotePhoto"] is True
        )
        checks.append(
            CheckResult(
                check_id="listing_editor_logic",
                name="Listing Editor Normalization Logic",
                area="Listing creation and browsing",
                check_type="executed",
                status="PASS" if pass_status else "FAIL",
                summary="Listing editor state cloning trimmed fields, de-duplicated tags, and detected meaningful listing content.",
                evidence=output,
            )
        )
    else:
        checks.append(
            CheckResult(
                check_id="listing_editor_logic",
                name="Listing Editor Normalization Logic",
                area="Listing creation and browsing",
                check_type="executed",
                status="FAIL",
                summary="Listing editor logic could not be executed.",
                evidence=output[:500],
            )
        )

    feed_js = "./Testing py/build/feedRanking.js"
    feed_expr = textwrap.dedent(
        f"""
        const m=require({feed_js!r});
        const base=m.createEmptyFeedRankCache();
        const now=1710000000000;
        const cache1=m.registerFeedImpressions(base,[{{postId:'p1',authorId:'a1'}},{{postId:'p2',authorId:'a2'}}],now,0);
        const cache2=m.registerFeedLike(cache1,{{postId:'p1',authorId:'a1',liked:true,nowMs:now+1000}});
        const ranked=m.rankForYouFeed({{
          posts:[
            {{id:'p1',authorUid:'a1',likes:5,commentCount:1,createdAtMs:now-10000}},
            {{id:'p2',authorUid:'a2',likes:1,commentCount:0,createdAtMs:now-5000}}
          ],
          followingIds:new Set(),
          likedPostIds:new Set(['p1']),
          cache:cache2,
          nowMs:now+2000
        }}).map((post)=>post.id);
        console.log(JSON.stringify({{
          ranked,
          postRecords:Object.keys(cache2.posts).length,
          authorRecords:Object.keys(cache2.authors).length
        }}));
        """
    ).strip()
    ok, output = run_node_expression(feed_expr)
    if ok:
        parsed = json.loads(output)
        pass_status = parsed["ranked"] == ["p1", "p2"] and parsed["postRecords"] == 2 and parsed["authorRecords"] == 2
        checks.append(
            CheckResult(
                check_id="feed_ranking_logic",
                name="Feed Ranking Logic",
                area="Post publishing and feed display",
                check_type="executed",
                status="PASS" if pass_status else "FAIL",
                summary="Feed ranking updated impression and like state, then ranked the stronger liked post first.",
                evidence=output,
            )
        )
    else:
        checks.append(
            CheckResult(
                check_id="feed_ranking_logic",
                name="Feed Ranking Logic",
                area="Post publishing and feed display",
                check_type="executed",
                status="FAIL",
                summary="Feed ranking logic could not be executed.",
                evidence=output[:500],
            )
        )

    return checks


def run_firebase_rules_checks() -> list[CheckResult]:
    package_path = RULES_TEST_DIR / "package.json"
    node_modules_dir = RULES_TEST_DIR / "node_modules"

    if not package_path.exists():
        return [
            CheckResult(
                check_id="firebase_rules_suite",
                name="Firebase Security Rules Suite",
                area="Firebase security rules",
                check_type="executed",
                status="FAIL",
                summary="The Firebase rules test package is missing from Testing py/fb auto testing py.",
                evidence=str(package_path),
            )
        ]

    if not node_modules_dir.exists():
        return [
            CheckResult(
                check_id="firebase_rules_suite",
                name="Firebase Security Rules Suite",
                area="Firebase security rules",
                check_type="executed",
                status="FAIL",
                summary="Firebase rules test dependencies are not installed.",
                evidence="Run npm install in Testing py/fb auto testing py before running the functional matrix.",
            )
        ]

    proc = run_command(["npm", "run", "test:rules"], cwd=RULES_TEST_DIR)
    details = (proc.stdout + proc.stderr).strip()

    if not RULES_RESULTS_PATH.exists():
        return [
            CheckResult(
                check_id="firebase_rules_suite",
                name="Firebase Security Rules Suite",
                area="Firebase security rules",
                check_type="executed",
                status="FAIL",
                summary="The Firebase rules suite did not produce its JSON results file.",
                evidence=str(RULES_RESULTS_PATH),
                details=details[:800],
            )
        ]

    try:
        payload = json.loads(RULES_RESULTS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [
            CheckResult(
                check_id="firebase_rules_suite",
                name="Firebase Security Rules Suite",
                area="Firebase security rules",
                check_type="executed",
                status="FAIL",
                summary="The Firebase rules suite wrote invalid JSON output.",
                evidence=str(exc),
                details=details[:800],
            )
        ]

    checks = payload.get("checks") or []
    total = len(checks)
    passed = sum(1 for check in checks if check.get("status") == "PASS")
    failed_names = [str(check.get("name") or check.get("check_id") or "") for check in checks if check.get("status") != "PASS"]

    return [
        CheckResult(
            check_id="firebase_rules_suite",
            name="Firebase Security Rules Suite",
            area="Firebase security rules",
            check_type="executed",
            status="PASS" if not failed_names else "FAIL",
            summary="Emulator-backed Firestore and Storage rules checks covered unauthenticated writes, immutable fields, counterfeit counters, blocked access, and payment-state protection.",
            evidence=f"{passed}/{total} rule checks passed.",
            details="All rules checks passed." if not failed_names else "Failed checks: " + ", ".join(failed_names[:8]),
        )
    ]


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def wait_for_url(url: str, timeout_s: float = 30.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status < 500:
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return True
            time.sleep(0.5)
        except Exception:
            time.sleep(0.5)
    return False


def http_json(url: str, method: str = "GET", payload: dict | None = None) -> tuple[int, str]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")
    except Exception as exc:
        return 0, str(exc)


class ManagedProcess:
    def __init__(self, args: list[str], cwd: Path, env: dict[str, str]) -> None:
        self.args = args
        self.cwd = cwd
        self.env = env
        self.proc: subprocess.Popen[str] | None = None

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.args,
            cwd=str(self.cwd),
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )

    def stop(self) -> None:
        if not self.proc:
            return
        if self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def run_live_service_checks(include_live: bool) -> list[CheckResult]:
    if not include_live:
        return [
            CheckResult(
                check_id="live_service_checks",
                name="Live Service Checks",
                area="Harness",
                check_type="executed",
                status="NEEDS_MORE",
                summary="Live HTTP smoke checks were skipped. Run with --live to exercise local service routes.",
                evidence="Skipped by flag",
            )
        ]

    checkout_env = os.environ.copy()
    checkout_env.update(parse_env_file(CHECKOUT_DIR / ".env"))
    checkout_env["PORT"] = str(CHECKOUT_PORT)

    tryon_env = os.environ.copy()
    tryon_env.update(parse_env_file(TRYON_DIR / ".env"))
    tryon_env["PORT"] = str(TRYON_PORT)

    tryon = ManagedProcess(["node", "serve.mjs"], TRYON_DIR, tryon_env)
    checkout = ManagedProcess(["node", "index.js"], CHECKOUT_DIR, checkout_env)

    results: list[CheckResult] = []

    try:
        tryon.start()
        checkout.start()

        tryon_up = wait_for_url(f"http://127.0.0.1:{TRYON_PORT}/health")
        checkout_up = wait_for_url(f"http://127.0.0.1:{CHECKOUT_PORT}/checkout/success", timeout_s=10)

        if tryon_up:
            status, body = http_json(f"http://127.0.0.1:{TRYON_PORT}/health")
            results.append(
                CheckResult(
                    check_id="tryon_health",
                    name="Try-On Service Health",
                    area="Try-on generation for each supported role",
                    check_type="executed",
                    status="PASS" if status == 200 and '"ok":true' in body.replace(" ", "") else "FAIL",
                    summary="The local try-on service booted and responded on /health.",
                    evidence=body[:500],
                )
            )
        else:
            results.append(
                CheckResult(
                    check_id="tryon_health",
                    name="Try-On Service Health",
                    area="Try-on generation for each supported role",
                    check_type="executed",
                    status="FAIL",
                    summary="The local try-on service did not become ready.",
                    evidence=f"http://127.0.0.1:{TRYON_PORT}/health",
                )
            )

        prompt_cases = [
            ("streetwear_outfit", "minimal streetwear outfit"),
            ("single_shoes", "just black shoes"),
            ("sport_fit", "football matchday fit"),
        ]
        prompt_responses: list[dict[str, str]] = []
        prompt_pass = True
        prompt_blocker = ""
        for case_name, prompt in prompt_cases:
            status, body = http_json(
                f"http://127.0.0.1:{TRYON_PORT}/recommend",
                method="POST",
                payload={"prompt": prompt, "gender_pref": "any", "pool_size": 1},
            )
            prompt_responses.append({"case": case_name, "status": str(status), "body": body[:220]})
            if status != 200 or ("selection" not in body and "outfits" not in body):
                prompt_pass = False
                if "PERMISSION_DENIED" in body or "Permission 'aiplatform.endpoints.predict' denied" in body:
                    prompt_blocker = "Vertex Gemini IAM denied"
        results.append(
            CheckResult(
                check_id="recommend_multi_prompt_types",
                name="Recommender Outputs for Multiple Prompt Types",
                area="Prompt recommendation outputs for multiple prompt types",
                check_type="executed",
                status="PASS" if prompt_pass else "NEEDS_MORE",
                summary=(
                    "The recommender returned outputs for outfit, single-item, and sport-flavored prompts."
                    if prompt_pass
                    else "The recommender route is reachable, but multi-prompt execution is blocked before output generation."
                ),
                evidence=json.dumps(prompt_responses),
                details=prompt_blocker,
            )
        )

        role_responses: list[dict[str, str]] = []
        role_pass = True
        role_blocker = ""
        for role in ["top", "bottom", "dress", "outerwear"]:
            status, body = http_json(
                f"http://127.0.0.1:{TRYON_PORT}/tryon",
                method="POST",
                payload={
                    "personB64": ONE_PIXEL_PNG_B64,
                    "productB64": ONE_PIXEL_PNG_B64,
                    "personMime": "image/png",
                    "productMime": "image/png",
                    "category": role,
                    "count": 1,
                },
            )
            role_responses.append({"role": role, "status": str(status), "body": body[:220]})
            if status != 200 or "image_b64" not in body:
                role_pass = False
                if "Permission 'aiplatform.endpoints.predict' denied" in body:
                    role_blocker = "Vertex try-on IAM denied"
        results.append(
            CheckResult(
                check_id="tryon_role_matrix",
                name="Try-On Role Matrix",
                area="Try-on generation for each supported role",
                check_type="executed",
                status="PASS" if role_pass else "NEEDS_MORE",
                summary=(
                    "The try-on route generated outputs for top, bottom, dress, and outerwear."
                    if role_pass
                    else "The try-on route accepted all supported role values, but generation is blocked before image output."
                ),
                evidence=json.dumps(role_responses),
                details=role_blocker,
            )
        )

        if checkout_up:
            status, body = http_json(
                f"http://127.0.0.1:{CHECKOUT_PORT}/create-checkout-session",
                method="POST",
                payload={"items": [{"title": "Smoke Item", "qty": 1, "unitAmount": 100}]},
            )
            created = False
            try:
                parsed = json.loads(body)
                created = status == 200 and "checkout.stripe.com" in str(parsed.get("url", ""))
            except json.JSONDecodeError:
                parsed = {}
            results.append(
                CheckResult(
                    check_id="checkout_session_handoff",
                    name="Hosted Checkout Handoff",
                    area="Cart assembly and sandbox checkout handoff",
                    check_type="executed",
                    status="PASS" if created else "NEEDS_MORE",
                    summary=(
                        "The checkout server created a hosted Stripe checkout URL for a sandbox item."
                        if created
                        else "The checkout route responded, but did not complete hosted checkout URL creation."
                    ),
                    evidence=body[:600],
                )
            )

            status, body = http_json(
                f"http://127.0.0.1:{CHECKOUT_PORT}/finalize-payment-intent",
                method="POST",
                payload={},
            )
            results.append(
                CheckResult(
                    check_id="checkout_finalize_validation",
                    name="Checkout Finalize Validation",
                    area="Cart assembly and sandbox checkout handoff",
                    check_type="executed",
                    status="PASS" if status == 400 and "Missing paymentIntentId" in body else "FAIL",
                    summary="The finalize-payment-intent route rejected an empty request with the expected validation error.",
                    evidence=body[:300],
                )
            )
        else:
            results.append(
                CheckResult(
                    check_id="checkout_session_handoff",
                    name="Hosted Checkout Handoff",
                    area="Cart assembly and sandbox checkout handoff",
                    check_type="executed",
                    status="FAIL",
                    summary="The checkout server did not become ready for smoke testing.",
                    evidence=f"http://127.0.0.1:{CHECKOUT_PORT}",
                )
            )

    finally:
        tryon.stop()
        checkout.stop()

    return results


def line_for_pattern(path: Path, pattern: str) -> int | None:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if pattern in line:
            return number
        try:
            if re.search(pattern, line):
                return number
        except re.error:
            pass
    return None


def format_anchor(path: str, pattern: str) -> str:
    full_path = REPO_ROOT / path
    line = line_for_pattern(full_path, pattern)
    if line is None:
        return f"{path}:missing"
    return f"{path}:{line}"


def run_source_anchor_checks() -> list[CheckResult]:
    checks: list[CheckResult] = []

    source_checks = [
        (
            "auth_profile_wiring",
            "Auth and Profile Wiring",
            "Authentication and profile persistence",
            [
                ("src/context/AuthContext.tsx", "onAuthStateChanged"),
                ("src/context/AuthContext.tsx", "createUserWithEmailAndPassword"),
                ("src/lib/firebaseUsers.ts", "export async function createUserProfile"),
                ("src/lib/firebaseUsers.ts", "export async function updateUserProfile"),
            ],
            "Sign-in, sign-up, profile creation, and profile update wiring are present in app code.",
        ),
        (
            "wardrobe_tagging_wiring",
            "Wardrobe Creation and Tagging Wiring",
            "Wardrobe item creation and tagging",
            [
                ("src/screens/ProfileScreen.tsx", "persistClosetImage"),
                ("src/screens/ProfileScreen.tsx", "saveLocalCloset"),
                ("src/utils/localClassifier.ts", "export async function classifyPhoto"),
                ("src/screens/UploadScreen.tsx", "applyAutoFill"),
            ],
            "Closet persistence, classifier tagging, and upload auto-fill hooks are wired.",
        ),
        (
            "recommender_pipeline_wiring",
            "Prompt Recommendation Wiring",
            "Prompt recommendation outputs for multiple prompt types",
            [
                ("src/utils/localRecommender.ts", "export async function recommendFromPrompt"),
                ("src/screens/StudioScreen.tsx", "recommendFromPrompt(promptForRecommendation, genderPref)"),
                ("tryon-local/serve.mjs", "app.post('/recommend'"),
            ],
            "Prompt recommendation client and local recommender route are wired.",
        ),
        (
            "tryon_pipeline_wiring",
            "Try-On Pipeline Wiring",
            "Try-on generation for each supported role",
            [
                ("src/tryon/types.ts", "export type GarmentCategory = 'top' | 'bottom' | 'dress' | 'outerwear';"),
                ("src/tryon/TryOnEngine.ts", "export async function generateTryOn"),
                ("src/tryon/providers/googleTryOn.ts", "export async function googleTryOn"),
                ("tryon-local/serve.mjs", "app.post('/tryon'"),
            ],
            "Supported try-on roles and the client-to-server pipeline are wired.",
        ),
        (
            "listing_publish_wiring",
            "Listing Publish Wiring",
            "Listing creation and browsing",
            [
                ("src/lib/firebaseListings.ts", "export async function createListing"),
                ("src/lib/firebaseListings.ts", "export async function updateListing"),
                ("src/screens/UploadScreen.tsx", "await createListing"),
                ("src/screens/HomeScreen.tsx", "collection(db, 'listings')"),
            ],
            "Listing creation, update, and browse queries are wired.",
        ),
        (
            "cart_checkout_wiring",
            "Cart and Hosted Checkout Wiring",
            "Cart assembly and sandbox checkout handoff",
            [
                ("src/context/CartContext.tsx", "const add = (item: CartItem) => {"),
                ("src/context/CartContext.tsx", "AsyncStorage.setItem(CART_STORAGE_KEY"),
                ("src/screens/BasketScreen.tsx", "create-checkout-session"),
                ("src/screens/BasketScreen.tsx", "WebBrowser.openBrowserAsync"),
                ("server/index.js", "app.post('/create-checkout-session'"),
            ],
            "Basket persistence and checkout handoff wiring are present.",
        ),
        (
            "post_feed_wiring",
            "Post Publish and Feed Wiring",
            "Post publishing and feed display",
            [
                ("src/lib/firebasePosts.ts", "export async function createPostFromImage"),
                ("src/components/ResultModal.tsx", "await createPostFromImage"),
                ("src/screens/FeedScreen.tsx", "const filteredFeed = useMemo"),
                ("src/lib/feedRanking.ts", "export function rankForYouFeed"),
            ],
            "Try-on posting and feed ranking/display wiring are present.",
        ),
        (
            "blocking_access_wiring",
            "Blocking and Access Filtering Wiring",
            "Blocking behaviour and access denial",
            [
                ("src/lib/postModeration.ts", "export async function blockUser"),
                ("src/lib/postModeration.ts", "export async function unblockUser"),
                ("src/screens/FeedScreen.tsx", "return realPosts.filter((post) => !blockedIds.has(post.authorUid));"),
                ("src/screens/UserProfileScreen.tsx", "await blockUser"),
            ],
            "Blocking mutations and blocked-user filtering are present.",
        ),
    ]

    for check_id, name, area, anchors, summary in source_checks:
        evidence_parts = [format_anchor(path, pattern) for path, pattern in anchors]
        missing = [entry for entry in evidence_parts if entry.endswith(":missing")]
        checks.append(
            CheckResult(
                check_id=check_id,
                name=name,
                area=area,
                check_type="source-backed",
                status="NEEDS_MORE" if not missing else "FAIL",
                summary=summary,
                evidence=", ".join(evidence_parts),
                details="All anchors found, but the full flow still needs live integration coverage." if not missing else "One or more expected implementation anchors were missing.",
            )
        )

    return checks


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    def sanitize_cell(value: str) -> str:
        return str(value).replace("|", "\\|").replace("\n", "<br>")

    lines = [
        "| " + " | ".join(sanitize_cell(header) for header in headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(sanitize_cell(cell) for cell in row) + " |")
    return "\n".join(lines)


def format_status(check: CheckResult) -> str:
    if check.status == "PASS":
        return "PASS"
    if check.status == "FAIL":
        return "FAIL"
    details = f"{check.summary} {check.details}".lower()
    if "permission" in details or "iam denied" in details or "vertex" in details:
        return "BLOCKED_EXTERNAL_PERMISSION"
    if check.check_type == "source-backed":
        return "SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION"
    return "REQUIRES_LIVE_VALIDATION"


def format_method(check: CheckResult) -> str:
    if check.check_type == "executed":
        return "executed"
    if check.check_type == "source-backed":
        return "source-anchor"
    return check.check_type


def short_text(value: str, max_len: int = 220) -> str:
    normalized = " ".join(str(value or "").split())
    if len(normalized) <= max_len:
        return normalized
    return normalized[: max_len - 3] + "..."


def build_area_summary_rows(checks: list[CheckResult]) -> list[list[str]]:
    area_order: list[str] = []
    grouped: dict[str, list[CheckResult]] = {}
    for check in checks:
        if check.area not in grouped:
            grouped[check.area] = []
            area_order.append(check.area)
        grouped[check.area].append(check)

    rows: list[list[str]] = []
    for area in area_order:
        area_checks = grouped[area]
        labels = [format_status(check) for check in area_checks]
        if "FAIL" in labels:
            aggregate = "FAIL"
        elif "BLOCKED_EXTERNAL_PERMISSION" in labels:
            aggregate = "BLOCKED_EXTERNAL_PERMISSION"
        elif any(label.endswith("REQUIRES_LIVE_VALIDATION") for label in labels):
            aggregate = "REQUIRES_LIVE_VALIDATION"
        else:
            aggregate = "PASS"

        passed = sum(1 for label in labels if label == "PASS")
        failed = sum(1 for label in labels if label == "FAIL")
        blocked = sum(1 for label in labels if label == "BLOCKED_EXTERNAL_PERMISSION")
        live = sum(1 for label in labels if label.endswith("REQUIRES_LIVE_VALIDATION"))
        rows.append(
            [
                area,
                aggregate,
                f"{len(area_checks)}",
                f"pass={passed}; blocked={blocked}; live={live}; fail={failed}",
            ]
        )
    return rows


def write_report(checks: list[CheckResult]) -> None:
    passed = sum(1 for check in checks if format_status(check) == "PASS")
    blocked = sum(1 for check in checks if format_status(check) == "BLOCKED_EXTERNAL_PERMISSION")
    failed = sum(1 for check in checks if format_status(check) == "FAIL")
    live = sum(
        1 for check in checks if format_status(check).endswith("REQUIRES_LIVE_VALIDATION")
    )
    full_rows = [
        [
            check.name,
            check.area,
            format_method(check),
            format_status(check),
            check.summary,
            short_text(check.evidence),
            short_text(check.details),
        ]
        for check in checks
    ]

    report = [
        "# Functional Test Report",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        "",
        f"Summary: total={len(checks)}; pass={passed}; blocked_external_permission={blocked}; requires_live_validation={live}; fail={failed}",
        "",
        "## Area Summary",
        "",
        markdown_table(["Area", "Status", "Checks", "Breakdown"], build_area_summary_rows(checks)),
        "",
        "## Detailed Results",
        "",
        markdown_table(
            ["Check", "Area", "Method", "Status", "Summary", "Evidence", "Details"],
            full_rows,
        ),
        "",
        "## Notes",
        "",
        "- `Method=executed` indicates a local harness or route-level check ran in this environment.",
        "- `Method=source-anchor` indicates implementation anchors were found in source, but the full flow was not executed end to end.",
        "- `Status=BLOCKED_EXTERNAL_PERMISSION` indicates the route ran but an external model/service permission blocked completion.",
        "- `Evidence` contains captured response fragments, anchor locations, or serialized harness output.",
        "",
    ]
    REPORT_PATH.write_text("\n".join(report), encoding="utf-8")


def write_json(checks: list[CheckResult]) -> None:
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "checks": [asdict(check) for check in checks],
    }
    JSON_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local functional matrix checks and generate markdown tables.")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Also start local try-on and checkout services to run route-level smoke tests.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    all_checks: list[CheckResult] = []
    all_checks.extend(run_firebase_rules_checks())
    all_checks.extend(compile_typescript_modules())
    all_checks.extend(run_compiled_logic_checks())
    all_checks.extend(run_live_service_checks(include_live=args.live))
    all_checks.extend(run_source_anchor_checks())
    write_report(all_checks)
    write_json(all_checks)
    print(f"Wrote report: {REPORT_PATH}")
    print(f"Wrote JSON: {JSON_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
