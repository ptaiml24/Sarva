-- Persisted LLM provider configs (keys stored server-side; protect DB access in production).
CREATE TABLE "llm_provider_connection" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "base_url" TEXT,
    "api_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_provider_connection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "llm_provider_connection" ADD CONSTRAINT "llm_provider_connection_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE INDEX "llm_provider_connection_company_id_idx" ON "llm_provider_connection"("company_id");

ALTER TABLE "model_binding" ADD COLUMN "llm_provider_connection_id" UUID;

ALTER TABLE "model_binding" ADD CONSTRAINT "model_binding_llm_provider_connection_id_fkey" FOREIGN KEY ("llm_provider_connection_id") REFERENCES "llm_provider_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
