import "server-only";
import mongoose from "mongoose";
import { env } from "@/lib/env";

type Cache = { promise: Promise<typeof mongoose> | null };

// Reuse one connection across hot reloads in dev and across warm serverless invocations.
const globalCache = globalThis as typeof globalThis & { __mongoose?: Cache };
const cache: Cache = (globalCache.__mongoose ??= { promise: null });

export async function connectDb(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  cache.promise ??= mongoose
    .connect(env().mongo.uri, {
      dbName: env().mongo.dbName,
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
    })
    .catch((error) => {
      cache.promise = null;
      throw error;
    });
  return cache.promise;
}

export async function pingDb(): Promise<boolean> {
  try {
    const conn = await connectDb();
    await conn.connection.db!.admin().ping();
    return true;
  } catch (error) {
    console.error("[db] ping failed", error);
    return false;
  }
}
