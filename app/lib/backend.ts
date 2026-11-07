import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { DemoUser } from "./demo-auth";

export async function backendRequest(user: DemoUser, pathname: string, body?: unknown) {
  try {
    const key = (await readFile(path.join(process.cwd(), ".local", "api-key"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:8080/api/${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-DealHunter-User": user.id,
        "X-DealHunter-Key": key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    return NextResponse.json(pathname === "dashboard" && response.ok ? { ...data, currentUser: user } : data, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "データに接続できませんでした。Java APIとPostgreSQLの起動を確認し、もう一度お試しください。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
