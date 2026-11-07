export interface RegistryView {
  activeProfileId?: string;
  profiles: {
    id: string;
    name: string;
    models: { id: string; label?: string }[];
    defaultModel?: string;
    lightModel?: string;
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

function parseModel(raw: unknown): { id: string; label?: string } | undefined {
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
  const model: { id: string; label?: string } = { id };
  const label = readString(raw, "label");
  if (label !== undefined) {
    model.label = label;
  }
  return model;
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
    models: [],
  };

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
