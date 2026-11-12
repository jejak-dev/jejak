import { Icon } from "./Icon";
import { todoProgress, type TodoItem } from "../lib/todos";

export interface TodosTabProps {
  /** Daftar langkah terakhir yang dikirim agent. */
  todos: readonly TodoItem[];
}

const EMPTY_MESSAGE = "Belum ada daftar langkah dari agent.";

/** Ikon status: centang (selesai), titik berdenyut (berjalan), lingkaran kosong (menunggu). */
function StatusMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <span class="jk-todo-mark jk-todo-mark-done" title="Selesai" role="img" aria-label="Selesai">
        <Icon name="check" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span class="jk-todo-mark" title="Berjalan" role="img" aria-label="Sedang berjalan">
        <span class="jk-todo-dot jk-todo-dot-run" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span class="jk-todo-mark" title="Menunggu" role="img" aria-label="Menunggu">
      <span class="jk-todo-dot jk-todo-dot-wait" aria-hidden="true" />
    </span>
  );
}

export function TodosTab({ todos }: TodosTabProps) {
  const { done, total } = todoProgress(todos);

  if (todos.length === 0) {
    return (
      <div class="jk-panel-body">
        <p class="jk-panel-note">{EMPTY_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div class="jk-panel-body">
      <p class="jk-panel-note">
        {done} dari {total} selesai
      </p>
      <ul class="jk-todo-list">
        {todos.map((todo, index) => (
          <li class="jk-todo-item" key={`${index}-${todo.content}`}>
            <StatusMark status={todo.status} />
            <span class="jk-todo-text">
              {todo.status === "in_progress" && todo.activeForm !== undefined
                ? todo.activeForm
                : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
