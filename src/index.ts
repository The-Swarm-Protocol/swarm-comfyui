/**
 * ComfyUI Plugin — 2D image generation via ComfyUI (self-hosted) or Replicate (cloud).
 *
 * Capabilities:
 *   texture-2d — Tileable textures for floors, walls, etc.
 *   sprite-2d  — Pixel art character sprites
 *
 * The underlying API clients live at lib/mods/comfyui/.
 * This plugin wraps them with the GenerationPlugin contract.
 */

import type {
  GenerationPlugin,
  GenerationJob,
  JobStep,
  AssetKind,
  StepAdvanceResult,
} from "../types";
import { registerPlugin } from "../registry";

// Re-export provider functions for direct use if needed
export {
  getProvider,
  isImageGenerationConfigured,
  submitImageGeneration,
  pollImageStatus,
  downloadGeneratedImage,
} from "@/lib/mods/comfyui/provider";

import {
  isImageGenerationConfigured,
  submitImageGeneration,
  pollImageStatus,
} from "@/lib/mods/comfyui/provider";
import type { ComfyUIProvider } from "@/lib/mods/comfyui/provider";

/* ═══════════════════════════════════════
   Step definitions
   ═══════════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildSteps(_assetKind: AssetKind, _config?: Record<string, unknown>): JobStep[] {
  return [
    { name: "generate", status: "pending" },
    { name: "download", status: "pending" },
  ];
}

/* ═══════════════════════════════════════
   Step advancement logic
   ═══════════════════════════════════════ */

async function advanceStep(job: GenerationJob): Promise<StepAdvanceResult> {
  const steps = job.steps.map((s) => ({ ...s }));
  let currentStep = job.currentStep;
  const step = steps[currentStep];

  if (!step) {
    return { steps, currentStep, progress: 100, error: "No step to advance" };
  }

  // Extract provider from job config (set when the job is created)
  const provider = (job.config?.provider as ComfyUIProvider) || "replicate";

  try {
    switch (step.name) {
      case "generate": {
        if (step.status === "pending") {
          const negativePrompt = job.assetKind === "texture-2d"
            ? "blurry, text, watermark, logo, frame, border, low quality, seam visible"
            : "blurry, realistic, photograph, 3d render, multiple characters, text, watermark, frame, border";

          const size = job.assetKind === "sprite-2d" ? 512 : 1024;
          const result = await submitImageGeneration(job.prompt, negativePrompt, size, size);

          step.externalId = result.id;
          step.status = "running";
          step.startedAt = Date.now();

          // Store the actual provider used in the step for polling
          return { steps, currentStep, progress: 15 };
        }

        // Poll status
        if (!step.externalId) return { steps, currentStep, progress: 0, error: "Missing generation ID" };
        const status = await pollImageStatus(step.externalId, provider);

        if (status.status === "failed") {
          step.status = "failed";
          return { steps, currentStep, progress: 0, error: "Image generation failed" };
        }
        if (status.status === "completed") {
          step.status = "completed";
          step.outputUrl = status.outputUrl;
          step.completedAt = Date.now();
          currentStep++;
          return { steps, currentStep, progress: 70 };
        }
        return { steps, currentStep, progress: status.status === "running" ? 40 : 15 };
      }

      case "download": {
        // The output URL from the generate step is the final output
        const genStep = steps.find((s) => s.name === "generate");
        const outputUrl = genStep?.outputUrl;

        if (!outputUrl) {
          step.status = "failed";
          return { steps, currentStep, progress: 70, error: "No output URL from generation step" };
        }

        step.status = "completed";
        step.outputUrl = outputUrl;
        step.completedAt = Date.now();
        currentStep++;

        return { steps, currentStep, progress: 100, outputUrl };
      }

      default:
        return { steps, currentStep, progress: job.progress, error: `Unknown step: ${step.name}` };
    }
  } catch (err) {
    step.status = "failed";
    return {
      steps,
      currentStep,
      progress: job.progress,
      error: err instanceof Error ? err.message : "Unknown ComfyUI error",
    };
  }
}

/* ═══════════════════════════════════════
   Plugin definition + registration
   ═══════════════════════════════════════ */

export const comfyuiPlugin: GenerationPlugin = {
  id: "comfyui",
  name: "ComfyUI / Replicate",
  capabilities: ["texture-2d", "sprite-2d"],
  requiredEnvVars: ["COMFYUI_ENDPOINT"], // or REPLICATE_API_TOKEN
  isConfigured: isImageGenerationConfigured,
  buildSteps,
  advanceStep,
};

// Auto-register on import
registerPlugin({
  plugin: comfyuiPlugin,
  slug: "comfyui",
  description: "AI-powered 2D image generation — textures and sprites via ComfyUI or Replicate SDXL",
  icon: "Image",
  tags: ["2d", "comfyui", "replicate", "textures", "sprites", "ai"],
});
