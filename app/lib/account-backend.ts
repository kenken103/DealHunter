import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

// Only server code can reach the API-key-protected local account endpoints.
export async function accountBackend<T>(pathname: string, body?: unknown, userId?: string): Promise<{ status: number; data: T }> {
  const key = (await readFile(path.join(process.cwd(), ".local", "api-key"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:8080/api/${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-DealHunter-Key": key,
      ...(userId ? { "X-DealHunter-User": userId } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() as T };
}
