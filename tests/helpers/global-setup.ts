import { MongoMemoryServer } from "mongodb-memory-server";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

let mongo: MongoMemoryServer;

export async function setup(project: TestProject) {
  mongo = await MongoMemoryServer.create();
  project.provide("mongoUri", mongo.getUri());
}

export async function teardown() {
  await mongo?.stop();
}
