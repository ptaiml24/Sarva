import { Link } from "react-router-dom";

/**
 * Company-level repo references are not stored as a separate entity in R1; use project intake for code remotes.
 */
export function ReposPage() {
  return (
    <div data-testid="repos-page">
      <p className="muted page-intro">
        <strong>Work → Repos &amp; templates</strong> — where code and doc remotes are attached in Sarva.
      </p>
      <div className="card">
        <h2>Company-wide</h2>
        <p className="muted">
          There is no separate &quot;company repo list&quot; in this release. Document or policy links belong in project{" "}
          <strong>Intake</strong> (requirements links, document repository URL). Use{" "}
          <Link to="/organization/business-units">Business units</Link> for org structure.
        </p>
      </div>
      <div className="card">
        <h2>Per project</h2>
        <p className="muted">
          Each project&apos;s clone URL, branch, and paths are set under <strong>Project → Intake</strong> (repository scope) and
          in the project context. Open a project from <Link to="/projects">Projects</Link> and start with the intake workflow.
        </p>
      </div>
    </div>
  );
}
