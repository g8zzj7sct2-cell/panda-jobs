// Panda Jobs — configuration.
// LIVE since 2026-10-27: points at Rigo's Supabase project "panda-jobs"
// (ref hgfbzsnwihbdgdkuyubj, us-east-1). The ANON key below is public by
// design (it ships in every visitor's browser; row-level security in
// supabase/schema.sql is what protects the data).
// NEVER put the service_role key or the Gmail app password in this file.
window.PANDA_CONFIG = {
  SUPABASE_URL: "https://hgfbzsnwihbdgdkuyubj.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnZmJ6c253aWhiZGdka3V5dWJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDA4MDYsImV4cCI6MjEwODcxNjgwNn0.RO6lVrz3K9Vpba-vZ5uS46RKeG6CT4w-Udln2vGsNXw",
  // Public base URL of the deployed app (GitHub Pages).
  // Client links used by the "Send to client" buttons are built from it.
  APP_PUBLIC_URL: "https://g8zzj7sct2-cell.github.io/panda-jobs/",
};
window.PANDA_CONFIG.DEMO_MODE =
  window.PANDA_CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") ||
  window.PANDA_CONFIG.SUPABASE_ANON_KEY.includes("YOUR-ANON-KEY");
