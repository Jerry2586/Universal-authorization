export const BUILD_JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const SOURCE_KIND = Object.freeze({
  OFFICIAL: 'official',
  UPLOAD: 'upload',
});

export function publicBuildJob(job) {
  return {
    id: job.id,
    version: job.requested_version,
    intent: job.intent ?? 'install',
    base_version: job.base_version ?? null,
    domain: job.requested_domain,
    source_kind: job.source_kind,
    status: job.status,
    progress: job.progress,
    message: job.status_message,
    build_id: job.build_id,
    artifact_available: Boolean(job.artifact_ref),
    created_at: job.created_at,
    completed_at: job.completed_at,
  };
}
