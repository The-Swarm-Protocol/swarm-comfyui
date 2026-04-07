/**
 * ComfyUI API Client — Canonical Swarm-level integration (server-side only)
 *
 * Wraps the full ComfyUI REST API surface: system stats, node info,
 * image upload, prompt queue, history, image retrieval, and control.
 *
 * This is independent of the Office Sim mod client at
 * `lib/mods/comfyui/client.ts` which handles pixel-art-specific workflows.
 *
 * Env vars:
 *   COMFYUI_BASE_URL  — required, e.g. "http://localhost:8188"
 *   COMFYUI_API_KEY   — optional, added as Bearer token when present
 */

/* ═══════════════════════════════════════
   Types
   ═══════════════════════════════════════ */

export interface ComfySystemStats {
  system: {
    os: string;
    python_version: string;
    embedded_python: boolean;
  };
  devices: {
    name: string;
    type: string;
    index: number;
    vram_total: number;
    vram_free: number;
    torch_vram_total: number;
    torch_vram_free: number;
  }[];
}

export interface ComfyNodeInfo {
  input: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output: unknown[];
  output_name: string[];
  name: string;
  description: string;
  category: string;
}

export interface ComfyUploadResult {
  name: string;
  subfolder: string;
  type: string;
}

export interface ComfyQueueResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface ComfyQueueStatus {
  queue_running: unknown[][];
  queue_pending: unknown[][];
}

export interface ComfyHistoryEntry {
  prompt: unknown[];
  outputs: Record<
    string,
    {
      images?: {
        filename: string;
        subfolder: string;
        type: string;
      }[];
    }
  >;
  status: {
    status_str: string;
    completed: boolean;
  };
}

/* ═══════════════════════════════════════
   Config helpers
   ═══════════════════════════════════════ */

/**
 * Returns the ComfyUI base URL with trailing slash stripped.
 * Throws if `COMFYUI_BASE_URL` is not set.
 */
export function getComfyBaseUrl(): string {
  const url = process.env.COMFYUI_BASE_URL;
  if (!url) {
    throw new Error(
      "COMFYUI_BASE_URL environment variable is not set. " +
        "Configure it to point at your ComfyUI instance (e.g. http://localhost:8188).",
    );
  }
  return url.replace(/\/+$/, "");
}

/**
 * Returns `true` when a ComfyUI base URL is configured.
 */
export function isComfyConfigured(): boolean {
  return !!process.env.COMFYUI_BASE_URL;
}

/**
 * Returns the optional API key, or `null` when not configured.
 */
export function getComfyApiKey(): string | null {
  return process.env.COMFYUI_API_KEY ?? null;
}

/* ═══════════════════════════════════════
   Internal fetch helper
   ═══════════════════════════════════════ */

/**
 * Low-level fetch wrapper that:
 *  - prepends the configured base URL
 *  - attaches Bearer auth when an API key is present
 *  - applies a per-request timeout (default 30 s)
 *  - throws a descriptive error on non-2xx responses
 */
