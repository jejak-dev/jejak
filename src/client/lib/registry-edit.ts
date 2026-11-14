import type { RegistryView } from "./registry-view";

export type KeyMode = "env" | "literal" | "keep" | "none";

export interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  keyMode: KeyMode;
  apiKeyEnv: string;
  apiKey: string;
  modelsText: string;
  modelLabels: Record<string, string>;
  modelPrices: Record<string, { input: string; output: string; cacheRead: string; cacheWrite: string }>;
  /** Jendela konteks per model (teks angka, kosong = otomatis). */
  modelWindows: Record<string, string>;
  defaultModel: string;
  lightModel: string;
  /** ID profil lain untuk satu kali fallback; string kosong berarti tanpa cadangan. */
  fallbackProfileId?: string;
  isNew: boolean;
}

export interface RegistryDraft {
  activeProfileId?: string;
  profiles: ProfileDraft[];
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDACTED_KEY = "***";

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function modelLines(modelsText: string): string[] {
  const models: string[] = [];
  for (const line of modelsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") models.push(trimmed);
  }
  return models;
}

function hasEmptyModelLine(modelsText: string): boolean {
  const lines = modelsText.split(/\r?\n/);
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
    lines.pop();
  }
  return lines.some((line) => line.trim() === "");
}

function copyProfile(profile: ProfileDraft): ProfileDraft {
  return { ...profile, modelLabels: { ...profile.modelLabels }, modelPrices: { ...profile.modelPrices },
    modelWindows: { ...profile.modelWindows },
  };
}

interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function parseNonNegative(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Bangun objek price untuk payload; butuh input dan output valid. */
function buildPrice(
  price: { input: string; output: string; cacheRead: string; cacheWrite: string } | undefined,
): ModelPrice | undefined {
  if (price === undefined) return undefined;
  const input = parseNonNegative(price.input);
  const output = parseNonNegative(price.output);
  if (input === undefined || output === undefined) return undefined;

  const result: ModelPrice = { input, output };
  const cacheRead = parseNonNegative(price.cacheRead);
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  const cacheWrite = parseNonNegative(price.cacheWrite);
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  return result;
}

export function toDraft(view: RegistryView): RegistryDraft {
  const profiles = view.profiles.map((profile) => {
    const mode: KeyMode =
      profile.apiKeyEnv !== undefined ? "env" : profile.hasKey ? "keep" : "none";
    const modelLabels: Record<string, string> = {};
    const modelPrices: Record<string, { input: string; output: string; cacheRead: string; cacheWrite: string }> = {};
    const modelWindows: Record<string, string> = {};
    for (const model of profile.models) {
      if (model.label !== undefined) modelLabels[model.id] = model.label;
      if (model.contextWindow !== undefined) modelWindows[model.id] = String(model.contextWindow);
      if (model.price !== undefined) {
        modelPrices[model.id] = {
          input: String(model.price.input),
          output: String(model.price.output),
          cacheRead: model.price.cacheRead !== undefined ? String(model.price.cacheRead) : "",
          cacheWrite: model.price.cacheWrite !== undefined ? String(model.price.cacheWrite) : "",
        };
      }
    }
    const draft: ProfileDraft = {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl ?? "",
      keyMode: mode,
      apiKeyEnv: profile.apiKeyEnv ?? "",
      apiKey: "",
      modelsText: profile.models.map((model) => model.id).join("\n"),
      modelLabels,
      modelPrices,
      modelWindows,
      defaultModel: profile.defaultModel ?? "",
      lightModel: profile.lightModel ?? "",
      isNew: false,
    };
    if (profile.fallbackProfileId !== undefined) {
      draft.fallbackProfileId = profile.fallbackProfileId;
    }
    return draft;
  });

  const draft: RegistryDraft = { profiles };
  if (view.activeProfileId !== undefined) draft.activeProfileId = view.activeProfileId;
  return draft;
}

const DEFAULT_PROFILE_NAME = "Provider";

/** Nama tampilan bawaan; pakai nomor terkecil yang belum dipakai bila bentrok. */
export function defaultProfileName(existingNames: string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(DEFAULT_PROFILE_NAME)) return DEFAULT_PROFILE_NAME;
  let index = 2;
  while (taken.has(`${DEFAULT_PROFILE_NAME} ${index}`)) {
    index += 1;
  }
  return `${DEFAULT_PROFILE_NAME} ${index}`;
}

