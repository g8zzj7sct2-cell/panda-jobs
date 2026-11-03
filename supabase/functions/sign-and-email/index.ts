// Panda Jobs — `sign-and-email` Edge Function (Plan Task 7, live mode).
//
// POST { action: "sign", token, name, signatureDataUrl, acceptedOptionals: number[], pdfBase64? }
// POST { action: "complete", token, recipientEmail, pdfBase64, photoCounts,
//        embeddedPhotoCount?, failedPhotoCount?, completedAt?, resend? }
// POST { action: "send-quote", token, recipientEmail }   (owner JWT required)
//
// action "send-quote" (owner presses "Email" in the panel — added
// 2026-10-28 after Rigo found the old mailto button never sent anything):
//   1. Require a signed-in owner: the panel's supabase-js invoke attaches
//      the owner's session JWT; it is verified with the ANON key client.
//      The client token alone is NOT enough (a link holder must not be
//      able to trigger quote emails).
//   2. Load the job + its quote items by token (service role).
//   3. Email the quote (summary + totals + the client link) to the
//      recipient the owner typed, bcc to the company, via the same
//      Gmail SMTP path as the other actions.
//   4. ONLY on success, record the send in the job's send_log (channel
//      "Email", recipient), remember send_email and advance a draft to
//      "quote" — the panel history therefore only lists REAL sends.
//      A failed send logs nothing and returns emailStatus "failed".
//
// action "complete" (owner presses "Send evidence" on the In progress
// stage — ronda 2026-11-02):
//   1. Verify the token identifies a SIGNED job in a completable state
//      (signed / scheduled / in_progress, or done for a re-send).
//   2. Email FIRST: the browser-generated evidence PDF (payload
//      pdfBase64, pdf.js adaptive profiles keep it <= ~2.75M base64
//      chars) plus every photo as an individual JPEG attachment
//      (payload photoAttachments), to the recipient with a bcc copy to
//      the company. The email body keeps the summary (work, materials,
//      final total) and the portal button as backup. Server-side PDF
//      generation is NOT done here — it died on the CPU limit (546).
//   3. ONLY when the email actually went out, mark the job Done
//      server-side (status + completed_at; a re-send keeps the
//      original completed_at). If the email FAILS, the job KEEPS its
//      current stage (it is NOT moved to Done) and gets the DISTINCT
//      completion_email_status "failed" (+ completion_email_log entry)
//      so the owner can fix the address and send again; the signed-copy
//      status is never overwritten either way.
//   The completion document row is recorded in the panel flow
//   (data.saveDocument, kind "completion-pdf") — this function does
//   not duplicate that row.
//   Response: { ok: true, emailStatus: "sent" | "failed", completedAt }.
//
// action "send-schedule" (owner saves the appointment on a signed job):
//   Emails the client the appointment date; on success, a job still in
//   "signed" advances to "scheduled" automatically (ronda 2026-11-02).
//
// Flow:
//   1. Look the job up by its client token with the SERVICE ROLE key
//      (server-side only — the key never reaches the browser/repo).
//   2. Reject if this quote version is already signed (signed versions are
//      immutable by design and by the signatures unique(job_id, version)).
//   3. Record the accepted optionals, insert the signature (image, printed
//      name, timestamp), set signed_version = version, status -> "signed".
//   4. Email the signed PDF (client-supplied base64 generated in the portal,
//      or a text summary fallback) to the CLIENT, with a copy to the company,
//      via Gmail SMTP through the SENDER account (see SENDER below —
//      temporarily the technician account, not the company inbox).
//      - The Gmail app password comes ONLY from the function secret
//        GMAIL_APP_PASSWORD (supabase secrets set GMAIL_APP_PASSWORD=...).
//      - Email failure NEVER rolls back the signature: the job is flagged
//        copy_email_failed = true and the portal keeps offering the PDF.
//   5. Response: { ok: true, emailStatus: "sent" | "failed" }.
//
// Deploy (needs Rigo's Supabase project):
//   supabase functions deploy sign-and-email
//   supabase secrets set GMAIL_APP_PASSWORD=<app password>
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const COMPANY = {
  name: "Angry Panda Heating and Cooling",
  email: "angrypandahvac@gmail.com",
  city: "Chicago, IL",
  cert: "EPA Section 608 Universal Certified",
};

