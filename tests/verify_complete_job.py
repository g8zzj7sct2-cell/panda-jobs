#!/usr/bin/env python3
"""Panda Jobs — "Complete job" verification (demo mode).

Verifies Rigo's requested flow end to end in a real browser:
  signed job -> owner adds photos + work details -> "Complete job"
  button -> in-app confirmation ("Is this job complete?") showing the
  evidence counts + recipient -> Cancel changes nothing -> Confirm
  persists the unsaved execution form, marks the job Done, records a
  completion-pdf document and the (simulated, demo-labelled) completion
  email -> the generated PDF itself is extracted and checked (title,
  summary, materials, photo section headings, embedded images, and the
  no-owner-phone privacy rule) -> the done state supports Re-send ->
  a job with no recipient email is blocked with a clear message and a
  zero-photo warning -> the client portal shows Done + completion date.

Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_complete_job.py
Server must be running in DEMO mode on :8765 (copy of the project with
placeholder config.js, per the account-suite recipe in
docs/verification-2026-10-27.md).
Writes tests/results-complete.json, tests/completion.pdf and
screenshots 18/19 to docs/screenshots/.
"""
import json, os, subprocess, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
results = []
console_errors = []

RECIPIENT = "completion-recipient@example.com"
SUMMARY = "Installed the new ignitor, cleaned the burner assembly and verified three full heating cycles."
MATERIALS = "OEM ignitor 41-411 and a new flame sensor"

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:220] if detail else ""))

def body(page):
    return page.inner_text("body")

