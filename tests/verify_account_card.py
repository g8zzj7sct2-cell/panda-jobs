#!/usr/bin/env python3
"""Panda Jobs — Account card (owner "Set password") verification.

Why this test exists: the owner account was created through a Supabase
email INVITATION. Clicking the invite link lands on the app with a live
session, but the app offered no way to set a password, so the owner could
never log in again once that session ended. The owner panel (live mode
only) has an Account card with a set-password form
(supabase.auth.updateUser({password})).

UX update (Rigo's request): the card no longer sits open in the panel.
It renders COLLAPSED (display:none) on every render, behind a small
"Account" toggle button in the header next to "Log out" (#acctToggle);
clicking the toggle shows/hides it in place. This test asserts the
hidden-by-default state, the toggle round-trip, and — after opening the
card — the same validation / updateUser / verbatim-error behavior as
before. Demo mode must have neither the card nor the toggle.

Setup — two static servers, both serving COPIES of the project so the real
config.js in the repo is never touched:
  1. LIVE copy:  cp -r the project to /tmp/pj-live-check, KEEP the real
     config.js, then  cd /tmp/pj-live-check && python3 -m http.server 8766
  2. DEMO copy:  cp -r the project to /tmp/pj-demo-check, replace config.js
     with placeholder values (SUPABASE_URL "https://YOUR-PROJECT.supabase.co",
     SUPABASE_ANON_KEY "YOUR-ANON-KEY", APP_PUBLIC_URL "") so DEMO_MODE=true,
     then  cd /tmp/pj-demo-check && python3 -m http.server 8765
Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_account_card.py
Env overrides: PJ_LIVE_BASE (default http://127.0.0.1:8766),
               PJ_DEMO_BASE (default http://127.0.0.1:8765)

How the live path is tested without a real Supabase session: a fake,
far-future session is seeded into localStorage under the key supabase-js v2
uses (sb-<project-ref>-auth-token), so auth.getSession() returns it exactly
as it does right after an invitation-link sign-in. EVERY request to the real
Supabase project host is route-intercepted and answered locally with canned
JSON — nothing reaches Supabase and no real account is touched. The
updateUser PUT is captured so the test can assert the new password was
actually sent, and a forced 400 checks that a server error is shown
verbatim.
"""
import base64, json, os, sys, time
from playwright.sync_api import sync_playwright

LIVE = os.environ.get("PJ_LIVE_BASE", "http://127.0.0.1:8766")
DEMO = os.environ.get("PJ_DEMO_BASE", "http://127.0.0.1:8765")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
os.makedirs(SHOTS, exist_ok=True)

SB_HOST = "https://hgfbzsnwihbdgdkuyubj.supabase.co"
SB_KEY = "sb-hgfbzsnwihbdgdkuyubj-auth-token"
EMAIL = "owner.invite@example.com"
ERR_TEXT = "Server says no: weak password XYZ"

results = []
console_errors = []

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:200] if detail else ""))

