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
// action "complete" (owner presses "Complete job" in the panel):
//   1. Verify the token identifies a SIGNED job in a completable state
//      (signed / scheduled / in_progress, or done for a re-send).
//   2. Mark the job Done server-side (status + completed_at; a re-send
//      keeps the original completed_at) and record the completion PDF
//      document row in the panel flow (data.saveDocument, kind
//      "completion-pdf") — this function does not duplicate that row.
//   3. Email the browser-generated evidence PDF to the recipient (the
//      panel's per-job override wins; the panel passes it explicitly),
//      with a bcc copy to the company. Email failure NEVER undoes the
//      completion: the job keeps status "done" and gets the DISTINCT
//      completion_email_status "failed" (+ completion_email_log entry),
//      so the signed-copy status is never overwritten.
//   Response: { ok: true, emailStatus: "sent" | "failed", completedAt }.
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
  const pdfBase64 = typeof payload.pdfBase64 === "string" ? payload.pdfBase64 : null;
  const resend = payload.resend === true;
  const rawCounts = (payload.photoCounts ?? {}) as Record<string, unknown>;
  const photoCounts = {
    assessment: cleanCount(rawCounts.assessment),
    before: cleanCount(rawCounts.before),
    after: cleanCount(rawCounts.after),
  };
  const embeddedPhotoCount = cleanCount(payload.embeddedPhotoCount);
  const failedPhotoCount = cleanCount(payload.failedPhotoCount);
  const requestedCompletedAt = typeof payload.completedAt === "string" && payload.completedAt
    ? payload.completedAt
    : null;
  if (requestedCompletedAt && Number.isNaN(Date.parse(requestedCompletedAt))) {
    return json({ error: "completedAt is not a valid date" }, 400);
  }
  if (!token || !EMAIL_RE.test(recipient) || !pdfBase64 || pdfBase64.length < 100) {
    return json({ error: "token, a valid recipientEmail and the completion PDF are required" }, 400);
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

  // 3) Mark Done BEFORE emailing — an email failure never rolls this back.
  const completedAt = resend && job.completed_at
    ? String(job.completed_at)
    : (requestedCompletedAt ?? (job.completed_at ? String(job.completed_at) : new Date().toISOString()));
  const { error: doneErr } = await supabase.from("jobs").update({
    status: "done",
    completed_at: completedAt,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
  if (doneErr) return json({ error: "Could not mark the job done: " + doneErr.message }, 500);

  // 4) Email the evidence PDF (client + company bcc copy)
  const client = (job as { clients?: { email?: string; name?: string } }).clients ?? {};
  let emailStatus: "sent" | "failed" = "failed";
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
    const attempted = photoCounts.assessment + photoCounts.before + photoCounts.after;
    const completeText = [
      `Hi ${client.name ?? "there"},`,
      ``,
      `Your job "${job.title ?? "Heating / cooling service"}" is complete. The completion report is attached as a PDF.`,
      `Completed: ${new Date(completedAt).toLocaleString("en-US")}`,
      `Photo evidence in the report: ${embeddedPhotoCount} of ${attempted} photo(s) embedded` +
        (failedPhotoCount ? ` (${failedPhotoCount} could not be embedded).` : "."),
      ``,
      `You can also review the work, photos and your signed agreement any time from your personal link — keep that email.`,
      `Questions? Email us at ${COMPANY.email} and we will get back to you.`,
      ``,
      `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
    ].join("\n");
    await smtp.send({
      from: `${COMPANY.name} <${SENDER.email}>`,
      replyTo: COMPANY.email,
      to: [recipient],
      bcc: [COMPANY.email], // company copy
      subject: `Your job completion report - ${COMPANY.name}`,
      content: asciiSafe(completeText),
      html: htmlFromText(completeText),
      attachments: [{
        filename: "Angry-Panda-Job-Completion-Report.pdf",
        contentType: "application/pdf",
        encoding: "base64" as const,
        content: pdfBase64,
      }],
    });
    await smtp.close();
    emailStatus = "sent";
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  // 5) Distinct completion email status + log (signed-copy fields untouched)
  const priorLog = Array.isArray(job.completion_email_log) ? job.completion_email_log : [];
  const entry: Record<string, unknown> = {
    at: new Date().toISOString(), to: recipient, status: emailStatus,
    photoCounts, embeddedPhotoCount, failedPhotoCount,
  };
  if (emailError) entry.error = emailError;
  await supabase.from("jobs").update({
    completion_email_status: emailStatus,
    completion_email_log: [...priorLog, entry],
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

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
  await supabase.from("jobs").update({
    send_log: [...priorLog, { channel: "Email", at: new Date().toISOString(), to: recipient, kind: "schedule" }],
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

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
