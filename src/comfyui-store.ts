/**
 * ComfyUI Store — Firestore CRUD for ComfyUI workflow jobs and output artifacts.
 *
 * Collections:
 *   comfyJobs      — workflow execution records
 *   comfyArtifacts — output images/files produced by completed workflows
 *   comfyWorkflows — saved workflow templates
 */

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  serverTimestamp,
  Timestamp,
  increment,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ComfyJobStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface ComfyJob {
  id: string;
  orgId: string;
  userId: string;                    // wallet address of requester
  agentId?: string;                  // if triggered by an agent
  comfyPromptId: string;             // ComfyUI's prompt_id
  workflowName: string;              // user-friendly label
  prompt: string;                    // text prompt used
  workflow: Record<string, unknown>; // full workflow JSON
  status: ComfyJobStatus;
  progress: number;                  // 0-100
  error?: string;
  previewUrl?: string;               // thumbnail/preview during generation
  negativePrompt?: string;           // negative prompt
  width?: number;                    // output width
  height?: number;                   // output height
  steps?: number;                    // sampling steps
  cfg?: number;                      // classifier-free guidance scale
  sampler?: string;                  // sampler name
  scheduler?: string;                // scheduler name
  seed?: number;                     // random seed used
  checkpoint?: string;               // model checkpoint used
  tags?: string[];                   // user tags for organization
  isFavorite?: boolean;              // starred by user
  createdAt: Date | null;
  updatedAt: Date | null;
  completedAt?: Date | null;
}

export interface ComfyArtifact {
  id: string;
  orgId: string;
  jobId: string;          // references comfyJobs doc
  comfyPromptId: string;
  filename: string;       // ComfyUI output filename
  subfolder: string;
  mimeType: string;       // image/png, image/jpeg, etc.
  url?: string;           // external URL if uploaded to storage
  width?: number;
  height?: number;
  nodeId: string;         // which ComfyUI node produced this
  createdAt: Date | null;
}