async function comfyFetch(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const base = getComfyBaseUrl();
  const apiKey = getComfyApiKey();
  const { timeoutMs = 30_000, ...fetchInit } = init ?? {};

  const headers = new Headers(fetchInit.headers);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const res = await fetch(`${base}${path}`, {
    ...fetchInit,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ComfyUI ${init?.method ?? "GET"} ${path} failed (${res.status}): ${body}`,
    );
  }

  return res;
}

/* ═══════════════════════════════════════
   System
   ═══════════════════════════════════════ */

/**
 * GET /system_stats — hardware, VRAM, python version, etc.
 */
export async function getSystemStats(): Promise<ComfySystemStats> {
  const res = await comfyFetch("/system_stats");
  return res.json() as Promise<ComfySystemStats>;
}

/**
 * GET /object_info — full node registry (inputs, outputs, categories).
 * Uses a 60 s timeout because the payload can be large on nodes-heavy installs.
 */
export async function getObjectInfo(): Promise<Record<string, ComfyNodeInfo>> {
  const res = await comfyFetch("/object_info", { timeoutMs: 60_000 });
  return res.json() as Promise<Record<string, ComfyNodeInfo>>;
}

/* ═══════════════════════════════════════
   Image upload
   ═══════════════════════════════════════ */

/**
 * POST /upload/image — upload an image file via multipart/form-data.
 *
 * @param file       Raw image bytes
 * @param filename   Desired filename (e.g. "ref.png")
 * @param opts.subfolder  Target subfolder inside the input directory
 * @param opts.overwrite  Replace existing file with the same name
 * @param opts.type       Storage bucket — "input" (default) or "temp"
 */
export async function uploadImage(
  file: Buffer,
  filename: string,
  opts?: {
    subfolder?: string;
    overwrite?: boolean;
    type?: "input" | "temp";
  },
): Promise<ComfyUploadResult> {
  const form = new FormData();
  // Copy into a plain ArrayBuffer to satisfy TS 5.9 BlobPart constraints
  const ab = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
  form.append("image", new Blob([ab]), filename);

  if (opts?.subfolder) {
    form.append("subfolder", opts.subfolder);
  }
  if (opts?.overwrite !== undefined) {
    form.append("overwrite", opts.overwrite ? "true" : "false");
  }
  if (opts?.type) {
    form.append("type", opts.type);
  }

  const res = await comfyFetch("/upload/image", {
    method: "POST",
    body: form,
  });

  return res.json() as Promise<ComfyUploadResult>;
}

/* ═══════════════════════════════════════
   Queue
   ═══════════════════════════════════════ */

/**
 * POST /prompt — queue a workflow for execution.
 *
 * @param workflow  The ComfyUI workflow graph (node-id keyed object)
 * @param clientId  Optional client identifier for WebSocket correlation
 */
export async function queuePrompt(
  workflow: Record<string, unknown>,
  clientId?: string,
): Promise<ComfyQueueResult> {
  const payload: Record<string, unknown> = { prompt: workflow };
  if (clientId) {
    payload.client_id = clientId;
  }

  const res = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return res.json() as Promise<ComfyQueueResult>;
}

/**
 * GET /queue — current running and pending queue entries.
 */
export async function getQueue(): Promise<ComfyQueueStatus> {
  const res = await comfyFetch("/queue");
  return res.json() as Promise<ComfyQueueStatus>;
}

/**
 * GET /history/{promptId} — fetch the execution record for a single prompt.
 * Returns `null` when the prompt ID is not found in history.
 */
export async function getPromptHistory(
  promptId: string,
): Promise<ComfyHistoryEntry | null> {
  const base = getComfyBaseUrl();
  const apiKey = getComfyApiKey();

  const headers = new Headers();
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const res = await fetch(
    `${base}/history/${encodeURIComponent(promptId)}`,
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    if (res.status === 404) return null;
    const body = await res.text().catch(() => "");
    throw new Error(
      `ComfyUI GET /history/${promptId} failed (${res.status}): ${body}`,
    );
  }

  const data: Record<string, ComfyHistoryEntry> = await res.json();
  return data[promptId] ?? null;
}

/* ═══════════════════════════════════════
   Images
   ═══════════════════════════════════════ */

/**
 * GET /view — download an image produced by ComfyUI.
 *
 * @param filename   Image filename (from history outputs)
 * @param subfolder  Subfolder within the output directory
 * @param type       Image type — "output" (default), "input", or "temp"
 * @returns Raw image bytes as a Buffer
 */
export async function viewImage(
  filename: string,
  subfolder?: string,
  type?: string,
): Promise<Buffer> {
  const params = new URLSearchParams({ filename });
  if (subfolder) params.set("subfolder", subfolder);
  if (type) params.set("type", type);

  const res = await comfyFetch(`/view?${params.toString()}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/* ═══════════════════════════════════════
   Control
   ═══════════════════════════════════════ */

/**
 * POST /interrupt — cancel the currently executing prompt.
 */
export async function interrupt(): Promise<void> {
  await comfyFetch("/interrupt", { method: "POST" });
}

/**
 * POST /free — release GPU resources.
 *
 * @param unloadModels  Unload all loaded models from VRAM (default `false`)
 * @param freeMemory    Free cached memory allocations (default `false`)
 */
export async function freeModels(
  unloadModels = false,
  freeMemory = false,
): Promise<void> {
  await comfyFetch("/free", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      unload_models: unloadModels,
      free_memory: freeMemory,
    }),
  });
}

/* ═══════════════════════════════════════
   Additional types
   ═══════════════════════════════════════ */

export interface ComfyEmbeddings {
  [key: string]: string[]; // category -> embedding names
}

/* ═══════════════════════════════════════
   Constants
   ═══════════════════════════════════════ */

export const COMFYUI_SAMPLERS = [
  "euler",
  "euler_ancestral",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ddim",
  "uni_pc",
  "uni_pc_bh2",
] as const;

export const COMFYUI_SCHEDULERS = [
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
] as const;

export const COMFYUI_IMAGE_SIZES = [
  { label: "512x512", width: 512, height: 512 },
  { label: "768x768", width: 768, height: 768 },
  { label: "1024x1024", width: 1024, height: 1024 },
  { label: "1024x768 (Landscape)", width: 1024, height: 768 },
  { label: "768x1024 (Portrait)", width: 768, height: 1024 },
  { label: "1344x768 (Wide)", width: 1344, height: 768 },
  { label: "768x1344 (Tall)", width: 768, height: 1344 },
] as const;

/* ═══════════════════════════════════════
   History management
   ═══════════════════════════════════════ */

