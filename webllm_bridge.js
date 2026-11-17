// HomeMaster WebLLM & Hub Bridge
// Connects to Family App Hub central registries (hub-core.js, webllm-hub.js,
// models.json), manages WebGPU model weights, and captures redacted web errors.

const HUB_BASE_URL = "https://family-app-hub.m-maniruzzaman.workers.dev";
const HUB_MODELS_URL = `${HUB_BASE_URL}/models.json`;
const HUB_WEBLLM_URL = `${HUB_BASE_URL}/webllm-hub.js`;
const HUB_CORE_URL = `${HUB_BASE_URL}/hub-core.js`;

const MODEL_STORAGE_KEY = "selected_webllm_model";
const DIAGNOSTICS_STORAGE_KEY = "home-master_diagnostics_v1";
const DEFAULT_MODEL = "Qwen2.5-3B-Instruct-q4f16_1-MLC";

const ALLOWED_FAMILIES = [
  "Qwen",
  "Llama-3.2",
  "Phi-3.5",
  "gemma-2",
  "DeepSeek-R1",
  "SmolLM2",
];

const FALLBACK_MODELS = [
  {
    id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
    label: "SmolLM2 1.7B (Fast / Mobile)",
    vramMB: 1774,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B (Balanced)",
    vramMB: 2263,
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen 2.5 3B (Recommended)",
    vramMB: 2504,
  },
  {
    id: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
    label: "DeepSeek R1 Distill 7B (Desktop)",
    vramMB: 5107,
  },
];

let webllmModule = null;
let hubCoreModule = null;
let webllmHubModule = null;
let engine = null;
let activeModelId = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
let currentProgress = {
  text: "Idle",
  progress: 0,
  isLoaded: false,
  modelId: activeModelId,
};

function redactDiagnosticsText(input) {
  return String(input || "")
    .replace(/#state=[^\s&"']+/g, "#state=[REDACTED]")
    .replace(/#handoff=[^\s&"']+/g, "#handoff=[REDACTED]")
    .replace(/\$\s*[0-9,]+(?:\.[0-9]{1,2})?/g, "$[REDACTED]")
    .replace(/\/(Users|home)\/[^/\s]+/g, "/[USER]");
}

function recordWebDiagnostic(type, err) {
  try {
    const existing = JSON.parse(
      localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) || "[]"
    );
    const list = Array.isArray(existing) ? existing : [];
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: redactDiagnosticsText(err?.message || err),
      stackPreview: err?.stack
        ? redactDiagnosticsText(String(err.stack).split("\n").slice(0, 3).join(" | "))
        : undefined,
    };
    const next = [...list, entry].slice(-15);
    localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(next));
  } catch (_) {}
}