export function newProfileDraft(existingIds: string[], existingNames: string[] = []): ProfileDraft {
  const taken = new Set(existingIds);
  let index = 1;
  while (taken.has(`profil-${index}`)) {
    index += 1;
  }
  return {
    id: `profil-${index}`,
    name: defaultProfileName(existingNames),
    baseUrl: "",
    keyMode: "none",
    apiKeyEnv: "",
    apiKey: "",
    modelsText: "",
    modelLabels: {},
    modelPrices: {},
    modelWindows: {},
    defaultModel: "",
    lightModel: "",
    fallbackProfileId: "",
    isNew: true,
  };
}

export interface FallbackOption {
  id: string;
  name: string;
}

/** Profil lain yang boleh menjadi cadangan: bukan dirinya dan tanpa cadangan sendiri. */
export function fallbackOptions(draft: RegistryDraft, profileId: string): FallbackOption[] {
  const options: FallbackOption[] = [];
  for (const profile of draft.profiles) {
    if (profile.id === profileId) continue;
    if ((profile.fallbackProfileId ?? "") !== "") continue;
    options.push({ id: profile.id, name: profile.name.trim() === "" ? profile.id : profile.name });
  }
  return options;
}

/** `null` menghapus cadangan; ID divalidasi server. */
export function setFallbackProfile(
  draft: RegistryDraft,
  id: string,
  fallbackProfileId: string | null,
): RegistryDraft {
  return updateProfile(draft, id, { fallbackProfileId: fallbackProfileId ?? "" });
}

/** Nama tampilan cadangan; `undefined` bila tidak diisi. */
export function fallbackName(draft: RegistryDraft, profile: ProfileDraft): string | undefined {
  const id = profile.fallbackProfileId;
  if (id === undefined || id === "") return undefined;
  const match = draft.profiles.find((entry) => entry.id === id);
  if (match === undefined) return id;
  return match.name.trim() === "" ? match.id : match.name;
}

/** Petakan galat validasi (lokal atau server) ke field formulir profil. */
export function fieldForMessage(message: string): string {  if (message.includes("cadangan")) return "fallback";
  if (message.startsWith("ID ")) return "id";
  if (message.startsWith("Nama variabel env")) return "apiKeyEnv";
  if (message.startsWith("Nama ")) return "name";
  if (message.startsWith("Base URL")) return "baseUrl";
  if (message.startsWith("API key")) return "apiKey";
  if (message.startsWith("Model utama")) return "defaultModel";
  if (message.startsWith("Model ringan")) return "lightModel";
  if (message.startsWith("Tarif ")) return "prices";
  if (message.startsWith("Model ")) return "models";
  return "lain";
}

export function updateProfile(
  draft: RegistryDraft,
  id: string,
  patch: Partial<ProfileDraft>,
): RegistryDraft {
  return {
    ...draft,
    profiles: draft.profiles.map((profile) =>
      profile.id === id ? { ...profile, ...patch } : profile,
    ),
  };
}

export function addProfile(draft: RegistryDraft, profile: ProfileDraft): RegistryDraft {
  const activeProfileId =
    draft.profiles.length === 0 ? profile.id : draft.activeProfileId;
  const next: RegistryDraft = { profiles: [...draft.profiles, copyProfile(profile)] };
  if (activeProfileId !== undefined) next.activeProfileId = activeProfileId;
  return next;
}

