export type Ink = 'blue' | 'pink';

export type Person = {
  id: string;
  tgId: string;
  displayName: string;
  ink: Ink;
};

/** Состояние связки — единственное, что знает экран на этом шаге. */
export type PairState = {
  me: Person;
  partner: Person | null;
  couple: { id: string; inviteCode: string };
};

export type ApiError = { error: string; detail?: string };
