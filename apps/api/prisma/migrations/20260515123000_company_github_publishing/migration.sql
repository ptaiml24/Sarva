-- Company-level GitHub publishing (Admin → GitHub setup; Board → Publish to GitHub).
ALTER TABLE "Company" ADD COLUMN "github_owner_login" TEXT;
ALTER TABLE "Company" ADD COLUMN "github_owner_is_organization" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "github_pat" TEXT;
ALTER TABLE "Company" ADD COLUMN "github_repos_private_by_default" BOOLEAN NOT NULL DEFAULT true;
