#!/usr/bin/env python3
"""Panda Jobs — evidence-PDF size guarantee (demo mode).

Bug being locked down (2026-11-03): in production the evidence send
failed 3x with the mail worker's "The evidence PDF is too large to
email" even for an ordinary job (a stale cached pdf.js is the prime
suspect — its profile ladder stopped too early). The fix hardens
pdf.js completionBase64: two smaller photo profiles (620/0.5,
500/0.45), one emergency pass (420/0.4), and an overBudget flag when
even that cannot fit. app.js refuses to send an over-budget build.

This suite calls PandaPDF.completionBase64 directly with the worst
realistic input — TEN full-sensor-noise photos (1600x1200 random
pixel noise, which JPEG can barely compress) split across the three
evidence groups — and asserts:
  * base64 length <= 2,750,000 (the mail budget)
  * overBudget is falsy (the emergency/small profiles actually fit)
  * all 10 photos were embedded (none silently dropped)

Run:  ~/workspace/venvs/playwright-test/bin/python tests/verify_pdf_budget.py
Server must be running in DEMO mode on :8765 (placeholder config.js).
Writes tests/results-pdf-budget.json.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []
console_errors = []

def rec(name, ok, detail=""):
    results.append({"test": name, "pass": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail)[:220] if detail else ""))

BUILD_JS = r"""async () => {
  function noiseDataUrl(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (Math.random() * 256) | 0;
      d[i + 1] = (Math.random() * 256) | 0;
      d[i + 2] = (Math.random() * 256) | 0;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.95);
  }
  const groups = { assessment: [], before: [], after: [] };
  const kinds = ['assessment', 'before', 'after'];
  let totalSrc = 0;
  for (let i = 0; i < 10; i++) {
    const u = noiseDataUrl(1600, 1200);
    totalSrc += u.length;
    groups[kinds[i % 3]].push(u);
  }
  const job = {
    title: 'Noise photo budget check', version: 1, signedVersion: 1,
    completedAt: new Date().toISOString(), paymentStatus: 'pending',
    workNotes: 'Synthetic worst-case evidence load.',
    materials: 'Ten random-noise photos.',
    finalTotal: 100, deposit: 0, terms: '',
    items: [{ desc: 'Service', qty: 1, price: 100, optional: false, accepted: true }],
    signatures: [], photos: groups,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const client = { name: 'Budget Client', address: '1 Noise Way',
                   email: 'budget@example.com', phone: '', equipment: '' };
  const out = await PandaPDF.completionBase64(job, client, {});
  return {
    srcChars: totalSrc,
    b64len: out.base64.length,
    overBudget: out.overBudget === true,
    attempted: out.stats.attemptedPhotoCount,
    embedded: out.stats.embeddedPhotoCount,
    failed: out.stats.failedPhotoCount
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(300000)
    page.set_default_navigation_timeout(120000)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: console_errors.append("console." + m.type + ": " + m.text) if m.type == "error" else None)

    page.goto(BASE + "/#/")
    page.wait_for_load_state("networkidle")
    rec("PandaPDF.completionBase64 is available on the page",
        page.evaluate("typeof PandaPDF !== 'undefined' && typeof PandaPDF.completionBase64 === 'function'"))

    out = page.evaluate(BUILD_JS)
    print("budget result:", json.dumps(out))
    rec("10 worst-case noise photos (source ~%d chars) produce base64 <= 2,750,000"
        % out["srcChars"],
        out["b64len"] <= 2750000, "base64=%d" % out["b64len"])
    rec("overBudget is falsy (small/emergency profiles actually fit)",
        out["overBudget"] is False, "overBudget=%r" % out["overBudget"])
    rec("All 10 photos attempted and embedded, none dropped",
        out["attempted"] == 10 and out["embedded"] == 10 and out["failed"] == 0,
        json.dumps({k: out[k] for k in ("attempted", "embedded", "failed")}))

    rec("No JS console/page errors during the budget run", len(console_errors) == 0,
        "; ".join(console_errors[:4]))
    browser.close()

with open(os.path.join(ROOT, "tests", "results-pdf-budget.json"), "w") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, indent=2)
failed = [r for r in results if not r["pass"]]
print(f"\n==== {len(results) - len(failed)}/{len(results)} passed ====")
sys.exit(1 if failed else 0)
