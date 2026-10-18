import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { Empty } from "../components/ui";

export default function NotFound() {
  return (
    <div className="page">
      <div className="card">
        <Empty
          icon={<Compass size={20} />}
          title="Page not found"
          description="This route does not exist in KI00. Use the sidebar or open the command palette (Ctrl/Cmd + K) to find a project or deployment."
          action={
            <Link to="/" className="btn primary sm">
              Go to overview
            </Link>
          }
        />
      </div>
    </div>
  );
}
