import { NextRequest, NextResponse } from "next/server";
import { put, head, del } from "@vercel/blob";

export const runtime = "nodejs";

const BLOB_PATH = "performe-logo/logo-current";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Arquivo não enviado" }, { status: 400 });
    }

    const allowed = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
    if (!allowed.includes(file.type)) {
      return NextResponse.json(
        { ok: false, error: `Tipo ${file.type} não suportado. Use PNG, JPG, WEBP ou SVG.` },
        { status: 400 }
      );
    }

    if (file.size > 2 * 1024 * 1024) {
      return NextResponse.json(
        { ok: false, error: "Arquivo muito grande (máx 2 MB)" },
        { status: 400 }
      );
    }

    // Deleta blobs anteriores de qualquer extensão
    for (const ext of ["png", "jpg", "jpeg", "webp", "svg"]) {
      try {
        const existing = await head(`${BLOB_PATH}.${ext}`);
        if (existing) await del(existing.url);
      } catch {}
    }

    const ext = file.type === "image/svg+xml" ? "svg" : file.type.split("/")[1];
    const buffer = Buffer.from(await file.arrayBuffer());

    const blob = await put(`${BLOB_PATH}.${ext}`, buffer, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return NextResponse.json({ ok: true, url: blob.url, size: file.size });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Erro no upload" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
