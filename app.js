/* Panda Jobs — app (Plan Tasks 1, 3, 4, 5, 6).
 * Hash routes:  #/            owner panel (login gate in demo; Supabase Auth live)
 *               #/c/<token>   client portal (no account, token only)
 */
(function () {
  "use strict";
  var D = window.PandaData;
  var COMPANY = window.PandaPDF.COMPANY;
  var app = document.getElementById("app");
  var DEMO = D.DEMO_MODE;
  var DEMO_PASSWORD = "panda2026"; // demo gate only — live mode uses Supabase Auth
  var liveUserEmail = ""; // filled by liveSession() in live mode (Account card)
  var REF_RANGES = [
    ["Diagnostic / service call", "$75 – $99"],
    ["Furnace tune-up", "$89 – $119"],
    ["AC tune-up", "$89 – $119"],
    ["Ignitor replacement", "$175 – $400"],
    ["Flame sensor", "$150 – $300"],
    ["Capacitor", "$150 – $300"],
    ["Blower motor", "$450 – $1,100"],
    ["Thermostat replacement", "$150 – $450"],
    ["Circuit board", "$300 – $650"],
    ["New furnace installed", "$4,500 – $9,500"],
    ["New AC installed (with coil)", "$5,000 – $9,000"],
    ["Full system (furnace + AC)", "$7,500 – $13,000"],
    ["Tank water heater 40/50 gal installed", "$1,800 – $3,200"],
    ["Tankless water heater installed", "$3,500 – $6,500"],
    ["Maintenance plan (if offered)", "$15 – $20 / mo"]
  ];
  var STAGES = [
    ["draft", "Draft"], ["quote", "Quote sent"], ["signed", "Signed / Approved"], ["scheduled", "Scheduled"],
    ["in_progress", "In progress"], ["done", "Done"], ["invoiced", "Invoiced"]
  ];
  function stageLabel(s) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i][0] === s) return STAGES[i][1]; return s; }
  function money(n) { return window.PandaPDF.money(n); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(iso) { if (!iso) return ""; try { return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return iso; } }
  var PUBLIC_BASE = (window.PANDA_CONFIG && window.PANDA_CONFIG.APP_PUBLIC_URL) || "";
  function clientLink(token) { return (PUBLIC_BASE || (location.origin + location.pathname)) + "#/c/" + token; }
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim()); }
  function sendLogHTML(job) {
    var log = job.sendLog || [];
    if (!log.length) return "";
    return '<h4 class="send-log-h">Send history</h4>' + log.map(function (e) {
      return '<p class="small muted send-log-line">Sent via ' + esc(e.channel) +
        (e.channel === "Email" && e.to ? " to " + esc(e.to) : "") + " · " + fmtDate(e.at) + "</p>";
    }).join("");
  }
  function signedSig(job) {
    var s = null;
    (job.signatures || []).forEach(function (x) { if (x.version === job.signedVersion) s = x; });
    return job.signedVersion > 0 ? s : null;
  }
  function statusTimeline(job) {
    var order = ["draft", "quote", "signed", "scheduled", "in_progress", "done", "invoiced"];
    var idx = order.indexOf(job.status);
    var labels = ["Draft", "Quote", "Signed", "Scheduled", "Working", "Done", "Invoiced"];
    return '<div class="timeline">' + labels.map(function (l, i) {
      return "<div" + (i <= idx ? ' class="done"' : "") + ">" + l + "</div>";
    }).join("") + "</div>";
  }
  function headerHTML(sub) {
    return '<header class="app-header"><img src="assets/logo.png" alt="Angry Panda logo">' +
      '<div class="brand">Angry Panda<small>Heating and Cooling — Chicago, IL</small></div>' +
      '<div class="spacer"></div>' +
      (sub || "") +
      (DEMO ? '<span class="badge demo">DEMO MODE</span>' : '<span class="badge live">LIVE</span>') +
      "</header>";
  }
  function footerHTML() {
    return '<footer class="app-foot">' + esc(COMPANY.name) + " • " + esc(COMPANY.cert) + "<br>" +
      '<a href="mailto:' + esc(COMPANY.email) + '">' + esc(COMPANY.email) + "</a> • Chicago, IL</footer>";
  }
  function errBox(msg) { return '<div class="notice bad" role="alert">' + esc(msg) + "</div>"; }

  /* ---------------- photo compression (Task 6) ---------------- */
  function processPhotoFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var MAX = 1600, w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, MAX / Math.max(w, h));
          var cw = Math.round(w * scale), ch = Math.round(h * scale);
          var c = document.createElement("canvas"); c.width = cw; c.height = ch;
          c.getContext("2d").drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL("image/jpeg", 0.82));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not read that photo.")); };
      img.src = url;
    });
  }

  /* ---------------- auth ---------------- */
  function isAuthed() {
    if (DEMO) return sessionStorage.getItem("pj.demoAuth") === "1";
    return !!sessionStorage.getItem("pj.liveAuth");
  }
  async function liveSession() {
    if (DEMO) return;
    try {
      var s = await D.supabase().auth.getSession();
      if (s && s.data && s.data.session) {
        sessionStorage.setItem("pj.liveAuth", "1");
        if (s.data.session.user) liveUserEmail = s.data.session.user.email || "";
      }
    } catch (e) { /* stay logged out */ }
  }

  /* Live mode only: shows the signed-in owner and lets them set/change the
     account password (Supabase Auth updateUser). This is how an owner who
     arrived via an email invitation link gets a password they can log in
     with after that first session ends. Never rendered in demo mode.
     The card stays COLLAPSED (display:none) behind the small "Account"
     toggle button in the header (#acctToggle) so it doesn't sit in the
     panel permanently — Rigo's request, since more people will use the
     app. renderOwner() always starts it hidden; the toggle shows/hides. */
  function accountHTML() {
    return '<div class="card" id="acctCard" style="display:none"><h2>Account</h2>' +
      '<p class="muted small">Signed in as <b>' + esc(liveUserEmail || "your account") + '</b>.</p>' +
      '<p class="small">Set a password for this account — you will need it to log in next time (invitation and recovery links sign you in only once). Use at least 8 characters.</p>' +
      '<label class="f" for="acctPw1">New password</label><input type="password" id="acctPw1" autocomplete="new-password">' +
      '<label class="f" for="acctPw2">Confirm new password</label><input type="password" id="acctPw2" autocomplete="new-password">' +
      '<div id="acctMsg"></div>' +
      '<div class="btn-row"><button class="btn primary" id="acctSave">Save password</button></div></div>';
  }

  /* ================= OWNER PANEL ================= */
  var ownerTab = "jobs";
  var boardFilter = "all"; // Jobs board: "all" or one stage key (chips)

  async function renderOwner() {
    await liveSession();
    if (!isAuthed()) return renderLogin();
    var clients = await D.listClients();
    var jobs = await D.listJobs();
    var byClient = {}; clients.forEach(function (c) { byClient[c.id] = c; });
    /* Live mode: discreet "Account" toggle next to Log out — shows/hides
       the collapsed Account card (see accountHTML). Demo mode has no
       account card or toggle at all, header unchanged. */
    var html = headerHTML((DEMO ? "" : '<button class="btn small light" id="acctToggle" aria-expanded="false" aria-controls="acctCard">Account</button>') +
      '<button class="btn small light" id="logoutBtn">Log out</button>');
    html += '<nav class="owner-nav">' +
      '<button data-tab="jobs" class="' + (ownerTab === "jobs" ? "on" : "") + '">Jobs</button>' +
      '<button data-tab="clients" class="' + (ownerTab === "clients" ? "on" : "") + '">Clients</button>' +
      '<button data-tab="history" class="' + (ownerTab === "history" ? "on" : "") + '">History</button>' +
      '<button data-tab="new" class="' + (ownerTab === "new" ? "on" : "") + '">+ New job</button></nav>';
    html += '<main class="wrap wide">';
    if (DEMO) html += '<div class="notice warn"><b>Demo mode:</b> data is stored only in this browser (localStorage) and the signed-copy email is simulated — nothing is sent. Fill in <code>config.js</code> with the Supabase project to go live (see README).</div>';
    if (ownerTab === "clients") html += clientsHTML(clients, jobs);
    else if (ownerTab === "history") html += historyHTML(jobs, byClient);
    else if (ownerTab === "new") html += newJobHTML(clients);
    else html += jobsHTML(jobs, byClient);
    if (!DEMO) html += accountHTML();
    html += "</main>" + footerHTML();
    app.innerHTML = html;
    wireOwner(clients, jobs, byClient);
  }

  function renderLogin() {
    app.innerHTML = headerHTML("") +
      '<main class="wrap"><div class="card"><h2>Owner login</h2>' +
      (DEMO
        ? '<p class="muted">Demo mode: use the demo password <b>panda2026</b>. In live mode this becomes your real Supabase Auth login.</p>' +
          '<label class="f" for="pw">Password</label><input type="password" id="pw" autocomplete="current-password">' +
          '<div id="loginErr"></div><div class="btn-row"><button class="btn primary" id="loginBtn">Log in</button></div>'
        : '<label class="f" for="em">Email</label><input type="email" id="em" autocomplete="username">' +
          '<label class="f" for="pw">Password</label><input type="password" id="pw" autocomplete="current-password">' +
          '<div id="loginErr"></div><div class="btn-row"><button class="btn primary" id="loginBtn">Log in</button></div>') +
      "</div></main>" + footerHTML();
    document.getElementById("loginBtn").addEventListener("click", async function () {
      var err = document.getElementById("loginErr");
      if (DEMO) {
        if (document.getElementById("pw").value === DEMO_PASSWORD) { sessionStorage.setItem("pj.demoAuth", "1"); renderOwner(); }
        else err.innerHTML = errBox("Wrong password.");
      } else {
        try {
          var r = await D.supabase().auth.signInWithPassword({ email: document.getElementById("em").value.trim(), password: document.getElementById("pw").value });
          if (r.error) throw r.error;
          sessionStorage.setItem("pj.liveAuth", "1"); renderOwner();
        } catch (e) { err.innerHTML = errBox("Login failed: " + (e.message || e)); }
      }
    });
  }

  /* Jobs board, simplified: one row of stage chips (with counts) filters
     the list; empty stages disappear in the "All" view instead of showing
     seven "No jobs here" boxes. Job cards also show the appointment. */
  function jobsHTML(jobs, byClient) {
    jobs = jobs.filter(function (j) { return !j.archivedAt; }); // archived jobs live in History
    var counts = {};
    STAGES.forEach(function (st) { counts[st[0]] = jobs.filter(function (j) { return j.status === st[0]; }).length; });
    var html = '<div class="chips">' +
      '<button class="chip' + (boardFilter === "all" ? " on" : "") + '" data-board-filter="all">All <b>' + jobs.length + "</b></button>" +
      STAGES.map(function (st) {
        return '<button class="chip' + (boardFilter === st[0] ? " on" : "") + '" data-board-filter="' + st[0] + '"><span class="dot d-' + st[0] + '"></span>' + st[1] + " <b>" + counts[st[0]] + "</b></button>";
      }).join("") + "</div>";
    html += '<div class="pipe">';
    STAGES.forEach(function (st) {
      if (boardFilter !== "all" && boardFilter !== st[0]) return;
      var inStage = jobs.filter(function (j) { return j.status === st[0]; });
      if (!inStage.length) {
        if (boardFilter !== "all") html += '<section class="stage s-' + st[0] + '"><h3>' + st[1] + ' (0)</h3><p class="muted small">No jobs here yet.</p></section>';
        return;
      }
      html += '<section class="stage s-' + st[0] + '"><h3>' + st[1] + " (" + inStage.length + ")</h3>";
      inStage.forEach(function (j) {
        var c = byClient[j.clientId];
        html += '<button class="job-card" data-open-job="' + j.id + '"><b>' + esc(j.title || "Untitled job") + "</b>" +
          "<span>" + esc(c ? c.name : "—") + " • " + money(window.PandaPDF.total(j)) + " • v" + j.version +
          (j.signedVersion === j.version ? ' • <span class="pill">SIGNED</span>' : "") +
          (j.copyEmailStatus === "failed" ? ' <span class="pill red">copy email failed</span>' : "") + "</span>" +
          (j.scheduledAt ? '<span class="appt-line">📅 ' + fmtDate(j.scheduledAt) + "</span>" : "") + "</button>";
      });
      html += "</section>";
    });
    if (!jobs.length) html += '<div class="stage empty-board"><img src="assets/logo.png" alt=""><p class="muted">No jobs yet — create the first one with <b>+ New job</b>.</p></div>';
    return html + "</div>";
  }

  function clientsHTML(clients, jobs) {
    var html = '<div class="card"><h2>Clients</h2><div id="clientMsg"></div>';
    clients.forEach(function (c) {
      var n = jobs.filter(function (j) { return j.clientId === c.id; }).length;
      html += '<div class="list-row"><div class="grow"><b>' + esc(c.name) + "</b><br><span class=\"muted small\">" +
        esc(c.phone || "") + " • " + esc(c.email || "") + "<br>" + esc(c.address || "") + (c.equipment ? "<br>Equipment: " + esc(c.equipment) : "") +
        (c.notes ? "<br>" + esc(c.notes) : "") + "<br>" + n + " job(s)</span></div>" +
        '<button class="btn small light" data-edit-client="' + c.id + '">Edit</button>' +
        '<button class="btn small danger" data-del-client="' + c.id + '">Delete</button></div>';
    });
    html += "</div>";
    html += '<div class="card"><h2 id="clientFormTitle">Add a client</h2>' +
      '<input type="hidden" id="cf_id">' +
      '<label class="f">Full name *</label><input type="text" id="cf_name">' +
      '<label class="f">Phone</label><input type="tel" id="cf_phone">' +
      '<label class="f">Email * (needed to send quotes and the signed copy)</label><input type="email" id="cf_email">' +
      '<label class="f">Service address</label><input type="text" id="cf_address">' +
      '<label class="f">Equipment (brand / model, if known)</label><input type="text" id="cf_equipment">' +
      '<label class="f">Notes</label><textarea id="cf_notes"></textarea>' +
      '<div class="btn-row"><button class="btn primary" id="cf_save">Save client</button>' +
      '<button class="btn light" id="cf_clear">Clear</button></div></div>';
    return html;
  }

  function newJobHTML(clients) {
    if (!clients.length) return '<div class="card"><h2>New job</h2><p>Add a client first (Clients tab), then create the job.</p></div>';
    var opts = clients.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + " — " + esc(c.email || "no email") + "</option>"; }).join("");
    return '<div class="card"><h2>New job</h2>' +
      '<label class="f">Client</label><select id="nj_client">' + opts + "</select>" +
      '<label class="f">Job title</label><input type="text" id="nj_title" placeholder="e.g. Furnace replacement — no heat">' +
      '<div class="btn-row"><button class="btn primary" id="nj_create">Create job & build quote</button></div></div>';
  }

  /* ---------- History (archived jobs) ----------
     Jobs the owner finished from the Invoiced stage land here with only
     the record that matters later: photos, installation date & time,
     notes, the invoice amounts and the signed contract. Searchable by
     client name, phone (digits) or email for future lookups. */
  function historyHTML(jobs, byClient) {
    var archived = jobs.filter(function (j) { return j.archivedAt; }).slice()
      .sort(function (a, b) { return String(b.archivedAt).localeCompare(String(a.archivedAt)); });
    var html = '<div class="card"><h2>🗂️ Job history</h2>' +
      '<p class="small muted">Finished jobs, kept for future lookups — photos, installation date &amp; time, notes, invoice and signed contract.</p>' +
      '<label class="f" for="historySearch">Search by name, phone or email</label>' +
      '<input type="text" id="historySearch" autocomplete="off" placeholder="e.g. Maria, 3125550147, maria@email.com">' +
      '<div id="historyList" style="margin-top:12px">';
    if (!archived.length) html += '<p class="muted" id="historyEmpty">No finished jobs yet. When an invoiced job is done for good, press <b>“Complete &amp; move to History”</b> on it and it will live here.</p>';
    archived.forEach(function (j) {
      var c = byClient[j.clientId];
      var when = j.scheduledAt || j.completedAt || j.archivedAt;
      var searchText = ((c ? c.name : "") + " " + (c ? c.email : "") + " " + (c ? c.phone : "") + " " + (j.title || "")).toLowerCase();
      var phoneDigits = c ? String(c.phone || "").replace(/\D/g, "") : "";
      html += '<button class="job-card hist-card" data-open-history="' + j.id + '" data-search="' + esc(searchText) + '" data-phone="' + phoneDigits + '"><b>' + esc(j.title || "Untitled job") + "</b>" +
        "<span>" + esc(c ? c.name : "—") + " • " + money(j.finalTotal != null ? j.finalTotal : window.PandaPDF.total(j)) + "</span>" +
        '<span class="appt-line">📅 Installed: ' + fmtDate(when) + "</span></button>";
    });
    html += '</div><p class="small muted" id="historyNoMatch" style="display:none">No records match that search.</p></div>';
    return html;
  }

  async function renderHistoryRecord(jobId) {
    var job = await D.getJob(jobId);
    if (!job || !job.archivedAt) { ownerTab = "history"; renderOwner(); return; }
    var clients = await D.listClients();
    var client = clients.filter(function (c) { return c.id === job.clientId; })[0];
    var sig = signedSig(job);
    var total = job.finalTotal != null ? job.finalTotal : window.PandaPDF.total(job);
    var html = headerHTML('<button class="btn small light" id="logoutBtn">Log out</button>');
    html += '<main class="wrap wide"><div class="btn-row"><button class="btn light small" id="backHistory">← Job history</button></div>';
    html += '<div id="histMsg"></div>';
    html += '<div class="card job-head"><h2>' + esc(job.title || "Untitled job") + '</h2>' +
      '<p class="muted small">Client: <b>' + esc(client ? client.name : "—") + "</b> • " + esc(client ? client.phone : "") + " • " + esc(client ? client.email : "") + "<br>" +
      esc(client ? client.address : "") + (client && client.equipment ? "<br>Equipment: " + esc(client.equipment) : "") + "</p>" +
      '<p class="small">📅 <b>Installation date &amp; time:</b> ' + (job.scheduledAt ? fmtDate(job.scheduledAt) : "—") + "<br>" +
      "✅ <b>Work completed:</b> " + (job.completedAt ? fmtDate(job.completedAt) : "—") + "<br>" +
      "🗂️ <b>Moved to History:</b> " + fmtDate(job.archivedAt) + "</p></div>";

    /* Photos — the visual record */
    html += '<div class="card"><h2>📸 Photos</h2>';
    var anyPhoto = false;
    [["assessment", "Assessment"], ["before", "BEFORE"], ["after", "AFTER"]].forEach(function (pair) {
      var list = job.photos[pair[0]] || [];
      if (!list.length) return;
      anyPhoto = true;
      html += "<h3>" + pair[1] + " (" + list.length + ')</h3><div class="photo-grid">' +
        list.map(function (p, i) { return '<figure><img src="' + p + '" alt="' + pair[1] + " photo " + (i + 1) + '"></figure>'; }).join("") + "</div>";
    });
    if (!anyPhoto) html += '<p class="muted">No photos were uploaded for this job.</p>';
    html += "</div>";

    /* Notes */
    html += '<div class="card"><h2>📝 Notes</h2>';
    if (job.workNotes) html += "<h3>What we did</h3><p style=\"white-space:pre-wrap\">" + esc(job.workNotes) + "</p>";
    if (job.materials) html += "<h3>Materials used</h3><p style=\"white-space:pre-wrap\">" + esc(job.materials) + "</p>";
    if (!job.workNotes && !job.materials) html += '<p class="muted">No notes recorded.</p>';
    html += "</div>";

    /* Invoice — the billed amounts on the job */
    html += '<div class="card"><h2>🧾 Invoice</h2>' +
      '<table class="items"><tr><th>Description</th><th class="num">Qty</th><th class="num">Amount</th></tr>' +
      job.items.filter(function (it) { return !it.optional || it.accepted; }).map(function (it) {
        return "<tr><td>" + esc(it.desc) + '</td><td class="num">' + it.qty + '</td><td class="num">' + money(it.qty * it.price) + "</td></tr>";
      }).join("") +
      '<tr class="total"><td colspan="2">Total' + (job.finalTotal != null ? " (final)" : "") + '</td><td class="num">' + money(total) + "</td></tr></table>" +
      (job.deposit ? '<p class="small muted">Deposit at signing: <b>' + money(job.deposit) + "</b></p>" : "") +
      '<p>Status: <span class="pill">' + esc(stageLabel(job.status)) + "</span> " +
      (job.paymentStatus === "paid" ? '<span class="pill">PAID</span>' : '<span class="pill amber">Payment pending</span>') + "</p></div>";

    /* Signed contract */
    html += '<div class="card"><h2>✍️ Signed contract</h2>';
    if (sig) {
      html += '<p>Signed by <b>' + esc(sig.name) + "</b> on " + fmtDate(sig.signedAt) + " (version " + sig.version + ').</p>' +
        '<div class="sig-locked"><img src="' + sig.signatureDataUrl + '" alt="Client signature"></div>' +
        '<div class="btn-row"><button class="btn primary" id="histSignedPdf">Download signed contract (PDF)</button>' +
        '<button class="btn ghost" id="histCompletionPdf">Download completion report</button></div>';
    } else {
      html += '<p class="muted">No signature on file for this job.</p>';
    }
    html += '<div class="btn-row"><button class="btn light" id="histRestore">Restore to Jobs board</button></div></div>';
    html += "</main>" + footerHTML();
    app.innerHTML = html;
    document.getElementById("logoutBtn").addEventListener("click", doLogout);
    document.getElementById("backHistory").addEventListener("click", function () { ownerTab = "history"; renderOwner(); });
    var m = document.getElementById("histMsg");
    var sp = document.getElementById("histSignedPdf");
    if (sp) sp.addEventListener("click", async function () {
      await window.PandaPDF.download(job, client, { version: sig.version, filename: "angry-panda-signed-v" + sig.version + ".pdf" });
    });
    var cp = document.getElementById("histCompletionPdf");
    if (cp) cp.addEventListener("click", async function () {
      try { await window.PandaPDF.completionDownload(job, client, { completedAt: job.completedAt || undefined, filename: "angry-panda-completion-report.pdf" }); }
      catch (e) { m.innerHTML = errBox("Could not generate the completion report: " + (e.message || e)); }
    });
    document.getElementById("histRestore").addEventListener("click", async function () {
      if (!confirm("Restore this job to the Jobs board? It will leave History and reappear under its stage.")) return;
      try {
        var fresh = (await D.getJob(job.id)) || job;
        fresh.archivedAt = "";
        await D.saveJob(fresh);
        ownerTab = "jobs"; renderOwner();
      } catch (e) { m.innerHTML = errBox("Could not restore the job: " + (e.message || e)); }
    });
  }

  /* ---------- job detail / quote builder ---------- */
  async function renderJobDetail(jobId) {
    var job = await D.getJob(jobId);
    if (!job) { app.innerHTML = headerHTML("") + '<main class="wrap">' + errBox("Job not found.") + "</main>"; return; }
    var clients = await D.listClients();
    var client = clients.filter(function (c) { return c.id === job.clientId; })[0];
    var sig = signedSig(job);
    var locked = !!sig && job.signedVersion === job.version;
    var link = clientLink(job.token);
    var firstName = client ? (client.name || "").split(" ")[0] : "there";
    var sendMsg = "Hi " + firstName + ", this is Angry Panda Heating and Cooling. Here is your quote — tap the link to review and sign: " + link;
    var phoneDigits = client ? String(client.phone || "").replace(/\D/g, "") : "";
    var phoneIntl = phoneDigits.length === 10 ? "1" + phoneDigits : phoneDigits;
    var hasPhone = phoneDigits.length >= 10;
    var storedEmail = client ? (client.email || "") : "";
    // Recipient for the Email button: last address used on this job
    // (job.sendEmail) wins, else the client's stored email. Editable per send.
    var recipientEmail = job.sendEmail || storedEmail;
    var recipientValid = validEmail(recipientEmail);
    var smsHref = hasPhone ? "sms:+" + phoneIntl + "?&body=" + encodeURIComponent(sendMsg) : "";
    var isDemoLink = DEMO || link.indexOf("localhost") >= 0 || link.indexOf("127.0.0.1") >= 0;
    var html = headerHTML('<button class="btn small light" id="logoutBtn">Log out</button>');
    html += '<main class="wrap wide"><div class="btn-row"><button class="btn light small" id="backBtn">← All jobs</button></div>';
    html += '<div id="jobMsg"></div>';
    html += '<div class="card job-head"><h2>' + esc(job.title || "Untitled job") + "</h2>" +
      '<p class="muted small">Client: <b>' + esc(client ? client.name : "—") + "</b> • " + esc(client ? client.email : "") + " • " + esc(client ? client.phone : "") + "<br>" +
      esc(client ? client.address : "") + (client && client.equipment ? "<br>Equipment: " + esc(client.equipment) : "") + "</p>" +
      '<label class="f">Job title</label><input type="text" id="jd_title" value="' + esc(job.title) + '">' +
      '<label class="f">Status</label><select id="jd_status">' +
      STAGES.map(function (s) { return '<option value="' + s[0] + '"' + (job.status === s[0] ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select>" +
      "</div>";

    /* Quote builder — STEP 1 of the simplified detail flow:
       1 Quote → 2 Send → 3 Schedule, work & photos. */
    html += '<div class="card step"><h2><span class="stepn">1</span>Quote / contract — version ' + job.version + "</h2>";
    if (locked) html += '<div class="notice ok"><b>Signed</b> by ' + esc(sig.name) + " on " + fmtDate(sig.signedAt) + ". This version is locked. Saving any change below creates version " + (job.version + 1) + " and the client must sign again — the signed version stays intact.</div>";
    else if (sig) html += '<div class="notice warn">Version ' + sig.version + " was <b>signed</b> by " + esc(sig.name) + " on " + fmtDate(sig.signedAt) + " and stays intact. This is version " + job.version + " — <b>not signed yet</b>; the client must sign it from their link.</div>";
    if (job.copyEmailStatus === "failed") html += '<div class="notice bad"><b>Copy email failed.</b> The signature and PDF are saved; the client can still download the PDF from their portal. Check the client email and re-send from the Documents section.</div>';
    html += '<div id="qrows">';
    job.items.forEach(function (it, i) { html += qrowHTML(it, i); });
    html += "</div>";
    html += '<button class="btn light small" id="addItem">+ Add line item</button>';
    html += '<label class="f">Deposit due at signing ($)</label><input type="number" id="jd_deposit" min="0" step="0.01" value="' + (job.deposit || 0) + '">';
    html += '<p><b>Quote total: <span id="qTotal">' + money(window.PandaPDF.total(job)) + '</span></b> <span class="muted small">(required items + accepted optionals)</span></p>';
    html += '<details class="ref"><summary>Internal price reference — owner only (never shown to the client)</summary>' +
      '<p class="small muted">Chicago-area market ranges from the 2026-10-27 competitor research. Orientation only — the final price is always the one Rigo writes in the quote.</p><table><tr><th>Service</th><th>Market range</th></tr>' +
      REF_RANGES.map(function (r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("") + "</table></details>";
    html += '<details class="ref"><summary>Terms &amp; conditions — shown to the client, included in the PDF</summary><textarea id="jd_terms" style="min-height:170px;margin-top:10px">' + esc(job.terms) + "</textarea></details>";
    html += '<div class="btn-row"><button class="btn primary" id="saveQuote">Save quote</button>' +
      '<button class="btn ghost" id="ownerPdf">Download PDF</button></div></div>';
    html += '<div class="card step"><h2><span class="stepn">2</span>Send to client</h2><p class="small muted">Client link (unique, no password). Send it straight from here:</p>' +
      '<code class="linkbox">' + esc(link) + "</code>";
    if (isDemoLink) html += '<p class="notice warn" id="demoLinkWarn">Demo link — only opens on this device until the app is deployed.</p>';
    html += '<label class="f" for="sendEmailTo">Send to email</label>' +
      '<input type="email" id="sendEmailTo" autocomplete="off" placeholder="name@example.com" value="' + esc(recipientEmail) + '">' +
      '<p class="small muted" id="sendEmailHint">' + (storedEmail
        ? "Prefilled with the client's email — change it here if this quote should go to someone else (a spouse, the office, a property manager…)."
        : "No email on file for this client — type the address to send to here.") + "</p>" +
      '<a href="#" id="saveClientEmail" class="small"' + (client && recipientValid && recipientEmail !== storedEmail ? "" : ' style="display:none"') + ">Save as client email</a>" +
      '<div id="sendEmailError"></div>';
    html += '<div class="btn-row">' +
      (hasPhone
        ? '<a class="btn primary" id="sendSms" href="' + esc(smsHref) + '">📱 Text message</a>'
        : '<a class="btn primary disabled" id="sendSms" aria-disabled="true">📱 Text message</a>') +
      (recipientValid
        ? '<button type="button" class="btn ghost" id="sendEmail">✉️ Email</button>'
        : '<button type="button" class="btn ghost disabled" id="sendEmail" aria-disabled="true">✉️ Email</button>') +
      '<button class="btn light" id="copyLink">Copy link</button></div>';
    if (!hasPhone) html += '<p class="small muted" id="sendPhoneHint">No phone number on file for this client — add one in the Clients tab to enable text message.</p>';
    html += '<div id="sendLogList">' + sendLogHTML(job) + "</div>";
    html += '<div class="btn-row"><button class="btn light" id="copySms">Copy ready-to-send text</button>' +
      '<button class="btn light" id="regenToken">Regenerate link</button></div>' +
      '<p class="small muted">Regenerating the link makes the old one stop working.</p></div>';

    /* Signatures & documents */
    html += '<div class="card"><h2>Signatures & documents</h2>';
    if (!job.signatures.length) html += '<p class="muted">No signatures yet.</p>';
    job.signatures.slice().reverse().forEach(function (s) {
      html += '<div class="list-row"><div class="grow"><b>v' + s.version + " — " + esc(s.name) + "</b><br><span class=\"muted small\">" + fmtDate(s.signedAt) + '</span></div><span class="pill">SIGNED</span></div>';
    });
    if (job.copyEmailLog && job.copyEmailLog.length) {
      html += '<h3>Signed-copy email log</h3>' + job.copyEmailLog.map(function (l) {
        return '<p class="small muted">' + fmtDate(l.at) + " → " + esc(l.to) + ": <b>" + esc(l.status) + "</b>" + (l.note ? " — " + esc(l.note) : "") + "</p>";
      }).join("");
    }
    var completionDocs = (job.documents || []).filter(function (d) { return d.kind === "completion-pdf"; });
    if (completionDocs.length) {
      html += '<h3>Completion reports</h3>' + (job.documents || []).map(function (d, ix) {
        if (d.kind !== "completion-pdf") return "";
        return '<div class="list-row"><div class="grow"><b>Completion report</b><br><span class="muted small">' +
          fmtDate(d.createdAt || d.completedAt || "") + (d.recipient ? " • for " + esc(d.recipient) : "") +
          (d.failedPhotoCount ? " • " + d.failedPhotoCount + " photo(s) could not be embedded" : "") +
          '</span></div>' + (d.pdfDataUrl
            ? '<button class="btn small light" data-download-completion="' + ix + '">Download</button>'
            : '<span class="pill">PDF recorded</span>') + "</div>";
      }).join("");
    }
    if (job.completionEmailLog && job.completionEmailLog.length) {
      html += '<h3>Completion email log</h3>' + job.completionEmailLog.map(function (l) {
        return '<p class="small muted">' + fmtDate(l.at) + " → " + esc(l.to) + ": <b>" + esc(l.status) + "</b>" + (l.note ? " — " + esc(l.note) : "") + "</p>";
      }).join("");
    }
    html += '<div class="btn-row"><button class="btn light" id="docPdf">Download signed PDF</button></div></div>';

    /* Execution — STEP 3: the appointment lives here now, next to the
       work it schedules (it used to be lost in the header card). */
    html += '<div class="card step"><h2><span class="stepn">3</span>Schedule, work &amp; photos</h2>' +
      '<div class="appt-box"><label class="f" style="margin-top:0">📅 Appointment (date &amp; time)</label>' +
      '<input type="datetime-local" id="jd_sched" value="' + esc(job.scheduledAt || "") + '">' +
      '<p class="small muted" style="margin:6px 0 0">The day and time of the installation or work — the client sees it in their link. Saved by the button below.</p></div>' +
      '<label class="f">Work performed (summary the client will see)</label><textarea id="jd_notes">' + esc(job.workNotes) + "</textarea>" +
      '<label class="f">Materials used</label><textarea id="jd_materials">' + esc(job.materials) + "</textarea>" +
      '<label class="f">Final total ($) — leave empty to use the quote total</label><input type="number" id="jd_final" min="0" step="0.01" value="' + (job.finalTotal == null ? "" : job.finalTotal) + '">' +
      '<label class="f">Payment</label><select id="jd_pay"><option value="pending"' + (job.paymentStatus === "pending" ? " selected" : "") + '>Pending</option><option value="paid"' + (job.paymentStatus === "paid" ? " selected" : "") + ">Paid</option></select>" +
      '<div class="btn-row"><button class="btn primary" id="saveExec">Save execution details</button></div>';
    ["assessment", "before", "after"].forEach(function (kind) {
      var label = kind === "assessment" ? "Assessment photos" : kind === "before" ? "BEFORE photos" : "AFTER photos";
      html += "<h3>" + label + '</h3><div class="photo-grid single">' +
        (job.photos[kind] || []).map(function (p, ix) {
          return '<figure><img src="' + p + '" alt="' + kind + ' photo"><figcaption>' + kind + " #" + (ix + 1) +
            ' <button class="btn small danger" data-del-photo="' + kind + ":" + ix + '">Remove</button></figcaption></figure>';
        }).join("") + "</div>" +
        '<label class="btn light file-btn" style="margin-top:8px">+ Add ' + kind + ' photo (camera or album)<input type="file" accept="image/*" data-photo-input="' + kind + '"></label>';
    });
    /* Completion: "Complete job" lives here, under the work + photos it
       sends as evidence. Draft/quote jobs cannot be completed (nothing
       signed yet); done/invoiced jobs show their completion state. */
    var pc = { assessment: (job.photos.assessment || []).length, before: (job.photos.before || []).length, after: (job.photos.after || []).length };
    var canComplete = job.signedVersion > 0 && ["signed", "scheduled", "in_progress"].indexOf(job.status) >= 0;
    html += '<div class="completion-zone"><h3>Completion</h3>';
    if (job.status === "done" || job.status === "invoiced") {
      html += '<div class="notice ok" id="completionState"><b>✓ Job completed</b>' +
        (job.completedAt ? " on " + fmtDate(job.completedAt) + "." : " (this job was marked Done before completion tracking, so no completion date was recorded).") +
        "<br>Completion evidence email: <b>" + esc(job.completionEmailStatus || "not sent through Complete job") + "</b>" +
        (job.completionEmailLog && job.completionEmailLog.length ? " — last to " + esc(job.completionEmailLog[job.completionEmailLog.length - 1].to) : "") +
        "</div>" +
        '<div class="btn-row"><button class="btn ghost" id="downloadCompletionPdf">Download completion PDF</button>' +
        (job.status === "done" && job.completionEmailStatus !== "sent"
          ? '<button class="btn primary" id="resendCompletionBtn">Re-send completion PDF</button>' : "") +
        "</div>" +
        (job.status === "invoiced"
          ? '<div class="btn-row"><button class="btn primary block" id="archiveJobBtn">🏁 Complete &amp; move to History</button></div>' +
            '<p class="small muted">Finished for good? This takes the job off the board and files it in <b>History</b> (photos, installation date &amp; time, notes, invoice and signed contract), searchable by name, phone or email.</p>'
          : "");
    } else if (canComplete) {
      html += '<p class="small muted">When the work and the photos above are ready, complete the job: the client gets ONE evidence PDF with the summary, materials, agreement, signature and all photos (' +
        pc.assessment + " assessment · " + pc.before + " before · " + pc.after + " after).</p>" +
        '<button class="btn primary block" id="completeJobBtn">✅ Complete job</button>';
    } else {
      html += '<p class="small muted" id="completeUnavailable">The <b>Complete job</b> button appears here once the client has signed and the job is scheduled or in progress. Draft and unsigned quotes cannot be completed.</p>';
    }
    if (canComplete || (job.status === "done" && job.completionEmailStatus !== "sent")) {
      html += '<div id="completeConfirm" class="confirm-panel" style="display:none">' +
        '<h3 id="completeConfirmTitle">Is this job complete?</h3>' +
        '<div id="completeConfirmBody"></div><div id="completeMsg"></div>' +
        '<div class="btn-row"><button class="btn light" id="completeCancel">Cancel</button>' +
        '<button class="btn primary" id="completeConfirmBtn">Yes, complete &amp; send PDF</button></div></div>';
    }
    html += "</div></div>";
    html += '<div class="card"><button class="btn danger" id="delJob">Delete this job</button></div>';
    html += "</main>" + footerHTML();
    app.innerHTML = html;
    wireJobDetail(job, client, link, sendMsg);
  }

  function qrowHTML(it, i) {
    return '<div class="qrow" data-qrow="' + i + '">' +
      '<input type="text" data-f="desc" placeholder="Description" value="' + esc(it.desc) + '">' +
      '<input type="number" data-f="qty" min="0" step="1" value="' + it.qty + '">' +
      '<input type="number" data-f="price" min="0" step="0.01" value="' + it.price + '">' +
      '<span class="small muted" data-line-total>' + money(it.qty * it.price) + "</span>" +
      '<button class="del" data-del-item="' + i + '" title="Remove item">×</button>' +
      '<label class="opt-toggle"><input type="checkbox" data-f="optional"' + (it.optional ? " checked" : "") + "> Optional item (client can accept/decline)" +
      ' &nbsp; <input type="checkbox" data-f="accepted"' + (it.accepted ? " checked" : "") + "> Accepted</label></div>";
  }

  function readQuoteFromForm(job) {
    job.title = document.getElementById("jd_title").value.trim();
    job.status = document.getElementById("jd_status").value;
    job.scheduledAt = document.getElementById("jd_sched").value;
    job.deposit = parseFloat(document.getElementById("jd_deposit").value) || 0;
    job.terms = document.getElementById("jd_terms").value;
    var rows = document.querySelectorAll("[data-qrow]");
    var items = [];
    rows.forEach(function (row) {
      items.push({
        desc: row.querySelector('[data-f="desc"]').value,
        qty: parseFloat(row.querySelector('[data-f="qty"]').value) || 0,
        price: parseFloat(row.querySelector('[data-f="price"]').value) || 0,
        optional: row.querySelector('[data-f="optional"]').checked,
        accepted: row.querySelector('[data-f="accepted"]').checked
      });
    });
    job.items = items;
    return job;
  }
  function quoteChanged(a, b) { return JSON.stringify(a) !== JSON.stringify(b); }

  function wireJobDetail(job, client, link, sendMsg) {
    var msg = document.getElementById("jobMsg");
    /* Direct-send logging (Text message only — the Email send is logged
       server-side by the Edge Function): records the channel on the job
       (fresh copy, so unsaved form edits and signed versions are never
       clobbered) and, while the job is still a draft, advances it to the
       "Quote sent" stage. The DOM is updated in place — no re-render —
       so the send link's default action (opening the messaging app) is
       never interrupted. */
    async function logSend(channel, recipient) {
      try {
        var fresh = (await D.getJob(job.id)) || job;
        fresh.sendLog = fresh.sendLog || [];
        var entry = { channel: channel, at: new Date().toISOString() };
        if (channel === "Email" && recipient) { entry.to = recipient; fresh.sendEmail = recipient; }
        fresh.sendLog.push(entry);
        if (fresh.status === "draft") fresh.status = "quote";
        await D.saveJob(fresh);
        job.sendLog = fresh.sendLog; job.status = fresh.status; job.sendEmail = fresh.sendEmail;
        var sel = document.getElementById("jd_status"); if (sel) sel.value = job.status;
        var box = document.getElementById("sendLogList"); if (box) box.innerHTML = sendLogHTML(job);
      } catch (e) { msg.innerHTML = errBox("Could not record the send: " + (e.message || e)); }
    }
    document.getElementById("backBtn").addEventListener("click", function () { ownerTab = "jobs"; renderOwner(); });
    document.getElementById("logoutBtn").addEventListener("click", doLogout);
    document.getElementById("addItem").addEventListener("click", async function () {
      readQuoteFromForm(job); job.items.push({ desc: "", qty: 1, price: 0, optional: false, accepted: true });
      await D.saveJob(job); renderJobDetail(job.id);
    });
    app.addEventListener("input", recalcTotals);
    document.querySelectorAll("[data-del-item]").forEach(function (b) {
      b.addEventListener("click", async function () { readQuoteFromForm(job); job.items.splice(+b.getAttribute("data-del-item"), 1); await D.saveJob(job); renderJobDetail(job.id); });
    });
    document.getElementById("saveQuote").addEventListener("click", async function () {
      var before = JSON.stringify({ i: job.items, d: job.deposit, t: job.terms, ti: job.title });
      readQuoteFromForm(job);
      var after = JSON.stringify({ i: job.items, d: job.deposit, t: job.terms, ti: job.title });
      if (job.signedVersion === job.version && quoteChanged(before, after)) {
        job.version += 1; // signed version stays locked; new version needs a new signature
        msg.innerHTML = '<div class="notice warn">Saved as <b>version ' + job.version + "</b>. The previously signed version is unchanged; the client must sign the new version.</div>";
      } else {
        msg.innerHTML = '<div class="notice ok">Quote saved.</div>';
      }
      await D.saveJob(job); window.scrollTo(0, 0);
      setTimeout(function () { renderJobDetail(job.id); }, 900);
    });
    document.getElementById("ownerPdf").addEventListener("click", async function () {
      readQuoteFromForm(job);
      await window.PandaPDF.download(job, client, { filename: "angry-panda-quote-v" + job.version + ".pdf" });
    });
    document.getElementById("docPdf").addEventListener("click", async function () {
      if (!job.signatures.length) { msg.innerHTML = errBox("No signature yet — the signed PDF is generated when the client signs."); return; }
      var sig = signedSig(job) || job.signatures[job.signatures.length - 1];
      await window.PandaPDF.download(job, client, { version: sig.version, filename: "angry-panda-signed-v" + sig.version + ".pdf" });
    });
    document.getElementById("copyLink").addEventListener("click", function () { copyText(link, this); });
    document.getElementById("copySms").addEventListener("click", function () { copyText(sendMsg, this); });
    var smsEl = document.getElementById("sendSms");
    if (smsEl && !smsEl.classList.contains("disabled")) smsEl.addEventListener("click", function () { logSend("Text message"); });
    /* Editable recipient email: the Email button sends the quote FOR
       REAL through the sign-and-email Edge Function (same Gmail path as
       the signed copy), to the address currently typed in #sendEmailTo —
       prefilled with job.sendEmail (last used on this job) or the
       client's stored email, and overwritable per send (spouse, office,
       property manager…). The server records the send in the history
       ONLY when the email actually went out; a failure shows its error
       here and logs nothing. (Before 2026-10-28 this button was a
       mailto: link that merely opened the owner's mail app — Rigo
       clicked it, the history claimed "Sent", and nothing ever left.) */
    var emailField = document.getElementById("sendEmailTo");
    var emailBtn = document.getElementById("sendEmail");
    var emailErr = document.getElementById("sendEmailError");
    var saveEmailLink = document.getElementById("saveClientEmail");
    function refreshEmailUI(showErr) {
      if (!emailField || !emailBtn) return;
      var addr = emailField.value.trim();
      var ok = validEmail(addr);
      if (ok) { emailBtn.classList.remove("disabled"); emailBtn.removeAttribute("aria-disabled"); }
      else { emailBtn.classList.add("disabled"); emailBtn.setAttribute("aria-disabled", "true"); }
      if (emailErr) emailErr.innerHTML = (showErr && addr && !ok) ? errBox("That doesn't look like a valid email address — check it before sending. Nothing was sent.") : (ok || !addr ? "" : emailErr.innerHTML);
      if (saveEmailLink) saveEmailLink.style.display = (client && ok && addr !== (client.email || "")) ? "" : "none";
    }
    if (emailField) {
      emailField.addEventListener("input", function () { refreshEmailUI(false); });
      emailField.addEventListener("change", async function () {
        refreshEmailUI(true);
        try {
          var fresh = (await D.getJob(job.id)) || job;
          fresh.sendEmail = emailField.value.trim();
          await D.saveJob(fresh);
          job.sendEmail = fresh.sendEmail;
        } catch (e) { /* non-fatal: the send click persists it too */ }
      });
    }
    if (emailBtn) emailBtn.addEventListener("click", async function () {
      var addr = emailField ? emailField.value.trim() : "";
      if (!validEmail(addr)) {
        if (emailErr) emailErr.innerHTML = errBox("Type a valid email address in “Send to email” first (e.g. name@example.com) — nothing was sent.");
        return;
      }
      if (emailErr) emailErr.innerHTML = "";
      var originalLabel = emailBtn.textContent;
      emailBtn.disabled = true; emailBtn.classList.add("disabled"); emailBtn.textContent = "Sending…";
      try {
        var res = await D.sendQuoteEmail(job.token, addr);
        if (res && res.emailStatus === "sent") {
          var fresh = (await D.getJob(job.id)) || job;
          job.sendLog = fresh.sendLog; job.status = fresh.status; job.sendEmail = fresh.sendEmail;
          var sel = document.getElementById("jd_status"); if (sel) sel.value = job.status;
          var box = document.getElementById("sendLogList"); if (box) box.innerHTML = sendLogHTML(job);
          if (emailErr) emailErr.innerHTML = '<div class="notice ok">Quote emailed to ' + esc(addr) + " ✓</div>";
        } else {
          if (emailErr) emailErr.innerHTML = errBox("The email could not be sent" + (res && res.emailError ? ": " + res.emailError : ".") + " Nothing was logged — check the address and try again.");
        }
      } catch (e2) {
        if (emailErr) emailErr.innerHTML = errBox("The email could not be sent: " + (e2.message || e2) + " Nothing was logged.");
      }
      emailBtn.disabled = false; emailBtn.classList.remove("disabled"); emailBtn.textContent = originalLabel;
    });
    if (saveEmailLink) saveEmailLink.addEventListener("click", async function (e) {
      e.preventDefault();
      var addr = emailField ? emailField.value.trim() : "";
      if (!client || !validEmail(addr)) return;
      try {
        await D.saveClient(Object.assign({}, client, { email: addr }));
        client.email = addr;
        refreshEmailUI(false);
        msg.innerHTML = '<div class="notice ok">Client email updated to ' + esc(addr) + ".</div>";
      } catch (err2) { msg.innerHTML = errBox("Could not update the client email: " + (err2.message || err2)); }
    });
    document.getElementById("regenToken").addEventListener("click", async function () {
      if (!confirm("Regenerate the client link? The old link will stop working.")) return;
      job.token = D.newToken(); await D.saveJob(job); renderJobDetail(job.id);
    });
    document.getElementById("saveExec").addEventListener("click", async function () {
      job.workNotes = document.getElementById("jd_notes").value;
      job.materials = document.getElementById("jd_materials").value;
      var f = document.getElementById("jd_final").value;
      job.finalTotal = f === "" ? null : parseFloat(f);
      job.paymentStatus = document.getElementById("jd_pay").value;
      job.status = document.getElementById("jd_status").value;
      job.scheduledAt = document.getElementById("jd_sched").value;
      await D.saveJob(job);
      msg.innerHTML = '<div class="notice ok">Execution details saved — the client portal is updated.</div>'; window.scrollTo(0, 0);
    });
    /* ---------- Complete job ----------
       Flow: open panel (no writes) -> Cancel leaves everything untouched
       -> Confirm persists the CURRENT execution form first, generates
       the evidence PDF, records it as a "completion-pdf" document, then
       D.completeJob marks Done + emails it (demo simulates; live goes
       through the Edge Function action "complete"). Email failure never
       undoes the completion — see the catch path and the done state. */
    var completionMode = "complete";
    function completionCounts() {
      return {
        assessment: (job.photos.assessment || []).length,
        before: (job.photos.before || []).length,
        after: (job.photos.after || []).length
      };
    }
    function completionRecipient() {
      var f = document.getElementById("sendEmailTo");
      return (f ? f.value : (job.sendEmail || (client ? client.email : "")) || "").trim();
    }
    function readExecutionInto(target) {
      target.workNotes = document.getElementById("jd_notes").value;
      target.materials = document.getElementById("jd_materials").value;
      var f = document.getElementById("jd_final").value;
      target.finalTotal = f === "" ? null : parseFloat(f);
      target.paymentStatus = document.getElementById("jd_pay").value;
      target.scheduledAt = document.getElementById("jd_sched").value;
      return target;
    }
    function openCompletionPanel(mode) {
      completionMode = mode;
      var panel = document.getElementById("completeConfirm"); if (!panel) return;
      var recipient = completionRecipient();
      var counts = completionCounts();
      var totalPhotos = counts.assessment + counts.before + counts.after;
      var notes = document.getElementById("jd_notes").value.trim();
      var mats = document.getElementById("jd_materials").value.trim();
      var okRecipient = validEmail(recipient);
      document.getElementById("completeConfirmTitle").textContent =
        mode === "resend" ? "Re-send the completion PDF?" : "Is this job complete?";
      var bodyHtml = mode === "resend"
        ? '<p>This will re-send the completion evidence PDF for this job. The job stays <b>Done</b> and keeps its original completion date.</p>'
        : '<p>This will mark the job <b>Done</b>, save the work details as currently typed, generate ONE evidence PDF and email it to the client.</p>';
      bodyHtml += '<ul class="small">' +
        '<li>Assessment photos: <b>' + counts.assessment + '</b></li>' +
        '<li>BEFORE photos: <b>' + counts.before + '</b></li>' +
        '<li>AFTER photos: <b>' + counts.after + '</b></li>' +
        '<li>Work summary: <b>' + (notes ? "included" : "not written") + '</b></li>' +
        '<li>Materials: <b>' + (mats ? "included" : "not written") + '</b></li>' +
        '<li>Recipient: <b>' + esc(recipient || "(no email)") + '</b></li></ul>';
      if (!totalPhotos) bodyHtml += '<div class="notice warn"><b>No photos uploaded.</b> The PDF will still be sent, but it will contain no photo evidence. Add photos above first if the client should receive them.</div>';
      if (!okRecipient) bodyHtml += errBox("No valid recipient email — type one in the \u201cSend to email\u201d field above (or fix the client's email in the Clients tab). The job was NOT completed and nothing was sent.");
      document.getElementById("completeConfirmBody").innerHTML = bodyHtml;
      document.getElementById("completeMsg").innerHTML = "";
      var confirmBtn = document.getElementById("completeConfirmBtn");
      confirmBtn.textContent = mode === "resend" ? "Yes, re-send PDF" : "Yes, complete & send PDF";
      confirmBtn.disabled = !okRecipient;
      panel.style.display = "";
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    var completeBtn = document.getElementById("completeJobBtn");
    if (completeBtn) completeBtn.addEventListener("click", function () { openCompletionPanel("complete"); });
    var resendBtn = document.getElementById("resendCompletionBtn");
    if (resendBtn) resendBtn.addEventListener("click", function () { openCompletionPanel("resend"); });
    var completeCancel = document.getElementById("completeCancel");
    if (completeCancel) completeCancel.addEventListener("click", function () {
      var panel = document.getElementById("completeConfirm");
      if (panel) panel.style.display = "none";
    });
    var completeConfirmBtn = document.getElementById("completeConfirmBtn");
    if (completeConfirmBtn) completeConfirmBtn.addEventListener("click", async function () {
      var recipient = completionRecipient();
      var panelMsg = document.getElementById("completeMsg");
      if (!validEmail(recipient)) {
        panelMsg.innerHTML = errBox("No valid recipient email — the job was NOT completed and nothing was sent.");
        return;
      }
      completeConfirmBtn.disabled = true;
      if (completeCancel) completeCancel.disabled = true;
      completeConfirmBtn.textContent = "Working…";
      try {
        // 1) Persist the latest execution-form values + the recipient
        //    override BEFORE anything is generated or marked.
        readExecutionInto(job);
        job.sendEmail = recipient;
        await D.saveJob(job);
        // 2) Generate the evidence PDF from the just-saved values.
        var completedAt = completionMode === "resend" && job.completedAt
          ? job.completedAt : new Date().toISOString();
        var pdfJob = Object.assign({}, job, { status: "done", completedAt: completedAt });
        var made = await window.PandaPDF.completionBase64(pdfJob, client, { completedAt: completedAt });
        var stats = made.stats;
        // 3) Record the PDF as a completion document.
        await D.saveDocument(job.id, {
          version: job.version, kind: "completion-pdf",
          pdfDataUrl: "data:application/pdf;base64," + made.base64,
          recipient: recipient, photoCounts: stats.photoCounts,
          embeddedPhotoCount: stats.embeddedPhotoCount,
          failedPhotoCount: stats.failedPhotoCount, completedAt: completedAt
        });
        // 4) Mark Done + send (demo simulates; live = Edge Function).
        var result;
        try {
          result = await D.completeJob(job.token, {
            recipientEmail: recipient, pdfBase64: made.base64,
            photoCounts: stats.photoCounts,
            embeddedPhotoCount: stats.embeddedPhotoCount,
            failedPhotoCount: stats.failedPhotoCount,
            completedAt: completedAt, resend: completionMode === "resend"
          });
        } catch (sendErr) {
          // If the completion DID land server-side but the response was
          // lost, keep the completion and record the email as failed.
          var fresh = null;
          try { fresh = await D.getJob(job.id); } catch (e2) { /* ignore */ }
          if (fresh && fresh.status === "done") {
            fresh.completionEmailStatus = "failed";
            fresh.completionEmailLog = fresh.completionEmailLog || [];
            fresh.completionEmailLog.push({
              at: new Date().toISOString(), to: recipient, status: "failed",
              note: "Job completed and PDF recorded, but the email request failed: " + (sendErr.message || sendErr),
              photoCounts: stats.photoCounts, embeddedPhotoCount: stats.embeddedPhotoCount,
              failedPhotoCount: stats.failedPhotoCount
            });
            try { await D.saveJob(fresh); } catch (e3) { /* status stays failed in the UI message */ }
            result = { ok: true, emailStatus: "failed", completedAt: fresh.completedAt || completedAt };
          } else { throw sendErr; }
        }
        var emailStatus = (result && result.emailStatus) || "";
        await renderJobDetail(job.id);
        var m2 = document.getElementById("jobMsg");
        if (m2) {
          if (emailStatus === "failed") {
            m2.innerHTML = '<div class="notice bad"><b>Job completed.</b> The evidence PDF was generated and recorded, but the completion email <b>failed</b> — the job stays Done and the PDF can be re-sent from the completion section below.</div>';
          } else if (String(emailStatus).indexOf("demo") === 0) {
            m2.innerHTML = '<div class="notice warn"><b>Job completed (demo).</b> The evidence PDF was generated and recorded; the completion email is <b>simulated</b> in demo mode — nothing was actually sent.</div>';
          } else {
            m2.innerHTML = '<div class="notice ok"><b>Job completed.</b> The evidence PDF was emailed to ' + esc(recipient) + ".</div>";
          }
          if (stats.failedPhotoCount) {
            m2.innerHTML += '<div class="notice warn">' + stats.failedPhotoCount + " photo(s) could not be embedded in the PDF (the rest of the evidence was included).</div>";
          }
          window.scrollTo(0, 0);
        }
      } catch (e) {
        panelMsg.innerHTML = errBox("Could not complete the job: " + (e.message || e));
        completeConfirmBtn.disabled = false;
        if (completeCancel) completeCancel.disabled = false;
        completeConfirmBtn.textContent = completionMode === "resend" ? "Yes, re-send PDF" : "Yes, complete & send PDF";
      }
    });
    var archiveBtn = document.getElementById("archiveJobBtn");
    if (archiveBtn) archiveBtn.addEventListener("click", async function () {
      if (!confirm("Finish this job and move it to History? It will leave the Jobs board — you can restore it from History anytime.")) return;
      try {
        var fresh = (await D.getJob(job.id)) || job;
        fresh.archivedAt = new Date().toISOString();
        await D.saveJob(fresh);
        ownerTab = "jobs"; renderOwner();
      } catch (e) { msg.innerHTML = errBox("Could not move the job to History: " + (e.message || e)); }
    });
    var dlCompletion = document.getElementById("downloadCompletionPdf");
    if (dlCompletion) dlCompletion.addEventListener("click", async function () {
      try {
        var st = await window.PandaPDF.completionDownload(job, client, {
          completedAt: job.completedAt || undefined,
          filename: "angry-panda-completion-report.pdf"
        });
        if (st && st.failedPhotoCount) msg.innerHTML = '<div class="notice warn">' + st.failedPhotoCount + " photo(s) could not be embedded in the downloaded PDF.</div>";
      } catch (e) { msg.innerHTML = errBox("Could not generate the completion PDF: " + (e.message || e)); }
    });
    document.querySelectorAll("[data-download-completion]").forEach(function (b) {
      b.addEventListener("click", function () {
        var d = (job.documents || [])[+b.getAttribute("data-download-completion")];
        if (!d || !d.pdfDataUrl) return;
        var a = document.createElement("a");
        a.href = d.pdfDataUrl; a.download = "angry-panda-completion-report.pdf";
        document.body.appendChild(a); a.click(); a.remove();
      });
    });
    document.querySelectorAll("[data-photo-input]").forEach(function (inp) {
      inp.addEventListener("change", async function () {
        var file = inp.files && inp.files[0]; if (!file) return;
        var kind = inp.getAttribute("data-photo-input");
        try {
          var dataUrl = await processPhotoFile(file);
          await D.addPhoto(job.id, kind, dataUrl);
          renderJobDetail(job.id);
        } catch (e) { msg.innerHTML = errBox("Photo upload failed: " + (e.message || e)); }
      });
    });
    document.querySelectorAll("[data-del-photo]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var parts = b.getAttribute("data-del-photo").split(":");
        await D.removePhoto(job.id, parts[0], +parts[1]); renderJobDetail(job.id);
      });
    });
    document.getElementById("delJob").addEventListener("click", async function () {
      if (!confirm("Delete this job and its data? This cannot be undone.")) return;
      await D.deleteJob(job.id); ownerTab = "jobs"; renderOwner();
    });
  }
  function recalcTotals() {
    var tot = document.getElementById("qTotal"); if (!tot) return;
    var sum = 0;
    document.querySelectorAll("[data-qrow]").forEach(function (row) {
      var q = parseFloat(row.querySelector('[data-f="qty"]').value) || 0;
      var p = parseFloat(row.querySelector('[data-f="price"]').value) || 0;
      var lt = row.querySelector("[data-line-total]"); if (lt) lt.textContent = money(q * p);
      if (!row.querySelector('[data-f="optional"]').checked || row.querySelector('[data-f="accepted"]').checked) sum += q * p;
    });
    tot.textContent = money(sum);
  }
  function copyText(t, btn) {
    function done() { var old = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(function () { btn.textContent = old; }, 1600); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, done);
    else { var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove(); done(); }
  }
  async function doLogout() {
    sessionStorage.removeItem("pj.demoAuth"); sessionStorage.removeItem("pj.liveAuth");
    if (!DEMO) { try { await D.supabase().auth.signOut(); } catch (e) {} }
    renderLogin();
  }

  function wireOwner(clients, jobs, byClient) {
    document.getElementById("logoutBtn").addEventListener("click", doLogout);
    /* Account toggle (live mode only): the card renders collapsed on every
       render/route change; clicking "Account" in the header shows/hides it
       in place — no re-render, so typed passwords are never clobbered by
       toggling and the card never lingers open across tabs. */
    var acctToggle = document.getElementById("acctToggle");
    if (acctToggle) acctToggle.addEventListener("click", function () {
      var card = document.getElementById("acctCard");
      if (!card) return;
      var show = card.style.display === "none";
      card.style.display = show ? "" : "none";
      acctToggle.setAttribute("aria-expanded", show ? "true" : "false");
    });
    /* Account card (live mode only): set/change the owner's password. Works
       for any live session — including one that started from an email
       invitation or recovery link, which is the primary case. */
    var acctBtn = document.getElementById("acctSave");
    if (acctBtn) acctBtn.addEventListener("click", async function () {
      var m = document.getElementById("acctMsg");
      var p1 = document.getElementById("acctPw1").value;
      var p2 = document.getElementById("acctPw2").value;
      if (p1.length < 8) { m.innerHTML = errBox("Password must be at least 8 characters."); return; }
      if (p1 !== p2) { m.innerHTML = errBox("Passwords do not match — type the same password in both fields."); return; }
      acctBtn.disabled = true; acctBtn.textContent = "Saving…";
      try {
        var r = await D.supabase().auth.updateUser({ password: p1 });
        if (r.error) throw r.error;
        document.getElementById("acctPw1").value = "";
        document.getElementById("acctPw2").value = "";
        m.innerHTML = '<div class="notice ok">Password saved — use it to log in next time.</div>';
      } catch (e) { m.innerHTML = errBox((e && e.message) || String(e)); }
      acctBtn.disabled = false; acctBtn.textContent = "Save password";
    });
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { ownerTab = b.getAttribute("data-tab"); renderOwner(); });
    });
    document.querySelectorAll("[data-open-job]").forEach(function (b) {
      b.addEventListener("click", function () { renderJobDetail(b.getAttribute("data-open-job")); });
    });
    document.querySelectorAll("[data-board-filter]").forEach(function (b) {
      b.addEventListener("click", function () { boardFilter = b.getAttribute("data-board-filter"); renderOwner(); });
    });
    /* History tab: open a record, and live-search by name / phone / email
       (phone matching is digit-based, so "(312) 555-0147" and "3125550147"
       find the same record). */
    document.querySelectorAll("[data-open-history]").forEach(function (b) {
      b.addEventListener("click", function () { renderHistoryRecord(b.getAttribute("data-open-history")); });
    });
    var hSearch = document.getElementById("historySearch");
    if (hSearch) hSearch.addEventListener("input", function () {
      var q = hSearch.value.trim().toLowerCase();
      var qd = q.replace(/\D/g, "");
      var anyVisible = false;
      document.querySelectorAll("[data-open-history]").forEach(function (el) {
        var hit = !q || (el.getAttribute("data-search") || "").indexOf(q) >= 0 ||
          (qd.length >= 3 && (el.getAttribute("data-phone") || "").indexOf(qd) >= 0);
        el.style.display = hit ? "" : "none";
        if (hit) anyVisible = true;
      });
      var nm = document.getElementById("historyNoMatch");
      if (nm) nm.style.display = anyVisible ? "none" : "";
    });
    var saveBtn = document.getElementById("cf_save");
    if (saveBtn) {
      saveBtn.addEventListener("click", async function () {
        var c = {
          id: document.getElementById("cf_id").value || undefined,
          name: document.getElementById("cf_name").value.trim(),
          phone: document.getElementById("cf_phone").value.trim(),
          email: document.getElementById("cf_email").value.trim(),
          address: document.getElementById("cf_address").value.trim(),
          equipment: document.getElementById("cf_equipment").value.trim(),
          notes: document.getElementById("cf_notes").value.trim()
        };
        var m = document.getElementById("clientMsg");
        if (!c.name) { m.innerHTML = errBox("The client's name is required."); return; }
        if (!c.email) { m.innerHTML = errBox("The client's email is required — the signed copy is emailed automatically."); return; }
        await D.saveClient(c); renderOwner();
      });
      document.getElementById("cf_clear").addEventListener("click", function () { renderOwner(); });
      document.querySelectorAll("[data-edit-client]").forEach(function (b) {
        b.addEventListener("click", function () {
          var c = clients.filter(function (x) { return x.id === b.getAttribute("data-edit-client"); })[0]; if (!c) return;
          document.getElementById("cf_id").value = c.id;
          document.getElementById("cf_name").value = c.name || "";
          document.getElementById("cf_phone").value = c.phone || "";
          document.getElementById("cf_email").value = c.email || "";
          document.getElementById("cf_address").value = c.address || "";
          document.getElementById("cf_equipment").value = c.equipment || "";
          document.getElementById("cf_notes").value = c.notes || "";
          document.getElementById("clientFormTitle").textContent = "Edit client";
          window.scrollTo(0, document.body.scrollHeight);
        });
      });
      document.querySelectorAll("[data-del-client]").forEach(function (b) {
        b.addEventListener("click", async function () {
          if (!confirm("Delete this client AND all their jobs? This cannot be undone.")) return;
          await D.deleteClient(b.getAttribute("data-del-client")); renderOwner();
        });
      });
    }
    var nj = document.getElementById("nj_create");
    if (nj) nj.addEventListener("click", async function () {
      var job = D.newJob(document.getElementById("nj_client").value);
      job.title = document.getElementById("nj_title").value.trim();
      await D.saveJob(job); renderJobDetail(job.id);
    });
  }

  /* ================= CLIENT PORTAL ================= */
  async function renderClient(token) {
    var job = await D.getJobByToken(token);
    if (!job) {
      app.innerHTML = headerHTML("") +
        '<main class="wrap"><div class="card center"><img src="assets/logo.png" alt="" style="width:84px">' +
        "<h2>This link is not valid</h2>" +
        '<p class="muted">This link may be old or incomplete. Please contact Angry Panda Heating and Cooling and we will send you a fresh link right away.</p>' +
        '<div class="btn-row"><a class="btn primary" href="mailto:angrypandahvac@gmail.com?subject=Help%20with%20my%20Panda%20Jobs%20link">✉️ Email us</a></div></div></main>' + footerHTML();
      return;
    }
    var client = null;
    if (DEMO) {
      var clients = await D.listClients();
      client = clients.filter(function (c) { return c.id === job.clientId; })[0] || null;
    } else if (job.client) { client = job.client; }
    var sig = signedSig(job);
    // "Signed" applies to the CURRENT version only: if the owner edited the
    // quote after signing, the portal must ask for a fresh signature on the
    // new version while the old signed version stays intact.
    var alreadySigned = !!sig && job.signedVersion === job.version;
    var prevSig = (!alreadySigned && sig) ? sig : null;
    var beforePhotos = job.photos.before || [], afterPhotos = job.photos.after || [], assessPhotos = job.photos.assessment || [];

    var html = '<div class="client-head"><img src="assets/logo.png" alt="Angry Panda Heating and Cooling logo">' +
      "<h1>Angry Panda Heating and Cooling</h1>" +
      "<p>Heating • Air Conditioning • Water Heaters</p><p>" + esc(COMPANY.cert) + " • Chicago, IL</p></div>";
    html += '<main class="wrap">';
    html += '<div class="btn-row"><a class="btn primary" href="mailto:angrypandahvac@gmail.com?subject=Help%20with%20my%20heating%2FAC%20unit">✉️ Email us</a></div>';
    html += statusTimeline(job);
    if (job.scheduledAt) html += '<div class="notice ok center">📅 Your appointment: <b>' + fmtDate(job.scheduledAt) + "</b></div>";
    if (job.copyEmailStatus === "failed" && alreadySigned) html += '<div class="notice warn">We could not email your signed copy — you can download it below, it is saved and valid.</div>';

    /* Quote card */
    html += '<section class="card"><h2>' + (alreadySigned ? "Your signed agreement" : "Your quote") + (job.title ? " — " + esc(job.title) : "") + "</h2>";
    html += '<p class="muted small">Prepared for ' + esc(client ? client.name : "you") + " • Quote version " + job.version + "</p>";
    if (prevSig) html += '<div class="notice warn">You signed version ' + prevSig.version + " on " + fmtDate(prevSig.signedAt) + ". This quote was updated to <b>version " + job.version + "</b> — please review the changes and sign the new version below. Your signed version " + prevSig.version + " stays on file, unchanged.</div>";
    html += '<table class="items"><tr><th>Description</th><th class="num">Qty</th><th class="num">Amount</th></tr>';
    job.items.forEach(function (it, i) {
      if (it.optional) {
        html += '<tr class="opt-row"><td><label class="check" style="margin:0"><input type="checkbox" data-opt="' + i + '"' +
          (it.accepted ? " checked" : "") + (alreadySigned ? " disabled" : "") + "><span><b>Optional:</b> " + esc(it.desc) + "</span></label></td>" +
          '<td class="num">' + it.qty + '</td><td class="num">' + money(it.qty * it.price) + "</td></tr>";
      } else {
        html += "<tr><td>" + esc(it.desc) + '</td><td class="num">' + it.qty + '</td><td class="num">' + money(it.qty * it.price) + "</td></tr>";
      }
    });
    html += '<tr class="total"><td colspan="2">Total' + (job.finalTotal != null ? " (final)" : "") + '</td><td class="num" id="cTotal">' + money(job.finalTotal != null ? job.finalTotal : window.PandaPDF.total(job)) + "</td></tr></table>";
    if (job.deposit) html += '<p class="small muted">Deposit due at signing: <b>' + money(job.deposit) + "</b> • Balance due on completion.</p>";
    html += "</section>";

    if (assessPhotos.length) {
      html += '<section class="card"><h2>Assessment photos</h2><div class="photo-grid">' +
        assessPhotos.map(function (p, i) { return '<figure><img src="' + p + '" alt="Assessment photo ' + (i + 1) + '"></figure>'; }).join("") + "</div></section>";
    }

    /* Terms + signature */
    html += '<section class="card"><h2>Terms &amp; conditions</h2><div class="small" style="white-space:pre-wrap">' + esc(job.terms) + "</div>";
    if (alreadySigned) {
      html += '<div class="sig-locked"><p><b>✓ Signed</b> by ' + esc(sig.name) + "<br><span class=\"muted small\">" + fmtDate(sig.signedAt) + "</span></p>" +
        '<img src="' + sig.signatureDataUrl + '" alt="Client signature"></div>';
      html += '<p class="small muted">A copy of your signed agreement was sent to your email automatically.</p>';
      html += '<div class="btn-row"><button class="btn primary" id="dlSigned">Download my signed PDF</button></div>';
    } else {
      html += '<div id="signMsg"></div>' +
        '<label class="f">Your full name (printed)</label><input type="text" id="sigName" autocomplete="name" placeholder="e.g. Maria Lopez">' +
        '<label class="f">Sign with your finger or mouse</label>' +
        '<div class="sig-wrap"><canvas class="sig" id="sigPad" width="640" height="190"></canvas><div class="sig-hint" id="sigHint">Sign here</div></div>' +
        '<div class="btn-row"><button class="btn light small" id="sigClear">Clear signature</button></div>' +
        '<label class="check"><input type="checkbox" id="agree"><span>I agree to the terms above and authorize Angry Panda Heating and Cooling to perform the work in this quote.</span></label>' +
        '<div class="btn-row"><button class="btn primary" id="signBtn">Sign &amp; accept</button></div>' +
        '<p class="small muted">When you sign, your signed copy is emailed to you automatically, and a copy goes to Angry Panda.</p>';
    }
    html += "</section>";

    /* Progress: before / after + summary */
    if (beforePhotos.length || afterPhotos.length || job.workNotes || job.status === "done" || job.status === "invoiced") {
      html += '<section class="card"><h2>Your job</h2>';
      html += '<p>Status: <span class="pill">' + esc(stageLabel(job.status)) + "</span> " +
        (job.paymentStatus === "paid" ? '<span class="pill">PAID</span>' : '<span class="pill amber">Payment pending</span>') + "</p>";
      if ((job.status === "done" || job.status === "invoiced") && job.completedAt) {
        html += '<p class="small muted">Completed on <b>' + fmtDate(job.completedAt) + "</b>.</p>";
      }
      if (job.workNotes) html += "<h3>What we did</h3><p style=\"white-space:pre-wrap\">" + esc(job.workNotes) + "</p>";
      if (job.materials) html += "<h3>Materials used</h3><p style=\"white-space:pre-wrap\">" + esc(job.materials) + "</p>";
      html += '<div class="photo-grid">';
      html += "<figure>" + (beforePhotos[0] ? '<img src="' + beforePhotos[0] + '" alt="Before photo">' : '<div class="empty-ph">Before photo coming soon</div>') + "<figcaption><b>Before</b></figcaption></figure>";
      html += "<figure>" + (afterPhotos[0] ? '<img src="' + afterPhotos[0] + '" alt="After photo">' : '<div class="empty-ph">After photo coming soon</div>') + "<figcaption><b>After</b></figcaption></figure>";
      html += "</div>";
      if (beforePhotos.length > 1 || afterPhotos.length > 1) {
        html += '<div class="photo-grid" style="margin-top:10px">' +
          beforePhotos.slice(1).map(function (p, i) { return '<figure><img src="' + p + '" alt="Before photo ' + (i + 2) + '"><figcaption>Before</figcaption></figure>'; }).join("") +
          afterPhotos.slice(1).map(function (p, i) { return '<figure><img src="' + p + '" alt="After photo ' + (i + 2) + '"><figcaption>After</figcaption></figure>'; }).join("") + "</div>";
      }
      if (alreadySigned) html += '<div class="btn-row"><button class="btn ghost" id="dlSigned2">Download my signed PDF</button></div>';
      html += "</section>";
    }
    html += "</main>" + footerHTML();
    app.innerHTML = html;
    wireClient(job, client, alreadySigned);
  }

  function wireClient(job, client, alreadySigned) {
    function download() {
      var sig = signedSig(job) || job.signatures[job.signatures.length - 1];
      window.PandaPDF.download(job, client, { version: sig ? sig.version : job.version, filename: "angry-panda-signed-agreement.pdf" });
    }
    var d1 = document.getElementById("dlSigned"); if (d1) d1.addEventListener("click", download);
    var d2 = document.getElementById("dlSigned2"); if (d2) d2.addEventListener("click", download);

    /* Optional items: update total live; locked after signing */
    document.querySelectorAll("[data-opt]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        job.items[+cb.getAttribute("data-opt")].accepted = cb.checked;
        var el = document.getElementById("cTotal");
        if (el && job.finalTotal == null) el.textContent = money(window.PandaPDF.total(job));
      });
    });
    if (alreadySigned) return;

    /* Signature pad — pointer events (finger on iOS, mouse on PC) */
    var canvas = document.getElementById("sigPad");
    var ctx = canvas.getContext("2d");
    var drawing = false, hasInk = false, last = null;
    function resizePad() {
      var data = hasInk ? canvas.toDataURL() : null;
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(190 * dpr);
      ctx.lineWidth = 2.4 * dpr; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#14261a";
      if (data) { var im = new Image(); im.onload = function () { ctx.drawImage(im, 0, 0, canvas.width, canvas.height); }; im.src = data; }
    }
    resizePad();
    window.addEventListener("resize", resizePad);
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
    canvas.addEventListener("pointerdown", function (e) { e.preventDefault(); drawing = true; last = pos(e); try { canvas.setPointerCapture(e.pointerId); } catch (err) {} });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return; e.preventDefault();
      var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p;
      if (!hasInk) { hasInk = true; var h = document.getElementById("sigHint"); if (h) h.style.display = "none"; }
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { canvas.addEventListener(ev, function () { drawing = false; }); });
    document.getElementById("sigClear").addEventListener("click", function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false;
      var h = document.getElementById("sigHint"); if (h) h.style.display = "";
    });

    document.getElementById("signBtn").addEventListener("click", async function () {
      var msg = document.getElementById("signMsg");
      var name = document.getElementById("sigName").value.trim();
      var agree = document.getElementById("agree").checked;
      if (!hasInk) { msg.innerHTML = errBox("Please sign in the box above — your signature is required."); canvas.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      if (!name) { msg.innerHTML = errBox("Please type your full name."); return; }
      if (!agree) { msg.innerHTML = errBox("Please check “I agree to the terms” to continue."); return; }
      var btn = this; btn.disabled = true; btn.textContent = "Signing…";
      try {
        var acceptedIdx = [];
        job.items.forEach(function (it, i) { if (it.optional && it.accepted) acceptedIdx.push(i); });
        var sigUrl = canvas.toDataURL("image/png");
        if (DEMO) {
          job = await D.signJob(job.token, { name: name, signatureDataUrl: sigUrl, acceptedOptionals: acceptedIdx });
        } else {
          await D.signJob(job.token, { name: name, signatureDataUrl: sigUrl, acceptedOptionals: acceptedIdx });
          job = await D.getJobByToken(job.token);
        }
        /* Signed PDF -> stored document; demo simulates the automatic email.
           In live mode the Edge Function already recorded the signed
           document server-side (service role), and this anonymous portal
           client has no INSERT policy on documents — so a failure here must
           never break the signed confirmation. */
        var sig = signedSig(job);
        var pdfUrl = await window.PandaPDF.dataUrl(job, client, { version: sig ? sig.version : job.version });
        try { await D.saveDocument(job.id, { version: sig ? sig.version : job.version, pdfDataUrl: pdfUrl }); } catch (e) { /* server copy already saved */ }
        job = (await D.getJobByToken(job.token)) || job;
        renderClient(job.token);
        window.scrollTo(0, 0);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Sign & accept";
        msg.innerHTML = errBox("Something went wrong while signing: " + (e.message || e) + " — please try again or contact us by email.");
      }
    });
  }

  /* ================= ROUTER ================= */
  function route() {
    var h = location.hash || "#/";
    var m = h.match(/^#\/c\/(.+)$/);
    app.innerHTML = '<div class="loading">Loading Panda Jobs…</div>';
    if (m) renderClient(decodeURIComponent(m[1]));
    else renderOwner();
  }
  window.addEventListener("hashchange", route);
  route();
})();
