import { NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  buildSessionTokenForPassword,
  isPasswordValid,
  isAuthConfigured,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { ok: false, message: "Auth env eksik. APP_AUTH_PASSWORD ve APP_AUTH_SECRET gerekli." },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null);
  const password =
    body && typeof body.password === "string" ? body.password : "";

  if (!isPasswordValid(password)) {
    return NextResponse.json(
      { ok: false, message: "Sifre hatali." },
      { status: 401 },
    );
  }
  const token = buildSessionTokenForPassword(password);

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
