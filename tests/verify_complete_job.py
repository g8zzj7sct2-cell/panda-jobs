#!/usr/bin/env python3
"""Panda Jobs — completion / evidence verification (demo mode).

Rewritten for Rigo's 2026-11-02 stage flow (the old one-page "Complete
job" button is gone). Verified end to end in a real browser:
  quote -> client signs in the portal -> owner opens the SIGNED view
  (ONLY the Schedule card) -> saves the appointment + amount paid ->
  the appointment email advances the job to SCHEDULED by itself ->
  SCHEDULED shows ONLY the money (total / paid / balance) + Start job
  -> Start job lands on IN PROGRESS (invoice + evidence only) ->
  photos + UNSAVED work details -> Finish work generates the evidence
  PDF -> Send evidence opens the confirmation (counts + recipient) ->
  Cancel changes nothing -> Confirm persists the form, records the
  completion-pdf document WITH the exact PDF bytes, emails it
  (simulated + demo-labelled) and the job lands on DONE by itself ->
  DONE shows ONLY contract + evidence PDF + invoice -> the stored
  evidence PDF is downloaded and content-checked (title, summary,
  materials, signature, photo headings, embedded images, no owner
  phone) -> photos are STILL stored (never auto-deleted) -> Re-send
  keeps the original completion date -> the portal shows Done -> a job
  with no recipient email is blocked with a clear message.

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
        startedAt: j.startedAt || '', finishedAt: j.finishedAt || '',
        amountPaid: j.amountPaid || 0,
        completionEmailStatus: j.completionEmailStatus || '',
        log: j.completionEmailLog || [], documents: j.documents || [],
        photos: { assessment: (j.photos.assessment||[]).length,
                  before: (j.photos.before||[]).length,
                  after: (j.photos.after||[]).length },
        workNotes: j.workNotes || '', materials: j.materials || '',
        finalTotal: j.finalTotal, paymentStatus: j.paymentStatus,
        sendLog: j.sendLog || []
      };
    }""", title)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
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
    rec("Draft job: no evidence/completion buttons in the quote stage",
        page.locator("#sendEvidenceBtn").count() == 0
        and page.locator("#finishWorkBtn").count() == 0
        and page.locator("#startJobBtn").count() == 0)
    page.click("#addItem"); page.wait_for_selector('[data-qrow="0"]')
    page.fill('[data-qrow="0"] [data-f="desc"]', "Furnace ignitor replacement (parts & labor)")
    page.fill('[data-qrow="0"] [data-f="price"]', "350")
    page.click("#saveQuote")
    page.wait_for_timeout(1600)
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
    rec("Client signed in the portal", "✓ Signed" in body(mob))

    # ---------- SIGNED view: ONLY the Schedule card ----------
    page.bring_to_front()
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Completion evidence check")')
    page.wait_for_selector("#saveScheduleBtn", timeout=8000)
    txt = body(page)
    rec("Signed view: Schedule card only (no title edit, no signatures card, no photos, no send card)",
        page.locator("#jd_sched").count() == 1
        and page.locator("#jd_title").count() == 0
        and page.locator("#sendSms").count() == 0
        and "Signatures & documents" not in txt
        and page.locator("[data-photo-input]").count() == 0
        and page.locator("#sendEvidenceBtn").count() == 0, txt[:200].replace("\n", " "))

    # ---------- save schedule -> auto-advance to SCHEDULED ----------
    page.fill("#jd_paid", "100")
    page.fill("#jd_sched", "2026-11-06T09:00")
    page.click("#saveScheduleBtn")
    page.wait_for_selector("#startJobBtn", timeout=10000)
    st = job_state(page, "Completion evidence check")
    rec("Appointment email sent -> job advanced signed -> scheduled by itself",
        st and st["status"] == "scheduled"
        and any(e.get("kind") == "schedule" for e in st["sendLog"])
        and st["amountPaid"] == 100, json.dumps(st)[:250] if st else "missing")

    # ---------- SCHEDULED view: ONLY the money + Start job ----------
    txt = body(page)
    rec("Scheduled view: money summary only (total / paid / balance) + Start job",
        "Payment summary" in txt and "$350.00" in txt and "$100.00" in txt and "$250.00" in txt
        and page.locator("#startJobBtn").count() == 1
        and page.locator("#jd_sched").count() == 0
        and page.locator("[data-photo-input]").count() == 0
        and "Invoice" not in txt, txt[:250].replace("\n", " "))
    page.click("#startJobBtn")
    page.wait_for_selector("#sendEvidenceBtn", timeout=8000)

    # ---------- IN PROGRESS view: invoice + evidence only ----------
    st = job_state(page, "Completion evidence check")
    txt = body(page)
    rec("Start job -> In progress; start time recorded; invoice + evidence sections only",
        st and st["status"] == "in_progress" and bool(st["startedAt"])
        and "Invoice" in txt and "Evidence" in txt and "$350.00" in txt
        and "Work started" in txt
        and page.locator("#finishWorkBtn").count() == 1
        and page.locator("#sendEvidenceBtn").count() == 1
        and "Signatures & documents" not in txt, json.dumps(st)[:200] if st else "missing")

    # ---------- photos + UNSAVED execution details ----------
    page.set_input_files('[data-photo-input="assessment"]', os.path.join(ROOT, "tests", "before.jpg"))
    page.wait_for_selector('img[alt="assessment photo"]', timeout=10000)
    page.set_input_files('[data-photo-input="before"]', os.path.join(ROOT, "tests", "before.jpg"))
    page.wait_for_selector('img[alt="before photo"]', timeout=10000)
    page.set_input_files('[data-photo-input="after"]', os.path.join(ROOT, "tests", "after.jpg"))
    page.wait_for_selector('img[alt="after photo"]', timeout=10000)
    # Deliberately NOT saved anywhere: the send flow must persist what
    # is currently typed in the form.
    page.fill("#jd_notes", SUMMARY)
    page.fill("#jd_materials", MATERIALS)
    page.fill("#jd_final", "425")
    page.select_option("#jd_pay", "paid")
    page.fill("#sendEmailTo", RECIPIENT)  # per-job recipient override

    # ---------- Finish work generates the evidence PDF ----------
    page.click("#finishWorkBtn")
    page.wait_for_selector("#finishMsg .notice.ok", timeout=30000)
    fin = page.inner_text("#finishMsg")
    st = job_state(page, "Completion evidence check")
    rec("Finish work: finish time recorded, PDF generated with 3 of 3 photos, job still In progress",
        "3 of 3 photos" in fin and st and bool(st["finishedAt"])
        and st["status"] == "in_progress", fin[:200].replace("\n", " "))

    # ---------- confirmation: content + Cancel ----------
    page.click("#sendEvidenceBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    panel = page.inner_text("#completeConfirm")
    rec("Confirmation summarises the evidence + recipient",
        "Send the evidence and finish the job?" in panel
        and "Assessment photos: 1" in panel and "BEFORE photos: 1" in panel
        and "AFTER photos: 1" in panel
        and "Work summary: included" in panel and "Materials: included" in panel
        and RECIPIENT in panel, panel[:300].replace("\n", " "))
    page.screenshot(path=os.path.join(SHOTS, "18-complete-confirm.png"), full_page=True)
    page.click("#completeCancel")
    page.wait_for_selector("#completeConfirm", state="hidden", timeout=5000)
    st = job_state(page, "Completion evidence check")
    rec("Cancel leaves status + completion metadata untouched",
        st and st["status"] == "in_progress" and st["completedAt"] == ""
        and not [d for d in st["documents"] if d.get("kind") == "completion-pdf"],
        json.dumps(st)[:200] if st else "job missing")

    # ---------- confirmation: Confirm sends + job lands on DONE ----------
    page.click("#sendEvidenceBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    page.click("#completeConfirmBtn")
    page.wait_for_selector("#completionState", timeout=30000)
    txt = body(page)
    rec("After confirm: Done view, completion date + demo email status shown",
        "Job completed" in txt and "Completion evidence email:" in txt
        and "demo — not sent" in txt
        and "Job completed (demo)" in txt, txt[:200].replace("\n", " "))
    rec("Send buttons replaced by the Done stage view",
        page.locator("#sendEvidenceBtn").count() == 0
        and page.locator("#completionState").count() == 1)
    st = job_state(page, "Completion evidence check")
    comp_docs = [d for d in (st["documents"] if st else []) if d.get("kind") == "completion-pdf"]
    rec("Job persisted as Done with completion metadata + demo email log",
        st and st["status"] == "done" and bool(st["completedAt"])
        and st["completionEmailStatus"] == "demo — not sent"
        and len(st["log"]) == 1 and st["log"][0].get("to") == RECIPIENT
        and st["log"][0].get("status") == "demo — not sent", json.dumps(st)[:300] if st else "missing")
    rec("Unsaved execution form was persisted by the send flow",
        st and st["workNotes"] == SUMMARY and st["materials"] == MATERIALS
        and st["finalTotal"] == 425 and st["paymentStatus"] == "paid")
    rec("Evidence document recorded WITH the exact PDF bytes + photo stats",
        len(comp_docs) == 1
        and (comp_docs[0].get("pdfDataUrl") or "").startswith("data:application/pdf;base64,")
        and (comp_docs[0].get("photoCounts") or {}).get("assessment") == 1
        and (comp_docs[0].get("photoCounts") or {}).get("before") == 1
        and (comp_docs[0].get("photoCounts") or {}).get("after") == 1
        and comp_docs[0].get("embeddedPhotoCount") == 3
        and comp_docs[0].get("failedPhotoCount") == 0,
        json.dumps({k: (v[:40] + "…" if isinstance(v, str) and len(v) > 40 else v) for k, v in comp_docs[0].items()})[:300] if comp_docs else "no completion doc")
    rec("Photos are STILL stored after Done (never auto-deleted)",
        st and st["photos"] == {"assessment": 1, "before": 1, "after": 1},
        json.dumps(st["photos"]) if st else "missing")

    # ---------- DONE view: ONLY contract + evidence PDF + invoice ----------
    txt = body(page)
    rec("Done view: contract + evidence PDF + invoice only",
        "Contract" in txt and "Signed by" in txt and "Completion Client" in txt
        and "Evidence PDF" in txt and "Invoice" in txt and "$425.00" in txt
        and page.locator("#jd_title").count() == 0
        and page.locator("[data-photo-input]").count() == 0
        and "Signatures & documents" not in txt
        and page.locator("#docPdf").count() == 1
        and page.locator("#downloadCompletionPdf").count() == 1, txt[:250].replace("\n", " "))
    page.screenshot(path=os.path.join(SHOTS, "19-complete-done.png"), full_page=True)

    # ---------- the stored evidence PDF (Download button) ----------
    pdf_path = os.path.join(ROOT, "tests", "completion.pdf")
    if os.path.exists(pdf_path):
        os.remove(pdf_path)
    with page.expect_download(timeout=30000) as dl_info:
        page.click("#downloadCompletionPdf")
    dl_info.value.save_as(pdf_path)
    pdf_ok = os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 10000
    rec("Evidence PDF downloads (real bytes, the exact file that was emailed)", pdf_ok,
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
        "Re-send the evidence email?" in page.inner_text("#completeConfirm"))
    page.click("#completeConfirmBtn")
    st2 = None
    for _ in range(40):
        page.wait_for_timeout(500)
        st2 = job_state(page, "Completion evidence check")
        if st2 and len(st2["log"]) >= 2:
            break
    rec("Re-send logged, original completion date preserved",
        st2 and len(st2["log"]) == 2 and st2["completedAt"] == first_completed
        and len([d for d in st2["documents"] if d.get("kind") == "completion-pdf"]) == 2,
        ("log=%s docs=%s completed=%s" % (
            len(st2["log"]), len(st2["documents"]), st2["completedAt"])) if st2 else "missing")

    # ---------- portal reflects Done ----------
    mob.bring_to_front(); mob.reload(); mob.wait_for_load_state("networkidle")
    txt = body(mob)
    rec("Portal shows Done + completion date + summary",
        "Done" in txt and "Completed on" in txt and "new ignitor" in txt.lower())
    rec("Portal still hides the owner's personal phone",
        "435" not in txt and "680-6873" not in mob.content())

    # ---------- blocked: no recipient email (and zero photos warning) ----------
    page.bring_to_front()
    page.evaluate("""async () => {
      const c = await PandaData.saveClient({name:'No Email Completion', phone:'', email:'x@x.co', address:'', equipment:'', notes:''});
      c.email = ''; await PandaData.saveClient(c);
      const j = PandaData.newJob(c.id);
      j.title = 'Blocked completion check'; j.status = 'in_progress'; j.signedVersion = 1;
      j.items = [{desc:'Service', qty:1, price:100, optional:false, accepted:true}];
      j.signatures = [{version:1, name:'No Email Completion', signatureDataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', signedAt:new Date().toISOString()}];
      await PandaData.saveJob(j);
    }""")
    page.reload(); page.wait_for_load_state("networkidle")
    page.click('[data-open-job]:has-text("Blocked completion check")')
    page.wait_for_selector("#sendEvidenceBtn", timeout=8000)
    page.click("#sendEvidenceBtn")
    page.wait_for_selector("#completeConfirm", state="visible", timeout=5000)
    panel = page.inner_text("#completeConfirm")
    rec("No recipient: send blocked with a clear pointer to the email field",
        "No valid recipient email" in panel
        and page.is_disabled("#completeConfirmBtn"), panel[:250].replace("\n", " "))
    rec("Zero photos: clear warning shown (not a hard block on opening)",
        "No photos uploaded" in panel)
    st3 = job_state(page, "Blocked completion check")
    rec("Blocked job stays In progress, no completion recorded",
        st3 and st3["status"] == "in_progress" and st3["completedAt"] == "")

    rec("No JS console/page errors during the completion run", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-complete.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
