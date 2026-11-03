/* Panda Jobs — data layer (Plan Task 2).
 * Dual backend behind one async API:
 *  - DEMO MODE (config placeholders): localStorage. Fully functional; the
 *    signed-copy email is simulated and logged on the job.
 *  - LIVE MODE: Supabase (Auth for owner, token RPC for the client portal,
 *    `sign-and-email` Edge Function for signing + PDF email).
 * API used by app.js / pdf.js:
 *   listClients()  saveClient(c)  deleteClient(id)
 *   listJobs()     getJob(id)     saveJob(j)   deleteJob(id)
 *   getJobByToken(token)
 *   signJob(jobIdOrToken, {name, signatureDataUrl, acceptedOptionals})
 *   addPhoto(jobId, kind, dataUrl)   removePhoto(jobId, kind, idx)
 *   saveDocument(jobId, data)  -> {ok, emailStatus, error?}
 *   deleteJobPhotos(jobId)     -> owner-confirmed photo purge (2026-11-02)
 * Job shape (see plan):
 *   {id, clientId, token, status, title, items:[{desc,qty,price,optional,accepted}],
 *    deposit, terms, version, signedVersion, signatures:[{version,name,signatureDataUrl,signedAt}],
 *    scheduledAt, workNotes, materials, finalTotal, paymentStatus,
 *    photos:{assessment:[],before:[],after:[]}, copyEmailStatus, copyEmailLog:[],
 *    amountPaid:0, startedAt:"", finishedAt:"", photosDeletedAt:"",
 *    completedAt:"", archivedAt:"", completionEmailStatus:"",
 *    completionEmailLog:[{at,to,status,note?,photoCounts,embeddedPhotoCount,failedPhotoCount}],
 *    documents:[{version,kind,pdfDataUrl?,fileUrl?,createdAt}],
 *    sendLog:[{channel, at, to?}], sendEmail:"", createdAt, updatedAt}
 *   sendEmail = recipient typed in the panel's "Send to email" field (last
 *   used on this job; may differ from the client's stored email). Email
 *   sendLog entries carry the recipient in `to`.
 * Status flow: "draft" (new) -> "quote" (= the "Quote sent" stage, set when the
 * owner sends the client link) -> "signed" -> "scheduled" -> "in_progress" ->
 * "done" -> "invoiced". sendLog records each direct send (Text message/Email).
 */
