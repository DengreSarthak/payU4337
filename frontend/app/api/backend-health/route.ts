import { NextResponse } from "next/server";

export async function GET() {
  const backendUrl = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!backendUrl) {
    return NextResponse.json({ ok: false, reason: "BACKEND_URL is not configured" }, { status: 400 });
  }

  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/health`, { cache: "no-store" });
    const json = await response.json();
    return NextResponse.json({ ok: response.ok, backend: json });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "backend health check failed" },
      { status: 500 },
    );
  }
}
