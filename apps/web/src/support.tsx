export type Ticket = {
  id: string;
  merchant: string;
  branch: string;
  register: string;
  assignee: string | null;
  assigneeId: string | null;
  resolvedAt: string | null;
};
export type History = {
  events: Array<{ id: string; kind: string; actor: string; message: string; occurredAt: string }>;
  grants: Array<{ id: string; operator: string; expiresAt: string; active: boolean; reason: string }>;
};

export function localTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Never observed';
}

export function Timeline({ history }: { history?: History }) {
  if (!history) return null;
  return <ol>{history.events.map((item) => <li key={item.id}>
    <strong>{item.kind.replaceAll('_', ' ')}</strong> · {item.actor} · {localTime(item.occurredAt)}
    <div>{item.message}</div>
  </li>)}</ol>;
}
