/* Panda Jobs — signed contract PDF generation (Plan Task 7).
 * Uses the vendored jsPDF UMD build (assets/jspdf.umd.min.js) — no CDN.
 * The PDF contains: logo, company block, client block, quote items (accepted
 * optionals marked), totals + deposit, terms, and — once signed — the
 * signature image, printed name and signing date/time.
 * Internal competitor reference data is NEVER rendered here.
 */
(function () {
  "use strict";
  var COMPANY = {
    name: "Angry Panda Heating and Cooling",
    phone: "(435) 680-6873",
    email: "angrypandahvac@gmail.com",
    city: "Chicago, IL",
    services: "Heating • Air Conditioning • Water Heaters",
    cert: "EPA Section 608 Universal Certified",
    owner: "Rigoberto Hernández, Owner • HVAC Tech"
  };

  function money(n) {
    return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function totals(job) {
    var required = 0;
    (job.items || []).forEach(function (it) { if (!it.optional) required += it.qty * it.price; });
    return { required: required, total: jobTotal(job) };
  }
  function jobTotal(job) {
    var t = 0;
    (job.items || []).forEach(function (it) {
      if (!it.optional || it.accepted) t += it.qty * it.price;
    });
    return t;
  }

  async function logoDataUrl() {
    try {
      var res = await fetch("assets/logo.png");
      var blob = await res.blob();
      return await new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    } catch (e) { return null; }
  }

  async function buildPdf(job, client, opts) {
    opts = opts || {};
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF not loaded");
    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
    var W = doc.internal.pageSize.getWidth();
    var M = 48, y = 48, maxW = W - M * 2;
    function ensure(space) { if (y + space > 730) { doc.addPage(); y = 48; } }
    function text(str, size, style, gap) {
      doc.setFont("helvetica", style || "normal"); doc.setFontSize(size || 11);
      var lines = doc.splitTextToSize(String(str == null ? "" : str), maxW);
      lines.forEach(function (ln) { ensure(16); doc.text(ln, M, y); y += (size || 11) * 1.35; });
      y += gap || 4;
    }
    function rule() { doc.setDrawColor(180); doc.line(M, y, W - M, y); y += 12; }

    /* Header */
    var logo = await logoDataUrl();
    if (logo) { try { doc.addImage(logo, "PNG", M, y - 8, 54, 54); } catch (e) {} }
    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(20, 83, 45);
    doc.text(COMPANY.name, M + 66, y + 12);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(60);
    doc.text(COMPANY.services, M + 66, y + 27);
    doc.text(COMPANY.phone + "  •  " + COMPANY.email + "  •  " + COMPANY.city, M + 66, y + 41);
    doc.setTextColor(0); y += 66; rule();

    var version = opts.version || job.version;
    var sig = null;
    (job.signatures || []).forEach(function (s) { if (s.version === version) sig = s; });
    text((sig ? "Signed Service Agreement" : "Service Quote") + " — v" + version, 14, "bold", 2);
    if (job.title) text(job.title, 12, "bold", 2);
    text("Date: " + new Date(job.updatedAt || job.createdAt || Date.now()).toLocaleDateString("en-US"), 10.5, "normal", 8);

    /* Client */
    text("CLIENT", 10, "bold", 1);
    if (client) {
      text(client.name, 11.5, "bold", 0);
      if (client.address) text(client.address, 11, "normal", 0);
      text([client.phone, client.email].filter(Boolean).join("  •  "), 11, "normal", 0);
      if (client.equipment) text("Equipment: " + client.equipment, 10.5, "normal", 0);
    }
    y += 6; rule();

    /* Items */
    text("QUOTE DETAILS", 10, "bold", 2);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(90);
    doc.text("Description", M, y); doc.text("Qty", W - M - 130, y); doc.text("Amount", W - M - 62, y);
    doc.setTextColor(0); y += 6; rule();
    (job.items || []).forEach(function (it) {
      var label = it.desc + (it.optional ? (it.accepted ? "  (optional — accepted)" : "  (optional — NOT included)") : "");
      doc.setFont("helvetica", "normal"); doc.setFontSize(10.5);
      var lines = doc.splitTextToSize(label, maxW - 150);
      lines.forEach(function (ln) { ensure(15); doc.text(ln, M, y); y += 14; });
      if (!it.optional || it.accepted) {
        doc.text(String(it.qty), W - M - 122, y - 14);
        doc.text(money(it.qty * it.price), W - M - 62, y - 14);
      }
      y += 2;
    });
    rule();
    var t = totals(job); var tot = job.finalTotal != null ? job.finalTotal : t.total;
    doc.setFont("helvetica", "bold"); doc.setFontSize(12);
    ensure(20); doc.text("Total: " + money(tot), M, y); y += 17;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5);
    if (job.deposit) { ensure(15); doc.text("Deposit due at signing: " + money(job.deposit) + "   •   Balance due on completion: " + money(tot - job.deposit), M, y); y += 16; }
    if (job.finalTotal != null) { ensure(15); doc.text("Final total confirmed in writing before work began.", M, y); y += 16; }
    y += 6; rule();

    /* Work summary (completed jobs) */
    if (job.workNotes || job.materials) {
      text("WORK COMPLETED", 10, "bold", 2);
      if (job.workNotes) text(job.workNotes, 10.5, "normal", 2);
      if (job.materials) text("Materials used: " + job.materials, 10.5, "normal", 2);
      y += 4; rule();
    }

    /* Terms */
    text("TERMS & CONDITIONS", 10, "bold", 2);
    text(job.terms || "", 9.5, "normal", 6);
    rule();

    /* Signature */
    if (sig) {
      text("CLIENT ACCEPTANCE", 10, "bold", 2);
      ensure(95);
      try { doc.addImage(sig.signatureDataUrl, "PNG", M, y, 200, 60); } catch (e) {}
      doc.setDrawColor(120); doc.line(M, y + 62, M + 210, y + 62);
      y += 78;
      text("Signed by: " + sig.name, 11, "bold", 0);
      text("Date/time: " + new Date(sig.signedAt).toLocaleString("en-US"), 10.5, "normal", 0);
      text("This signed copy was delivered to the client's email automatically.", 9.5, "normal", 6);
    } else {
      text("Client signature: ______________________________    Date: ____________", 11, "normal", 6);
    }

    /* Footer */
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
    doc.text(COMPANY.name + " • " + COMPANY.owner + " • " + COMPANY.cert, M, 758);
    doc.text(COMPANY.phone + " • " + COMPANY.email + " • " + COMPANY.city, M, 770);
    doc.setTextColor(0);
    return doc;
  }

  async function downloadPdf(job, client, opts) {
    var doc = await buildPdf(job, client, opts);
    doc.save(opts && opts.filename ? opts.filename : "angry-panda-agreement.pdf");
    return doc;
  }
  async function pdfDataUrl(job, client, opts) {
    var doc = await buildPdf(job, client, opts);
    return doc.output("datauristring");
  }
  async function pdfBase64(job, client, opts) {
    var doc = await buildPdf(job, client, opts);
    return doc.output("datauristring").split(",")[1];
  }

  window.PandaPDF = { build: buildPdf, download: downloadPdf, dataUrl: pdfDataUrl, base64: pdfBase64, totals: totals, total: jobTotal, money: money, COMPANY: COMPANY };
})();