export function removeProfile(draft: RegistryDraft, id: string): RegistryDraft {
  const profiles = draft.profiles.filter((profile) => profile.id !== id);
  const remaining: RegistryDraft = { profiles };
  const activeProfileId =
    draft.activeProfileId === id ? profiles[0]?.id : draft.activeProfileId;
  if (activeProfileId !== undefined) remaining.activeProfileId = activeProfileId;
  return remaining;
}

export function validateDraft(draft: RegistryDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const push = (key: string, message: string): void => {
    const list = errors[key];
    if (list === undefined) errors[key] = [message];
    else list.push(message);
  };

  if (draft.profiles.length === 0) {
    push("_", "Minimal satu profil");
    return errors;
  }

  const seenIds = new Set<string>();

  for (const profile of draft.profiles) {
    const id = profile.id;
    if (!PROFILE_ID_PATTERN.test(id)) {
      push(id, "ID hanya boleh berisi huruf kecil, angka, dan tanda hubung.");
    }
    if (seenIds.has(id)) {
      push(id, "ID sudah dipakai profil lain.");
    }
    seenIds.add(id);

    if (profile.name.trim() === "") {
      push(id, "Nama tidak boleh kosong.");
    }

    if (profile.baseUrl.trim() !== "" && !isHttpUrl(profile.baseUrl.trim())) {
      push(id, "Base URL harus URL http atau https yang valid.");
    }

    if (profile.keyMode === "env") {
      if (!ENV_NAME_PATTERN.test(profile.apiKeyEnv.trim())) {
        push(id, "Nama variabel env tidak valid.");
      }
    } else if (profile.keyMode === "literal" && profile.apiKey.trim() === "") {
      push(id, "API key tidak boleh kosong.");
    }

    const fallbackProfileId = (profile.fallbackProfileId ?? "").trim();
    if (fallbackProfileId !== "") {
      if (fallbackProfileId === profile.id) {
        push(id, "Profil cadangan tidak boleh dirinya sendiri.");
      } else {
        const fallback = draft.profiles.find((entry) => entry.id === fallbackProfileId);
        if (fallback === undefined) {
          push(id, `Profil cadangan "${fallbackProfileId}" tidak ditemukan.`);
        } else if ((fallback.fallbackProfileId ?? "") !== "") {
          push(id, `Profil cadangan "${fallbackProfileId}" tidak boleh memiliki cadangan sendiri.`);
        }
      }
    }

    const models = modelLines(profile.modelsText);
    if (hasEmptyModelLine(profile.modelsText)) {
      push(id, "Model tidak boleh kosong.");
    }
    const seenModels = new Set<string>();
    for (const model of models) {
      if (seenModels.has(model)) {
        push(id, `Model "${model}" ditulis lebih dari sekali.`);
      }
      seenModels.add(model);
    }

    if (models.length > 0) {
      const defaultModel = profile.defaultModel.trim();
      if (defaultModel !== "" && !seenModels.has(defaultModel)) {
        push(id, `Model utama "${defaultModel}" tidak ada di daftar model.`);
      }
      const lightModel = profile.lightModel.trim();
      if (lightModel !== "" && !seenModels.has(lightModel)) {
        push(id, `Model ringan "${lightModel}" tidak ada di daftar model.`);
      }
    }

    // Validasi tarif model (hanya untuk model yang masih ada di daftar)
    const priceErrors: string[] = [];
    for (const modelId of models) {
      const price = profile.modelPrices[modelId];
      if (price === undefined) continue;

      const input = price.input.trim();
      const output = price.output.trim();

      if (input !== "" || output !== "") {
        if (input === "" || output === "") {
          priceErrors.push(`Tarif model "${modelId}": Masuk dan Keluar harus diisi keduanya.`);
        } else if (
          !Number.isFinite(Number(input)) ||
          !Number.isFinite(Number(output)) ||
          Number(input) < 0 ||
          Number(output) < 0
        ) {
          priceErrors.push(`Tarif model "${modelId}": Masuk dan Keluar harus angka >= 0.`);
        }
      }

      for (const [key, label] of [
        ["cacheRead", "Cache baca"],
        ["cacheWrite", "Cache tulis"],
      ] as const) {
        const raw = price[key].trim();
        if (raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
          priceErrors.push(`Tarif model "${modelId}": ${label} harus angka >= 0.`);
        }
      }
    }

    for (const modelId of models) {
      const raw = profile.modelWindows[modelId]?.trim() ?? "";
      if (raw !== "" && !/^[1-9][0-9]*$/.test(raw)) {
        priceErrors.push(`Jendela konteks model "${modelId}" harus bilangan bulat > 0.`);
      }
    }

    for (const message of priceErrors) {
      push(id, message);
    }
  }

  return errors;
}

