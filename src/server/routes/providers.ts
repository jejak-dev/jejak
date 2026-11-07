import { Elysia } from "elysia";
import {
  parseRegistry,
  redactRegistry,
  redactResolved,
  resolveProvider,
  setActiveProfile,
  type ProviderSelection,
} from "../provider";
import { loadRegistry, providersPath, saveRegistry } from "../provider-store";

export interface ProviderRoutesOptions {
  path?: string;
  env?: Record<string, string | undefined>;
}

const REDACTED_KEY = "***";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("Body permintaan harus berupa JSON.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Body permintaan harus berupa JSON yang valid.");
  }
}

function parseActiveBody(body: unknown): string {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Body permintaan harus berupa objek.");
  }
  const profileId = (parsed as { profileId?: unknown }).profileId;
  if (typeof profileId !== "string" || profileId.trim() === "") {
    throw new Error("Field profileId harus berupa string yang tidak kosong.");
  }
  return profileId.trim();
}

function optionalQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function providerRoutes(options: ProviderRoutesOptions = {}): Elysia {
  const env = options.env ?? process.env;
  const path = options.path ?? providersPath(env);

  const load = () => loadRegistry(path, env);

  const plugin = new Elysia({ name: "jejak-provider-routes" })
    .get("/api/providers", async () => {
      try {
        const registry = await load();
        return { registry: redactRegistry(registry) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/providers",
      async ({ body }) => {
        try {
          const parsed = parseRegistry(parseJsonBody(body), env);
          const existing = await load();
          const previousById = new Map(existing.profiles.map((profile) => [profile.id, profile]));

          for (const profile of parsed.profiles) {
            if (profile.apiKeyEnv !== undefined) {
              continue;
            }
            if (profile.apiKey !== undefined && profile.apiKey !== REDACTED_KEY) {
              continue;
            }
            const previous = previousById.get(profile.id);
            if (previous?.apiKey !== undefined) {
              profile.apiKey = previous.apiKey;
            } else {
              delete profile.apiKey;
            }
          }

          await saveRegistry(parsed, path);
          return { registry: redactRegistry(parsed) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/providers/active",
      async ({ body }) => {
        try {
          const profileId = parseActiveBody(body);
          const registry = await load();
          const updated = setActiveProfile(registry, profileId);
          await saveRegistry(updated, path);
          return { registry: redactRegistry(updated) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/providers/resolve", async ({ query }) => {
      try {
        const registry = await load();
        const selection: ProviderSelection = {};
        const profileId = optionalQuery(query.profileId);
        const model = optionalQuery(query.model);
        const lightModel = optionalQuery(query.lightModel);
        if (profileId !== undefined) selection.profileId = profileId;
        if (model !== undefined) selection.model = model;
        if (lightModel !== undefined) selection.lightModel = lightModel;

        return { resolved: redactResolved(resolveProvider(registry, selection)) };
      } catch (error) {
        return errorResponse(error);
      }
    });

  return plugin as unknown as Elysia;
}
