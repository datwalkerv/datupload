import "server-only";
import { pingDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getChat, getMe } from "@/lib/telegram/client";

export interface HealthStatus {
  status: "ok" | "degraded";
  database: "connected" | "unavailable";
  telegram: "connected" | "unavailable";
  checkedAt: string;
}

const TTL_MS = 30_000;
let cached: { value: HealthStatus; expires: number } | null = null;
let inflight: Promise<HealthStatus> | null = null;

async function checkTelegram(): Promise<boolean> {
  try {
    // getChat also proves the bot can see the configured channel.
    await Promise.all([getMe(), getChat(env().telegram.channelId)]);
    return true;
  } catch (error) {
    console.error("[health] telegram check failed", error);
    return false;
  }
}

async function runChecks(): Promise<HealthStatus> {
  let configured = true;
  try {
    env();
  } catch (error) {
    console.error("[health]", error);
    configured = false;
  }
  const [db, telegram] = configured ? await Promise.all([pingDb(), checkTelegram()]) : [false, false];
  return {
    status: db && telegram ? "ok" : "degraded",
    database: db ? "connected" : "unavailable",
    telegram: telegram ? "connected" : "unavailable",
    checkedAt: new Date().toISOString(),
  };
}

/** Health of MongoDB and Telegram, cached briefly so the endpoint can't be used to hammer either. */
export async function getHealth(): Promise<HealthStatus> {
  if (cached && cached.expires > Date.now()) return cached.value;
  inflight ??= runChecks()
    .then((value) => {
      cached = { value, expires: Date.now() + TTL_MS };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
