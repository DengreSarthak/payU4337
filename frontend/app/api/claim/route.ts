import { NextResponse } from "next/server";

// Thin proxy to the backend /claim endpoint.
// The backend owns DB access (pg) and Tenderly simulation, so the frontend
// must not import backend code directly (it pulls in node-only deps that
// break the Next.js build). Configure BACKEND_URL in the deployment env.
export async function POST(request: Request) {
  const backendUrl = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!backendUrl) {
    return NextResponse.json(
      { ok: false, reason: "BACKEND_URL is not configured" },
      { status: 500 },
    );
  }

  try {
    const body = await request.text();
    const upstream = await fetch(`${backendUrl.replace(/\/$/, "")}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "claim proxy failed" },
      { status: 502 },
    );
  }
}