export function toPayload(draft: RegistryDraft): unknown {
  const profiles = draft.profiles.map((profile) => {
    const models = modelLines(profile.modelsText).map((id) => {
      const label = profile.modelLabels[id];
      const price = buildPrice(profile.modelPrices[id]);
      const windowText = profile.modelWindows[id]?.trim() ?? "";
      const window = /^[1-9][0-9]*$/.test(windowText) ? Number(windowText) : undefined;
      if (label === undefined && price === undefined && window === undefined) return id;
      const model: Record<string, unknown> = { id };
      if (label !== undefined) model.label = label;
      if (price !== undefined) model.price = price;
      if (window !== undefined) model.contextWindow = window;
      return model;
    });
    const payload: Record<string, unknown> = {
      id: profile.id,
      name: profile.name,
      models,
    };

    if (profile.baseUrl.trim() !== "") {
      payload.baseUrl = profile.baseUrl.trim();
    }

    if (profile.keyMode === "env") {
      if (profile.apiKeyEnv.trim() !== "") payload.apiKeyEnv = profile.apiKeyEnv.trim();
    } else if (profile.keyMode === "literal") {
      if (profile.apiKey !== "") payload.apiKey = profile.apiKey;
    } else if (profile.keyMode === "keep") {
      payload.apiKey = REDACTED_KEY;
    }

    if (profile.defaultModel.trim() !== "") {
      payload.defaultModel = profile.defaultModel.trim();
    }
    if (profile.lightModel.trim() !== "") {
      payload.lightModel = profile.lightModel.trim();
    }
    const fallbackProfileId = (profile.fallbackProfileId ?? "").trim();
    if (fallbackProfileId !== "") {
      payload.fallbackProfileId = fallbackProfileId;
    }
    return payload;
  });

  const payload: Record<string, unknown> = { profiles };
  if (draft.activeProfileId !== undefined) {
    payload.activeProfileId = draft.activeProfileId;
  }
  return payload;
}

function comparable(profile: ProfileDraft): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    keyMode: profile.keyMode,
    apiKeyEnv: profile.apiKeyEnv,
    apiKey: profile.apiKey,
    modelsText: profile.modelsText,
    modelPrices: profile.modelPrices,
    modelWindows: profile.modelWindows,
    defaultModel: profile.defaultModel,
    lightModel: profile.lightModel,
    fallbackProfileId: profile.fallbackProfileId ?? "",
  };
}

export function isDirty(original: RegistryDraft, current: RegistryDraft): boolean {
  if (original.activeProfileId !== current.activeProfileId) {
    return true;
  }
  if (original.profiles.length !== current.profiles.length) {
    return true;
  }
  for (let index = 0; index < original.profiles.length; index += 1) {
    const left = original.profiles[index];
    const right = current.profiles[index];
    if (left === undefined || right === undefined) {
      return true;
    }
    if (JSON.stringify(comparable(left)) !== JSON.stringify(comparable(right))) {
      return true;
    }
  }
  return false;
}