/**
 * POST /history — delete a specific prompt from history.
 *
 * @param promptId  The prompt ID to remove from history
 */
export async function deleteHistory(promptId: string): Promise<void> {
  await comfyFetch("/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
}

/* ═══════════════════════════════════════
   Queue management
   ═══════════════════════════════════════ */

/**
 * POST /queue — clear the entire queue (both pending and running).
 */
export async function clearQueue(): Promise<void> {
  await comfyFetch("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  });
}

/**
 * POST /queue — delete specific items from the queue.
 *
 * @param deleteIds  Array of queue entry IDs to remove
 */
export async function deleteQueueItem(deleteIds: string[]): Promise<void> {
  await comfyFetch("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: deleteIds }),
  });
}

/* ═══════════════════════════════════════
   Embeddings & Extensions
   ═══════════════════════════════════════ */

/**
 * GET /embeddings — list all available embeddings grouped by category.
 */
export async function getEmbeddings(): Promise<ComfyEmbeddings> {
  const res = await comfyFetch("/embeddings");
  return res.json() as Promise<ComfyEmbeddings>;
}

/**
 * GET /extensions — list all loaded ComfyUI extension names.
 */
export async function getExtensions(): Promise<string[]> {
  const res = await comfyFetch("/extensions");
  return res.json() as Promise<string[]>;
}

/* ═══════════════════════════════════════
   Mask upload
   ═══════════════════════════════════════ */

/**
 * POST /upload/mask — upload a mask image via multipart/form-data.
 *
 * @param file          Raw mask image bytes
 * @param filename      Desired filename (e.g. "mask.png")
 * @param opts.subfolder    Target subfolder inside the input directory
 * @param opts.overwrite    Replace existing file with the same name
 * @param opts.originalRef  Reference to the original image this mask belongs to
 */
export async function uploadMask(
  file: Buffer,
  filename: string,
  opts?: {
    subfolder?: string;
    overwrite?: boolean;
    originalRef?: string;
  },
): Promise<ComfyUploadResult> {
  const form = new FormData();
  // Copy into a plain ArrayBuffer to satisfy TS 5.9 BlobPart constraints
  const ab = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
  form.append("image", new Blob([ab]), filename);

  if (opts?.subfolder) {
    form.append("subfolder", opts.subfolder);
  }
  if (opts?.overwrite !== undefined) {
    form.append("overwrite", opts.overwrite ? "true" : "false");
  }
  if (opts?.originalRef) {
    form.append("original_ref", opts.originalRef);
  }

  const res = await comfyFetch("/upload/mask", {
    method: "POST",
    body: form,
  });

  return res.json() as Promise<ComfyUploadResult>;
}

/* ═══════════════════════════════════════
   Object info helpers (models, samplers, schedulers)
   ═══════════════════════════════════════ */

/**
 * GET /object_info/CheckpointLoaderSimple — list available model checkpoint names.
 * Falls back to an empty array if the fetch fails.
 */
export async function getModels(): Promise<string[]> {
  try {
    const res = await comfyFetch("/object_info/CheckpointLoaderSimple", {
      timeoutMs: 15_000,
    });
    const data = await res.json();
    const names =
      data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    if (Array.isArray(names)) return names as string[];
    return [];
  } catch {
    return [];
  }
}

/**
 * GET /object_info/KSampler — list available sampler algorithm names.
 * Falls back to `COMFYUI_SAMPLERS` if the fetch fails.
 */
export async function getSamplers(): Promise<string[]> {
  try {
    const res = await comfyFetch("/object_info/KSampler", {
      timeoutMs: 15_000,
    });
    const data = await res.json();
    const names = data?.KSampler?.input?.required?.sampler_name?.[0];
    if (Array.isArray(names)) return names as string[];
    return [...COMFYUI_SAMPLERS];
  } catch {
    return [...COMFYUI_SAMPLERS];
  }
}

/**
 * GET /object_info/KSampler — list available scheduler names.
 * Falls back to `COMFYUI_SCHEDULERS` if the fetch fails.
 */
export async function getSchedulers(): Promise<string[]> {
  try {
    const res = await comfyFetch("/object_info/KSampler", {
      timeoutMs: 15_000,
    });
    const data = await res.json();
    const names = data?.KSampler?.input?.required?.scheduler?.[0];
    if (Array.isArray(names)) return names as string[];
    return [...COMFYUI_SCHEDULERS];
  } catch {
    return [...COMFYUI_SCHEDULERS];
  }
}

/* ═══════════════════════════════════════
   Health check
   ═══════════════════════════════════════ */

/**
 * Ping the ComfyUI instance via `getSystemStats` with a 5 s timeout.
 * Returns connection status and measured latency in milliseconds.
 */
export async function healthCheck(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await comfyFetch("/system_stats", { timeoutMs: 5_000 });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error";
    return { ok: false, latencyMs: 0, error: message };
  }
}
