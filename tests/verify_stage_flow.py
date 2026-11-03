#!/usr/bin/env python3
"""Panda Jobs — stage-flow extras (ronda 2026-11-02), demo mode.

Covers the pieces of Rigo's 2026-11-02 round that verify_complete_job.py
does not:
  B) New Job client SEARCH — filters the client list by name, phone
     digits, email and address; a no-match search says so; creating a
     job uses the client the search selected.
  C) Signed view purity on a seeded signed job (Schedule only).
  C) "Start work" (Inicio de trabajo) on a job that lands on In
     progress without a start stamp: button present -> click stamps
     startedAt and the button is replaced by the started line.
  D) Photo purge: a Done job keeps its photos until the owner presses
     "Confirm receipt & delete photos" AND accepts the confirm dialog;
     dismissing the dialog deletes nothing; after the purge the photos
     are gone, the purge is date-stamped, and the evidence PDF stays.

Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_stage_flow.py
Server must be running in DEMO mode on :8765 (placeholder-config copy).
Writes tests/results-stage.json and screenshots 20/21.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
results = []
console_errors = []
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:220] if detail else ""))

def body(page):
    return page.inner_text("body")

def visible_options(page):
    return page.evaluate("""() => {
      const sel = document.getElementById('nj_client');
      return { visible: Array.from(sel.options).filter(o => !o.hidden).map(o => o.textContent),
               value: sel.value };
    }""")

def job_by_title(page, title):
    return page.evaluate("""async (title) => {
      const jobs = await PandaData.listJobs();
      const j = jobs.find(x => x.title === title);
      if (!j) return null;
      return { status: j.status, startedAt: j.startedAt || '', photosDeletedAt: j.photosDeletedAt || '',
               photos: { assessment: (j.photos.assessment||[]).length, before: (j.photos.before||[]).length,
                         after: (j.photos.after||[]).length } };
    }""", title)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: console_errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)
    dialog_mode = {"accept": True}
    page.on("dialog", lambda d: d.accept() if dialog_mode["accept"] else d.dismiss())

    # ---------- clean start + login + seed clients ----------
    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.reload(); page.wait_for_load_state("networkidle")
    page.fill("#pw", "panda2026")
    page.click("#loginBtn")
    page.wait_for_selector('button[data-tab="clients"]', timeout=5000)
    page.evaluate("""async () => {
      await PandaData.saveClient({name:'Maria Fernanda Lopez', phone:'(312) 555-0147', email:'maria.lopez@example.com', address:'742 W Fulton St, Chicago, IL', equipment:'', notes:''});
      await PandaData.saveClient({name:'John Smith', phone:'(773) 555-0199', email:'john.smith@example.com', address:'1200 S State St, Chicago, IL', equipment:'', notes:''});
      await PandaData.saveClient({name:'Aiko Tanaka', phone:'(312) 555-0173', email:'aiko.t@example.com', address:'88 W Completion Ave, Chicago, IL', equipment:'', notes:''});
    }""")
    page.reload(); page.wait_for_load_state("networkidle")

    # ---------- B) New Job client search ----------
    page.click('button[data-tab="new"]')
    page.wait_for_selector("#nj_search", timeout=5000)
    rec("New job screen has the client search field", page.locator("#nj_client").count() == 1)
    page.fill("#nj_search", "Tanaka")
    page.wait_for_timeout(300)
    v = visible_options(page)
    rec("Search by NAME filters to the one client and selects her",
        len(v["visible"]) == 1 and "Aiko Tanaka" in v["visible"][0], json.dumps(v))
    page.fill("#nj_search", "5550199")
    page.wait_for_timeout(300)
    v = visible_options(page)
    rec("Search by PHONE digits filters to John Smith",
        len(v["visible"]) == 1 and "John Smith" in v["visible"][0], json.dumps(v))
    page.fill("#nj_search", "maria.lopez@")
    page.wait_for_timeout(300)
    v = visible_options(page)
    rec("Search by EMAIL filters to Maria Fernanda Lopez",
        len(v["visible"]) == 1 and "Maria Fernanda Lopez" in v["visible"][0], json.dumps(v))
    page.fill("#nj_search", "Fulton")
    page.wait_for_timeout(300)
    v = visible_options(page)
    rec("Search by ADDRESS filters to the Fulton St client",
        len(v["visible"]) == 1 and "Maria Fernanda Lopez" in v["visible"][0], json.dumps(v))
    page.fill("#nj_search", "zzzqqq-nobody")
    page.wait_for_timeout(300)
    v = visible_options(page)
    rec("No-match search hides every option and says so",
        len(v["visible"]) == 0 and page.locator("#nj_noMatch").is_visible(), json.dumps(v))
    page.fill("#nj_search", "Tanaka")
    page.wait_for_timeout(300)
    page.fill("#nj_title", "Search flow check")
    page.click("#nj_create")
    page.wait_for_selector("#addItem", timeout=5000)
    rec("Create job uses the client the search selected",
        "Aiko Tanaka" in body(page), body(page)[:200].replace("\n", " "))
    page.screenshot(path=os.path.join(SHOTS, "20-newjob-search.png"), full_page=True)

    # ---------- C) seeded jobs for the stage checks ----------
    page.evaluate("""async (png) => {
      const cs = await PandaData.listClients();
      const c = cs.find(x => x.name === 'John Smith');
      const mk = (title, status) => {
        const j = PandaData.newJob(c.id);
        j.title = title; j.status = status; j.signedVersion = 1;
        j.items = [{desc:'Service call', qty:1, price:200, optional:false, accepted:true}];
        j.signatures = [{version:1, name:'John Smith', signatureDataUrl:png, signedAt:new Date().toISOString()}];
        return j;
      };
      await PandaData.saveJob(mk('Seeded signed check', 'signed'));
      const w = mk('Seeded work check', 'in_progress');
      await PandaData.saveJob(w);
      const d = mk('Seeded purge check', 'done');
      d.completedAt = new Date().toISOString();
      d.completionEmailStatus = 'demo — not sent';
      await PandaData.saveJob(d);
      await PandaData.addPhoto(d.id, 'before', png);
      await PandaData.addPhoto(d.id, 'after', png);
      await PandaData.saveDocument(d.id, {version: 1, kind: 'completion-pdf', recipient: 'john.smith@example.com',
        pdfDataUrl: 'data:application/pdf;base64,AAAA', photoCounts: {assessment:0, before:1, after:1},
        embeddedPhotoCount: 2, failedPhotoCount: 0, completedAt: d.completedAt});
    }""", TINY_PNG)
    page.reload(); page.wait_for_load_state("networkidle")

    # ---------- C) signed view purity (seeded) ----------
    page.click('[data-open-job]:has-text("Seeded signed check")')
    page.wait_for_selector("#saveScheduleBtn", timeout=5000)
    txt = body(page)
    rec("Seeded signed job: Schedule card only",
        page.locator("#jd_sched").count() == 1
        and page.locator("#jd_title").count() == 0
        and page.locator("[data-photo-input]").count() == 0
        and "Signatures & documents" not in txt, txt[:200].replace("\n", " "))
    page.click("#backBtn"); page.wait_for_timeout(600)

    # ---------- C) Start work stamps the start ----------
    page.click('[data-open-job]:has-text("Seeded work check")')
    page.wait_for_selector("#startWorkBtn", timeout=5000)
    rec("In progress without a start stamp offers Start work",
        page.locator("#finishWorkBtn").count() == 1 and page.locator("#sendEvidenceBtn").count() == 1)
    page.click("#startWorkBtn")
    page.wait_for_selector("text=Work started", timeout=8000)
    st = job_by_title(page, "Seeded work check")
    rec("Start work stamps startedAt and the button is replaced by the started line",
        st and bool(st["startedAt"]) and page.locator("#startWorkBtn").count() == 0,
        json.dumps(st) if st else "missing")
    page.click("#backBtn"); page.wait_for_timeout(600)

    # ---------- D) photo purge only on explicit confirmation ----------
    page.click('[data-open-job]:has-text("Seeded purge check")')
    page.wait_for_selector("#confirmDeletePhotosBtn", timeout=5000)
    st = job_by_title(page, "Seeded purge check")
    rec("Done job still holds its photos (2) and offers the confirm-delete button",
        st and st["photos"]["before"] == 1 and st["photos"]["after"] == 1
        and "2 photo(s) are still stored" in body(page), json.dumps(st) if st else "missing")
    dialog_mode["accept"] = False
    page.click("#confirmDeletePhotosBtn")
    page.wait_for_timeout(1200)
    st = job_by_title(page, "Seeded purge check")
    rec("DISMISSING the confirm dialog deletes nothing",
        st and st["photos"]["before"] == 1 and st["photosDeletedAt"] == "",
        json.dumps(st) if st else "missing")
    dialog_mode["accept"] = True
    page.click("#confirmDeletePhotosBtn")
    page.wait_for_selector("text=Photos deleted from the app", timeout=8000)
    st = job_by_title(page, "Seeded purge check")
    txt = body(page)
    rec("CONFIRMING deletes the photos, stamps the purge, and the evidence PDF stays",
        st and st["photos"] == {"assessment": 0, "before": 0, "after": 0}
        and bool(st["photosDeletedAt"])
        and page.locator("#confirmDeletePhotosBtn").count() == 0
        and page.locator("#downloadCompletionPdf").count() == 1,
        json.dumps(st) if st else "missing")
    page.screenshot(path=os.path.join(SHOTS, "21-photos-purged.png"), full_page=True)

    rec("No JS console/page errors during the stage-flow run", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-stage.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
