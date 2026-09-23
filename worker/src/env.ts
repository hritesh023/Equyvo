export interface Env {
  EQUYVO_KV: KVNamespace;
  // Optional R2 warehouse (zero egress). Bind as EQUYVO_R2 when ready.
  EQUYVO_R2?: R2Bucket;
  R2_PUBLIC_BASE?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_UPLOAD_PRESET?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  AWS_USER_POOL_ID?: string;
  MAX_UPLOAD_MB?: string;
  BILLING_BASE_URL?: string;
  REQUIRE_VERIFIED_WRITES?: string;
  ALLOWED_ORIGINS?: string;
  APP_VERSION?: string;
  // Contabo shared brain for AI search/feed suggestions (best-effort proxy).
  BRAIN_URL?: string;
  BRAIN_BASE_URL?: string;
}
