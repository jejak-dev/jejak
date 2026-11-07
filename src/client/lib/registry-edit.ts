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
  defaultModel: string;
  lightModel: string;
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
  return { ...profile, modelLabels: { ...profile.modelLabels } };
}

export function toDraft(view: RegistryView): RegistryDraft {
  const profiles = view.profiles.map((profile) => {
    const mode: KeyMode =
      profile.apiKeyEnv !== undefined ? "env" : profile.hasKey ? "keep" : "none";
    const modelLabels: Record<string, string> = {};
    for (const model of profile.models) {
      if (model.label !== undefined) modelLabels[model.id] = model.label;
    }
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl ?? "",
      keyMode: mode,
      apiKeyEnv: profile.apiKeyEnv ?? "",
      apiKey: "",
      modelsText: profile.models.map((model) => model.id).join("\n"),
      modelLabels,
      defaultModel: profile.defaultModel ?? "",
      lightModel: profile.lightModel ?? "",
      isNew: false,
    };
  });

  const draft: RegistryDraft = { profiles };
  if (view.activeProfileId !== undefined) draft.activeProfileId = view.activeProfileId;
  return draft;
}

export function newProfileDraft(existingIds: string[]): ProfileDraft {
  const taken = new Set(existingIds);
  let index = 1;
  while (taken.has(`profil-${index}`)) {
    index += 1;
  }
  return {
    id: `profil-${index}`,
    name: "Profil baru",
    baseUrl: "",
    keyMode: "none",
    apiKeyEnv: "",
    apiKey: "",
    modelsText: "",
    modelLabels: {},
    defaultModel: "",
    lightModel: "",
    isNew: true,
  };
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
  }

  return errors;
}

export function toPayload(draft: RegistryDraft): unknown {
  const profiles = draft.profiles.map((profile) => {
    const models = modelLines(profile.modelsText).map((id) => {
      const label = profile.modelLabels[id];
      return label === undefined ? id : { id, label };
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
    defaultModel: profile.defaultModel,
    lightModel: profile.lightModel,
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