// TEMPORARY SENDER (Rigo's call, 2026-10-28): the company Gmail is a
// brand-new account and Google blocks creating an app password on it.
// Until it unblocks, mail is sent THROUGH Rigo's technician account —
// the GMAIL_APP_PASSWORD secret must hold THAT account's app password.
// Clients still see the company name, get a Reply-To to the company
// inbox, and the company copy (bcc) still lands at COMPANY.email.
// To revert: point SENDER.email back to COMPANY.email and replace the
// secret with the company account's app password.
const SENDER = {
  email: "rigo.technician.hvac@gmail.com",
};

// Public base URL of the deployed app (same value as config.js
// APP_PUBLIC_URL) — the quote email carries the client's personal link.
const APP_URL = "https://g8zzj7sct2-cell.github.io/panda-jobs/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanCount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function completeJob(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const token = String(payload.token ?? "");
  const recipient = String(payload.recipientEmail ?? "").trim();
  const resend = payload.resend === true;
  const requestedCompletedAt = typeof payload.completedAt === "string" && payload.completedAt
    ? payload.completedAt
    : null;
  if (requestedCompletedAt && Number.isNaN(Date.parse(requestedCompletedAt))) {
    return json({ error: "completedAt is not a valid date" }, 400);
  }
  if (!token || !EMAIL_RE.test(recipient)) {
    return json({ error: "token and a valid recipientEmail are required" }, 400);
  }

  /* Evidence attachments (ronda 2026-11-02). The browser builds the
     PDF (pdf.js adaptive profiles cap it at ~2.75M base64 chars) and
     converts each photo to a JPEG; this worker only attaches, which
     keeps its CPU profile tiny — generating PDFs server-side is what
     died with the 546 limit. Everything is size-guarded: an oversized
     PDF fails the send honestly (the job is NOT moved to Done), and
     if the combined attachments would get huge, the individual photo
     attachments are dropped first (the PDF already contains them). */
  const PDF_B64_MAX = 3000000;
  const PHOTO_B64_MAX = 1500000;
  const TOTAL_B64_MAX = 10000000;
  let pdfBase64: string | null = null;
  let pdfError = "";
  if (typeof payload.pdfBase64 === "string" && payload.pdfBase64) {
    if (payload.pdfBase64.length <= PDF_B64_MAX) pdfBase64 = payload.pdfBase64;
    else pdfError = "The evidence PDF is too large to email";
  }
  type PhotoAtt = { filename: string; contentType: string; encoding: "base64"; content: string };
  const photoAtts: PhotoAtt[] = [];
  if (Array.isArray(payload.photoAttachments)) {
    for (const raw of payload.photoAttachments.slice(0, 30)) {
      const a = raw as Record<string, unknown>;
      const content = typeof a.content === "string" ? a.content : "";
      const ct = a.contentType === "image/png" ? "image/png" : "image/jpeg";
      if (!content || content.length > PHOTO_B64_MAX) continue;
      const fn = String(a.filename ?? "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "photo.jpg";
      photoAtts.push({ filename: fn, contentType: ct, encoding: "base64", content });
    }
  }
  let droppedPhotoAtts = 0;
  if (pdfBase64) {
    let totalB64 = pdfBase64.length + photoAtts.reduce((s, a) => s + a.content.length, 0);
    while (totalB64 > TOTAL_B64_MAX && photoAtts.length) {
      totalB64 -= photoAtts.pop()!.content.length;
      droppedPhotoAtts++;
    }
  }

  // 1) Job by token (service role — server-side only)
  const { data: job, error: jobErr } = await supabase
    .from("jobs").select("*, clients(*)").eq("token", token).single();
  if (jobErr || !job) return json({ error: "Link not valid" }, 404);

  // 2) State guard: only a signed job can be completed; "done" is allowed
  //    so a failed evidence email can be re-sent.
  const completable = ["signed", "scheduled", "in_progress", "done"];
  if (!((job.signed_version ?? 0) > 0) || !completable.includes(String(job.status))) {
    return json({ error: "This job is not in a state that can be completed" }, 409);
  }

  const completedAt = resend && job.completed_at
    ? String(job.completed_at)
    : (requestedCompletedAt ?? (job.completed_at ? String(job.completed_at) : new Date().toISOString()));

  // 3) Compose the email. Body = backup summary (work, materials,
  //    final total) + the portal button; the evidence itself rides as
  //    attachments. Only when NO PDF was supplied do we fall back to
  //    the 2026-10-28 evidence-in-the-email rendering (hosted photos).
  const client = (job as { clients?: { email?: string; name?: string } }).clients ?? {};
  const photos = (job.photos ?? {}) as Record<string, unknown>;
  const photoGroups = [
    { kind: "assessment", label: "Assessment photos" },
    { kind: "before", label: "BEFORE photos" },
    { kind: "after", label: "AFTER photos" },
  ].map((g) => ({
    ...g,
    urls: (Array.isArray(photos[g.kind]) ? photos[g.kind] : [])
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)),
  }));
  const serverCounts = {
    assessment: photoGroups[0].urls.length,
    before: photoGroups[1].urls.length,
    after: photoGroups[2].urls.length,
  };
  const payloadCounts = (payload.photoCounts ?? null) as Record<string, unknown> | null;
  const photoCounts = {
    assessment: payloadCounts ? cleanCount(payloadCounts.assessment) : serverCounts.assessment,
    before: payloadCounts ? cleanCount(payloadCounts.before) : serverCounts.before,
    after: payloadCounts ? cleanCount(payloadCounts.after) : serverCounts.after,
  };
  const totalPhotos = photoCounts.assessment + photoCounts.before + photoCounts.after;
  const embeddedPhotoCount = typeof payload.embeddedPhotoCount === "number"
    ? cleanCount(payload.embeddedPhotoCount) : (pdfBase64 ? totalPhotos : totalPhotos);
  const failedPhotoCount = (typeof payload.failedPhotoCount === "number"
    ? cleanCount(payload.failedPhotoCount) : 0) + droppedPhotoAtts;
  const { data: items } = await supabase
    .from("quote_items").select("qty, price, accepted").eq("job_id", job.id);
  const quoteTotal = (items ?? []).filter((i) => i.accepted)
    .reduce((s, i) => s + Number(i.qty) * Number(i.price), 0);
  const finalTotal = job.final_total === null || job.final_total === undefined
    ? quoteTotal : Number(job.final_total);
  const link = `${APP_URL}#/c/${token}`;
  let emailStatus: "sent" | "failed" = "failed";
  let emailError = pdfError;
  try {
    if (pdfError) throw new Error(pdfError);
    const appPassword = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: SENDER.email, password: appPassword },
      },
    });
    const lines: string[] = [
      `Hi ${client.name ?? "there"},`,
      ``,
      `Your job "${job.title ?? "Heating / cooling service"}" is complete.`,
      `Completed: ${new Date(completedAt).toLocaleString("en-US")}`,
    ];
    if (job.work_notes) lines.push(``, `Work performed:`, String(job.work_notes));
    if (job.materials) lines.push(``, `Materials used:`, String(job.materials));
    lines.push(``, `Final total: ${usd(finalTotal)}`);
    if (pdfBase64) {
      lines.push(``, `Attached to this email: your completion report (PDF) with all the photo evidence inside (${photoCounts.assessment} assessment, ${photoCounts.before} before, ${photoCounts.after} after)${photoAtts.length ? ", plus each photo as an individual file" : ""}. You can also review the work and your signed agreement any time from your personal link:`);
    } else if (totalPhotos) {
      lines.push(``, `Photo evidence is included in this email (${photoCounts.assessment} assessment, ${photoCounts.before} before, ${photoCounts.after} after) and in your personal link:`);
    } else {
      lines.push(``, `You can review the work and your signed agreement any time from your personal link:`);
    }
    lines.push(
      link,
      ``,
      `Questions? Email us at ${COMPANY.email} and we will get back to you.`,
      ``,
      `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
    );
    const completeText = lines.join("\n");
    let completeHtml = htmlFromText(completeText, { url: link, label: "View your job details" });
    if (!pdfBase64 && totalPhotos) {
      let sections = "";
      for (const g of photoGroups) {
        if (!g.urls.length) continue;
        sections += `<br><b>${g.label} (${g.urls.length})</b><br>` + g.urls.map((u, ix) =>
          `<img src="${escHtml(u)}" alt="${g.label} ${ix + 1}" style="width:100%;max-width:520px;border-radius:8px;margin:6px 0">`
        ).join("");
      }
      completeHtml = completeHtml.replace(/<\/div>$/, sections + "</div>");
    }
    const attachments: PhotoAtt[] = [];
    if (pdfBase64) {
      attachments.push({
        filename: "Angry-Panda-Completion-Report.pdf",
        contentType: "application/pdf", encoding: "base64", content: pdfBase64,
      });
    }
    for (const a of photoAtts) attachments.push(a);
    await smtp.send({
      from: `${COMPANY.name} <${SENDER.email}>`,
      replyTo: COMPANY.email,
      to: [recipient],
      bcc: [COMPANY.email], // company copy
      subject: `Your job completion report - ${COMPANY.name}`,
      content: asciiSafe(completeText),
      html: completeHtml,
      ...(attachments.length ? { attachments } : {}),
    });
    await smtp.close();
    emailStatus = "sent";
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  // 4) Record the outcome. SUCCESS also moves the job to Done (the
  //    email is really out — ronda 2026-11-02); FAILURE only records
  //    the failed attempt and the job KEEPS its current stage so the
  //    send can be fixed and retried (a re-send on an already-Done job
  //    naturally leaves it Done).
  const priorLog = Array.isArray(job.completion_email_log) ? job.completion_email_log : [];
  const entry: Record<string, unknown> = {
    at: new Date().toISOString(), to: recipient, status: emailStatus,
    photoCounts, embeddedPhotoCount, failedPhotoCount,
    note: emailStatus === "sent"
      ? (pdfBase64 ? `Evidence PDF + ${photoAtts.length} photo attachment(s) emailed` : "Evidence in email (no PDF attachment)")
      : "Evidence email failed — job NOT moved to Done",
  };
  if (emailError) entry.error = emailError;
  const upd: Record<string, unknown> = {
    completion_email_status: emailStatus,
    completion_email_log: [...priorLog, entry],
    updated_at: new Date().toISOString(),
  };
  if (emailStatus === "sent") {
    upd.status = "done";
    upd.completed_at = completedAt;
  }
  await supabase.from("jobs").update(upd).eq("id", job.id);

  return json({
    ok: true, emailStatus, completedAt,
    ...(emailError ? { emailError } : {}),
  });
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* Email rendering (Rigo, 2026-10-28): clients must NOT see the raw
   GitHub Pages URL, and Apple Mail was mangling the em dashes and
   bullets of the plain-text mail ("no heat" â€") because the text part
   carries no reliable UTF-8 declaration. So every client email now
   goes out as multipart: an HTML part (UTF-8, the personal link shown
   as a labeled button, punctuation intact) + a plain-text part with
   ASCII-safe punctuation that can never garble. */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function asciiSafe(s: string): string {
  return s.replace(/—/g, "-").replace(/–/g, "-").replace(/•/g, "|")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
function htmlFromText(text: string, link?: { url: string; label: string }): string {
  let body = escHtml(text);
  if (link) {
    const u = escHtml(link.url);
    const btn = `<a href="${u}" style="display:inline-block;background:#1d7a3a;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(link.label)}</a>`;
    body = body.split(u).join(btn);
  }
  body = body.replace(/\n/g, "<br>");
  /* The mail library does not declare UTF-8 reliably on the HTML part
     either (Apple Mail still garbled the footer's bullets), so encode
     EVERY non-ASCII character as a numeric entity — entities render
     identically under any declared charset. Tags/URLs are pure ASCII
     and pass through untouched. */
  body = body.replace(/[^\x00-\x7F]/g, (ch) => `&#${ch.codePointAt(0)};`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px">${body}</div>`;
}
/* Appointment display: the owner types the date/time into a
   datetime-local field, so the stored components ARE the wall clock
   the client must see — format them as stored, never tz-shifted. */
