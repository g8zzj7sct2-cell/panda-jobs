// Panda Jobs — `sign-and-email` Edge Function (Plan Task 7, live mode).
//
// POST { action: "sign", token, name, signatureDataUrl, acceptedOptionals: number[], pdfBase64? }
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
  phone: "(435) 680-6873",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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
        `Questions? Call or text us at ${COMPANY.phone}.`,
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
