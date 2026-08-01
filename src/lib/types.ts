export type Ink = 'blue' | 'pink';
export type ItemType = 'task' | 'wish' | 'home' | 'date';

export type Person = {
  id: string;
  tgId: string;
  displayName: string;
  ink: Ink;
};

export type PairState = {
  me: Person;
  partner: Person | null;
  couple: { id: string; inviteCode: string };
};

export type Item = {
  id: string;
  authorId: string;
  ownerId: string | null; // null = общее
  type: ItemType;
  text: string;
  note: string | null;
  dueAt: string | null;
  done: boolean;
  /** Приходит заполненным только тому, кто взял. Маскируется в items_visible. */
  claimedBy: string | null;
  /** Секретные пункты партнёру не приходят вовсе — это гарантирует RLS. */
  secret: boolean;
  url: string | null;
  price: string | null;
  createdAt: string;
};

export type Energy = { userId: string; level: 1 | 2 | 3 };

export type Snapshot = { items: Item[]; energy: Energy[] };

export type AppState = PairState & Snapshot;

export type ApiError = { error: string; detail?: string };
