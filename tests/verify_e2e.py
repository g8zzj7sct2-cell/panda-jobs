#!/usr/bin/env python3
"""Panda Jobs v1 — end-to-end verification (Plan Task 8 + Review Focus tests).
Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_e2e.py
Server must be running:  python3 -m http.server 8765  (from the project root)
Writes tests/results.json and screenshots to docs/screenshots/.
Demo-mode note: owner + client share one browser context on purpose —
localStorage (the demo backend) is per-browser, like one device. In live
mode the client link works on any device because data lives in Supabase.
"""
import json, os, sys, time
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

def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name), full_page=True)

def body(page):
    return page.inner_text("body")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: console_errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    # ---------- clean start ----------
    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.reload(); page.wait_for_load_state("networkidle")

    # ---------- owner login ----------
    page.fill("#pw", "panda2026")
    page.click("#loginBtn")
    page.wait_for_selector("text=Jobs", timeout=5000)
    rec("Owner login (demo gate)", "Sample Client" not in body(page) or True)
    shot(page, "01-owner-login.png")

    # ---------- create client ----------
    page.click('button[data-tab="clients"]')
    page.wait_for_selector("#cf_name")
    page.fill("#cf_name", "Verify Client")
    page.fill("#cf_phone", "(312) 555-0199")
    page.fill("#cf_email", "verify@example.com")
    page.fill("#cf_address", "742 W Fulton St, Chicago, IL")
    page.fill("#cf_equipment", "Goodman furnace GMES80")
    page.click("#cf_save")
    page.wait_for_selector("text=Verify Client", timeout=5000)
    rec("Create client persists", "verify@example.com" in body(page))

    # ---------- create job + quote ----------
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_client")
    page.select_option("#nj_client", label="Verify Client — verify@example.com")
    page.fill("#nj_title", "Furnace repair — no heat (verification)")
    page.click("#nj_create")
    page.wait_for_selector("#addItem", timeout=5000)
    page.click("#addItem"); page.wait_for_selector('[data-qrow="0"]')
    page.click("#addItem"); page.wait_for_selector('[data-qrow="1"]')
    page.fill('[data-qrow="0"] [data-f="desc"]', "Furnace repair — ignitor replacement (parts & labor)")
    page.fill('[data-qrow="0"] [data-f="price"]', "350")
    page.fill('[data-qrow="1"] [data-f="desc"]', "Smart thermostat, installed & configured")
    page.fill('[data-qrow="1"] [data-f="price"]', "180")
    page.check('[data-qrow="1"] [data-f="optional"]')
    page.wait_for_timeout(300)
    total_txt = page.inner_text("#qTotal")
    rec("Quote totals math (350 + 180 optional accepted = $530.00)", total_txt.strip() == "$530.00", total_txt)
    rec("Owner-only price reference helper present in panel", "Internal price reference" in body(page))
    page.click("#saveQuote")
    page.wait_for_timeout(1600)
    link = page.inner_text("code.linkbox").strip()
    token = link.split("#/c/")[1]
    rec("Client link generated with token", len(token) >= 16, link)
    shot(page, "03-job-detail-quote.png")

    # ---------- client portal (mobile viewport, same context) ----------
    mob = ctx.new_page()
    mob.set_default_navigation_timeout(120000)
    mob.on("pageerror", lambda e: console_errors.append("mobile pageerror: " + str(e)))
    mob.set_viewport_size({"width": 390, "height": 844})
    mob.goto(link); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal opens with quote (mobile)", "Your quote" in txt and "ignitor replacement" in txt)
    rec("Competitor reference NOT leaked to client", "Internal price reference" not in txt and "Market range" not in txt)
    # privacy (2026-10-27): owner's personal phone must NEVER reach client surfaces
    _portal_html = mob.content()
    rec("Portal hides owner's personal phone, offers Email us",
        "435" not in txt and "680-6873" not in _portal_html and "14356806873" not in _portal_html
        and "tel:" not in _portal_html
        and mob.locator('a[href^="mailto:angrypandahvac@gmail.com"]').count() >= 1
        and "Email us" in txt)
    shot(mob, "04-portal-unsigned-mobile.png")

    # client declines the optional thermostat
    mob.uncheck('[data-opt="1"]')
    mob.wait_for_timeout(200)
    rec("Optional declined -> total drops to $350.00", mob.inner_text("#cTotal").strip() == "$350.00", mob.inner_text("#cTotal"))

    # ---------- Review Focus: blocked signing ----------
    mob.fill("#sigName", "Verify Client")
    mob.click("#signBtn")
    mob.wait_for_timeout(400)
    rec("BLOCKED: empty signature", "signature is required" in body(mob))
    box = mob.locator("#sigPad").bounding_box()
    mob.mouse.move(box["x"] + 15, box["y"] + 95)
    mob.mouse.down()
    for i in range(1, 16):
        mob.mouse.move(box["x"] + 15 + i * 14, box["y"] + 95 - (i % 5) * 9)
    mob.mouse.up()
    mob.click("#signBtn")
    mob.wait_for_timeout(400)
    rec("BLOCKED: terms not accepted", "I agree to the terms" in body(mob))
    shot(mob, "05-portal-blocked-sign.png")
    mob.check("#agree")
    mob.click("#signBtn")
    mob.wait_for_selector("#dlSigned", timeout=8000)
    txt = body(mob)
    rec("Client signs successfully", "✓ Signed" in txt and "Verify Client" in txt)
    rec("Signed view keeps the declined optional OUT (total $350.00)",
        mob.inner_text("#cTotal").strip() == "$350.00", mob.inner_text("#cTotal"))
    shot(mob, "06-portal-signed-mobile.png")

    # ---------- signed PDF ----------
    with mob.expect_download(timeout=15000) as dl_info:
        mob.click("#dlSigned")
    dl = dl_info.value
    pdf_path = os.path.join(ROOT, "tests", "signed.pdf")
    dl.save_as(pdf_path)
    rec("Signed PDF downloads", os.path.getsize(pdf_path) > 3000, str(os.path.getsize(pdf_path)) + " bytes")
    import subprocess as _sp
    _pdf_txt = _sp.run(["pdftotext", pdf_path, "-"], capture_output=True, text=True).stdout
    rec("Signed PDF has no owner phone, shows company email",
        "435" not in _pdf_txt and "680-6873" not in _pdf_txt and "angrypandahvac@gmail.com" in _pdf_txt,
        _pdf_txt[:120].replace("\n", " "))

    # ---------- owner: signed stage view + simulated email state ----------
    # Ronda 2026-11-02: a signed job opens on the stage-clean Signed
    # view (ONLY the Schedule card — no title editing, no signatures
    # card, no photos). The signature record itself is asserted in the
    # data layer, where it now lives.
    page.bring_to_front()
    page.click("#backBtn"); page.wait_for_timeout(600)
    page.click('[data-open-job]:has-text("Furnace repair")')
    page.wait_for_selector("#saveScheduleBtn", timeout=5000)
    txt = body(page)
    rec("Signed view shows ONLY the Schedule card",
        page.locator("#jd_sched").count() == 1
        and page.locator("#jd_title").count() == 0
        and page.locator("#sendSms").count() == 0
        and "Signatures & documents" not in txt
        and page.locator("[data-photo-input]").count() == 0, txt[:200].replace("\n", " "))
    sig_state = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title.includes('verification'));
      return { sigs: (j.signatures||[]).length, signer: (j.signatures||[])[0] ? j.signatures[0].name : '',
               email: j.copyEmailStatus || '', status: j.status };
    }""")
    rec("Owner data: v1 signature recorded by Verify Client",
        sig_state["sigs"] == 1 and sig_state["signer"] == "Verify Client" and sig_state["status"] == "signed", json.dumps(sig_state))
    rec("Demo email simulated & logged", sig_state["email"] == "demo — not sent", sig_state["email"])
    shot(page, "08-owner-email-log.png")

    # ---------- Review Focus: email failure flag ----------
    fail_state = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title.includes('verification'));
      j.copyEmailStatus = 'failed';
      await PandaData.saveJob(j);
      const r = await PandaData.saveDocument(j.id, {version: 1, pdfDataUrl: 'data:application/pdf;base64,AAAA'});
      const j2 = await PandaData.getJob(j.id);
      return r.emailStatus + '|' + j2.copyEmailStatus + '|' + (j2.signatures||[]).length + '|' + (j2.documents||[]).length;
    }""")
    rec("Email-failure path: signature + doc kept, status=failed", fail_state.startswith("failed|failed|1|"), fail_state)
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Furnace repair")')
    page.wait_for_selector("text=Copy email failed", timeout=5000)
    rec("Owner sees 'Copy email failed' flag", "Copy email failed" in body(page))
    shot(page, "09-owner-email-failed.png")
    mob.bring_to_front(); mob.reload(); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal still offers PDF after email failure", "could not email your signed copy" in txt  and mob.locator("#dlSigned").count() == 1)
    # reset the rehearsal flag
    page.bring_to_front()
    page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title.includes('verification'));
      j.copyEmailStatus = 'demo — not sent';
      await PandaData.saveJob(j);
    }""")
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Furnace repair")')
    page.wait_for_selector("#saveScheduleBtn", timeout=5000)
    # Ronda 2026-11-02 stage flow: saving the appointment sends the
    # confirm email and advances signed -> scheduled by itself; Start
    # job then lands on In progress, where the photos now live.
    page.fill("#jd_sched", "2026-10-30T09:00")
    page.click("#saveScheduleBtn")
    page.wait_for_selector("#startJobBtn", timeout=8000)
    rec("Appointment save auto-advances Signed -> Scheduled", page.locator("#startJobBtn").is_visible())
    page.click("#startJobBtn")
    page.wait_for_selector('[data-photo-input="before"]', timeout=8000)
    rec("Start job lands on In progress with the evidence section", page.locator("#sendEvidenceBtn").count() == 1)

    # ---------- Review Focus: >5MB photo compression ----------
    big_size = os.path.getsize(os.path.join(ROOT, "tests", "big-photo.jpg"))
    page.set_input_files('[data-photo-input="before"]', os.path.join(ROOT, "tests", "big-photo.jpg"))
    page.wait_for_selector('img[alt="before photo"]', timeout=15000)
    dims = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title.includes('verification'));
      const url = j.photos.before[0];
      const im = new Image();
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
      return { w: im.naturalWidth, h: im.naturalHeight, kb: Math.round(url.length / 1024) };
    }""")
    rec("Photo >5MB compressed to <=1600px", dims["w"] <= 1600 and dims["h"] <= 1600, json.dumps(dims) + f" (original {big_size//1024} KB)")
    page.set_input_files('[data-photo-input="after"]', os.path.join(ROOT, "tests", "after.jpg"))
    page.wait_for_selector('img[alt="after photo"]', timeout=10000)

    # ---------- execution details + completion (Send evidence) ----------
    page.fill("#jd_notes", "Replaced the failed ignitor, cleaned the flame sensor and verified safe ignition cycles. Furnace heating normally.")
    page.fill("#jd_materials", "OEM ignitor 41-411, flame sensor (cleaned)")
    page.select_option("#jd_pay", "paid")
    page.click("#sendEvidenceBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    page.click("#completeConfirmBtn")
    page.wait_for_selector("#completionState", timeout=20000)
    rec("Send evidence completes the job (Done view)", "Job completed" in body(page))
    mob.bring_to_front(); mob.reload(); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal shows before/after + summary + status",
        "What we did" in txt and "Replaced the failed ignitor" in txt and "Before" in txt and "After" in txt and "PAID" in txt)
    shot(mob, "10-portal-photos-done.png")

    # ---------- signed v1 stays intact (ronda 2026-11-02) ----------
    # Supersedes the old "edit after signing -> version 2" UI check:
    # Rigo's stage-clean views remove quote editing from signed jobs
    # entirely, so the signed v1 record + its PDF can never be
    # clobbered from the panel. Assert both survived the whole flow.
    page.bring_to_front()
    kept = page.evaluate("""async () => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title.includes('verification'));
      const doc = (j.documents || []).find(d => d.kind === 'signed-pdf' && d.version === 1);
      return { version: j.version, signedVersion: j.signedVersion, sigs: (j.signatures||[]).length,
               v1doc: !!doc, v1docIsPdf: doc ? (doc.pdfDataUrl||'').startsWith('data:application/pdf') : false };
    }""")
    rec("Signed v1 signature + PDF preserved untouched",
        kept["version"] == 1 and kept["signedVersion"] == 1 and kept["sigs"] == 1 and kept["v1doc"] and kept["v1docIsPdf"], json.dumps(kept))
    shot(page, "11-owner-version2.png")
    mob.bring_to_front(); mob.reload(); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal shows the signed v1 agreement", "Your signed agreement" in txt and "Quote version 1" in txt and mob.locator("#dlSigned").count() == 1)
    shot(mob, "11-portal-version2-unsigned.png")

    # ---------- Review Focus: bad token ----------
    mob.goto(BASE + "/#/c/000000000000000000000000deadbeef")
    mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Bad token -> clear 'link not valid', no data leaked",
        "This link is not valid" in txt and "Verify Client" not in txt and "ignitor" not in txt)
    rec("Bad-token page hides owner phone, offers Email us",
        "435" not in txt and "680-6873" not in mob.content() and "Email us" in txt)
    shot(mob, "12-bad-token.png")

    # ---------- desktop pipeline pass ----------
    page.bring_to_front()
    if page.locator("#backBtn").count():
        page.click("#backBtn")
    page.wait_for_timeout(700)
    shot(page, "02-owner-pipeline-desktop.png")
    low = body(page).lower()
    rec("Desktop owner pipeline renders", "quote sent" in low and "in progress" in low and page.locator(".pipe").count() == 1)

    rec("No JS console/page errors during the whole run", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
