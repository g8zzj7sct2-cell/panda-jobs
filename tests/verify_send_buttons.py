#!/usr/bin/env python3
"""Panda Jobs — spot check for the owner panel "Send to client" direct-send
buttons (Text message / Email / Copy link + send log + status advance).
There is intentionally NO WhatsApp button: Rigo's market is the US, where
his clients use SMS/iMessage and email.
Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_send_buttons.py
Server must be running:  python3 -m http.server 8765  (from the project root)
SAFETY: the only phone involved is the fake test number 312-555-0148, and
clicking the sms: link in headless Chromium opens no app and sends nothing.
Writes tests/results-send.json and screenshots 13/14 to docs/screenshots/.
"""
import json, os, sys
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
results = []
console_errors = []

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:200] if detail else ""))

def body(page):
    return page.inner_text("body")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    try:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    except Exception:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: console_errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    # ---------- clean start + login ----------
    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.reload(); page.wait_for_load_state("networkidle")
    page.fill("#pw", "panda2026")
    page.click("#loginBtn")
    page.wait_for_selector('button[data-tab="clients"]', timeout=5000)

    # ---------- client WITH phone + email, and a job ----------
    page.click('button[data-tab="clients"]')
    page.wait_for_selector("#cf_name")
    page.fill("#cf_name", "Send Test")
    page.fill("#cf_phone", "(312) 555-0148")
    page.fill("#cf_email", "sendtest@example.com")
    page.fill("#cf_address", "100 W Test St, Chicago, IL")
    page.click("#cf_save")
    page.wait_for_selector("text=Send Test", timeout=5000)
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_client")
    page.select_option("#nj_client", label="Send Test — sendtest@example.com")
    page.fill("#nj_title", "Send buttons check")
    page.click("#nj_create")
    page.wait_for_selector("#sendSms", timeout=5000)

    link = page.inner_text("code.linkbox").strip()
    expected_msg = ("Hi Send, this is Angry Panda Heating and Cooling. "
                    "Here is your quote — tap the link to review and sign: " + link)

    rec("Exactly three send controls exist (Text, Email, Copy link)",
        page.locator("#sendSms").count() == 1 and page.locator("#sendEmail").count() == 1
        and page.locator("#copyLink").count() == 1)
    rec("NO WhatsApp anywhere in the job detail (no button, no wa.me link, no label)",
        page.locator("#sendWhatsApp").count() == 0
        and page.locator("a[href*='wa.me']").count() == 0
        and "WhatsApp" not in body(page))

    sms = page.get_attribute("#sendSms", "href") or ""
    rec("SMS href well-formed (sms:+13125550148?&body=...)",
        sms.split("?")[0] == "sms:+13125550148" and "?&body=" in sms
        and unquote(sms.split("?&body=", 1)[1]) == expected_msg, sms[:120])

    mail_tag = page.evaluate("document.getElementById('sendEmail').tagName")
    mail_href = page.get_attribute("#sendEmail", "href")
    rec("Email is a real send button now (BUTTON element, NO mailto href, enabled)",
        mail_tag == "BUTTON" and mail_href is None
        and "disabled" not in (page.get_attribute("#sendEmail", "class") or ""),
        mail_tag + " href=" + str(mail_href))

    rec("Demo-link warning is shown",
        "Demo link — only opens on this device until the app is deployed." in body(page))

    status_before = page.evaluate("document.querySelector('#jd_status option:checked').textContent")
    rec("Job starts at the Draft stage", status_before == "Draft", status_before)
    page.screenshot(path=os.path.join(SHOTS, "13-send-buttons.png"), full_page=True)

    # ---------- Copy link ----------
    page.click("#copyLink")
    page.wait_for_timeout(400)
    clip = page.evaluate("navigator.clipboard.readText()")
    rec("Copy link puts the exact client link on the clipboard", clip == link, clip)
    rec("Copy button shows 'Copied' feedback", "Copied" in page.inner_text("#copyLink"))

    # ---------- SMS click: logs the send + advances status ----------
    # Headless Chromium has no SMS app: the click fires the handler (which is
    # what we verify) and the protocol navigation goes nowhere. Nothing sent.
    try:
        page.click("#sendSms", timeout=5000)
    except Exception:
        page.evaluate("document.getElementById('sendSms').click()")
    page.wait_for_selector("text=Sent via Text message", timeout=5000)
    status_after = page.evaluate("document.querySelector('#jd_status option:checked').textContent")
    rec("Job detail shows 'Sent via Text message · <date/time>' and status 'Quote sent'",
        "Sent via Text message ·" in body(page) and status_after == "Quote sent", status_after)
    state = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === 'Send buttons check');
      return { status: j.status, log: j.sendLog || [] };
    }""")
    rec("Send persisted on the job (sendLog + status=quote)",
        state["status"] == "quote" and len(state["log"]) == 1 and state["log"][0]["channel"] == "Text message",
        json.dumps(state))
    page.screenshot(path=os.path.join(SHOTS, "14-send-log.png"), full_page=True)

    # ---------- Email click: real send path (demo-simulated) ----------
    # In demo mode the Demo backend simulates the Edge Function send and
    # records it exactly like the server does; in live mode the function
    # sends via Gmail and only then writes this same log entry.
    page.click("#sendEmail")
    page.wait_for_selector("text=Quote emailed to sendtest@example.com", timeout=5000)
    page.wait_for_selector("text=Sent via Email to sendtest@example.com", timeout=5000)
    state2 = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === 'Send buttons check');
      return { status: j.status, log: j.sendLog || [], sendEmail: j.sendEmail || '' };
    }""")
    rec("Email click shows the sent confirmation and logs 'Email' + recipient; sendEmail persisted",
        len(state2["log"]) == 2 and state2["log"][1]["channel"] == "Email"
        and state2["log"][1].get("to") == "sendtest@example.com"
        and state2["sendEmail"] == "sendtest@example.com",
        json.dumps(state2))

    # ---------- log survives a reload ----------
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Send buttons check")')
    page.wait_for_selector("text=Sent via Text message", timeout=5000)
    rec("Send log still shown after reload", "Sent via Text message ·" in body(page))

    # ---------- client WITHOUT phone: SMS disabled + hint ----------
    page.click("#backBtn"); page.wait_for_timeout(500)
    page.click('button[data-tab="clients"]')
    page.wait_for_selector("#cf_name")
    page.fill("#cf_name", "No Phone")
    page.fill("#cf_email", "nophone@example.com")
    page.click("#cf_save")
    page.wait_for_selector("text=No Phone", timeout=5000)
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_client")
    page.select_option("#nj_client", label="No Phone — nophone@example.com")
    page.fill("#nj_title", "No phone job")
    page.click("#nj_create")
    page.wait_for_selector("#sendSms", timeout=5000)
    sms2 = page.get_attribute("#sendSms", "href")
    sms2_cls = page.get_attribute("#sendSms", "class") or ""
    rec("No phone -> SMS disabled with hint, Email still enabled",
        sms2 is None and "disabled" in sms2_cls
        and page.get_attribute("#sendSms", "aria-disabled") == "true"
        and "No phone number on file" in body(page)
        and page.get_attribute("#sendEmail", "href") is None
        and "disabled" not in (page.get_attribute("#sendEmail", "class") or ""))

    # ---------- client WITHOUT email: Email disabled + hint ----------
    page.evaluate("""async () => {
      const c = await PandaData.saveClient({name:'No Email', phone:'(312) 555-0148', email:'', address:'', equipment:'', notes:''});
      const j = PandaData.newJob(c.id); j.title = 'No email job'; await PandaData.saveJob(j);
    }""")
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("No email job")')
    page.wait_for_selector("#sendEmail", timeout=5000)
    mail3 = page.get_attribute("#sendEmail", "href")
    mail3_cls = page.get_attribute("#sendEmail", "class") or ""
    rec("No email -> Email disabled with hint, SMS still enabled",
        mail3 is None and "disabled" in mail3_cls and "No email on file" in body(page)
        and (page.get_attribute("#sendSms", "href") or "").startswith("sms:+13125550148"))

    rec("No JS console/page errors during the spot check", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-send.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
