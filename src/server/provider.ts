export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelEntry {
  id: string;
  label?: string;
  price?: ModelPrice;
  /** Jendela konteks (token); menggantikan tebakan SDK untuk model non-Claude. */
  contextWindow?: number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: ModelEntry[];
  defaultModel?: string;
  lightModel?: string;
  /** Profil cadangan untuk satu kali fallback; bukan rahasia. */
  fallbackProfileId?: string;
}

export interface ProviderRegistry {
  profiles: ProviderProfile[];
  activeProfileId?: string;
}

export interface ProviderSelection {
  profileId?: string;
  model?: string;
  lightModel?: string;
}

export interface ResolvedProvider {
  profileId: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  lightModel?: string;
  price?: ModelPrice;
  contextWindow?: number;
}

/** Jendela konteks model yang dikenal bila profil tidak menyebutnya. */
export function knownContextWindow(model: string): number | undefined {
  return /^deepseek-v4/i.test(model) ? 1_000_000 : undefined;
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INVALID_BASE_URL = "(tidak valid)";

function pickEnv(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(source: Record<string, unknown>, key: string, context: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`${context}: field ${key} harus berupa string.`);
  }
  return value.trim();
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${context}: field ${key} harus berupa string.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseModels(raw: unknown, context: string): ModelEntry[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: field models harus berupa array.`);
  }

  return raw.map((item: unknown, index: number) => {
    if (typeof item === "string") {
      return { id: item.trim() };
    }
    if (!isRecord(item)) {
      throw new Error(`${context}: models[${index}] harus berupa string atau objek.`);
    }
    const id = item.id;
    if (typeof id !== "string") {
      throw new Error(`${context}: field models[${index}].id harus berupa string.`);
    }
    const entry: ModelEntry = { id: id.trim() };
    const label = item.label;
    if (label !== undefined) {
      if (typeof label !== "string") {
        throw new Error(`${context}: field models[${index}].label harus berupa string.`);
      }
      const trimmedLabel = label.trim();
      if (trimmedLabel !== "") {
        entry.label = trimmedLabel;
      }
    }
    const price = item.price;
    if (price !== undefined && isRecord(price)) {
      const parsed = parsePrice(price);
      if (parsed !== undefined) entry.price = parsed;
    }
    const window = item.contextWindow;
    if (typeof window === "number" && Number.isInteger(window) && window > 0) {
      entry.contextWindow = window;
    }
    return entry;
  });
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePrice(raw: Record<string, unknown>): ModelPrice | undefined {
  const input = raw.input;
  const output = raw.output;
  if (!isNonNegativeFiniteNumber(input) || !isNonNegativeFiniteNumber(output)) {
    return undefined;
  }
  const price: ModelPrice = { input, output };
  if (isNonNegativeFiniteNumber(raw.cacheRead)) price.cacheRead = raw.cacheRead;
  if (isNonNegativeFiniteNumber(raw.cacheWrite)) price.cacheWrite = raw.cacheWrite;
  return price;
}

function parseProfile(raw: unknown, index: number, env: Record<string, string | undefined>): ProviderProfile {
  const context = `Profil provider ke-${index + 1}`;
  if (!isRecord(raw)) {
    throw new Error(`${context} harus berupa objek.`);
  }

  const profile: ProviderProfile = {
    id: readRequiredString(raw, "id", context),
    name: readRequiredString(raw, "name", context),
    models: parseModels(raw.models, context),
  };

  const baseUrl = readOptionalString(raw, "baseUrl", context);
  if (baseUrl !== undefined) profile.baseUrl = baseUrl;

  const literalApiKey = readOptionalString(raw, "apiKey", context);
  const apiKeyEnv = readOptionalString(raw, "apiKeyEnv", context);
  if (apiKeyEnv !== undefined) profile.apiKeyEnv = apiKeyEnv;
  let apiKey = literalApiKey;
  if (apiKeyEnv !== undefined) {
    const fromEnv = pickEnv(env, [apiKeyEnv]);
    if (fromEnv !== undefined) apiKey = fromEnv;
  }
  if (apiKey !== undefined) profile.apiKey = apiKey;

  const defaultModel = readOptionalString(raw, "defaultModel", context);
  if (defaultModel !== undefined) profile.defaultModel = defaultModel;

  const lightModel = readOptionalString(raw, "lightModel", context);
  if (lightModel !== undefined) profile.lightModel = lightModel;

  const fallbackProfileId = readOptionalString(raw, "fallbackProfileId", context);
  if (fallbackProfileId !== undefined) profile.fallbackProfileId = fallbackProfileId;

  return profile;
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function redactBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return INVALID_BASE_URL;
  }
  if (url.username === "" && url.password === "") {
    return baseUrl;
  }
  url.username = "***";
  url.password = "";
  return url.href;
}

export function registryFromEnv(env: Record<string, string | undefined> = process.env): ProviderRegistry {
  const profile: ProviderProfile = { id: "default", name: "Default", models: [] };

  const baseUrl = pickEnv(env, ["JEJAK_BASE_URL", "ANTHROPIC_BASE_URL"]);
  if (baseUrl !== undefined) profile.baseUrl = baseUrl;

  const apiKey = pickEnv(env, ["JEJAK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  if (apiKey !== undefined) profile.apiKey = apiKey;

  const defaultModel = pickEnv(env, ["JEJAK_MODEL", "ANTHROPIC_MODEL"]);
  if (defaultModel !== undefined) profile.defaultModel = defaultModel;

  const lightModel = pickEnv(env, ["JEJAK_LIGHT_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]);
  if (lightModel !== undefined) profile.lightModel = lightModel;

  return { profiles: [profile], activeProfileId: "default" };
}

export function parseRegistry(
  input: unknown,
  env: Record<string, string | undefined> = process.env,
): ProviderRegistry {
  if (!isRecord(input)) {
    throw new Error("Konfigurasi provider harus berupa objek.");
  }
  if (!Array.isArray(input.profiles)) {
    throw new Error("Field profiles pada konfigurasi provider harus berupa array.");
  }

  const profiles = input.profiles.map((raw, index) => parseProfile(raw, index, env));

  let activeProfileId: string | undefined;
  const rawActiveProfileId = input.activeProfileId;
  if (rawActiveProfileId !== undefined) {
    if (typeof rawActiveProfileId !== "string") {
      throw new Error("Field activeProfileId harus berupa string.");
    }
    const trimmed = rawActiveProfileId.trim();
    if (trimmed !== "") activeProfileId = trimmed;
  }
  if (activeProfileId === undefined && profiles.length > 0) {
    activeProfileId = profiles[0]?.id;
  }

  const registry: ProviderRegistry = { profiles };
  if (activeProfileId !== undefined) registry.activeProfileId = activeProfileId;
  return registry;
}

export function serializeRegistry(registry: ProviderRegistry): unknown {
  const profiles = registry.profiles.map((profile) => {
    const serialized: Record<string, unknown> = {
      id: profile.id,
      name: profile.name,
    };
    if (profile.baseUrl !== undefined) serialized.baseUrl = profile.baseUrl;
    if (profile.apiKeyEnv !== undefined) serialized.apiKeyEnv = profile.apiKeyEnv;
    serialized.models = profile.models.map((model) => {
      const item: Record<string, unknown> = { id: model.id };
      if (model.label !== undefined) item.label = model.label;
      if (model.price !== undefined) item.price = model.price;
      if (model.contextWindow !== undefined) item.contextWindow = model.contextWindow;
      return item;
    });
    if (profile.apiKey !== undefined && profile.apiKeyEnv === undefined) {
      serialized.apiKey = profile.apiKey;
    }
    if (profile.defaultModel !== undefined) serialized.defaultModel = profile.defaultModel;
    if (profile.lightModel !== undefined) serialized.lightModel = profile.lightModel;
    if (profile.fallbackProfileId !== undefined) {
      serialized.fallbackProfileId = profile.fallbackProfileId;
    }
    return serialized;
  });

  const result: Record<string, unknown> = { profiles };
  if (registry.activeProfileId !== undefined) result.activeProfileId = registry.activeProfileId;
  return result;
}

export function validateRegistry(registry: ProviderRegistry): string[] {
  const errors: string[] = [];
  const profiles = Array.isArray(registry.profiles) ? registry.profiles : [];

  if (profiles.length === 0) {
    errors.push("Registry provider harus memiliki minimal satu profil.");
    return errors;
  }

  const seenIds = new Set<string>();

  for (const profile of profiles) {
    if (!PROFILE_ID_PATTERN.test(profile.id)) {
      errors.push(
        `id profil "${profile.id}" tidak valid; gunakan huruf kecil, angka, atau tanda hubung (maksimal 32 karakter).`,
      );
    }
    if (seenIds.has(profile.id)) {
      errors.push(`id profil "${profile.id}" duplikat.`);
    }
    seenIds.add(profile.id);

    if (profile.name.trim() === "") {
      errors.push(`nama profil "${profile.id}" tidak boleh kosong.`);
    }

    if (profile.baseUrl !== undefined && !isHttpUrl(profile.baseUrl)) {
      errors.push(`baseUrl profil "${profile.id}" harus berupa URL http atau https yang valid.`);
    }

    if (profile.apiKeyEnv !== undefined && !ENV_NAME_PATTERN.test(profile.apiKeyEnv)) {
      errors.push(
        `apiKeyEnv profil "${profile.id}" harus berupa nama variabel lingkungan yang valid.`,
      );
    }

    const modelIds = new Set<string>();
    for (const model of profile.models) {
      if (model.id.trim() === "") {
        errors.push(`Profil "${profile.id}" memiliki id model kosong.`);
        continue;
      }
      if (modelIds.has(model.id)) {
        errors.push(`Profil "${profile.id}" memiliki id model duplikat: "${model.id}".`);
      }
      modelIds.add(model.id);

      // Validate price if present
      if (model.price !== undefined) {
        if (!isRecord(model.price)) {
          errors.push(`Profil "${profile.id}" memiliki price untuk model "${model.id}" yang bukan objek.`);
        } else {
          const price = model.price;
          if (typeof price.input !== "number" || !Number.isFinite(price.input) || price.input < 0) {
            errors.push(`Profil "${profile.id}" memiliki price.input untuk model "${model.id}" yang tidak valid (harus angka berhingga >= 0).`);
          }
          if (typeof price.output !== "number" || !Number.isFinite(price.output) || price.output < 0) {
            errors.push(`Profil "${profile.id}" memiliki price.output untuk model "${model.id}" yang tidak valid (harus angka berhingga >= 0).`);
          }
          if (price.cacheRead !== undefined && (typeof price.cacheRead !== "number" || !Number.isFinite(price.cacheRead) || price.cacheRead < 0)) {
            errors.push(`Profil "${profile.id}" memiliki price.cacheRead untuk model "${model.id}" yang tidak valid (harus angka berhingga >= 0).`);
          }
          if (price.cacheWrite !== undefined && (typeof price.cacheWrite !== "number" || !Number.isFinite(price.cacheWrite) || price.cacheWrite < 0)) {
            errors.push(`Profil "${profile.id}" memiliki price.cacheWrite untuk model "${model.id}" yang tidak valid (harus angka berhingga >= 0).`);
          }
        }
      }
    }

    if (profile.models.length > 0 && modelIds.size > 0) {
      if (profile.defaultModel !== undefined && !modelIds.has(profile.defaultModel)) {
        errors.push(
          `defaultModel "${profile.defaultModel}" tidak ada di daftar model profil "${profile.id}".`,
        );
      }
      if (profile.lightModel !== undefined && !modelIds.has(profile.lightModel)) {
        errors.push(
          `lightModel "${profile.lightModel}" tidak ada di daftar model profil "${profile.id}".`,
        );
      }
    }
  }

  if (
    registry.activeProfileId !== undefined &&
    !profiles.some((profile) => profile.id === registry.activeProfileId)
  ) {
    errors.push(`activeProfileId "${registry.activeProfileId}" tidak cocok dengan profil mana pun.`);
  }

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const profile of profiles) {
    const fallbackId = profile.fallbackProfileId;
    if (fallbackId === undefined) continue;
    if (fallbackId === profile.id) {
      errors.push(`Profil "${profile.id}" tidak boleh menjadi cadangan dirinya sendiri.`);
      continue;
    }
    const fallback = byId.get(fallbackId);
    if (fallback === undefined) {
      errors.push(
        `Profil cadangan "${fallbackId}" pada profil "${profile.id}" tidak ditemukan.`,
      );
      continue;
    }
    if (fallback.fallbackProfileId !== undefined) {
      errors.push(
        `Profil cadangan "${fallbackId}" tidak boleh memiliki fallbackProfileId sendiri.`,
      );
    }
  }

  return errors;
}

export function setActiveProfile(registry: ProviderRegistry, profileId: string): ProviderRegistry {
  if (!registry.profiles.some((profile) => profile.id === profileId)) {
    throw new Error(`Profil provider "${profileId}" tidak ditemukan.`);
  }
  return { ...registry, profiles: [...registry.profiles], activeProfileId: profileId };
}

export function resolveProvider(
  registry: ProviderRegistry,
  selection: ProviderSelection = {},
): ResolvedProvider {
  if (registry.profiles.length === 0) {
    throw new Error("Registry provider kosong; minimal satu profil diperlukan.");
  }

  const profileId = selection.profileId ?? registry.activeProfileId ?? registry.profiles[0]?.id;
  const profile = registry.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    throw new Error(`Profil provider "${profileId ?? ""}" tidak ditemukan.`);
  }

  if (profile.models.length > 0) {
    const available = new Set(profile.models.map((model) => model.id));
    if (selection.model !== undefined && !available.has(selection.model)) {
      throw new Error(`Model "${selection.model}" tidak tersedia di profil "${profile.id}".`);
    }
    if (selection.lightModel !== undefined && !available.has(selection.lightModel)) {
      throw new Error(`Model "${selection.lightModel}" tidak tersedia di profil "${profile.id}".`);
    }
  }

  const resolved: ResolvedProvider = { profileId: profile.id };
  if (profile.baseUrl !== undefined) resolved.baseUrl = profile.baseUrl;
  if (profile.apiKey !== undefined) resolved.apiKey = profile.apiKey;

  // Tanpa model yang dipilih dan tanpa defaultModel, model pertama profil
  // dipakai; kalau tak ada, CLI memakai alias bawaannya sendiri.
  const modelPertama = profile.models[0]?.id;
  const model =
    selection.model ??
    profile.defaultModel ??
    (modelPertama === undefined || modelPertama === "" ? undefined : modelPertama);
  if (model !== undefined) {
    resolved.model = model;
    const modelEntry = profile.models.find((entry) => entry.id === model);
    if (modelEntry?.price !== undefined) {
      resolved.price = modelEntry.price;
    }
    const window = modelEntry?.contextWindow ?? knownContextWindow(model);
    if (window !== undefined) resolved.contextWindow = window;
  }

  const lightModel = selection.lightModel ?? profile.lightModel;
  if (lightModel !== undefined) resolved.lightModel = lightModel;

  return resolved;
}

export function fallbackSelection(
  registry: ProviderRegistry,
  profileId: string,
): ProviderSelection | undefined {
  const profile = registry.profiles.find((candidate) => candidate.id === profileId);
  const fallbackId = profile?.fallbackProfileId;
  if (fallbackId === undefined) return undefined;
  if (!registry.profiles.some((candidate) => candidate.id === fallbackId)) return undefined;
  return { profileId: fallbackId };
}

export function toSdkEnv(resolved: ResolvedProvider): Record<string, string> {
  const env: Record<string, string> = {};

  if (resolved.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = resolved.baseUrl;
  if (resolved.apiKey !== undefined) env.ANTHROPIC_API_KEY = resolved.apiKey;
  if (resolved.model !== undefined) env.ANTHROPIC_MODEL = resolved.model;
  if (resolved.lightModel !== undefined) env.ANTHROPIC_SMALL_FAST_MODEL = resolved.lightModel;
  // Tanpa ini CLI menganggap model non-Claude berjendela 200 rb dan auto compact
  // di sana. Diuji: hanya CLAUDE_CODE_MAX_CONTEXT_TOKENS yang menaikkan batas
  // (CLAUDE_CODE_AUTO_COMPACT_WINDOW hanya bisa menurunkan). Nama model berawalan
  // "claude-" diabaikan CLI, jadi aman.
  if (resolved.contextWindow !== undefined) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(resolved.contextWindow);
  }

  return env;
}

export function redactResolved(resolved: ResolvedProvider): Record<string, string | undefined> {
  const redacted: Record<string, string | undefined> = { profileId: resolved.profileId };

  if (resolved.baseUrl !== undefined) redacted.baseUrl = redactBaseUrl(resolved.baseUrl);
  if (resolved.apiKey !== undefined) redacted.apiKey = "***";
  if (resolved.model !== undefined) redacted.model = resolved.model;
  if (resolved.lightModel !== undefined) redacted.lightModel = resolved.lightModel;

  return redacted;
}

export function redactRegistry(registry: ProviderRegistry): unknown {
  const profiles = registry.profiles.map((profile) => {
    const redacted: Record<string, unknown> = {
      id: profile.id,
      name: profile.name,
      models: profile.models.map((model) => {
        const serialized: Record<string, unknown> = { id: model.id };
        if (model.label !== undefined) serialized.label = model.label;
        if (model.price !== undefined) serialized.price = model.price;
        return serialized;
      }),
    };
    if (profile.baseUrl !== undefined) redacted.baseUrl = redactBaseUrl(profile.baseUrl);
    if (profile.apiKeyEnv !== undefined) redacted.apiKeyEnv = profile.apiKeyEnv;
    if (profile.apiKey !== undefined) redacted.apiKey = "***";
    if (profile.defaultModel !== undefined) redacted.defaultModel = profile.defaultModel;
    if (profile.lightModel !== undefined) redacted.lightModel = profile.lightModel;
    if (profile.fallbackProfileId !== undefined) {
      redacted.fallbackProfileId = profile.fallbackProfileId;
    }
    return redacted;
  });

  const result: Record<string, unknown> = { profiles };
  if (registry.activeProfileId !== undefined) result.activeProfileId = registry.activeProfileId;
  return result;
}