def job_state(page, title):
    return page.evaluate("""async (title) => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === title);
      if (!j) return null;
      return {
        status: j.status, completedAt: j.completedAt || '',
        completionEmailStatus: j.completionEmailStatus || '',
        log: j.completionEmailLog || [], documents: j.documents || [],
        workNotes: j.workNotes || '', materials: j.materials || '',
        finalTotal: j.finalTotal, paymentStatus: j.paymentStatus
      };
    }""", title)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)  # shared VM can be CPU-busy (video renders); behavior checks matter, not load speed
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

    # ---------- client + job ----------
    page.click('button[data-tab="clients"]')
    page.wait_for_selector("#cf_name")
    page.fill("#cf_name", "Completion Client")
    page.fill("#cf_phone", "(312) 555-0117")
    page.fill("#cf_email", "completion.client@example.com")
    page.fill("#cf_address", "88 W Completion Ave, Chicago, IL")
    page.fill("#cf_equipment", "Goodman furnace GMES80")
    page.click("#cf_save")
    page.wait_for_selector("text=Completion Client", timeout=5000)
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_client")
    page.select_option("#nj_client", label="Completion Client — completion.client@example.com")
    page.fill("#nj_title", "Completion evidence check")
    page.click("#nj_create")
    page.wait_for_selector("#addItem", timeout=5000)
    page.click("#addItem"); page.wait_for_selector('[data-qrow="0"]')
    page.fill('[data-qrow="0"] [data-f="desc"]', "Furnace ignitor replacement (parts & labor)")
    page.fill('[data-qrow="0"] [data-f="price"]', "350")
    page.click("#saveQuote")
    page.wait_for_timeout(1600)

    rec("Draft job: no Complete button, exclusion note shown instead",
        page.locator("#completeJobBtn").count() == 0
        and page.locator("#completeUnavailable").count() == 1)

    link = page.inner_text("code.linkbox").strip()

    # ---------- client signs in the portal (mobile page, same context) ----------
    mob = ctx.new_page()
    mob.set_default_navigation_timeout(120000)
    mob.on("pageerror", lambda e: console_errors.append("mobile pageerror: " + str(e)))
    mob.on("console", lambda m: console_errors.append("mobile console." + m.type + ": " + m.text) if m.type == "error" else None)
    mob.set_viewport_size({"width": 390, "height": 844})
    mob.goto(link); mob.wait_for_load_state("networkidle")
    mob.fill("#sigName", "Completion Client")
    mob.locator("#sigPad").scroll_into_view_if_needed()
    mob.wait_for_timeout(300)
    box = mob.locator("#sigPad").bounding_box()
    mob.mouse.move(box["x"] + 15, box["y"] + 95)
    mob.mouse.down()
    for i in range(1, 16):
        mob.mouse.move(box["x"] + 15 + i * 14, box["y"] + 95 - (i % 5) * 9)
    mob.mouse.up()
    mob.check("#agree")
    mob.click("#signBtn")
    mob.wait_for_selector("#dlSigned", timeout=10000)
    rec("Client signed (job becomes completable)", "✓ Signed" in body(mob))

    # ---------- owner: photos + UNSAVED execution details ----------
    page.bring_to_front()
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Completion evidence check")')
    page.wait_for_selector("#completeJobBtn", timeout=8000)
    rec("Signed job: Complete job button appears",
        page.locator("#completeJobBtn").is_visible())
    page.set_input_files('[data-photo-input="assessment"]', os.path.join(ROOT, "tests", "before.jpg"))
    page.wait_for_selector('img[alt="assessment photo"]', timeout=10000)
    page.set_input_files('[data-photo-input="before"]', os.path.join(ROOT, "tests", "before.jpg"))
    page.wait_for_selector('img[alt="before photo"]', timeout=10000)
    page.set_input_files('[data-photo-input="after"]', os.path.join(ROOT, "tests", "after.jpg"))
    page.wait_for_selector('img[alt="after photo"]', timeout=10000)
    # Deliberately NOT saved with "Save execution details": the completion
    # confirm must persist what is currently typed.
    page.fill("#jd_notes", SUMMARY)
    page.fill("#jd_materials", MATERIALS)
    page.fill("#jd_final", "425")
    page.select_option("#jd_pay", "paid")
    page.fill("#sendEmailTo", RECIPIENT)  # per-job recipient override

    # ---------- confirmation: content + Cancel ----------
    page.click("#completeJobBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    panel = page.inner_text("#completeConfirm")
    rec("Confirmation asks 'Is this job complete?' and summarises the evidence",
        "Is this job complete?" in panel
        and "Assessment photos: 1" in panel and "BEFORE photos: 1" in panel
        and "AFTER photos: 1" in panel
        and "Work summary: included" in panel and "Materials: included" in panel
        and RECIPIENT in panel, panel[:300].replace("\n", " "))
    page.screenshot(path=os.path.join(SHOTS, "18-complete-confirm.png"), full_page=True)
    page.click("#completeCancel")
    page.wait_for_selector("#completeConfirm", state="hidden", timeout=5000)
    st = job_state(page, "Completion evidence check")
    rec("Cancel leaves status + completion metadata untouched",
        st and st["status"] == "signed" and st["completedAt"] == ""
        and not [d for d in st["documents"] if d.get("kind") == "completion-pdf"],
        json.dumps(st)[:200] if st else "job missing")

    # ---------- confirmation: Confirm completes ----------
    page.click("#completeJobBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    page.click("#completeConfirmBtn")
    page.wait_for_selector("#completionState", timeout=20000)
    txt = body(page)
    rec("After confirm: Done state, completion date + demo email status shown",
        "Job completed" in txt and "Completion evidence email:" in txt
        and "demo — not sent" in txt
        and "Job completed (demo)" in txt, txt[:200].replace("\n", " "))
    rec("Complete button replaced by the completion state",
        page.locator("#completeJobBtn").count() == 0
        and page.locator("#completionState").count() == 1)
    st = job_state(page, "Completion evidence check")
    comp_docs = [d for d in (st["documents"] if st else []) if d.get("kind") == "completion-pdf"]
    rec("Job persisted as Done with completion metadata + demo email log",
        st and st["status"] == "done" and bool(st["completedAt"])
        and st["completionEmailStatus"] == "demo — not sent"
        and len(st["log"]) == 1 and st["log"][0].get("to") == RECIPIENT
        and st["log"][0].get("status") == "demo — not sent", json.dumps(st)[:300] if st else "missing")
    rec("Unsaved execution form was persisted by the completion flow",
        st and st["workNotes"] == SUMMARY and st["materials"] == MATERIALS
        and st["finalTotal"] == 425 and st["paymentStatus"] == "paid")
    rec("Completion PDF recorded as a completion-pdf document with photo stats",
        len(comp_docs) == 1 and comp_docs[0].get("pdfDataUrl", "").startswith("data:application/pdf")
        and (comp_docs[0].get("photoCounts") or {}).get("assessment") == 1
        and (comp_docs[0].get("photoCounts") or {}).get("before") == 1
        and (comp_docs[0].get("photoCounts") or {}).get("after") == 1
        and comp_docs[0].get("embeddedPhotoCount") == 3
        and comp_docs[0].get("failedPhotoCount") == 0,
        json.dumps(comp_docs[0])[:300] if comp_docs else "no completion doc")
    page.screenshot(path=os.path.join(SHOTS, "19-complete-done.png"), full_page=True)

    # ---------- the generated PDF itself ----------
    pdf_path = os.path.join(ROOT, "tests", "completion.pdf")
    if comp_docs:
        import base64 as _b64
        raw = comp_docs[0]["pdfDataUrl"].split(",", 1)[1]
        with open(pdf_path, "wb") as f:
            f.write(_b64.b64decode(raw))
    pdf_ok = os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 10000
    rec("Completion PDF generated (real bytes)", pdf_ok,
        str(os.path.getsize(pdf_path)) + " bytes" if pdf_ok else "missing/small")
    if pdf_ok:
        pdf_txt = subprocess.run(["pdftotext", pdf_path, "-"], capture_output=True, text=True).stdout
        low = pdf_txt.lower()
        rec("PDF text: title, summary, materials, signature + photo headings",
            "Job Completion Report" in pdf_txt and "Completion evidence check" in pdf_txt
            and "new ignitor" in low and "flame sensor" in low
            and "Signed by: Completion Client" in pdf_txt
            and "Assessment photos" in pdf_txt and "BEFORE photos" in pdf_txt
            and "AFTER photos" in pdf_txt, pdf_txt[:200].replace("\n", " "))
        rec("PDF has NO owner personal phone, shows company email",
            "435" not in pdf_txt and "680-6873" not in pdf_txt
            and "angrypandahvac@gmail.com" in pdf_txt)
        imgs = subprocess.run(["pdfimages", "-list", pdf_path], capture_output=True, text=True).stdout
        img_rows = [ln for ln in imgs.splitlines() if " image " in ln]
        rec("PDF embeds images (logo + signature + 3 photos >= 5)",
            len(img_rows) >= 5, str(len(img_rows)) + " image rows")

    # ---------- re-send keeps the original completion date ----------
    first_completed = st["completedAt"] if st else ""
    rec("Done job offers Re-send while email is not 'sent'",
        page.locator("#resendCompletionBtn").count() == 1)
    page.click("#resendCompletionBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    rec("Re-send uses the confirmation panel too",
        "Re-send the completion PDF?" in page.inner_text("#completeConfirm"))
    page.click("#completeConfirmBtn")
    # Poll in Python: Playwright's wait_for_function does not reliably
    # await an async predicate here, and the re-send flow (PDF rebuild +
    # document record + completion call) takes a couple of seconds.
    st2 = None
    for _ in range(40):
        page.wait_for_timeout(500)
        st2 = job_state(page, "Completion evidence check")
        if st2 and len(st2["log"]) >= 2:
            break
    rec("Re-send logged, original completion date preserved",
        st2 and len(st2["log"]) == 2 and st2["completedAt"] == first_completed
        and len([d for d in st2["documents"] if d.get("kind") == "completion-pdf"]) == 2,
        ("log=%s docs=%s kinds=%s completed=%s" % (
            len(st2["log"]), len(st2["documents"]),
            [d.get("kind") for d in st2["documents"]], st2["completedAt"])) if st2 else "missing")

    # ---------- portal reflects Done (no fake completion download) ----------
    mob.bring_to_front(); mob.reload(); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal shows Done + completion date + summary, no completion download",
        "Done" in txt and "Completed on" in txt and "new ignitor" in txt.lower()
        and "Download completion report" not in txt
        and mob.locator("text=Download completion").count() == 0)
    rec("Portal still hides the owner's personal phone",
        "435" not in txt and "680-6873" not in mob.content())

    # ---------- blocked: no recipient email (and zero photos warning) ----------
    page.bring_to_front()
    page.evaluate("""async () => {
      const c = await PandaData.saveClient({name:'No Email Completion', phone:'', email:'x@x.co', address:'', equipment:'', notes:''});
      c.email = ''; await PandaData.saveClient(c);
      const j = PandaData.newJob(c.id);
      j.title = 'Blocked completion check'; j.status = 'signed'; j.signedVersion = 1;
      j.items = [{desc:'Service', qty:1, price:100, optional:false, accepted:true}];
      j.signatures = [{version:1, name:'No Email Completion', signatureDataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', signedAt:new Date().toISOString()}];
      await PandaData.saveJob(j);
    }""")
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Blocked completion check")')
    page.wait_for_selector("#completeJobBtn", timeout=8000)
    page.click("#completeJobBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    panel = page.inner_text("#completeConfirm")
    rec("No recipient: send blocked with a clear pointer to the email field",
        "No valid recipient email" in panel and "Send to email" in panel
        and page.is_disabled("#completeConfirmBtn"), panel[:250].replace("\n", " "))
    rec("Zero photos: clear warning shown (not a hard block on opening)",
        "No photos uploaded" in panel)
    st3 = job_state(page, "Blocked completion check")
    rec("Blocked job stays signed, no completion recorded",
        st3 and st3["status"] == "signed" and st3["completedAt"] == "")

    rec("No JS console/page errors during the completion run", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-complete.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
