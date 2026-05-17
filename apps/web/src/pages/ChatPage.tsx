import { Link } from "react-router-dom";

/** Chat route — shell matches sarva-full-app-mock.html; messaging not wired in R1. */
export function ChatPage() {
  return (
    <div data-testid="chat-page">
      <p className="muted page-intro">
        <strong>Chat</strong> — layout aligned with the full-app mock; threads are illustrative until a chat API exists.
      </p>
      <div className="chat-layout">
        <div className="chat-threads">
          <div className="chat-thread-item active">#standup · Platform</div>
          <div className="chat-thread-item">(More threads when wired)</div>
        </div>
        <div className="chat-pane">
          <p className="muted" style={{ margin: 0 }}>
            A dedicated chat surface is not wired in this release. Use <Link to="/projects">Projects</Link> (Intake,
            Plan, Board) for structured work; see <Link to="/agents">Agents</Link> for roster and{" "}
            <Link to="/admin">Admin</Link> for model bindings.
          </p>
        </div>
      </div>
    </div>
  );
}
