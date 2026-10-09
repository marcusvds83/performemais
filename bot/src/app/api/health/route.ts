/**
 * Health check endpoint — useful for verifying the Vercel deployment.
 * GET /api/health
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const requiredEnvVars = [
    "ODOO_URL",
    "ODOO_DB",
    "ODOO_USERNAME",
    "ODOO_API_KEY",
    "WHATSAPP_VERIFY_TOKEN",
  ];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);

  return NextResponse.json({
    ok: missing.length === 0,
    service: "performe-bot",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    env: {
      odooConfigured: !!process.env.ODOO_URL,
      odooDb: process.env.ODOO_DB ? "(set)" : "(missing)",
      whatsappToken: process.env.WHATSAPP_VERIFY_TOKEN ? "(set)" : "(missing)",
      operatorIds: process.env.NYTRO_OPERATOR_USER_IDS || "2,6 (default)",
      missing: missing.length === 0 ? null : missing,
    },
    endpoints: {
      webhook: "/api/whatsapp-webhook (GET verify, POST inbound)",
      health: "/api/health (this endpoint)",
    },
  });
}
