#!/usr/bin/env python3
"""Panda Jobs — History (archive) verification.
Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_history.py
Server must be running in DEMO mode:  python3 -m http.server 8765
(from the project root or a demo-config copy).

Flow: create a client + job, set it Invoiced with an appointment and
notes, press "Complete & move to History", check it leaves the board,
then exercise the History tab search (name / phone digits / email /
no-match) and the record view (installation date & time, notes,
invoice, signed-contract block), then Restore it to the board.
"""
import json, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + name + ((" — " + str(detail)[:200]) if detail else ""))

def body(page):
    return page.inner_text("body")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.reload(); page.wait_for_load_state("networkidle")
    page.fill("#pw", "panda2026")
    page.click("#loginBtn")
    page.wait_for_selector("text=Jobs", timeout=5000)

    # ---------- client + job ----------
    page.click('[data-tab="clients"]')
    page.fill("#cf_name", "History Client")
    page.fill("#cf_phone", "(312) 555-0173")
    page.fill("#cf_email", "history.client@example.com")
    page.fill("#cf_address", "742 W History Ave, Chicago, IL")
    page.click("#cf_save")
    page.wait_for_selector("text=History Client", timeout=5000)
    page.click('[data-tab="new"]')
    page.select_option("#nj_client", label="History Client — history.client@example.com")
    page.fill("#nj_title", "History check — furnace install")
    page.click("#nj_create")
    page.wait_for_selector("#jd_title", timeout=5000)
    page.click("#addItem")
    page.wait_for_selector('[data-qrow="0"]', timeout=5000)
    page.fill('[data-qrow="0"] [data-f="desc"]', "Furnace install, 80k BTU")
    page.fill('[data-qrow="0"] [data-f="price"]', "1200")
    page.click("#saveQuote")
    page.wait_for_timeout(1400)

    # ---------- make it invoiced, with appointment + notes ----------
    page.select_option("#jd_status", "invoiced")
    page.fill("#jd_sched", "2026-11-05T10:30")
    page.fill("#jd_notes", "Installed new furnace and tested heat.")
    page.click("#saveExec")
    page.wait_for_timeout(800)
    # Reopen the job: the completion zone renders for the saved status.
    page.click("#backBtn")
    page.wait_for_timeout(800)
    page.click('[data-open-job]:has-text("History check")')
    page.wait_for_selector("#jd_title", timeout=5000)
    rec("Archive button appears on an invoiced job", page.locator("#archiveJobBtn").count() == 1)

    # ---------- archive it ----------
    page.click("#archiveJobBtn")
    page.wait_for_timeout(1200)
    b = body(page)
    rec("Archived job leaves the Jobs board", "History check" not in b)

    # ---------- history tab + search ----------
    page.click('[data-tab="history"]')
    page.wait_for_selector("[data-open-history]", timeout=5000)
    rec("History lists the archived job", "History check — furnace install" in body(page))
    card = page.locator("[data-open-history]")
    page.fill("#historySearch", "5550173")
    page.wait_for_timeout(300)
    rec("Search by phone digits finds it", card.is_visible())
    page.fill("#historySearch", "history.client@")
    page.wait_for_timeout(300)
    rec("Search by email finds it", card.is_visible())
    page.fill("#historySearch", "History Client")
    page.wait_for_timeout(300)
    rec("Search by name finds it", card.is_visible())
    page.fill("#historySearch", "zzz-no-match")
    page.wait_for_timeout(300)
    rec("No-match search hides it and says so", (not card.is_visible()) and "No records match" in body(page))
    page.fill("#historySearch", "")
    page.wait_for_timeout(300)

    # ---------- record view ----------
    page.click("[data-open-history]")
    page.wait_for_selector("#histRestore", timeout=5000)
    t = body(page)
    rec("Record shows installation date & time", "Installation date" in t and "Nov 5, 2026" in t, t[:300])
    rec("Record shows the notes", "Installed new furnace and tested heat." in t)
    rec("Record shows the invoice", "Invoice" in t and "$1,200.00" in t)
    rec("Record shows the contract block", "Signed contract" in t)
    rec("Record shows client contact for lookups", "history.client@example.com" in t and "555-0173" in t)

    # ---------- restore ----------
    page.click("#histRestore")
    page.wait_for_timeout(1200)
    rec("Restored job is back on the board", "History check — furnace install" in body(page))

    with open(os.path.join(ROOT, "tests", "results-history.json"), "w") as f:
        json.dump(results, f, indent=1)
    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    browser.close()
