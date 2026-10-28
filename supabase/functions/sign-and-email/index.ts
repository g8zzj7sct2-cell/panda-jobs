// Panda Jobs — `sign-and-email` Edge Function (Plan Task 7, live mode).
//
// POST { action: "sign", token, name, signatureDataUrl, acceptedOptionals: number[], pdfBase64? }
// POST { action: "complete", token, recipientEmail, pdfBase64, photoCounts,
//        embeddedPhotoCount?, failedPhotoCount?, completedAt?, resend? }
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
//      from angrypandahvac@gmail.com via Gmail SMTP.
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
    const appPassword = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: COMPANY.email, password: appPassword },
      },
    });
    const attempted = photoCounts.assessment + photoCounts.before + photoCounts.after;
    await smtp.send({
      from: `${COMPANY.name} <${COMPANY.email}>`,
      to: [recipient],
      bcc: [COMPANY.email], // company copy
      subject: `Your job completion report — ${COMPANY.name}`,
      content: [
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
      ].join("\n"),
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
    const appPassword = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!appPassword) throw new Error("GMAIL_APP_PASSWORD secret is not set");
    if (!clientEmail) throw new Error("Client has no email on file");

    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: COMPANY.email, password: appPassword },
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

    await smtp.send({
      from: `${COMPANY.name} <${COMPANY.email}>`,
      to: [clientEmail],
      bcc: [COMPANY.email], // company copy
      subject: `Your signed agreement — ${COMPANY.name}`,
      content: [
        `Hi ${client.name ?? "there"},`,
        ``,
        `Thank you! Your signed agreement (version ${job.version}) with ${COMPANY.name} is attached to this email as a PDF.`,
        `Signed by: ${name} — ${new Date(signedAt).toLocaleString("en-US")}`,
        ``,
        `You can always review your quote, your signed copy, your appointment and your before/after photos from your personal link — keep this email.`,
        `Questions? Email us at ${COMPANY.email} and we will get back to you.`,
        ``,
        `${COMPANY.name} • ${COMPANY.cert} • ${COMPANY.city}`,
      ].join("\n"),
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