function formatAppt(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
  const dow = days[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const mins = mm === 0 ? "" : ":" + String(mm).padStart(2, "0");
  return `${dow}, ${months[mo - 1]} ${d}, ${y} at ${h12}${mins} ${ampm}`;
}

async function sendQuote(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const token = String(payload.token ?? "");
  const recipient = String(payload.recipientEmail ?? "").trim();
  if (!token || !EMAIL_RE.test(recipient)) {
    return json({ error: "token and a valid recipientEmail are required" }, 400);
  }

  // 1) Job + client by token (service role — server-side only)
  const { data: job, error: jobErr } = await supabase
    .from("jobs").select("*, clients(*)").eq("token", token).single();
  if (jobErr || !job) return json({ error: "Link not valid" }, 404);

  // 2) Quote items for the summary
  const { data: items } = await supabase
    .from("quote_items")
    .select("description, qty, price, optional, accepted")
    .eq("job_id", job.id).order("sort_order");
  const rows = items ?? [];
  const included = rows.filter((i) => i.accepted);
  const total = included.reduce((s, i) => s + Number(i.qty) * Number(i.price), 0);
  const pendingOptionals = rows.some((i) => i.optional && !i.accepted);

  const client = (job as { clients?: { email?: string; name?: string } }).clients ?? {};
  const firstName = (client.name ?? "").split(" ")[0] || "there";
  const link = `${APP_URL}#/c/${token}`;

  const lines: string[] = [
    `Hi ${firstName},`,
    ``,
    `This is ${COMPANY.name}. Here is your quote for "${job.title ?? "Heating / cooling service"}" — tap your personal link to review it in detail and sign when you're ready:`,
    ``,
    link,
    ``,
    `Quote summary:`,
  ];
  for (const i of included) {
    const qty = Number(i.qty), price = Number(i.price);
    lines.push(
      `- ${i.description} — ${usd(qty * price)}` +
      (qty !== 1 ? ` (${qty} × ${usd(price)})` : "") +
      (i.optional ? " (optional)" : ""),
    );
  }
  lines.push(`Total: ${usd(total)}`);
  if (Number(job.deposit ?? 0) > 0) lines.push(`Deposit due: ${usd(Number(job.deposit))}`);
  if (pendingOptionals) lines.push(`Optional add-ons are also waiting for you in your link.`);
  lines.push(
    ``,
    `Questions? Just reply to this email or write to ${COMPANY.email}.`,
    ``,
    `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
  );

  // 3) Send (same Gmail SMTP path as the other actions)
  let emailError = "";
  try {
    const appPassword = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: SENDER.email, password: appPassword },
      },
    });
    await smtp.send({
      from: `${COMPANY.name} <${SENDER.email}>`,
      replyTo: COMPANY.email,
      to: [recipient],
      bcc: [COMPANY.email], // company copy
      subject: `Your quote from ${COMPANY.name}`,
      content: asciiSafe(lines.join("\n")),
      html: htmlFromText(lines.join("\n"), { url: link, label: "Review & sign your quote" }),
    });
    await smtp.close();
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }
  if (emailError) return json({ ok: true, emailStatus: "failed", emailError });

  // 4) The send really happened — record it in the job's history.
  const priorLog = Array.isArray(job.send_log) ? job.send_log : [];
  const upd: Record<string, unknown> = {
    send_log: [...priorLog, { channel: "Email", at: new Date().toISOString(), to: recipient }],
    send_email: recipient,
    updated_at: new Date().toISOString(),
  };
  if (job.status === "draft") upd.status = "quote";
  await supabase.from("jobs").update(upd).eq("id", job.id);

  return json({ ok: true, emailStatus: "sent" });
}

/* ---------------- appointment email (owner action "send-schedule") ---
   Rigo's rule (2026-10-28): when the appointment (schedule) is set or
   changed, the client automatically gets an email WITH THE DATE. The
   panel calls this right after saving a changed appointment. Sends to
   the client's email on file; the send is recorded in the job history
   ONLY when it really went out. */
async function sendSchedule(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const token = String(payload.token ?? "");
  if (!token) return json({ error: "token is required" }, 400);

  const { data: job, error: jobErr } = await supabase
    .from("jobs").select("*, clients(*)").eq("token", token).single();
  if (jobErr || !job) return json({ error: "job not found" }, 404);
  if (!job.scheduled_at) return json({ error: "no appointment set on this job" }, 400);

  const client = (job as { clients?: { email?: string; name?: string; address?: string } }).clients ?? {};
  const recipient = String(client.email ?? "").trim();
  if (!EMAIL_RE.test(recipient)) return json({ error: "no client email on file" }, 400);
  const firstName = (client.name ?? "").split(" ")[0] || "there";
  const link = `${APP_URL}#/c/${token}`;
  const when = formatAppt(String(job.scheduled_at));

  const lines: string[] = [
    `Hi ${firstName},`,
    ``,
    `This is ${COMPANY.name}. Your appointment for "${job.title ?? "Heating / cooling service"}" is scheduled for:`,
    ``,
    when,
    ``,
  ];
  if (client.address) lines.push(`We'll come to: ${client.address}`, ``);
  lines.push(
    `You can see your job details anytime from your personal link:`,
    link,
    ``,
    `If you need to reschedule, just reply to this email and we'll find another day.`,
    ``,
    `Questions? Just reply to this email or write to ${COMPANY.email}.`,
    ``,
    `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
  );
  const text = lines.join("\n");

  let emailError = "";
  try {
    const appPassword = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: SENDER.email, password: appPassword },
      },
    });
    await smtp.send({
      from: `${COMPANY.name} <${SENDER.email}>`,
      replyTo: COMPANY.email,
      to: [recipient],
      bcc: [COMPANY.email], // company copy
      subject: `Your appointment - ${COMPANY.name}`,
      content: asciiSafe(text),
      html: htmlFromText(text, { url: link, label: "View your job details" }),
    });
    await smtp.close();
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }
  if (emailError) return json({ ok: true, emailStatus: "failed", emailError });

  const priorLog = Array.isArray(job.send_log) ? job.send_log : [];
  const schedUpd: Record<string, unknown> = {
    send_log: [...priorLog, { channel: "Email", at: new Date().toISOString(), to: recipient, kind: "schedule" }],
    updated_at: new Date().toISOString(),
  };
  // Ronda 2026-11-02: the appointment email is really out, so a signed
  // (approved) job advances to "scheduled" by itself — Rigo no longer
  // moves it by hand.
  if (job.status === "signed") schedUpd.status = "scheduled";
  await supabase.from("jobs").update(schedUpd).eq("id", job.id);

  return json({ ok: true, emailStatus: "sent" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  if (payload.action === "complete") return await completeJob(payload, supabase);
  if (payload.action === "send-quote") {
    // Owner-only action: verify the caller's Supabase session JWT (the
    // panel attaches it automatically via functions.invoke).
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: userData } = await anon.auth.getUser();
    if (!userData?.user) return json({ error: "Owner sign-in required" }, 401);
    return await sendQuote(payload, supabase);
  }
  if (payload.action === "send-schedule") {
    // Owner-only action, same session gate as send-quote.
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: userData } = await anon.auth.getUser();
    if (!userData?.user) return json({ error: "Owner sign-in required" }, 401);
    return await sendSchedule(payload, supabase);
  }
  if (payload.action !== "sign") return json({ error: "Unknown action" }, 400);

  const token = String(payload.token ?? "");
  const name = String(payload.name ?? "").trim();
  const signatureDataUrl = String(payload.signatureDataUrl ?? "");
  const acceptedOptionals: number[] = Array.isArray(payload.acceptedOptionals)
    ? (payload.acceptedOptionals as number[])
    : [];
  const pdfBase64 = typeof payload.pdfBase64 === "string" ? payload.pdfBase64 : null;

  if (!token || !name || !signatureDataUrl.startsWith("data:image/")) {
    return json({ error: "token, printed name and a signature image are required" }, 400);
  }

  // 1) Job by token
  const { data: job, error: jobErr } = await supabase
    .from("jobs").select("*, clients(*)").eq("token", token).single();
  if (jobErr || !job) return json({ error: "Link not valid" }, 404);

  // 2) Immutability guard
  if ((job.signed_version ?? 0) >= job.version) {
    return json({ error: "This quote version is already signed" }, 409);
  }

  // 3a) Accept the optionals the client checked
  const { data: items } = await supabase
    .from("quote_items").select("id, optional").eq("job_id", job.id).order("sort_order");
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].optional) {
        await supabase.from("quote_items")
          .update({ accepted: acceptedOptionals.includes(i) }).eq("id", items[i].id);
      }
    }
  }

  // 3b) Signature record (unique (job_id, version) protects the signed copy)
  const signedAt = new Date().toISOString();
  const { error: sigErr } = await supabase.from("signatures").insert({
    job_id: job.id, version: job.version, signer_name: name,
    signature_image_url: signatureDataUrl, signed_at: signedAt,
  });
  if (sigErr) return json({ error: "Could not save the signature: " + sigErr.message }, 500);

  await supabase.from("jobs").update({
    signed_version: job.version,
    status: job.status === "quote" ? "signed" : job.status,
    updated_at: signedAt,
  }).eq("id", job.id);

  // Keep a row for the generated PDF document
  await supabase.from("documents").insert({
    job_id: job.id, version: job.version, kind: "signed-pdf",
    file_url: pdfBase64 ? "generated-in-portal" : "",
  });

  // 4) Automatic email with the signed PDF attached (client + company copy)
  const client = (job as { clients?: { email?: string; name?: string } }).clients ?? {};
  const clientEmail = client.email ?? "";
  let emailStatus: "sent" | "failed" = "failed";
  let emailError = "";

  try {
    const appPassword = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    if (!clientEmail) throw new Error("Client has no email on file");

    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: SENDER.email, password: appPassword },
      },
    });

    const total = (items ?? []).length; // (line count; amounts are in the PDF)
    void total;
    const attachments = pdfBase64
      ? [{
          filename: `Angry-Panda-Signed-Agreement-v${job.version}.pdf`,
          contentType: "application/pdf",
          encoding: "base64" as const,
          content: pdfBase64,
        }]
      : undefined;

    const signText = [
      `Hi ${client.name ?? "there"},`,
      ``,
      `Thank you! Your signed agreement (version ${job.version}) with ${COMPANY.name} is attached to this email as a PDF.`,
      `Signed by: ${name} — ${new Date(signedAt).toLocaleString("en-US")}`,
      ``,
      `Next step — your installation day: just reply to this email and suggest the day that works best for you, and we'll confirm your appointment right away.`,
      ``,
      `You can always review your quote, your signed copy, your appointment and your before/after photos from your personal link — keep this email.`,
      `Questions? Email us at ${COMPANY.email} and we will get back to you.`,
      ``,
      `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
    ].join("\n");
    await smtp.send({
      from: `${COMPANY.name} <${SENDER.email}>`,
      replyTo: COMPANY.email,
      to: [clientEmail],
      bcc: [COMPANY.email], // company copy
      subject: `Your signed agreement - ${COMPANY.name}`,
      content: asciiSafe(signText),
      html: htmlFromText(signText),
      attachments,
    });
    await smtp.close();
    emailStatus = "sent";
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  // Flag the job on failure — the signature above stays saved either way.
  await supabase.from("jobs").update({
    copy_email_status: emailStatus,
    copy_email_failed: emailStatus === "failed",
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

  return json({ ok: true, emailStatus, ...(emailError ? { emailError } : {}) });
});
