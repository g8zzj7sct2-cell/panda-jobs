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
    doc.text(COMPANY.email + "  •  " + COMPANY.city, M + 66, y + 41);
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
    doc.text(COMPANY.email + " • " + COMPANY.city, M, 770);
    doc.setTextColor(0);
    return doc;
  }

  /* ---------- completion / evidence PDF ----------
   * One report with the agreement details, the signature, the work
   * summary/materials and EVERY uploaded job photo, grouped and
   * captioned Assessment / BEFORE / AFTER. Photos arrive as data URLs
   * (demo) or public storage URLs (live); each is normalised to JPEG
   * through a canvas (which also fixes aspect-ratio metadata). A photo
   * that cannot be loaded/embedded is counted and named in the report —
   * never silently dropped. Returns {doc, stats} so the caller can
   * report exactly how much evidence made it into the PDF. */
  async function imageSourceToJpeg(src) {
    if (!src) throw new Error("Empty photo source");
    var objectUrl = null;
    var url = src;
    if (!/^data:/i.test(src)) {
      var res = await fetch(src);
      if (!res.ok) throw new Error("Photo download failed (" + res.status + ")");
      var blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      url = objectUrl;
    }
    try {
      var img = await new Promise(function (resolve, reject) {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = function () { reject(new Error("Photo could not be loaded")); };
        im.src = url;
      });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error("Photo has no dimensions");
      var maxDim = 1400;
      var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));
      var canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return { dataUrl: canvas.toDataURL("image/jpeg", 0.84), width: w, height: h };
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function buildCompletionPdf(job, client, opts) {
    opts = opts || {};
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("jsPDF not loaded");
    var doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
    var W = doc.internal.pageSize.getWidth();
    var M = 48, y = 48, maxW = W - M * 2;
    var completedAt = opts.completedAt || job.completedAt || new Date().toISOString();
    var groups = [
      { kind: "assessment", heading: "Assessment photos", caption: "Assessment photo" },
      { kind: "before", heading: "BEFORE photos", caption: "BEFORE photo" },
      { kind: "after", heading: "AFTER photos", caption: "AFTER photo" }
    ];
    var counts = {};
    var attempted = 0;
    groups.forEach(function (g) {
      counts[g.kind] = ((job.photos || {})[g.kind] || []).length;
      attempted += counts[g.kind];
    });
    var embedded = 0, failed = 0;
    function ensure(space) { if (y + space > 730) { doc.addPage(); y = 48; } }
    function text(str, size, style, gap) {
      doc.setFont("helvetica", style || "normal"); doc.setFontSize(size || 11);
      var lines = doc.splitTextToSize(String(str == null ? "" : str), maxW);
      lines.forEach(function (ln) { ensure(16); doc.text(ln, M, y); y += (size || 11) * 1.35; });
      y += gap || 4;
    }
    function rule() { doc.setDrawColor(180); doc.line(M, y, W - M, y); y += 12; }

    /* Header — email + city only; no phone anywhere in this report. */
    var logo = await logoDataUrl();
    if (logo) { try { doc.addImage(logo, "PNG", M, y - 8, 54, 54); } catch (e) {} }
    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(20, 83, 45);
    doc.text(COMPANY.name, M + 66, y + 12);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(60);
    doc.text(COMPANY.services, M + 66, y + 27);
    doc.text(COMPANY.email + "  •  " + COMPANY.city, M + 66, y + 41);
    doc.setTextColor(0); y += 66; rule();

    text("Job Completion Report", 16, "bold", 2);
    if (job.title) text(job.title, 12.5, "bold", 2);
    text("Status: Done", 11, "bold", 0);
    text("Completed: " + new Date(completedAt).toLocaleString("en-US"), 11, "normal", 0);
    text("Payment status: " + (job.paymentStatus === "paid" ? "Paid" : "Pending"), 11, "normal", 8);

    text("CLIENT", 10, "bold", 1);
    if (client) {
      text(client.name, 11.5, "bold", 0);
      if (client.address) text(client.address, 11, "normal", 0);
      if (client.email) text(client.email, 11, "normal", 0);
      if (client.equipment) text("Equipment: " + client.equipment, 10.5, "normal", 0);
    }
    y += 6; rule();

    text("WORK PERFORMED", 10, "bold", 2);
    text(job.workNotes ? job.workNotes : "No work summary was provided.", 10.5, "normal", 4);
    text("Materials used: " + (job.materials ? job.materials : "None recorded."), 10.5, "normal", 6);
    rule();

    /* Agreement details (same accepted/declined semantics as the
       signed agreement PDF) */
    text("AGREEMENT DETAILS", 10, "bold", 2);
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
    ensure(20); doc.text("Final total: " + money(tot), M, y); y += 17;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5);
    if (job.deposit) { ensure(15); doc.text("Deposit due at signing: " + money(job.deposit) + "   •   Balance due on completion: " + money(tot - job.deposit), M, y); y += 16; }
    y += 6; rule();

    /* Signature (the one for the currently signed version if present) */
    var sig = null;
    (job.signatures || []).forEach(function (sg) { if (sg.version === job.signedVersion) sig = sg; });
    if (!sig && job.signatures && job.signatures.length) sig = job.signatures[job.signatures.length - 1];
    text("SIGNATURE", 10, "bold", 2);
    if (sig) {
      ensure(95);
      try { doc.addImage(sig.signatureDataUrl, "PNG", M, y, 200, 60); } catch (e) {}
      doc.setDrawColor(120); doc.line(M, y + 62, M + 210, y + 62);
      y += 78;
      text("Signed by: " + sig.name, 11, "bold", 0);
      text("Date/time: " + new Date(sig.signedAt).toLocaleString("en-US"), 10.5, "normal", 6);
    } else {
      text("No client signature is recorded for this job.", 10.5, "normal", 6);
    }
    rule();

    /* Photo evidence */
    text("PHOTO EVIDENCE", 10, "bold", 2);
    text("Photos included in this report: " + attempted + " (" +
      counts.assessment + " assessment, " + counts.before + " before, " + counts.after + " after).", 10.5, "normal", 6);
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var photos = ((job.photos || {})[g.kind] || []);
      text(g.heading + " (" + photos.length + ")", 12, "bold", 4);
      if (!photos.length) { text("No " + g.kind + " photos were uploaded.", 10.5, "normal", 6); continue; }
      for (var pi = 0; pi < photos.length; pi++) {
        var caption = g.caption + " " + (pi + 1);
        try {
          var loaded = await imageSourceToJpeg(photos[pi]);
          var iw = Math.min(maxW, 460);
          var ih = iw * loaded.height / loaded.width;
          if (ih > 320) { ih = 320; iw = ih * loaded.width / loaded.height; }
          ensure(20 + ih + 12);
          doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
          doc.text(caption, M, y); y += 16;
          doc.addImage(loaded.dataUrl, "JPEG", M + (maxW - iw) / 2, y, iw, ih);
          y += ih + 12;
          embedded++;
        } catch (e) {
          failed++;
          ensure(30);
          doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(160, 40, 35);
          doc.text(caption + " — this photo could not be embedded in the PDF.", M, y);
          doc.setTextColor(0); y += 22;
        }
      }
      y += 4;
    }
    if (failed) text("Warning: " + failed + " photo(s) could not be embedded in this PDF.", 10.5, "bold", 4);

    /* Footer on every page */
    var pages = doc.getNumberOfPages();
    for (var pg = 1; pg <= pages; pg++) {
      doc.setPage(pg);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(COMPANY.name + " • " + COMPANY.owner + " • " + COMPANY.cert, M, 758);
      doc.text(COMPANY.email + " • " + COMPANY.city, M, 770);
    }
    doc.setTextColor(0);
    return { doc: doc, stats: { photoCounts: counts, attemptedPhotoCount: attempted, embeddedPhotoCount: embedded, failedPhotoCount: failed } };
  }

  async function completionBase64(job, client, opts) {
    var r = await buildCompletionPdf(job, client, opts);
    return { base64: r.doc.output("datauristring").split(",")[1], stats: r.stats };
  }
  async function completionDataUrl(job, client, opts) {
    var r = await buildCompletionPdf(job, client, opts);
    return { dataUrl: r.doc.output("datauristring"), stats: r.stats };
  }
  async function completionDownload(job, client, opts) {
    opts = opts || {};
    var r = await buildCompletionPdf(job, client, opts);
    r.doc.save(opts.filename || "angry-panda-completion-report.pdf");
    return r.stats;
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

  window.PandaPDF = { build: buildPdf, download: downloadPdf, dataUrl: pdfDataUrl, base64: pdfBase64,
    buildCompletion: buildCompletionPdf, completionBase64: completionBase64,
    completionDataUrl: completionDataUrl, completionDownload: completionDownload,
    totals: totals, total: jobTotal, money: money, COMPANY: COMPANY };
})();
