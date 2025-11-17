import { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  API_BASE_URL,
  createTask,
  getTasks,
  updateTaskStatus,
} from "./lib/api";

const STATUS_COLORS = {
  pending: "#f97316",
  queued: "#0ea5e9",
  completed: "#22c55e",
};

function App() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", description: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingTaskId, setUpdatingTaskId] = useState(null);

  const totalCompleted = useMemo(
    () => tasks.filter((task) => task.status === "completed").length,
    [tasks]
  );

  async function loadTasks() {
    try {
      setError("");
      setLoading(true);
      const data = await getTasks();
      setTasks(data);
    } catch (err) {
      setError(err.message || "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTasks();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!form.title.trim()) {
      setError("Title is required");
      return;
    }

    try {
      setError("");
      setIsSubmitting(true);
      await createTask(form);
      setForm({ title: "", description: "" });
      await loadTasks();
    } catch (err) {
      setError(err.message || "Failed to create task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusUpdate = async (taskId, status) => {
    try {
      setUpdatingTaskId(taskId);
      await updateTaskStatus(taskId, status);
      await loadTasks();
    } catch (err) {
      setError(err.message || "Failed to update task");
    } finally {
      setUpdatingTaskId(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Three-tier demo</p>
          <h1>Task Processing Console</h1>
          <p className="subtitle">
            React frontend ↔ Node REST API ↔ PostgreSQL with RabbitMQ events
          </p>
        </div>
        <div className="environment">
          <span>API base</span>
          <code>{API_BASE_URL}</code>
        </div>
      </header>

      <main className="layout-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Create task</h2>
              <p>Submitting will persist the record and enqueue a job.</p>
            </div>
          </div>
          <form className="task-form" onSubmit={handleSubmit}>
            <label>
              Title
              <input
                type="text"
                value={form.title}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="Provision EC2"
                disabled={isSubmitting}
              />
            </label>
            <label>
              Description
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, description: e.target.value }))
                }
                placeholder="Add any details that the worker should know..."
                rows={4}
                disabled={isSubmitting}
              />
            </label>
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Create & enqueue"}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Tasks</h2>
              <p>
                {loading
                  ? "Loading..."
                  : `${tasks.length} total / ${totalCompleted} completed`}
              </p>
            </div>
            <button className="ghost" onClick={loadTasks} disabled={loading}>
              Refresh
            </button>
          </div>

          {loading ? (
            <p className="empty-state">Fetching data from the API…</p>
          ) : tasks.length === 0 ? (
            <p className="empty-state">
              No tasks yet. Use the form to create one.
            </p>
          ) : (
            <ul className="task-list">
              {tasks.map((task) => (
                <li key={task.id} className="task-card">
                  <div className="task-card-header">
                    <div>
                      <p className="task-title">{task.title}</p>
                      {task.description && (
                        <p className="task-desc">{task.description}</p>
                      )}
                    </div>
                    <span
                      className="status-pill"
                      style={{ backgroundColor: STATUS_COLORS[task.status] }}
                    >
                      {task.status}
                    </span>
                  </div>
                  <div className="task-meta">
                    <span>
                      Created {new Date(task.created_at).toLocaleString()}
                    </span>
                    <div className="task-actions">
                      <button
                        onClick={() => handleStatusUpdate(task.id, "completed")}
                        disabled={
                          updatingTaskId === task.id ||
                          task.status === "completed"
                        }
                      >
                        {task.status === "completed"
                          ? "Completed"
                          : updatingTaskId === task.id
                          ? "Updating..."
                          : "Mark done"}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
