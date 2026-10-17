// ─────────────────────────────────────────────────────────────
//  Blink configuration
//
//  Leave both values empty  → DEMO MODE (everything stays in this
//                              browser; great for trying the UI).
//  Fill both values in      → REAL MODE (accounts, friends, messages
//                              and snaps are shared between phones).
//
//  Find them in Supabase: Project Settings → API
//    SUPABASE_URL       e.g. https://abcdxyz.supabase.co
//    SUPABASE_ANON_KEY  the "anon / public" key.
//
//  The anon key is meant to be public — your data is protected by the
//  row-level-security rules in schema.sql. NEVER paste the
//  "service_role" key here.
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  SUPABASE_URL: 'https://qvwzqbbbdfcgwmftlgpi.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_UW0mQtpPgShpiIbMNM3aQQ_9sr7ZJIQ',
};