(function () {
  "use strict";
  var cfg = window.PANDA_CONFIG || {};
  var DEMO = !!cfg.DEMO_MODE;
  var LS_KEY = "pandajobs.v1";
  var COMPANY_EMAIL = "angrypandahvac@gmail.com";

  /* ---------------- shared helpers ---------------- */
  function uid(prefix) {
    var rand = "";
    if (window.crypto && crypto.getRandomValues) {
      var bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      rand = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } else {
      rand = (Date.now().toString(16) + Math.random().toString(16).slice(2, 14));
    }
    return (prefix || "") + rand;
  }
  function newToken() { return uid("").slice(0, 32); }
  function nowIso() { return new Date().toISOString(); }

  function defaultTerms() {
    return [
      "SCOPE OF WORK: Angry Panda Heating and Cooling will perform the work described in the line items above at the service address on file. Any work not listed is not included.",
      "NOT INCLUDED: Permits (unless listed above), electrical panel upgrades, drywall/paint repair, ductwork replacement, and any pre-existing code violations found during the job.",
      "LABOR WARRANTY: All labor is warranted for 12 months from the completion date. Equipment and parts carry the manufacturer's warranty. Warranty does not cover damage from misuse, lack of maintenance, power surges, or work by others.",
      "PAYMENT: A deposit (if listed above) is due at signing. The remaining balance is due upon completion. The final total is confirmed in writing before any work begins.",
      "QUOTE VALIDITY: This quote is valid for 15 days from the date shown on your client link.",
      "ACCEPTANCE: By signing below, the client accepts these terms and authorizes Angry Panda Heating and Cooling to perform the work described. EPA Section 608 Universal Certified technicians."
    ].join("\n\n");
  }

  function newJob(clientId) {
    return {
      id: uid("job_"), clientId: clientId, token: newToken(),
      title: "", status: "draft", items: [], deposit: 0,
      terms: defaultTerms(), version: 1, signedVersion: 0, signatures: [],
      scheduledAt: "", workNotes: "", materials: "", finalTotal: null,
      paymentStatus: "pending",
      amountPaid: 0, startedAt: "", finishedAt: "", photosDeletedAt: "",
      photos: { assessment: [], before: [], after: [] },
      copyEmailStatus: "", copyEmailLog: [],
      completedAt: "", archivedAt: "", completionEmailStatus: "", completionEmailLog: [], documents: [],
      sendLog: [], sendEmail: "",
      createdAt: nowIso(), updatedAt: nowIso()
    };
  }

  /* ---------------- DEMO backend (localStorage) ---------------- */
  function demoLoad() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) { var d = JSON.parse(raw); if (d && d.clients && d.jobs) return d; }
    } catch (e) { /* fall through to seed */ }
    var client = { id: uid("cli_"), name: "Sample Client", phone: "(312) 555-0147",
      email: "sample.client@example.com", address: "1234 W Sample Ave, Chicago, IL",
      equipment: "Carrier furnace, 80k BTU (sample)", notes: "Sample data — delete me.", createdAt: nowIso() };
    var job = newJob(client.id);
    job.title = "Furnace replacement — sample job";
    job.items = [
      { desc: "Furnace replacement, 80,000 BTU, 96% AFUE (equipment + labor)", qty: 1, price: 5900, optional: false, accepted: true },
      { desc: "New smart thermostat, installed and configured", qty: 1, price: 275, optional: true, accepted: true },
      { desc: "Duct cleaning, whole house", qty: 1, price: 349, optional: true, accepted: false }
    ];
    var db = { clients: [client], jobs: [job] };
    demoSave(db);
    return db;
  }
  function demoSave(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  function findJob(db, idOrToken) {
    return db.jobs.filter(function (j) { return j.id === idOrToken || j.token === idOrToken; })[0] || null;
  }

  var Demo = {
    listClients: async function () { return demoLoad().clients.slice(); },
    saveClient: async function (c) {
      var db = demoLoad();
      if (!c.id) { c.id = uid("cli_"); c.createdAt = nowIso(); db.clients.push(c); }
      else db.clients = db.clients.map(function (x) { return x.id === c.id ? Object.assign({}, x, c) : x; });
      demoSave(db); return c;
    },
    deleteClient: async function (id) {
      var db = demoLoad();
      db.clients = db.clients.filter(function (c) { return c.id !== id; });
      db.jobs = db.jobs.filter(function (j) { return j.clientId !== id; });
      demoSave(db); return true;
    },
    listJobs: async function () { return demoLoad().jobs.slice(); },
    getJob: async function (id) { return findJob(demoLoad(), id); },
    saveJob: async function (j) {
      var db = demoLoad();
      var idx = -1;
      db.jobs.forEach(function (x, i) { if (x.id === j.id) idx = i; });
      j.updatedAt = nowIso();
      if (idx < 0) db.jobs.push(j); else db.jobs[idx] = j;
      demoSave(db); return j;
    },
    deleteJob: async function (id) {
      var db = demoLoad(); db.jobs = db.jobs.filter(function (j) { return j.id !== id; });
      demoSave(db); return true;
    },
    getJobByToken: async function (token) { return findJob(demoLoad(), token); },
    signJob: async function (idOrToken, data) {
      var db = demoLoad(); var job = findJob(db, idOrToken);
      if (!job) throw new Error("Job not found");
      if (job.signedVersion === job.version) throw new Error("This version is already signed");
      job.signatures.push({ version: job.version, name: data.name, signatureDataUrl: data.signatureDataUrl, signedAt: nowIso() });
      job.signedVersion = job.version;
      if (Array.isArray(data.acceptedOptionals)) {
        // acceptedOptionals is the FULL set of accepted optionals at signing:
        // every other optional is recorded as declined.
        job.items.forEach(function (it, idx) { if (it.optional) it.accepted = data.acceptedOptionals.indexOf(idx) >= 0; });
      }
      if (job.status === "quote" || job.status === "draft") job.status = "signed";
      job.updatedAt = nowIso(); demoSave(db); return job;
    },
    addPhoto: async function (jobId, kind, dataUrl) {
      var db = demoLoad(); var job = findJob(db, jobId); if (!job) throw new Error("Job not found");
      job.photos[kind] = job.photos[kind] || []; job.photos[kind].push(dataUrl);
      job.updatedAt = nowIso(); demoSave(db); return job;
    },
    removePhoto: async function (jobId, kind, idx) {
      var db = demoLoad(); var job = findJob(db, jobId); if (!job) throw new Error("Job not found");
      job.photos[kind].splice(idx, 1); job.updatedAt = nowIso(); demoSave(db); return job;
    },
    // Demo document/email: records the document. For the default
    // "signed-pdf" kind it also SIMULATES the signed-copy email (legacy
    // behavior). A "completion-pdf" is only recorded here — completion
    // state + its simulated email live in Demo.completeJob, so the
    // signed-copy status/log are never overwritten by a completion.
    // Set job.copyEmailStatus = "failed" before calling saveDocument for a
    // signed PDF to rehearse the email-failure path (verification suite).
    saveDocument: async function (jobId, data) {
      var db = demoLoad(); var job = findJob(db, jobId); if (!job) throw new Error("Job not found");
      job.documents = job.documents || [];
      var kind = data.kind || "signed-pdf";
      job.documents.push({
        version: data.version, kind: kind, pdfDataUrl: data.pdfDataUrl || "",
        fileUrl: data.fileUrl || "", recipient: data.recipient || "",
        photoCounts: data.photoCounts || null,
        embeddedPhotoCount: data.embeddedPhotoCount,
        failedPhotoCount: data.failedPhotoCount,
        completedAt: data.completedAt || "", createdAt: nowIso()
      });
      if (kind === "completion-pdf") {
        job.updatedAt = nowIso(); demoSave(db);
        return { ok: true, emailStatus: job.completionEmailStatus || "" };
      }
      var client = db.clients.filter(function (c) { return c.id === job.clientId; })[0];
      var simulateFailure = job.copyEmailStatus === "failed";
      job.copyEmailLog = job.copyEmailLog || [];
      if (simulateFailure) {
        job.copyEmailStatus = "failed";
        job.copyEmailLog.push({ at: nowIso(), to: client ? client.email : "", status: "failed", note: "Simulated failure (verification rehearsal)" });
        demoSave(db); return { ok: true, emailStatus: "failed", error: "Simulated email failure" };
      }
      job.copyEmailStatus = "demo — not sent";
      job.copyEmailLog.push({ at: nowIso(), to: (client ? client.email : "") + " + " + COMPANY_EMAIL, status: "demo — not sent", note: "Demo mode: no email actually leaves the browser" });
      job.updatedAt = nowIso(); demoSave(db);
      return { ok: true, emailStatus: "demo — not sent" };
    },
    // Demo completion: marks the job Done and SIMULATES the evidence
    // email (clearly labelled). Since the 2026-11-02 ronda the email
    // carries the browser-generated evidence PDF + the photos as
    // attachments; the payload's photo stats are logged as provided.
    completeJob: async function (idOrToken, data) {
      var db = demoLoad(); var job = findJob(db, idOrToken); if (!job) throw new Error("Job not found");
      data = data || {};
      var recipient = String(data.recipientEmail || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) throw new Error("A valid recipient email is required to send the evidence email");
      if (!(job.signedVersion > 0) || ["signed", "scheduled", "in_progress", "done"].indexOf(job.status) < 0) {
        throw new Error("Only a signed job that is scheduled or in progress can be completed");
      }
      var completedAt = data.resend && job.completedAt ? job.completedAt : (data.completedAt || nowIso());
      job.completedAt = completedAt;
      job.status = "done";
      job.completionEmailStatus = "demo — not sent";
      job.completionEmailLog = job.completionEmailLog || [];
      var pc = data.photoCounts || {
        assessment: (job.photos.assessment || []).length,
        before: (job.photos.before || []).length,
        after: (job.photos.after || []).length
      };
      job.completionEmailLog.push({
        at: nowIso(), to: recipient, status: "demo — not sent",
        note: "Demo mode: evidence email simulated — PDF + photo attachments do not actually leave the browser",
        photoCounts: pc,
        embeddedPhotoCount: data.embeddedPhotoCount != null ? data.embeddedPhotoCount : (pc.assessment + pc.before + pc.after),
        failedPhotoCount: data.failedPhotoCount || 0
      });
      job.updatedAt = nowIso(); demoSave(db);
      return { ok: true, emailStatus: job.completionEmailStatus, completedAt: completedAt, job: job };
    },
    // Demo quote email: SIMULATES the server send (clearly labelled in
    // the return) and records the send in the job history exactly like
    // the live function does — only after a "successful" send.
    sendQuoteEmail: async function (idOrToken, recipientEmail) {
      var db = demoLoad(); var job = findJob(db, idOrToken); if (!job) throw new Error("Job not found");
      var recipient = String(recipientEmail || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) throw new Error("A valid recipient email is required");
      job.sendLog = job.sendLog || [];
      job.sendLog.push({ channel: "Email", at: nowIso(), to: recipient });
      job.sendEmail = recipient;
      if (job.status === "draft") job.status = "quote";
      job.updatedAt = nowIso(); demoSave(db);
      return { ok: true, emailStatus: "sent", demo: true, job: job };
    },
    // Demo appointment email: SIMULATES the server "send-schedule"
    // action and records the send in the job history like the server.
    sendScheduleEmail: async function (idOrToken) {
      var db = demoLoad(); var job = findJob(db, idOrToken); if (!job) throw new Error("Job not found");
      if (!job.scheduledAt) throw new Error("No appointment date set on this job");
      var client = db.clients.filter(function (c) { return c.id === job.clientId; })[0];
      var to = client ? (client.email || "") : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new Error("No client email on file");
      job.sendLog = job.sendLog || [];
      job.sendLog.push({ channel: "Email", at: nowIso(), to: to, kind: "schedule" });
      // Ronda 2026-11-02: once the appointment email is really sent, a
      // signed job advances to "scheduled" automatically (mirrors the
      // live Edge Function).
      if (job.status === "signed") job.status = "scheduled";
      job.updatedAt = nowIso(); demoSave(db);
      return { ok: true, emailStatus: "sent", demo: true, job: job };
    },
    // Demo photo purge: Rigo confirmed he has the evidence (PDF + email
    // attachments), so the stored photos go away and the purge is dated.
    deleteJobPhotos: async function (jobId) {
      var db = demoLoad(); var job = findJob(db, jobId); if (!job) throw new Error("Job not found");
      job.photos = { assessment: [], before: [], after: [] };
      job.photosDeletedAt = nowIso();
      job.updatedAt = nowIso(); demoSave(db); return job;
    }
  };

  /* ---------------- LIVE backend (Supabase) ---------------- */
  var sb = null;
  function client() {
    if (!sb) {
      if (!window.supabase) throw new Error("Supabase client library not loaded");
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return sb;
  }
  function rowToJob(r, items, signatures) {
    return {
      id: r.id, clientId: r.client_id, token: r.token, title: r.title, status: r.status,
      items: (items || []).map(function (i) { return { desc: i.description, qty: Number(i.qty), price: Number(i.price), optional: !!i.optional, accepted: !!i.accepted }; }),
      deposit: Number(r.deposit || 0), terms: r.terms, version: r.version, signedVersion: r.signed_version || 0,
      signatures: (signatures || []).map(function (s) { return { version: s.version, name: s.signer_name, signatureDataUrl: s.signature_image_url, signedAt: s.signed_at }; }),
      scheduledAt: r.scheduled_at || "", workNotes: r.work_notes || "", materials: r.materials || "",
      finalTotal: r.final_total === null || r.final_total === undefined ? null : Number(r.final_total),
      paymentStatus: r.payment_status,
      // Ronda 2026-11-02 fields — defaulted so the app keeps working
      // before the migration that adds these columns is applied.
      amountPaid: Number(r.amount_paid || 0),
      startedAt: r.started_at || "", finishedAt: r.finished_at || "",
      photosDeletedAt: r.photos_deleted_at || "",
      photos: r.photos || { assessment: [], before: [], after: [] },
      copyEmailStatus: r.copy_email_status || "", copyEmailLog: [],
      completedAt: r.completed_at || "", archivedAt: r.archived_at || "", completionEmailStatus: r.completion_email_status || "",
      completionEmailLog: r.completion_email_log || [], documents: [],
      sendLog: r.send_log || [], sendEmail: r.send_email || "",
      createdAt: r.created_at, updatedAt: r.updated_at
    };
  }
  var Live = {
    listClients: async function () {
      var res = await client().from("clients").select("*").order("created_at", { ascending: false });
      if (res.error) throw res.error;
      return res.data.map(function (r) { return { id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, equipment: r.equipment, notes: r.notes, createdAt: r.created_at }; });
    },
    saveClient: async function (c) {
      var row = { name: c.name, phone: c.phone, email: c.email, address: c.address, equipment: c.equipment, notes: c.notes };
      var res;
      if (c.id) res = await client().from("clients").update(row).eq("id", c.id).select().single();
      else res = await client().from("clients").insert(row).select().single();
      if (res.error) throw res.error;
      c.id = res.data.id; return c;
    },
    deleteClient: async function (id) {
      var res = await client().from("clients").delete().eq("id", id); if (res.error) throw res.error; return true;
    },
    _fetchJobParts: async function (jobId) {
      var items = await client().from("quote_items").select("*").eq("job_id", jobId).order("sort_order");
      var sigs = await client().from("signatures").select("*").eq("job_id", jobId);
      var photos = await client().from("photos").select("*").eq("job_id", jobId).order("created_at");
      var docs = await client().from("documents").select("*").eq("job_id", jobId).order("created_at");
      return { items: items.data || [], sigs: sigs.data || [], photos: photos.data || [], documents: docs.data || [] };
    },
    _assemble: function (r, parts) {
      var job = rowToJob(r, parts.items, parts.sigs);
      job.photos = { assessment: [], before: [], after: [] };
      parts.photos.forEach(function (p) { if (job.photos[p.kind]) job.photos[p.kind].push(p.image_url); });
      job.documents = (parts.documents || []).map(function (d) {
        return { version: d.version, kind: d.kind || "signed-pdf", fileUrl: d.file_url || "", pdfDataUrl: "", createdAt: d.created_at };
      });
      return job;
    },
    listJobs: async function () {
      var res = await client().from("jobs").select("*").order("created_at", { ascending: false });
      if (res.error) throw res.error;
      var out = [];
      for (var i = 0; i < res.data.length; i++) out.push(Live._assemble(res.data[i], await Live._fetchJobParts(res.data[i].id)));
      return out;
    },
    getJob: async function (id) {
      var res = await client().from("jobs").select("*").eq("id", id).single();
      if (res.error) return null;
      return Live._assemble(res.data, await Live._fetchJobParts(id));
    },
    saveJob: async function (j) {
      var row = { client_id: j.clientId, token: j.token, title: j.title, status: j.status, deposit: j.deposit,
        terms: j.terms, version: j.version, signed_version: j.signedVersion, scheduled_at: j.scheduledAt || null,
        work_notes: j.workNotes, materials: j.materials, final_total: j.finalTotal, payment_status: j.paymentStatus,
        photos: j.photos, copy_email_status: j.copyEmailStatus,
        completed_at: j.completedAt || null, archived_at: j.archivedAt || null, completion_email_status: j.completionEmailStatus || "",
        completion_email_log: j.completionEmailLog || [],
        send_log: j.sendLog || [], send_email: j.sendEmail || "",
        amount_paid: Number(j.amountPaid || 0),
        started_at: j.startedAt || null, finished_at: j.finishedAt || null,
        photos_deleted_at: j.photosDeletedAt || null };
      // Graceful degradation (ronda 2026-11-02): if the migration that
      // adds the new columns has not been applied yet, PostgREST rejects
      // the write naming the unknown column — strip the new fields and
      // retry once, so the live app never breaks over a pending SQL step.
      var NEW_COLS = ["amount_paid", "started_at", "finished_at", "photos_deleted_at"];
      async function attempt(r) {
        if (j.id && String(j.id).indexOf("job_") !== 0) return client().from("jobs").update(r).eq("id", j.id).select().single();
        return client().from("jobs").insert(r).select().single();
      }
      var res = await attempt(row);
      if (res.error && NEW_COLS.some(function (c) { return String(res.error.message || "").indexOf(c) >= 0; })) {
        NEW_COLS.forEach(function (c) { delete row[c]; });
        res = await attempt(row);
      }
      if (res.error) throw res.error;
      j.id = res.data.id;
      await client().from("quote_items").delete().eq("job_id", j.id);
      if (j.items.length) {
        var rows = j.items.map(function (it, ix) { return { job_id: j.id, description: it.desc, qty: it.qty, price: it.price, optional: !!it.optional, accepted: !!it.accepted, sort_order: ix }; });
        var ins = await client().from("quote_items").insert(rows); if (ins.error) throw ins.error;
      }
      return j;
    },
    deleteJob: async function (id) {
      var res = await client().from("jobs").delete().eq("id", id); if (res.error) throw res.error; return true;
    },
    // Client portal reads ONLY through the token-checked RPC.
    getJobByToken: async function (token) {
      var res = await client().rpc("get_job_by_token", { p_token: token });
      if (res.error || !res.data) return null;
      return res.data; // RPC returns the assembled job JSON (see schema.sql)
    },
    // Signing happens inside the Edge Function so the signature, the PDF and
    // the automatic email are one atomic flow server-side.
    signJob: async function (token, data) {
      var res = await client().functions.invoke("sign-and-email", {
        body: { action: "sign", token: token, name: data.name, signatureDataUrl: data.signatureDataUrl, acceptedOptionals: data.acceptedOptionals || [], pdfBase64: data.pdfBase64 || null }
      });
      if (res.error) throw res.error;
      return res.data;
    },
    addPhoto: async function (jobId, kind, dataUrl) {
      var r = await fetch(dataUrl); var blob = await r.blob();
      var path = jobId + "/" + kind + "/" + uid("") + ".jpg";
      var up = await client().storage.from("job-photos").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      var url = client().storage.from("job-photos").getPublicUrl(path).data.publicUrl;
      var ins = await client().from("photos").insert({ job_id: jobId, kind: kind, image_url: url });
      if (ins.error) throw ins.error;
      return Live.getJob(jobId);
    },
    removePhoto: async function (jobId, kind, idx) {
      var res = await client().from("photos").select("*").eq("job_id", jobId).eq("kind", kind).order("created_at");
      var row = (res.data || [])[idx]; if (!row) return Live.getJob(jobId);
      await client().from("photos").delete().eq("id", row.id);
      return Live.getJob(jobId);
    },
    saveDocument: async function (jobId, data) {
      var kind = data.kind || "signed-pdf";
      // Completion PDFs are generated in the browser and emailed as an
      // attachment by the Edge Function; no document-storage upload path
      // exists today, so the row honestly records "generated-in-portal"
      // instead of inventing a file URL.
      var fileUrl = data.fileUrl || (kind === "completion-pdf" ? "generated-in-portal" : "");
      var ins = await client().from("documents").insert({ job_id: jobId, version: data.version, kind: kind, file_url: fileUrl });
      if (ins.error) throw ins.error;
      return { ok: true, emailStatus: data.emailStatus || "" };
    },
    // Live completion (ronda 2026-11-02): the panel generates the
    // evidence PDF in the browser (pdf.js) and converts the photos to
    // JPEG attachments; the Edge Function only attaches what it
    // receives (generating PDFs server-side died on the CPU limit) and
    // moves the job to Done ONLY after the email actually went out.
    // An email failure comes back as {ok:true, emailStatus:"failed"}
    // and the job stays In progress so the send can be retried.
    completeJob: async function (token, data) {
      data = data || {};
      var res = await client().functions.invoke("sign-and-email", {
        body: {
          action: "complete", token: token, recipientEmail: data.recipientEmail || "",
          completedAt: data.completedAt || null, resend: !!data.resend,
          pdfBase64: data.pdfBase64 || null,
          photoAttachments: data.photoAttachments || [],
          photoCounts: data.photoCounts || null,
          embeddedPhotoCount: data.embeddedPhotoCount,
          failedPhotoCount: data.failedPhotoCount
        }
      });
      if (res.error) throw res.error;
      return res.data;
    },
    // Live quote email: the Edge Function verifies the owner's session
    // (functions.invoke attaches it), sends the quote through the same
    // Gmail path as the signed copy, and records the send server-side —
    // the returned emailStatus is "sent" only when it really went out.
    sendQuoteEmail: async function (token, recipientEmail) {
      var res = await client().functions.invoke("sign-and-email", {
        body: { action: "send-quote", token: token, recipientEmail: recipientEmail }
      });
      if (res.error) throw res.error;
      return res.data;
    },
    // Live appointment email: the Edge Function verifies the owner's
    // session, reads the job's saved appointment and emails the client
    // the date, recording the send in the job history server-side.
    sendScheduleEmail: async function (token) {
      var res = await client().functions.invoke("sign-and-email", {
        body: { action: "send-schedule", token: token }
      });
      if (res.error) throw res.error;
      return res.data;
    },
    // Live photo purge (ronda 2026-11-02): Rigo confirmed in the app
    // that he already has the evidence (the emailed PDF + photo
    // attachments). Deletes the photos-table rows AND their Storage
    // objects, empties the jobs.photos jsonb and stamps
    // photos_deleted_at. Before that confirmation, nothing is deleted.
    deleteJobPhotos: async function (jobId) {
      var res = await client().from("photos").select("image_url").eq("job_id", jobId);
      if (res.error) throw res.error;
      var marker = "/job-photos/";
      var paths = (res.data || []).map(function (r) {
        var ix = String(r.image_url || "").indexOf(marker);
        return ix >= 0 ? decodeURIComponent(String(r.image_url).slice(ix + marker.length)) : null;
      }).filter(Boolean);
      if (paths.length) {
        var rm = await client().storage.from("job-photos").remove(paths);
        if (rm.error) throw rm.error;
      }
      var del = await client().from("photos").delete().eq("job_id", jobId);
      if (del.error) throw del.error;
      var upd = { photos: { assessment: [], before: [], after: [] }, photos_deleted_at: new Date().toISOString() };
      var ures = await client().from("jobs").update(upd).eq("id", jobId);
      if (ures.error && String(ures.error.message || "").indexOf("photos_deleted_at") >= 0) {
        delete upd.photos_deleted_at; // column pending migration — rows/objects are already gone
        ures = await client().from("jobs").update(upd).eq("id", jobId);
      }
      if (ures.error) throw ures.error;
      return Live.getJob(jobId);
    }
  };

  var backend = DEMO ? Demo : Live;
  window.PandaData = Object.assign({}, backend, {
    DEMO_MODE: DEMO,
    COMPANY_EMAIL: COMPANY_EMAIL,
    newToken: newToken,
    newJob: newJob,
    defaultTerms: defaultTerms,
    supabase: DEMO ? null : client
  });
})();
