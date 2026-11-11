export interface ModelPriceView {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelView {
  id: string;
  label?: string;
  price?: ModelPriceView;
  contextWindow?: number;
}

export interface RegistryView {
  activeProfileId?: string;
  profiles: {
    id: string;
    name: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    hasKey: boolean;
    models: ModelView[];
    defaultModel?: string;
    lightModel?: string;
    fallbackProfileId?: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseModel(raw: unknown): ModelView | undefined {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id === "" ? undefined : { id };
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = readString(raw, "id");
  if (id === undefined) {
    return undefined;
  }
  const model: ModelView = { id };
  const label = readString(raw, "label");
  if (label !== undefined) {
    model.label = label;
  }

  const price = parsePrice(raw.price);
  if (price !== undefined) {
    model.price = price;
  }

  const window = raw.contextWindow;
  if (typeof window === "number" && Number.isInteger(window) && window > 0) {
    model.contextWindow = window;
  }

  return model;
}

function readNonNegative(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

function parsePrice(raw: unknown): ModelPriceView | undefined {
  if (!isRecord(raw)) return undefined;
  const input = readNonNegative(raw.input);
  const output = readNonNegative(raw.output);
  if (input === undefined || output === undefined) return undefined;

  const price: ModelPriceView = { input, output };
  const cacheRead = readNonNegative(raw.cacheRead);
  if (cacheRead !== undefined) price.cacheRead = cacheRead;
  const cacheWrite = readNonNegative(raw.cacheWrite);
  if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
  return price;
}

function parseProfile(
  raw: unknown,
): RegistryView["profiles"][number] | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = readString(raw, "id");
  if (id === undefined) {
    return undefined;
  }

  const profile: RegistryView["profiles"][number] = {
    id,
    name: readString(raw, "name") ?? id,
    hasKey: typeof raw.apiKey === "string" && raw.apiKey !== "",
    models: [],
  };

  const baseUrl = readString(raw, "baseUrl");
  if (baseUrl !== undefined) profile.baseUrl = baseUrl;
  const apiKeyEnv = readString(raw, "apiKeyEnv");
  if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv;

  const models = raw.models;
  if (Array.isArray(models)) {
    for (const item of models) {
      const model = parseModel(item);
      if (model !== undefined) profile.models.push(model);
    }
  }

  const defaultModel = readString(raw, "defaultModel");
  if (defaultModel !== undefined) profile.defaultModel = defaultModel;
  const lightModel = readString(raw, "lightModel");
  if (lightModel !== undefined) profile.lightModel = lightModel;
  const fallbackProfileId = readString(raw, "fallbackProfileId");
  if (fallbackProfileId !== undefined) profile.fallbackProfileId = fallbackProfileId;

  return profile;
}

export function parseRegistryView(input: unknown): RegistryView {
  try {
    let source: unknown = input;
    if (isRecord(input) && isRecord(input.registry)) {
      source = input.registry;
    }
    if (!isRecord(source)) {
      return { profiles: [] };
    }

    const view: RegistryView = { profiles: [] };
    const profiles = source.profiles;
    if (Array.isArray(profiles)) {
      for (const item of profiles) {
        const profile = parseProfile(item);
        if (profile !== undefined) view.profiles.push(profile);
      }
    }

    const activeProfileId = readString(source, "activeProfileId");
    if (activeProfileId !== undefined) view.activeProfileId = activeProfileId;

    return view;
  } catch {
    return { profiles: [] };
  }
}
