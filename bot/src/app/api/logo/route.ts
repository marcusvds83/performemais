import { NextResponse } from "next/server";
import { head } from "@vercel/blob";

export const runtime = "nodejs";

// Fallback: logo original hospedada no Odoo Performe+
const FALLBACK_LOGO_URL =
  "https://performe.odoo.com/web/image/website/1/logo?height=256";

// Paths possíveis — um por extensão de arquivo
const BLOB_PATHS = [
  "performe-logo/logo-current.png",
  "performe-logo/logo-current.jpg",
  "performe-logo/logo-current.jpeg",
  "performe-logo/logo-current.webp",
  "performe-logo/logo-current.svg",
];

async function findLogoBlob(): Promise<string | null> {
  for (const path of BLOB_PATHS) {
    try {
      const blob = await head(path);
      if (blob) return blob.url;
    } catch {
      // Não existe com essa extensão, tenta próxima
    }
  }
  return null;
}

export async function GET() {
  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=60, s-maxage=60",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const blobUrl = await findLogoBlob();
    if (blobUrl) {
      return NextResponse.redirect(blobUrl, { status: 302, headers });
    }
  } catch (err) {
    console.warn("[logo] erro ao buscar blob:", err);
  }

  return NextResponse.redirect(FALLBACK_LOGO_URL, { status: 302, headers });
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