export interface ComfyWorkflowTemplate {
  id: string;
  orgId: string;
  name: string;
  description: string;
  workflow: Record<string, unknown>;
  defaultPrompt?: string;
  defaultNegativePrompt?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultSteps?: number;
  defaultCfg?: number;
  defaultSampler?: string;
  defaultScheduler?: string;
  thumbnail?: string;     // base64 or URL
  tags?: string[];
  isPublic: boolean;      // visible in marketplace
  usageCount: number;
  createdBy: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function toDate(val: unknown): Date | null {
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  return null;
}

function docToJob(id: string, data: Record<string, unknown>): ComfyJob {
  return {
    id,
    orgId: data.orgId as string,
    userId: data.userId as string,
    agentId: data.agentId as string | undefined,
    comfyPromptId: data.comfyPromptId as string,
    workflowName: data.workflowName as string,
    prompt: data.prompt as string,
    workflow: (data.workflow as Record<string, unknown>) ?? {},
    status: data.status as ComfyJobStatus,
    progress: (data.progress as number) ?? 0,
    error: data.error as string | undefined,
    previewUrl: data.previewUrl as string | undefined,
    negativePrompt: data.negativePrompt as string | undefined,
    width: data.width as number | undefined,
    height: data.height as number | undefined,
    steps: data.steps as number | undefined,
    cfg: data.cfg as number | undefined,
    sampler: data.sampler as string | undefined,
    scheduler: data.scheduler as string | undefined,
    seed: data.seed as number | undefined,
    checkpoint: data.checkpoint as string | undefined,
    tags: data.tags as string[] | undefined,
    isFavorite: data.isFavorite as boolean | undefined,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
    completedAt: toDate(data.completedAt),
  };
}

function docToArtifact(id: string, data: Record<string, unknown>): ComfyArtifact {
  return {
    id,
    orgId: data.orgId as string,
    jobId: data.jobId as string,
    comfyPromptId: data.comfyPromptId as string,
    filename: data.filename as string,
    subfolder: data.subfolder as string,
    mimeType: data.mimeType as string,
    url: data.url as string | undefined,
    width: data.width as number | undefined,
    height: data.height as number | undefined,
    nodeId: data.nodeId as string,
    createdAt: toDate(data.createdAt),
  };
}

function docToWorkflow(id: string, data: Record<string, unknown>): ComfyWorkflowTemplate {
  return {
    id,
    orgId: data.orgId as string,
    name: data.name as string,
    description: data.description as string,
    workflow: (data.workflow as Record<string, unknown>) ?? {},
    defaultPrompt: data.defaultPrompt as string | undefined,
    defaultNegativePrompt: data.defaultNegativePrompt as string | undefined,
    defaultWidth: data.defaultWidth as number | undefined,
    defaultHeight: data.defaultHeight as number | undefined,
    defaultSteps: data.defaultSteps as number | undefined,
    defaultCfg: data.defaultCfg as number | undefined,
    defaultSampler: data.defaultSampler as string | undefined,
    defaultScheduler: data.defaultScheduler as string | undefined,
    thumbnail: data.thumbnail as string | undefined,
    tags: data.tags as string[] | undefined,
    isPublic: (data.isPublic as boolean) ?? false,
    usageCount: (data.usageCount as number) ?? 0,
    createdBy: data.createdBy as string,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

// ═══════════════════════════════════════════════════════════════
// Jobs
// ═══════════════════════════════════════════════════════════════

/** Create a new ComfyUI job record. Returns the Firestore document ID. */
export async function createComfyJob(
  data: Omit<ComfyJob, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { completedAt: _ca, ...rest } = data;
  const ref = await addDoc(collection(db, "comfyJobs"), {
    ...rest,
    completedAt: data.completedAt ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Fetch a single ComfyUI job by document ID. */
export async function getComfyJob(jobId: string): Promise<ComfyJob | null> {
  const snap = await getDoc(doc(db, "comfyJobs", jobId));
  if (!snap.exists()) return null;
  return docToJob(snap.id, snap.data() as Record<string, unknown>);
}

/** Update mutable fields on a ComfyUI job. */
export async function updateComfyJob(
  jobId: string,
  updates: Partial<Pick<ComfyJob, "status" | "progress" | "error" | "previewUrl" | "completedAt" | "negativePrompt" | "tags" | "isFavorite">>,
): Promise<void> {
  const payload: Record<string, unknown> = {
    ...updates,
    updatedAt: serverTimestamp(),
  };
  // Convert completedAt Date to serverTimestamp if set to a truthy value,
  // or leave it as-is (null / undefined) otherwise.
  if (updates.completedAt !== undefined) {
    payload.completedAt = updates.completedAt ?? null;
  }
  await updateDoc(doc(db, "comfyJobs", jobId), payload);
}

/**
 * List ComfyUI jobs for an organization.
 * Ordered by createdAt descending (newest first).
 */
export async function getOrgComfyJobs(
  orgId: string,
  opts?: { status?: ComfyJobStatus; limit?: number },
): Promise<ComfyJob[]> {
  const constraints = [
    where("orgId", "==", orgId),
  ];
  if (opts?.status) {
    constraints.push(where("status", "==", opts.status));
  }
  const q = query(
    collection(db, "comfyJobs"),
    ...constraints,
    orderBy("createdAt", "desc"),
    firestoreLimit(opts?.limit ?? 50),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToJob(d.id, d.data() as Record<string, unknown>));
}

/** Look up a ComfyUI job by the prompt_id returned from ComfyUI. */
export async function getComfyJobByPromptId(comfyPromptId: string): Promise<ComfyJob | null> {
  const q = query(
    collection(db, "comfyJobs"),
    where("comfyPromptId", "==", comfyPromptId),
    firestoreLimit(1),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return docToJob(d.id, d.data() as Record<string, unknown>);
}

/** Delete a ComfyUI job record. */
export async function deleteComfyJob(jobId: string): Promise<void> {
  await deleteDoc(doc(db, "comfyJobs", jobId));
}

// ═══════════════════════════════════════════════════════════════
// Artifacts
// ═══════════════════════════════════════════════════════════════

/** Create an artifact record for a ComfyUI output. Returns the Firestore document ID. */
export async function createComfyArtifact(
  data: Omit<ComfyArtifact, "id" | "createdAt">,
): Promise<string> {
  const ref = await addDoc(collection(db, "comfyArtifacts"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** Fetch all artifacts produced by a specific job. */
export async function getJobArtifacts(jobId: string): Promise<ComfyArtifact[]> {
  const q = query(
    collection(db, "comfyArtifacts"),
    where("jobId", "==", jobId),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToArtifact(d.id, d.data() as Record<string, unknown>));
}

/**
 * List artifacts for an organization.
 * Ordered by createdAt descending (newest first).
 */
export async function getOrgArtifacts(
  orgId: string,
  opts?: { limit?: number },
): Promise<ComfyArtifact[]> {
  const q = query(
    collection(db, "comfyArtifacts"),
    where("orgId", "==", orgId),
    orderBy("createdAt", "desc"),
    firestoreLimit(opts?.limit ?? 100),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToArtifact(d.id, d.data() as Record<string, unknown>));
}

/** Delete all artifacts associated with a job. */
export async function deleteJobArtifacts(jobId: string): Promise<void> {
  const q = query(
    collection(db, "comfyArtifacts"),
    where("jobId", "==", jobId),
  );
  const snap = await getDocs(q);
  const deletions = snap.docs.map((d) => deleteDoc(doc(db, "comfyArtifacts", d.id)));
  await Promise.all(deletions);
}

// ═══════════════════════════════════════════════════════════════
// Workflow Templates
// ═══════════════════════════════════════════════════════════════

/** Create a new workflow template. Returns the Firestore document ID. */
export async function createWorkflowTemplate(
  data: Omit<ComfyWorkflowTemplate, "id" | "createdAt" | "updatedAt">,
): Promise<string> {
  const ref = await addDoc(collection(db, "comfyWorkflows"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Fetch a single workflow template by document ID. */
export async function getWorkflowTemplate(id: string): Promise<ComfyWorkflowTemplate | null> {
  const snap = await getDoc(doc(db, "comfyWorkflows", id));
  if (!snap.exists()) return null;
  return docToWorkflow(snap.id, snap.data() as Record<string, unknown>);
}

/** Update mutable fields on a workflow template. */
export async function updateWorkflowTemplate(
  id: string,
  updates: Partial<Omit<ComfyWorkflowTemplate, "id" | "createdAt">>,
): Promise<void> {
  await updateDoc(doc(db, "comfyWorkflows", id), {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

/**
 * List workflow templates for an organization.
 * Ordered by createdAt descending (newest first).
 */
export async function getOrgWorkflowTemplates(orgId: string): Promise<ComfyWorkflowTemplate[]> {
  const q = query(
    collection(db, "comfyWorkflows"),
    where("orgId", "==", orgId),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToWorkflow(d.id, d.data() as Record<string, unknown>));
}

/** Delete a workflow template. */
export async function deleteWorkflowTemplate(id: string): Promise<void> {
  await deleteDoc(doc(db, "comfyWorkflows", id));
}

/** Atomically increment the usageCount on a workflow template. */
export async function incrementWorkflowUsage(id: string): Promise<void> {
  await updateDoc(doc(db, "comfyWorkflows", id), {
    usageCount: increment(1),
    updatedAt: serverTimestamp(),
  });
}

// ═══════════════════════════════════════════════════════════════
// Query Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Get aggregate job statistics for an organization.
 * Fetches all jobs in a single query and counts by status in-memory.
 */
export async function getOrgComfyStats(
  orgId: string,
): Promise<{ total: number; completed: number; failed: number; running: number }> {
  const q = query(
    collection(db, "comfyJobs"),
    where("orgId", "==", orgId),
  );
  const snap = await getDocs(q);

  const stats = { total: 0, completed: 0, failed: 0, running: 0 };
  for (const d of snap.docs) {
    stats.total++;
    const status = (d.data() as Record<string, unknown>).status as ComfyJobStatus;
    if (status === "completed") stats.completed++;
    else if (status === "failed") stats.failed++;
    else if (status === "running") stats.running++;
  }
  return stats;
}

/** Fetch artifacts from jobs that the user has marked as favorite. */
export async function getFavoriteArtifacts(
  orgId: string,
  limit?: number,
): Promise<ComfyArtifact[]> {
  // Step 1: get favorite job IDs
  const jobsQuery = query(
    collection(db, "comfyJobs"),
    where("orgId", "==", orgId),
    where("isFavorite", "==", true),
  );
  const jobsSnap = await getDocs(jobsQuery);
  const favoriteJobIds = jobsSnap.docs.map((d) => d.id);

  if (favoriteJobIds.length === 0) return [];

  // Step 2: fetch artifacts for those jobs (Firestore 'in' supports up to 30 values)
  const batches: string[][] = [];
  for (let i = 0; i < favoriteJobIds.length; i += 30) {
    batches.push(favoriteJobIds.slice(i, i + 30));
  }

  const allArtifacts: ComfyArtifact[] = [];
  for (const batch of batches) {
    const artQ = query(
      collection(db, "comfyArtifacts"),
      where("jobId", "in", batch),
      orderBy("createdAt", "desc"),
    );
    const artSnap = await getDocs(artQ);
    for (const d of artSnap.docs) {
      allArtifacts.push(docToArtifact(d.id, d.data() as Record<string, unknown>));
    }
  }

  // Sort combined results by createdAt descending and apply limit
  allArtifacts.sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    return tb - ta;
  });

  return limit ? allArtifacts.slice(0, limit) : allArtifacts;
}

/**
 * Shorthand for fetching recently completed jobs for an organization.
 * Ordered by completedAt descending.
 */
export async function getRecentCompletedJobs(
  orgId: string,
  limit?: number,
): Promise<ComfyJob[]> {
  const q = query(
    collection(db, "comfyJobs"),
    where("orgId", "==", orgId),
    where("status", "==", "completed"),
    orderBy("completedAt", "desc"),
    firestoreLimit(limit ?? 20),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToJob(d.id, d.data() as Record<string, unknown>));
}
