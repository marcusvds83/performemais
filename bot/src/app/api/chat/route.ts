/**
 * POST /api/chat
 * Body: { sessionId, message }
 *
 * Chat endpoint for the website widget.
 * Uses Gemini AI with Nytro knowledge base.
 * Creates Lead in Odoo CRM when detects contact info.
 */

import { NextRequest, NextResponse } from "next/server";
import { replyWhatsApp, type ChatMessage } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sessionId: string | undefined = body.sessionId;
    const message: string | undefined = body.message;
    const history: ChatMessage[] = body.history || [];

    if (!sessionId || !message || typeof message !== "string") {
      return NextResponse.json(
        { error: "sessionId and message are required" },
        { status: 400 }
      );
    }
    if (message.length > 4000) {
      return NextResponse.json(
        { error: "message too long (max 4000 chars)" },
        { status: 400 }
      );
    }

    // Build messages array from history + new message
    const messages: ChatMessage[] = [
      ...history.slice(-12).map((h: ChatMessage) => ({
        role: h.role,
        content: h.content,
      })),
      { role: "user", content: message },
    ];

    // Call AI
    const botReply = await replyWhatsApp({
      messages,
      channel: "web",
    });

    return NextResponse.json({
      reply: botReply.content,
      leadCreated: botReply.leadCreated || false,
      sessionId,
    });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "POST /api/chat",
    body: { sessionId: "string", message: "string", history: "ChatMessage[]" },
  });
}