window.addEventListener("error", (event) => {
  recordWebDiagnostic("window.error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  recordWebDiagnostic("unhandledrejection", event.reason);
});

async function tryLoadHubSdks() {
  if (!hubCoreModule) {
    try {
      hubCoreModule = await import(HUB_CORE_URL);
    } catch (_) {}
  }
  if (!webllmHubModule) {
    try {
      webllmHubModule = await import(HUB_WEBLLM_URL);
    } catch (_) {}
  }
}

async function ensureWebLLM() {
  if (!webllmModule) {
    webllmModule = await import("https://esm.run/@mlc-ai/web-llm@latest");
  }
  return webllmModule;
}

function getAvailableAppModels(webllm, maxVramMB = 4000) {
  const list = webllm?.prebuiltAppConfig?.model_list || [];
  return list
    .filter(
      (m) =>
        typeof m.model_id === "string" &&
        m.model_id.endsWith("-q4f16_1-MLC") &&
        (m.vram_required_MB ?? 9999) <= maxVramMB &&
        ALLOWED_FAMILIES.some((family) => m.model_id.includes(family))
    )
    .sort((a, b) => (a.vram_required_MB ?? 0) - (b.vram_required_MB ?? 0))
    .map((m) => ({
      id: m.model_id,
      label: m.model_id.replace("-q4f16_1-MLC", "").replaceAll("-", " "),
      vramMB: Math.round(m.vram_required_MB ?? 0),
    }));
}

async function resolveAndCleanModel(webllm, supportedModelIds, preferredDefault) {
  const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
  const fallbackDefault = supportedModelIds.includes(preferredDefault)
    ? preferredDefault
    : supportedModelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : supportedModelIds[0] || DEFAULT_MODEL;

  if (savedModel && !supportedModelIds.includes(savedModel)) {
    try {
      await webllm.deleteModelAllInfoInCache(savedModel);
      console.log(`Purged deprecated WebLLM model cache: ${savedModel}`);
    } catch (err) {
      console.warn("Could not purge old model cache:", err);
    }
    localStorage.setItem(MODEL_STORAGE_KEY, fallbackDefault);
    activeModelId = fallbackDefault;
    return fallbackDefault;
  }

  const chosen = savedModel || fallbackDefault;
  localStorage.setItem(MODEL_STORAGE_KEY, chosen);
  activeModelId = chosen;
  return chosen;
}

async function loadSyncedModels() {
  await tryLoadHubSdks();
  const webllm = await ensureWebLLM();
  const builtInIds = new Set(
    (webllm?.prebuiltAppConfig?.model_list || []).map((m) => m.model_id)
  );

  let selectedList = [];
  let preferredDefault = DEFAULT_MODEL;

  try {
    if (webllmHubModule && typeof webllmHubModule.loadSyncedModels === "function") {
      const synced = await webllmHubModule.loadSyncedModels({
        appId: "home-master",
        webllm,
        fallbackModels: FALLBACK_MODELS,
      });
      if (synced?.models?.length) {
        selectedList = synced.models.map((m) => ({
          id: m.id,
          label: m.label || m.id,
          vramMB: m.vramMB || 0,
        }));
        preferredDefault = synced.defaultModel || DEFAULT_MODEL;
      }
    }
  } catch (_) {}

  if (selectedList.length === 0) {
    try {
      const res = await fetch(HUB_MODELS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const registry = await res.json();

      for (const oldId of registry.deprecatedModels || []) {
        try {
          if (await webllm.hasModelInCache(oldId)) {
            await webllm.deleteModelAllInfoInCache(oldId);
          }
        } catch (_) {}
      }

      const validModels = (registry.models || []).filter((m) =>
        builtInIds.has(m.id)
      );
      if (validModels.length > 0) {
        selectedList = validModels.map((m) => ({
          id: m.id,
          label: m.label || m.id,
          vramMB: m.vramMB || 0,
        }));
        const appDefault = registry?.defaults?.apps?.["home-master"];
        const candidateDefault = appDefault || registry.defaultModel;
        preferredDefault = builtInIds.has(candidateDefault)
          ? candidateDefault
          : validModels[0].id;
      }
    } catch (err) {
      console.warn("Using offline/dynamic WebLLM model list:", err);
    }
  }

  if (selectedList.length === 0) {
    const dynamicModels = getAvailableAppModels(webllm, 4000);
    selectedList =
      dynamicModels.length > 0
        ? dynamicModels
        : FALLBACK_MODELS.filter(
            (m) => builtInIds.size === 0 || builtInIds.has(m.id)
          );
  }

  if (selectedList.length === 0) {
    selectedList = FALLBACK_MODELS;
  }

  const ids = selectedList.map((m) => m.id);
  const resolvedDefault = await resolveAndCleanModel(
    webllm,
    ids,
    preferredDefault
  );

  const annotated = await Promise.all(
    selectedList.map(async (m) => {
      let cached = false;
      try {
        cached = await webllm.hasModelInCache(m.id);
      } catch (_) {}
      return {
        ...m,
        cached,
      };
    })
  );

  return {
    webGpuAvailable: Boolean(navigator.gpu),
    activeModelId: resolvedDefault,
    isLoaded: Boolean(engine),
    models: annotated,
  };
}

window.HomeMasterWebLLM = {
  isWebGpuAvailable() {
    return Boolean(typeof navigator !== "undefined" && navigator.gpu);
  },

  getInitialHash() {
    return typeof window !== "undefined" ? window.location.hash || "" : "";
  },

  clearHash() {
    try {
      if (typeof window !== "undefined" && window.history?.replaceState) {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        );
      }
    } catch (_) {}
  },

  async shareText(title, text) {
    try {
      if (navigator?.share) {
        await navigator.share({ title, text });
        return true;
      }
    } catch (_) {}
    return false;
  },

  getProgressJson() {
    return JSON.stringify(currentProgress);
  },

  async getModelsJson() {
    try {
      const payload = await loadSyncedModels();
      return JSON.stringify(payload);
    } catch (err) {
      recordWebDiagnostic("getModelsJson", err);
      return JSON.stringify({
        webGpuAvailable: Boolean(typeof navigator !== "undefined" && navigator.gpu),
        activeModelId,
        isLoaded: Boolean(engine),
        models: FALLBACK_MODELS.map((m) => ({ ...m, cached: false })),
        error: String(err),
      });
    }
  },

  async initEngineJson(modelId) {
    try {
      if (!navigator.gpu) {
        return JSON.stringify({
          ok: false,
          error: "WebGPU is not supported in this browser.",
        });
      }

      const webllm = await ensureWebLLM();
      const targetId = modelId || activeModelId || DEFAULT_MODEL;
      localStorage.setItem(MODEL_STORAGE_KEY, targetId);
      activeModelId = targetId;

      currentProgress = {
        text: `Initializing ${targetId}...`,
        progress: 0.02,
        isLoaded: false,
        modelId: targetId,
      };

      if (engine && typeof engine.unload === "function") {
        try {
          await engine.unload();
        } catch (_) {}
      }

      engine = await webllm.CreateMLCEngine(targetId, {
        initProgressCallback: (report) => {
          currentProgress = {
            text: report.text || "Loading WebLLM model...",
            progress: typeof report.progress === "number" ? report.progress : 0,
            isLoaded: false,
            modelId: targetId,
          };
        },
      });

      currentProgress = {
        text: `Ready: ${targetId}`,
        progress: 1.0,
        isLoaded: true,
        modelId: targetId,
      };

      return JSON.stringify({
        ok: true,
        modelId: targetId,
      });
    } catch (err) {
      recordWebDiagnostic("initEngineJson", err);
      currentProgress = {
        text: `Failed: ${err}`,
        progress: 0,
        isLoaded: false,
        modelId: activeModelId,
      };
      return JSON.stringify({
        ok: false,
        error: String(err),
      });
    }
  },

  async generateJson(systemPrompt, userPrompt, maxTokens = 700, temperature = 0.25) {
    try {
      if (!engine) {
        return JSON.stringify({
          ok: false,
          error: "WebLLM engine is not initialized.",
        });
      }

      const reply = await engine.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      });

      const content = reply?.choices?.[0]?.message?.content || "";
      return JSON.stringify({
        ok: true,
        content,
        modelId: activeModelId,
      });
    } catch (err) {
      recordWebDiagnostic("generateJson", err);
      return JSON.stringify({
        ok: false,
        error: String(err),
      });
    }
  },

  async purgeCacheJson(modelId) {
    try {
      const webllm = await ensureWebLLM();
      if (modelId) {
        await webllm.deleteModelAllInfoInCache(modelId);
      }
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err) });
    }
  },
};
