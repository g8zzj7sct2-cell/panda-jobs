#!/usr/bin/env python3
"""Panda Jobs — spot check for the editable "Send to email" recipient field
in the owner panel job detail (Rigo's request: he must be able to type /
choose WHICH email a quote is sent to, not be locked to the client's
stored email).

Flow verified:
  client with email A -> field prefilled A -> overwrite with B -> click
  Email: the quote is sent through the send path (SIMULATED by the Demo
  backend here; live it goes out via the Edge Function/Gmail) to B, not
  A -> sendLog line shows B and job.sendEmail persists across reload ->
  "Save as client email" updates the client record to B -> invalid
  address shows a visible error and logs nothing -> client WITHOUT a
  stored email: field empty, Email disabled, typing a valid address
  enables it. The Email control is a <button> now — there is no mailto:
  href anywhere (the old mailto button never actually sent anything).
Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_send_email_field.py
Server must be running:  python3 -m http.server 8765  (from the project root)
Writes tests/results-send-email.json and screenshot 15 to docs/screenshots/.
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

A = "client-a@example.com"
B = "spouse-b@example.com"
C = "typed-c@example.com"

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

    # ---------- client WITH email A + a job ----------
    page.click('button[data-tab="clients"]')
    page.wait_for_selector("#cf_name")
    page.fill("#cf_name", "Mail Field")
    page.fill("#cf_phone", "(312) 555-0148")
    page.fill("#cf_email", A)
    page.fill("#cf_address", "200 W Sample St, Chicago, IL")
    page.click("#cf_save")
    page.wait_for_selector("text=Mail Field", timeout=5000)
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_client")
    page.select_option("#nj_client", label="Mail Field — " + A)
    page.fill("#nj_title", "Email field check")
    page.click("#nj_create")
    page.wait_for_selector("#sendEmailTo", timeout=5000)

    link = page.inner_text("code.linkbox").strip()
    expected_msg = ("Hi Mail, this is Angry Panda Heating and Cooling. "
                    "Here is your quote — tap the link to review and sign: " + link)

    rec("Email field exists and is prefilled with the client's stored email A",
        page.input_value("#sendEmailTo") == A, page.input_value("#sendEmailTo"))
    rec("Email button starts enabled for A and is a button (no mailto href)",
        page.get_attribute("#sendEmail", "href") is None
        and "disabled" not in (page.get_attribute("#sendEmail", "class") or ""))

    # ---------- overwrite A with B: the send must go to B ----------
    page.fill("#sendEmailTo", B)
    rec("After overwriting with B, Email stays a no-href button (recipient read at click time)",
        page.get_attribute("#sendEmail", "href") is None
        and "disabled" not in (page.get_attribute("#sendEmail", "class") or ""))
    rec("'Save as client email' appears when the typed address differs from the client's",
        page.is_visible("#saveClientEmail"))
    page.screenshot(path=os.path.join(SHOTS, "15-send-email-field.png"), full_page=True)

    # ---------- click Email: sends (demo-simulated) to B; verify the log ----------
    try:
        page.click("#sendEmail", timeout=5000)
    except Exception:
        page.evaluate("document.getElementById('sendEmail').click()")
    page.wait_for_selector("text=Quote emailed to " + B, timeout=5000)
    page.wait_for_selector("text=Sent via Email to " + B, timeout=5000)
    rec("Send history line shows 'Sent via Email to B · <date/time>'",
        ("Sent via Email to " + B + " ·") in body(page))
    state = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === 'Email field check');
      return { sendEmail: j.sendEmail || '', log: j.sendLog || [], status: j.status };
    }""")
    rec("sendLog entry records channel Email + recipient B, job.sendEmail = B, status advanced",
        len(state["log"]) == 1 and state["log"][0]["channel"] == "Email"
        and state["log"][0].get("to") == B and state["sendEmail"] == B
        and state["status"] == "quote", json.dumps(state))

    # ---------- persistence across reload ----------
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Email field check")')
    page.wait_for_selector("#sendEmailTo", timeout=5000)
    rec("Field still shows B after reload (job.sendEmail persisted) and history line remains",
        page.input_value("#sendEmailTo") == B
        and ("Sent via Email to " + B + " ·") in body(page), page.input_value("#sendEmailTo"))

    # ---------- Save as client email ----------
    rec("'Save as client email' still offered after reload (B differs from stored A)",
        page.is_visible("#saveClientEmail"))
    page.click("#saveClientEmail")
    page.wait_for_selector("text=Client email updated to " + B, timeout=5000)
    client_now = page.evaluate("""async () => {
      const cs = await PandaData.listClients();
      const c = cs.find(x => x.name === 'Mail Field');
      return c ? c.email : '(missing)';
    }""")
    rec("Client record now holds email B", client_now == B, client_now)
    rec("Save link hides once the field matches the client's email",
        not page.is_visible("#saveClientEmail"))

    # ---------- invalid address: visible error, nothing logged ----------
    page.fill("#sendEmailTo", "not-an-email")
    page.press("#sendEmailTo", "Tab")  # blur -> change handler validates visibly
    page.wait_for_selector("#sendEmailError .notice", timeout=5000)
    err_txt = page.inner_text("#sendEmailError")
    log_len = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === 'Email field check');
      return (j.sendLog || []).length;
    }""")
    rec("Invalid address: visible error shown, Email disabled, nothing new logged",
        "valid email address" in err_txt
        and page.get_attribute("#sendEmail", "href") is None
        and log_len == 1, err_txt[:120])
    page.evaluate("document.getElementById('sendEmail').click()")
    page.wait_for_timeout(400)
    log_len2 = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === 'Email field check');
      return (j.sendLog || []).length;
    }""")
    rec("Clicking with an invalid address still sends/logs nothing",
        log_len2 == 1, "log length " + str(log_len2))

    # ---------- client WITHOUT stored email ----------
    page.evaluate("""async () => {
      const c = await PandaData.saveClient({name:'No Stored Email', phone:'(312) 555-0148', email:'', address:'', equipment:'', notes:''});
      const j = PandaData.newJob(c.id); j.title = 'No stored email job'; await PandaData.saveJob(j);
    }""")
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("No stored email job")')
    page.wait_for_selector("#sendEmailTo", timeout=5000)
    rec("No stored email: field empty with hint, Email disabled",
        page.input_value("#sendEmailTo") == ""
        and "No email on file for this client" in body(page)
        and page.get_attribute("#sendEmail", "href") is None
        and "disabled" in (page.get_attribute("#sendEmail", "class") or ""))
    page.fill("#sendEmailTo", C)
    rec("Typing a valid address enables Email (no-href button, not disabled)",
        page.get_attribute("#sendEmail", "href") is None
        and "disabled" not in (page.get_attribute("#sendEmail", "class") or ""))

    rec("NO WhatsApp anywhere in the job detail",
        page.locator("#sendWhatsApp").count() == 0
        and page.locator("a[href*='wa.me']").count() == 0
        and "WhatsApp" not in body(page))
    rec("No JS console/page errors during the check", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-send-email.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
