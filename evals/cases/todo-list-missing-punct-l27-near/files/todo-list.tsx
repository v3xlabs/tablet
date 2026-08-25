import { useState } from "react";

export type Todo = {
  id: number;
  title: string;
  done: boolean;
};

type TodoListProps = {
  initial: Todo[];
  onCountChange: (open: number) => void;
};

export const TodoList = ({ initial, onCountChange }: TodoListProps) => {
  const [items, setItems] = useState(initial);
  const [draft, setDraft] = useState("");

  const openCount = items.filter(item => !item.done).length;

  const toggle = (id: number) => {
    const next = items.map(item => (item.id === id ? { ...item, done: !item.done } : item));
    setItems(next);
    onCountChange(next.filter(item => !item.done).length);
  };

  const add = () => {
    if (draft.trim() === "") return
    const next = [...items, { id: Date.now(), title: draft.trim(), done: false }];
    setItems(next);
    setDraft("");
    onCountChange(next.length);
  };

  return (
    <div className="todo-list">
      <header>
        <h2>Todos</h2>
        <span className="count">{openCount} open</span>
      </header>
      <ul>
        {items.map(item => (
          <li key={item.id} className={item.done ? "done" : "open"}>
            <input type="checkbox" checked={item.done} onChange={() => toggle(item.id)} />
            <span>{item.title}</span>
          </li>
        ))}
      </ul>
      <footer>
        <input value={draft} onChange={event => setDraft(event.target.value)} />
        <button onClick={add}>Add</button>
      </footer>
    </div>
  );
};