def b64url(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

now = int(time.time())
jwt = b64url({"alg": "HS256", "typ": "JWT"}) + "." + b64url({
    "sub": "00000000-0000-0000-0000-000000000001", "email": EMAIL,
    "role": "authenticated", "aud": "authenticated", "exp": now + 86400 * 365,
}) + ".fakesignature"
USER = {
    "id": "00000000-0000-0000-0000-000000000001", "aud": "authenticated",
    "role": "authenticated", "email": EMAIL,
    "app_metadata": {"provider": "email", "providers": ["email"]},
    "user_metadata": {}, "created_at": "2026-10-27T00:00:00Z",
    "updated_at": "2026-10-27T00:00:00Z",
}
SESSION = {
    "access_token": jwt, "refresh_token": "fake-refresh-token",
    "token_type": "bearer", "expires_in": 86400 * 365,
    "expires_at": now + 86400 * 365, "user": USER,
}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ---------------- LIVE mode (intercepted Supabase) ----------------
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("live pageerror: " + str(e)))
    # The forced-400 error-path test below makes Chromium log a network
    # "Failed to load resource ... 400" console error by design — that one is
    # expected and excluded; any other console/page error fails the run.
    page.on("console", lambda m: console_errors.append("live console." + m.type + ": " + m.text) if m.type == "error" and "status of 400" not in m.text else None)
    page.add_init_script(
        "localStorage.setItem(%s, %s);" % (json.dumps(SB_KEY), json.dumps(json.dumps(SESSION)))
    )

    update_calls = []
    state = {"fail_update": False}

    def handle(route):
        req = route.request
        url = req.url
        if "/auth/v1/user" in url and req.method == "PUT":
            update_calls.append(req.post_data or "")
            if state["fail_update"]:
                route.fulfill(status=400, content_type="application/json",
                              body=json.dumps({"message": ERR_TEXT}))
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(USER))
        elif "/rest/v1/" in url:
            route.fulfill(status=200, content_type="application/json", body="[]")
        elif "/auth/v1/" in url:
            route.fulfill(status=200, content_type="application/json", body="{}")
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    page.route(SB_HOST + "/**", handle)

    page.goto(LIVE + "/#/")
    try:
        page.wait_for_selector("#acctToggle", timeout=12000)
        rendered = True
    except Exception:
        rendered = False
    body_txt = page.inner_text("body") if rendered else ""
    rec("Live: owner panel renders from seeded (invite-style) session", rendered)
    rec("Live: LIVE badge shown", rendered and "LIVE" in body_txt)
    if rendered:
        # Collapsed by default: toggle button visible in the header, card
        # present in the DOM but NOT visible, password fields not visible,
        # and the card's text does not leak into the rendered page text.
        rec("Live: Account toggle in header, card hidden by default",
            page.locator("#acctToggle").is_visible()
            and page.locator("#logoutBtn").is_visible()
            and page.locator("#acctCard").count() == 1
            and not page.locator("#acctCard").is_visible()
            and not page.locator("#acctPw1").is_visible()
            and "Signed in as" not in body_txt)
        page.screenshot(path=os.path.join(SHOTS, "17-account-collapsed-live.png"), full_page=True)
        # Toggle opens the card, with the signed-in email as before.
        page.click("#acctToggle")
        page.wait_for_timeout(200)
        body_txt = page.inner_text("body")
        rec("Live: Account card appears after toggle, with signed-in email",
            page.locator("#acctCard").is_visible()
            and "Signed in as" in body_txt and EMAIL in body_txt
            and page.locator("#acctPw1").is_visible())

    if rendered:
        # validation: mismatch (no network call allowed)
        page.fill("#acctPw1", "LongEnough1")
        page.fill("#acctPw2", "Different99")
        page.click("#acctSave")
        page.wait_for_timeout(300)
        rec("Validation: mismatched passwords blocked, no update sent",
            "do not match" in page.inner_text("body") and len(update_calls) == 0)
        # validation: too short
        page.fill("#acctPw1", "short")
        page.fill("#acctPw2", "short")
        page.click("#acctSave")
        page.wait_for_timeout(300)
        rec("Validation: <8 chars blocked, no update sent",
            "at least 8 characters" in page.inner_text("body") and len(update_calls) == 0)
        # success path
        page.fill("#acctPw1", "NewPass123")
        page.fill("#acctPw2", "NewPass123")
        page.click("#acctSave")
        page.wait_for_selector("text=Password saved", timeout=8000)
        rec("updateUser called with the new password",
            len(update_calls) == 1 and "NewPass123" in update_calls[0],
            update_calls[0][:120] if update_calls else "no PUT captured")
        rec("Success message shown verbatim",
            "Password saved — use it to log in next time." in page.inner_text("body"))
        rec("Password fields cleared after save",
            page.input_value("#acctPw1") == "" and page.input_value("#acctPw2") == "")
        # toggle round-trip: hide again, then re-open for the error path
        page.click("#acctToggle")
        page.wait_for_timeout(200)
        hidden_again = not page.locator("#acctCard").is_visible()
        page.click("#acctToggle")
        page.wait_for_timeout(200)
        rec("Toggle hides and re-shows the card",
            hidden_again and page.locator("#acctCard").is_visible())
        # server error path -> verbatim
        state["fail_update"] = True
        page.fill("#acctPw1", "AnotherPass9")
        page.fill("#acctPw2", "AnotherPass9")
        page.click("#acctSave")
        page.wait_for_selector("text=" + ERR_TEXT, timeout=8000)
        rec("Supabase error shown verbatim", ERR_TEXT in page.inner_text("body"))
        page.screenshot(path=os.path.join(SHOTS, "16-account-card-live.png"), full_page=True)
    ctx.close()

    # ---------------- DEMO mode: card must NOT exist ----------------
    dctx = browser.new_context(viewport={"width": 1280, "height": 900})
    dpage = dctx.new_page()
    dpage.on("pageerror", lambda e: console_errors.append("demo pageerror: " + str(e)))
    dpage.on("console", lambda m: console_errors.append("demo console." + m.type + ": " + m.text) if m.type == "error" else None)
    dpage.goto(DEMO + "/#/")
    dpage.wait_for_load_state("networkidle")
    dpage.evaluate("localStorage.clear(); sessionStorage.clear();")
    dpage.reload(); dpage.wait_for_load_state("networkidle")
    dpage.fill("#pw", "panda2026")
    dpage.click("#loginBtn")
    dpage.wait_for_selector("text=Jobs", timeout=8000)
    dpage.wait_for_timeout(500)
    rec("Demo: owner panel renders, Account card AND toggle ABSENT",
        dpage.locator("#acctSave").count() == 0 and dpage.locator("#acctPw1").count() == 0
        and dpage.locator("#acctCard").count() == 0 and dpage.locator("#acctToggle").count() == 0
        and "Signed in as" not in dpage.inner_text("body"))
    dctx.close()

    rec("No JS console/page errors", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-account.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
