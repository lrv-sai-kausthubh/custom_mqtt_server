// Runtime settings for the static frontend.
//
// When the frontend is served by the Node backend (local development), leave
// backendUrl empty and it will use the same origin.
//
// When the frontend is hosted separately (Vercel / niat.tech), either:
//   1. set backendUrl to a fixed backend URL, or
//   2. leave backendUrl empty and let the app read the latest Quick Tunnel URL
//      from the public.app_discovery table below.
//
// The Supabase anon key is safe to expose in a browser. It can only read the
// public.app_discovery row; all account tables remain locked to the backend's
// service-role key.
window.HOMELINK_CONFIG = {
  backendUrl: "",

  // Automatic Cloudflare Quick Tunnel discovery.
  supabaseUrl: "https://htlrmrkhuzunrceshsrk.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0bHJtcmtodXp1bnJjZXNoc3JrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNjIzNTMsImV4cCI6MjEwNzYzODM1M30.zm0anDp6RnZq54KeaL0_lQzFfK947fMxWv9AEcfI3JU",
  discoveryTable: "app_discovery"
};
