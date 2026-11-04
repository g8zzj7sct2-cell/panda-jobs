#!/usr/bin/env python3
"""Panda Jobs — Legal Pack views (2026-11-03), demo mode.

The Privacy Policy and Terms of Service live INSIDE the app as public
hash routes (#/privacy, #/terms) — no login — because the client arrives
through a token link and must be able to read them BEFORE signing.

Covers:
  A) Direct landing on #/privacy and #/terms with NO session: each view
     renders its title and the app's own contact email
     (angrypandahvac@gmail.com); the Terms carry the figures the signed
     agreement already promises (15-day quote validity, 12-month labor
     warranty — aligned with defaultTerms() in data.js).
  B) Client portal (unsigned job): the footer shows the Privacy Policy /
     Terms of Service links, and the note next to the signature area
     ("Before you sign, please read our Privacy Policy and Terms of
     Service") renders ABOVE the Sign button. Following the footer
     Privacy link renders the policy; Back returns to the portal.
  C) Owner panel footer shows the same two links after demo login.

Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_legal.py
Server must be running in DEMO mode on :8765 (placeholder-config copy).
Writes tests/results-legal.json and screenshot 26.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
results = []
console_errors = []

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:220] if detail else ""))

def body(page):
    return page.inner_text("body")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: console_errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    # ---------- A) public legal views, no session at all ----------
    page.goto(BASE + "/#/privacy")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".card.legal h2", timeout=5000)
    txt = body(page)
    rec("Privacy view renders without login, with title and contact email",
        "Privacy Policy" in txt and "angrypandahvac@gmail.com" in txt
        and "What we collect" in txt and "never sell" in txt,
        txt[:200].replace("\n", " "))

    page.goto(BASE + "/#/terms")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".card.legal h2", timeout=5000)
    txt = body(page)
    rec("Terms view renders without login, with title and contact email",
        "Terms of Service" in txt and "angrypandahvac@gmail.com" in txt,
        txt[:200].replace("\n", " "))
    rec("Terms figures match the signed agreement (15 days / 12 months)",
        "valid for 15 days" in txt and "warranted for 12 months" in txt
        and "due upon completion" in txt, "")

    # ---------- seed an unsigned job (owner session), then drop auth ----------
    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    page.reload(); page.wait_for_load_state("networkidle")
    page.fill("#pw", "panda2026")
    page.click("#loginBtn")
    page.wait_for_selector('button[data-tab="clients"]', timeout=5000)
    token = page.evaluate("""async () => {
      await PandaData.saveClient({name:'Legal Check Client', phone:'(312) 555-0111', email:'legal.check@example.com', address:'10 W Legal Ave, Chicago, IL', equipment:'', notes:''});
      const cs = await PandaData.listClients();
      const c = cs.find(x => x.name === 'Legal Check Client');
      const j = PandaData.newJob(c.id);
      j.title = 'Legal check job';
      j.items = [{desc:'Service call', qty:1, price:200, optional:false, accepted:true}];
      await PandaData.saveJob(j);
      return j.token;
    }""")
    rec("Seeded an unsigned job for the portal check", bool(token), token or "no token")

    # ---------- C) owner footer carries the links ----------
    txt = body(page)
    rec("Owner panel footer shows Privacy Policy and Terms of Service links",
        page.locator('footer.app-foot a[href="#/privacy"]').count() >= 1
        and page.locator('footer.app-foot a[href="#/terms"]').count() >= 1, "")

    # ---------- B) client portal: footer + signature-area note ----------
    page.evaluate("sessionStorage.clear();")  # portal must work with NO owner session
    page.goto(BASE + "/#/c/" + token)
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#sigPad", timeout=5000)
    rec("Portal footer shows Privacy Policy and Terms of Service links",
        page.locator('footer.app-foot a[href="#/privacy"]').is_visible()
        and page.locator('footer.app-foot a[href="#/terms"]').is_visible(), "")
    note = page.locator(".legal-note")
    rec("Signature area shows the read-before-signing note with both links",
        note.count() >= 1 and note.first.is_visible()
        and note.first.locator('a[href="#/privacy"]').count() == 1
        and note.first.locator('a[href="#/terms"]').count() == 1
        and "Before you sign" in note.first.inner_text(), "")
    order = page.evaluate("""() => {
      const n = document.querySelector('.legal-note');
      const b = document.getElementById('signBtn');
      if (!n || !b) return null;
      return n.getBoundingClientRect().bottom <= b.getBoundingClientRect().top;
    }""")
    rec("The note renders ABOVE the Sign & accept button", order is True, json.dumps(order))
    page.screenshot(path=os.path.join(SHOTS, "26-legal-portal.png"), full_page=True)

    # ---------- follow the footer link and come Back ----------
    page.click('footer.app-foot a[href="#/privacy"]')
    page.wait_for_selector(".card.legal h2", timeout=5000)
    rec("Footer Privacy link from the portal opens the policy view",
        "Privacy Policy" in body(page) and page.url.endswith("#/privacy"), page.url)
    page.click("#legalBack")
    page.wait_for_selector("#sigPad", timeout=5000)
    rec("Back from the policy returns to the client portal",
        page.url.endswith("#/c/" + token), page.url)

    rec("No JS console/page errors during the legal run", len(console_errors) == 0, "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-legal.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
